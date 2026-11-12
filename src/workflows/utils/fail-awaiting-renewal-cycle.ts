import type { MedusaContainer } from "@medusajs/framework/types"
import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../../modules/activity-log/types"
import { normalizeActivityLogEvent } from "../../modules/activity-log/utils/normalize-log-event"
import { RENEWAL_MODULE } from "../../modules/renewal"
import type RenewalModuleService from "../../modules/renewal/service"
import {
  type RenewalAppliedPendingUpdateData,
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../modules/renewal/types"
import {
  classifyRenewalFailure,
  createRenewalCorrelationId,
  getRenewalErrorMessage,
  isAlertableRenewalFailure,
  logRenewalEvent,
} from "../../modules/renewal/utils/observability"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import type SubscriptionModuleService from "../../modules/subscription/service"
import {
  SubscriptionStatus,
  type SubscriptionType,
} from "../../modules/subscription/types"
import { startDunningWorkflow } from "../start-dunning"
import { persistSubscriptionLogEvent } from "../steps/create-subscription-log-event"
import { toISOStringOrNull } from "./date-output"
import {
  type RenewalSessionSignal,
  signalNamesAttempt,
} from "./renewal-session-marker"
import { runUnderLock } from "./run-under-lock"
import type { RenewalSettlementAudit } from "./settle-renewal-cycle-succeeded"

const RUN_LOCK_WAIT_SECONDS = 5
const LOCK_HOLD_SECONDS = 120

const LOCK_WORTHY_STATUSES: readonly RenewalCycleStatus[] = [
  RenewalCycleStatus.AWAITING_PAYMENT,
  RenewalCycleStatus.PROCESSING,
]

const DUNNING_SUBSCRIPTION_STATUSES = new Set<SubscriptionStatus>([
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
])

export type FailAwaitingRenewalCycleInput = {
  renewal_cycle_id: string
  session_id: string | null
  attempt_id: string | null
  action: string
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

function readSettlementAudit(
  settlementInputs: Record<string, unknown> | null
): RenewalSettlementAudit | null {
  const audit = settlementInputs?.audit

  if (!audit || typeof audit !== "object") {
    return null
  }

  const candidate = audit as Partial<Record<keyof RenewalSettlementAudit, unknown>>

  if (
    typeof candidate.correlation_id !== "string" ||
    (candidate.trigger_type !== "scheduler" && candidate.trigger_type !== "manual") ||
    typeof candidate.attempt_no !== "number" ||
    typeof candidate.operation_started_at !== "number" ||
    typeof candidate.scheduled_for !== "string" ||
    !candidate.previous_state ||
    typeof candidate.previous_state !== "object"
  ) {
    return null
  }

  return audit as RenewalSettlementAudit
}

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

export async function failAwaitingRenewalCycle(
  container: MedusaContainer,
  input: FailAwaitingRenewalCycleInput
): Promise<void> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)

  const cycle = await loadCycle(renewalModule, input.renewal_cycle_id)

  if (!cycle || !LOCK_WORTHY_STATUSES.includes(cycle.status)) {
    return
  }

  await runUnderLock(
    container,
    `renewal:subscription:${cycle.subscription_id}`,
    () => failAwaitingRenewalCycleUnderLock(container, input),
    { wait_seconds: RUN_LOCK_WAIT_SECONDS, hold_seconds: LOCK_HOLD_SECONDS }
  )
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

  if (!cycle || !LOCK_WORTHY_STATUSES.includes(cycle.status)) {
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
  const audit = readSettlementAudit(cycle.settlement_inputs)
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
      ? audit.trigger_type === "manual"
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
        ? audit.trigger_type === "manual"
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

  if (DUNNING_SUBSCRIPTION_STATUSES.has(subscription.status)) {
    try {
      await startDunningWorkflow(container).run({
        input: {
          subscription_id: subscription.id,
          renewal_cycle_id: cycle.id,
          renewal_order_id: orderId,
          payment_failure_source: "payment_provider",
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
        event: "renewal.dunning",
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
      event: "renewal.dunning",
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
    event: "renewal.execution",
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
