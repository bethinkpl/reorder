import type { MedusaContainer } from "@medusajs/framework/types"
import {
  type PaymentFailureAction,
  type PaymentFailureHandling,
  readReportedPaymentFailure,
  type RecordedPaymentFailureOutcome,
  type ReportedPaymentFailure,
} from "../../common/types/reported-payment-failure"
import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../../modules/activity-log/types"
import { normalizeActivityLogEvent } from "../../modules/activity-log/utils/normalize-log-event"
import { DunningPaymentFailureSource } from "../../modules/dunning/types"
import { RENEWAL_MODULE } from "../../modules/renewal"
import type RenewalModuleService from "../../modules/renewal/service"
import {
  CHARGE_IN_FLIGHT_RENEWAL_CYCLE_STATUSES,
  CLOSED_RENEWAL_CYCLE_STATUSES,
  type RenewalAppliedPendingUpdateData,
  RenewalAttemptStatus,
  RenewalCycleStatus,
  RenewalTriggerType,
} from "../../modules/renewal/types"
import {
  classifyRenewalFailure,
  createRenewalCorrelationId,
  getRenewalErrorMessage,
  isAlertableRenewalFailure,
  logRenewalEvent,
  RenewalLogEvents,
} from "../../modules/renewal/utils/observability"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import type SubscriptionModuleService from "../../modules/subscription/service"
import {
  CHARGEABLE_SUBSCRIPTION_STATUSES,
  type SubscriptionType,
} from "../../modules/subscription/types"
import { startDunningWorkflow } from "../start-dunning"
import { persistSubscriptionLogEvent } from "../steps/create-subscription-log-event"
import { loadOrderAmounts } from "../steps/run-dunning-retry"
import { toISOStringOrNull } from "./date-output"
import {
  type RenewalSessionSignal,
  signalNamesAttempt,
} from "./renewal-session-marker"
import { tryUnderLock } from "./run-under-lock"
import { readStoredSettlementInputs } from "./settle-renewal-cycle-succeeded"
import { renewalSubscriptionLockKey } from "../../modules/renewal/utils/lock-key"

const RUN_LOCK_WAIT_SECONDS = 5
const LOCK_HOLD_SECONDS = 120

export type FailAwaitingRenewalCycleInput = {
  renewal_cycle_id: string
  session_id: string | null
  attempt_id: string | null
  action: PaymentFailureAction
  reason: string | null
  message?: string
}

type RenewalCycleRecord = {
  id: string
  subscription_id: string
  scheduled_for: Date | string
  status: RenewalCycleStatus
  processed_at: Date | string | null
  generated_order_id: string | null
  applied_pending_update_data: RenewalAppliedPendingUpdateData | null
  settlement_inputs: Record<string, unknown> | null
  last_error: string | null
  attempt_count: number
}

type RenewalAttemptRecord = {
  id: string
  attempt_no: number
  status: RenewalAttemptStatus
  payment_reference: string | null
  order_id: string | null
  metadata: Record<string, unknown> | null
}

const SUBMITTED_ATTEMPT_STATUSES: readonly RenewalAttemptStatus[] = [
  RenewalAttemptStatus.PROCESSING,
  RenewalAttemptStatus.FAILED,
]

async function loadCycle(
  renewalModule: RenewalModuleService,
  id: string
): Promise<RenewalCycleRecord | null> {
  const [cycle] = await renewalModule.listRenewalCycles({ id })

  return (cycle as RenewalCycleRecord | undefined) ?? null
}

async function findAttemptForSession(
  renewalModule: RenewalModuleService,
  cycle: RenewalCycleRecord,
  signal: RenewalSessionSignal
): Promise<RenewalAttemptRecord | null> {
  const [latest] = await renewalModule.listRenewalAttempts(
    { renewal_cycle_id: cycle.id },
    { order: { attempt_no: "DESC" }, take: 1 }
  )

  if (!latest || !signalNamesAttempt(latest, signal)) {
    return null
  }

  if (latest.payment_reference) {
    return SUBMITTED_ATTEMPT_STATUSES.includes(latest.status) ? latest : null
  }

  return cycle.status === RenewalCycleStatus.PROCESSING &&
    latest.status === RenewalAttemptStatus.PROCESSING
    ? latest
    : null
}

/**
 * When another holder keeps the lock for the whole wait, the report is recorded on the attempt it
 * names for the awaiting-payment sweep to apply: the bus would only redeliver it within seconds,
 * and nothing else keeps a failure.
 */
export async function failAwaitingRenewalCycle(
  container: MedusaContainer,
  input: FailAwaitingRenewalCycleInput & { session_id: string }
): Promise<PaymentFailureHandling> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)

  const cycle = await loadCycle(renewalModule, input.renewal_cycle_id)

  if (
    !cycle ||
    (!CLOSED_RENEWAL_CYCLE_STATUSES.includes(cycle.status) &&
      !CHARGE_IN_FLIGHT_RENEWAL_CYCLE_STATUSES.includes(cycle.status))
  ) {
    return "ignored"
  }

  const run = await tryUnderLock(
    container,
    renewalSubscriptionLockKey(cycle.subscription_id),
    () => applyRenewalPaymentFailureUnderLock(container, input),
    { wait_seconds: RUN_LOCK_WAIT_SECONDS, hold_seconds: LOCK_HOLD_SECONDS }
  )

  if (run.acquired) {
    return run.result ? "applied" : "ignored"
  }

  if (!(await recordRenewalPaymentFailure(container, cycle, input))) {
    throw run.error
  }

  return "recorded"
}

/**
 * Written without the lock, so it touches the one column nothing else writes but the sweep that
 * applies and clears it under the lock.
 */
async function recordRenewalPaymentFailure(
  container: MedusaContainer,
  cycle: RenewalCycleRecord,
  input: FailAwaitingRenewalCycleInput & { session_id: string }
): Promise<boolean> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const attempts = await renewalModule.listRenewalAttempts({ renewal_cycle_id: cycle.id })
  const attempt = attempts.find((candidate) =>
    signalNamesAttempt(candidate, {
      session_id: input.session_id,
      attempt_id: input.attempt_id,
    })
  )

  if (!attempt) {
    return false
  }

  const failure: ReportedPaymentFailure = {
    session_id: input.session_id,
    action: input.action,
    reason: input.reason,
    received_at: new Date().toISOString(),
  }

  await renewalModule.updateRenewalAttempts({
    id: attempt.id,
    reported_payment_failure: failure,
  })

  logRenewalEvent(container.resolve("logger"), "info", {
    event: RenewalLogEvents.PAYMENT_FAILURE_RECORDED,
    correlation_id: createRenewalCorrelationId("renewal-payment-failure"),
    renewal_cycle_id: cycle.id,
    subscription_id: cycle.subscription_id,
    alertable: false,
    message: `The renewal lock stayed taken, so the '${input.action}' reported for payment session '${input.session_id}' was recorded on its attempt for the awaiting-payment sweep to apply`,
    metadata: { attempt_id: attempt.id, payment_session_id: input.session_id },
  })

  return true
}

/** The caller holds the subscription's renewal lock. */
export async function applyRenewalPaymentFailureUnderLock(
  container: MedusaContainer,
  input: FailAwaitingRenewalCycleInput
): Promise<boolean> {
  const cycle = await loadCycle(
    container.resolve<RenewalModuleService>(RENEWAL_MODULE),
    input.renewal_cycle_id
  )

  if (!cycle) {
    return false
  }

  return CLOSED_RENEWAL_CYCLE_STATUSES.includes(cycle.status)
    ? await failAttemptOfClosedCycleUnderLock(container, input)
    : await failAwaitingRenewalCycleUnderLock(container, input)
}

/** The caller holds the subscription's renewal lock. */
export async function applyRecordedRenewalPaymentFailureUnderLock(
  container: MedusaContainer,
  attemptId: string
): Promise<RecordedPaymentFailureOutcome | null> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const [attempt] = await renewalModule.listRenewalAttempts({ id: attemptId })
  const failure = readReportedPaymentFailure(attempt?.reported_payment_failure)

  if (!attempt || !failure) {
    return null
  }

  const cycle = await loadCycle(renewalModule, attempt.renewal_cycle_id)
  const orderId = cycle?.generated_order_id ?? attempt.order_id
  const orderPaid = orderId
    ? (await loadOrderAmounts(container, orderId)).pending <= 0
    : false
  const applied =
    !orderPaid &&
    (await applyRenewalPaymentFailureUnderLock(container, {
      renewal_cycle_id: attempt.renewal_cycle_id,
      session_id: failure.session_id,
      attempt_id: attempt.id,
      action: failure.action,
      reason: failure.reason,
    }))

  await renewalModule.updateRenewalAttempts({
    id: attempt.id,
    reported_payment_failure: null,
  })

  return applied ? "applied" : orderPaid ? "order_paid" : "stale"
}

async function failAttemptOfClosedCycleUnderLock(
  container: MedusaContainer,
  input: FailAwaitingRenewalCycleInput
): Promise<boolean> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const cycle = await loadCycle(renewalModule, input.renewal_cycle_id)

  if (!cycle || !CLOSED_RENEWAL_CYCLE_STATUSES.includes(cycle.status)) {
    return false
  }

  const attempts = await renewalModule.listRenewalAttempts({
    renewal_cycle_id: cycle.id,
    status: RenewalAttemptStatus.PROCESSING,
  })
  const attempt = attempts.find((candidate) =>
    signalNamesAttempt(candidate, {
      session_id: input.session_id,
      attempt_id: input.attempt_id,
    })
  )

  if (!attempt) {
    return false
  }

  const message = input.reason
    ? `Payment provider reported the renewal payment as '${input.action}' (${input.reason}) after the renewal had closed`
    : `Payment provider reported the renewal payment as '${input.action}' after the renewal had closed`

  await renewalModule.updateRenewalAttempts({
    id: attempt.id,
    status: RenewalAttemptStatus.FAILED,
    finished_at: new Date(),
    error_code: input.reason ?? input.action,
    error_message: message,
  })

  logRenewalEvent(container.resolve("logger"), "info", {
    event: RenewalLogEvents.LATE_PAYMENT_FAILURE,
    outcome: "failed",
    correlation_id: createRenewalCorrelationId("renewal-late-payment-failure"),
    renewal_cycle_id: cycle.id,
    subscription_id: cycle.subscription_id,
    alertable: false,
    message,
    metadata: { attempt_id: attempt.id, payment_session_id: input.session_id },
  })

  return true
}

export async function failAwaitingRenewalCycleUnderLock(
  container: MedusaContainer,
  input: FailAwaitingRenewalCycleInput
): Promise<boolean> {
  const startedAtMs = Date.now()
  const logger = container.resolve("logger")
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

  const cycle = await loadCycle(renewalModule, input.renewal_cycle_id)

  if (!cycle || !CHARGE_IN_FLIGHT_RENEWAL_CYCLE_STATUSES.includes(cycle.status)) {
    return false
  }

  const attempt = await findAttemptForSession(renewalModule, cycle, {
    session_id: input.session_id,
    attempt_id: input.attempt_id,
  })

  if (!attempt) {
    return false
  }

  const subscription = (await subscriptionModule.retrieveSubscription(
    cycle.subscription_id
  )) as SubscriptionType

  const finishedAt = new Date()
  const errorCode = input.reason ?? input.action
  const message =
    input.message ??
    (input.reason
      ? `Payment provider reported the renewal payment as '${input.action}' (${input.reason})`
      : `Payment provider reported the renewal payment as '${input.action}'`)
  const failureKind = classifyRenewalFailure(message)
  const orderId = cycle.generated_order_id ?? attempt.order_id
  const { audit } = readStoredSettlementInputs(cycle.settlement_inputs)
  const correlationId =
    audit?.correlation_id ?? createRenewalCorrelationId("renewal-payment-failure")
  const triggerReason =
    typeof attempt.metadata?.reason === "string" ? attempt.metadata.reason : null
  const appliedPendingChanges = cycle.applied_pending_update_data

  if (attempt.status === RenewalAttemptStatus.PROCESSING) {
    await renewalModule.updateRenewalAttempts({
      id: attempt.id,
      status: RenewalAttemptStatus.FAILED,
      finished_at: finishedAt,
      error_code: errorCode,
      error_message: message,
      order_id: orderId,
      payment_reference: attempt.payment_reference ?? input.session_id,
    })
  }

  await renewalModule.updateRenewalCycles({
    id: cycle.id,
    status: RenewalCycleStatus.FAILED,
    processed_at: finishedAt,
    last_error: message,
  })

  await persistSubscriptionLogEvent(container, normalizeActivityLogEvent({
    subscription_id: subscription.id,
    customer_id: subscription.customer_id,
    event_type: ActivityLogEventType.RENEWAL_FAILED,
    actor_type: audit
      ? audit.trigger_type === RenewalTriggerType.MANUAL
        ? ActivityLogActorType.USER
        : ActivityLogActorType.SCHEDULER
      : ActivityLogActorType.SYSTEM,
    actor_id: audit?.triggered_by ?? null,
    display: {
      subscription_reference: subscription.reference,
      customer_name: subscription.customer_snapshot?.full_name ?? null,
      product_title: subscription.product_snapshot.product_title ?? null,
      variant_title:
        appliedPendingChanges?.variant_title ??
        subscription.product_snapshot.variant_title ??
        null,
    },
    previous_state: audit?.previous_state ?? {
      status: cycle.status,
      attempt_count: cycle.attempt_count,
      processed_at: toISOStringOrNull(cycle.processed_at),
      generated_order_id: cycle.generated_order_id,
      last_error: cycle.last_error,
    },
    new_state: {
      status: RenewalCycleStatus.FAILED,
      attempt_count: attempt.attempt_no,
      processed_at: toISOStringOrNull(finishedAt),
      generated_order_id: orderId,
      last_error: message,
      applied_pending_update_data: appliedPendingChanges,
    },
    reason: triggerReason,
    metadata: {
      source: audit
        ? audit.trigger_type === RenewalTriggerType.MANUAL
          ? "admin"
          : "scheduler"
        : "payment_provider",
      renewal_cycle_id: cycle.id,
      order_id: orderId,
      trigger_type: audit?.trigger_type ?? null,
      reason_code: failureKind,
      scheduled_for: audit?.scheduled_for ?? toISOStringOrNull(cycle.scheduled_for),
    },
    correlation_id: correlationId,
    dedupe: {
      scope: "renewal",
      target_id: cycle.id,
      qualifier: toISOStringOrNull(finishedAt),
    },
  }))

  const durationMs = () =>
    Date.now() - (audit?.operation_started_at ?? startedAtMs)

  if (CHARGEABLE_SUBSCRIPTION_STATUSES.includes(subscription.status)) {
    try {
      await startDunningWorkflow(container).run({
        input: {
          subscription_id: subscription.id,
          renewal_cycle_id: cycle.id,
          renewal_order_id: orderId,
          payment_failure_source: DunningPaymentFailureSource.PAYMENT_PROVIDER,
          payment_error_code: errorCode,
          payment_error_message: message,
          failed_at: finishedAt,
          triggered_by: audit?.triggered_by ?? null,
          reason: triggerReason,
          metadata: {
            renewal_trigger_type: audit?.trigger_type ?? null,
            renewal_attempt_id: attempt.id,
            renewal_attempt_no: attempt.attempt_no,
            renewal_correlation_id: correlationId,
          },
        },
      })
    } catch (dunningError) {
      logRenewalEvent(logger, "warn", {
        event: RenewalLogEvents.DUNNING,
        outcome: "failed",
        correlation_id: correlationId,
        renewal_cycle_id: cycle.id,
        subscription_id: subscription.id,
        ...(audit ? { trigger_type: audit.trigger_type } : {}),
        triggered_by: audit?.triggered_by ?? null,
        duration_ms: durationMs(),
        failure_kind: failureKind,
        alertable: true,
        message: `Failed to start dunning after renewal failure: ${getRenewalErrorMessage(
          dunningError
        )}`,
      })
    }
  } else {
    logRenewalEvent(logger, "warn", {
      event: RenewalLogEvents.DUNNING,
      outcome: "blocked",
      correlation_id: correlationId,
      renewal_cycle_id: cycle.id,
      subscription_id: subscription.id,
      ...(audit ? { trigger_type: audit.trigger_type } : {}),
      triggered_by: audit?.triggered_by ?? null,
      duration_ms: durationMs(),
      failure_kind: "subscription_not_eligible",
      alertable: isAlertableRenewalFailure("subscription_not_eligible"),
      message: `Renewal payment failed while the subscription is '${subscription.status}'; dunning was not started`,
    })
  }

  logRenewalEvent(logger, "error", {
    event: RenewalLogEvents.EXECUTION,
    outcome: "failed",
    correlation_id: correlationId,
    renewal_cycle_id: cycle.id,
    subscription_id: subscription.id,
    ...(audit ? { trigger_type: audit.trigger_type } : {}),
    triggered_by: audit?.triggered_by ?? null,
    attempt_no: attempt.attempt_no,
    duration_ms: durationMs(),
    success_count: 0,
    failure_count: 1,
    failure_kind: failureKind,
    alertable: isAlertableRenewalFailure(failureKind),
    message,
  })

  return true
}
