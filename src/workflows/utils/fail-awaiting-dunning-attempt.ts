import type { MedusaContainer } from "@medusajs/framework/types"
import {
  type PaymentFailureAction,
  type PaymentFailureHandling,
  readReportedPaymentFailure,
  type RecordedPaymentFailureOutcome,
  toReportedPaymentFailure,
} from "../../common/types/reported-payment-failure"
import { DUNNING_MODULE } from "../../modules/dunning"
import { DunningEvents } from "../../modules/dunning/events"
import type DunningModuleService from "../../modules/dunning/service"
import {
  CHARGE_IN_FLIGHT_DUNNING_CASE_STATUSES,
  CLOSED_DUNNING_CASE_STATUSES,
  DunningAttemptStatus,
  type DunningCaseStatus,
} from "../../modules/dunning/types"
import {
  createDunningCorrelationId,
  DunningLogEvents,
  logDunningEvent,
} from "../../modules/dunning/utils/observability"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import type SubscriptionModuleService from "../../modules/subscription/service"
import { emitDunningEvent } from "../steps/emit-dunning-event"
import {
  classifyReportedPaymentFailure,
  loadDunningCase,
  isOrderPaid,
  type RunDunningRetryStepOutput,
  settleDeclinedRetryAttempt,
} from "../steps/run-dunning-retry"
import { tryUnderLock } from "./run-under-lock"
import { dunningCaseLockKey } from "../../modules/dunning/utils/lock-key"

const RUN_LOCK_WAIT_SECONDS = 5
const LOCK_HOLD_SECONDS = 120

export type FailAwaitingDunningAttemptInput = {
  session_id: string
  action: PaymentFailureAction
  reason: string | null
}

type RetryMarkers = {
  dunning_case_id: string
  dunning_attempt_id: string
}

async function loadCaseStatus(
  dunningModule: DunningModuleService,
  caseId: string
): Promise<DunningCaseStatus | null> {
  const [dunningCase] = await dunningModule.listDunningCases({ id: caseId })

  return dunningCase?.status ?? null
}

async function failAttemptOfClosedCaseUnderLock(
  container: MedusaContainer,
  input: FailAwaitingDunningAttemptInput & RetryMarkers
): Promise<boolean> {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const status = await loadCaseStatus(dunningModule, input.dunning_case_id)

  if (!status || !CLOSED_DUNNING_CASE_STATUSES.includes(status)) {
    return false
  }

  const [attempt] = await dunningModule.listDunningAttempts({
    id: input.dunning_attempt_id,
    dunning_case_id: input.dunning_case_id,
    status: DunningAttemptStatus.PROCESSING,
  })

  if (
    !attempt ||
    (attempt.payment_reference !== null && attempt.payment_reference !== input.session_id)
  ) {
    return false
  }

  const outcome = classifyReportedPaymentFailure({
    action: input.action,
    reason: input.reason,
    payment_reference: input.session_id,
  })
  const message = `${outcome.error_message} after its dunning case had closed`

  await dunningModule.updateDunningAttempts({
    id: attempt.id,
    status: DunningAttemptStatus.FAILED,
    finished_at: new Date(),
    error_code: outcome.error_code,
    error_message: message,
    payment_reference: input.session_id,
  })

  logDunningEvent(container.resolve("logger"), "info", {
    event: DunningLogEvents.LATE_PAYMENT_FAILURE,
    outcome: "failed",
    correlation_id: createDunningCorrelationId("dunning-late-payment-failure"),
    dunning_case_id: input.dunning_case_id,
    attempt_no: attempt.attempt_no,
    alertable: false,
    message,
    metadata: { attempt_id: attempt.id, payment_session_id: input.session_id },
  })

  return true
}

/**
 * When another holder keeps the lock for the whole wait, a failure report is recorded on the
 * attempt for the dunning sweep to apply: the bus would only redeliver it within seconds, and
 * nothing else keeps a failure.
 */
export async function failAwaitingDunningAttempt(
  container: MedusaContainer,
  input: FailAwaitingDunningAttemptInput & RetryMarkers
): Promise<PaymentFailureHandling> {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const status = await loadCaseStatus(dunningModule, input.dunning_case_id)

  if (
    !status ||
    (!CLOSED_DUNNING_CASE_STATUSES.includes(status) &&
      !CHARGE_IN_FLIGHT_DUNNING_CASE_STATUSES.includes(status))
  ) {
    return "ignored"
  }

  const run = await tryUnderLock(
    container,
    dunningCaseLockKey(input.dunning_case_id),
    () => applyDunningPaymentFailureUnderLock(container, input),
    { wait_seconds: RUN_LOCK_WAIT_SECONDS, hold_seconds: LOCK_HOLD_SECONDS }
  )

  if (run.acquired) {
    if (run.result.output) {
      await emitDunningAttemptOutcomeEvents(container, run.result.output)
    }

    return run.result.applied ? "applied" : "ignored"
  }

  if (!(await recordDunningPaymentFailure(container, input))) {
    throw run.error
  }

  return "recorded"
}

/**
 * Written without the lock, so it touches the one column nothing else writes but the sweep that
 * applies and clears it under the lock.
 */
async function recordDunningPaymentFailure(
  container: MedusaContainer,
  input: FailAwaitingDunningAttemptInput & RetryMarkers
): Promise<boolean> {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const [attempt] = await dunningModule.listDunningAttempts({
    id: input.dunning_attempt_id,
    dunning_case_id: input.dunning_case_id,
  })

  if (!attempt) {
    return false
  }

  await dunningModule.updateDunningAttempts({
    id: attempt.id,
    reported_payment_failure: toReportedPaymentFailure(input),
  })

  logDunningEvent(container.resolve("logger"), "info", {
    event: DunningLogEvents.PAYMENT_FAILURE_RECORDED,
    correlation_id: createDunningCorrelationId("dunning-payment-failure"),
    dunning_case_id: input.dunning_case_id,
    attempt_no: attempt.attempt_no,
    alertable: false,
    message: `The dunning case's lock stayed taken, so the '${input.action}' reported for payment session '${input.session_id}' was recorded on its attempt for the dunning sweep to apply`,
    metadata: { attempt_id: attempt.id, payment_session_id: input.session_id },
  })

  return true
}

export type DunningPaymentFailureApplication = {
  applied: boolean
  output: RunDunningRetryStepOutput | null
}

async function applyDunningPaymentFailureUnderLock(
  container: MedusaContainer,
  input: FailAwaitingDunningAttemptInput & RetryMarkers
): Promise<DunningPaymentFailureApplication> {
  if (await failAttemptOfClosedCaseUnderLock(container, input)) {
    return { applied: true, output: null }
  }

  const output = await failAwaitingDunningAttemptUnderLock(container, input)

  return { applied: output !== null, output }
}

export async function applyRecordedDunningPaymentFailureUnderLock(
  container: MedusaContainer,
  attemptId: string
): Promise<{
  outcome: RecordedPaymentFailureOutcome
  output: RunDunningRetryStepOutput | null
} | null> {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const [attempt] = await dunningModule.listDunningAttempts({ id: attemptId })
  const failure = readReportedPaymentFailure(attempt?.reported_payment_failure)

  if (!attempt || !failure) {
    return null
  }

  const [dunningCase] = await dunningModule.listDunningCases({ id: attempt.dunning_case_id })
  const orderPaid = await isOrderPaid(container, dunningCase?.renewal_order_id)
  const application = orderPaid
    ? { applied: false, output: null }
    : await applyDunningPaymentFailureUnderLock(container, {
        dunning_case_id: attempt.dunning_case_id,
        dunning_attempt_id: attempt.id,
        session_id: failure.session_id,
        action: failure.action,
        reason: failure.reason,
      })

  await dunningModule.updateDunningAttempts({
    id: attempt.id,
    reported_payment_failure: null,
  })

  return {
    outcome: application.applied ? "applied" : orderPaid ? "order_paid" : "stale",
    output: application.output,
  }
}

export type FailAwaitingDunningAttemptUnderLockInput = RetryMarkers & {
  session_id: string | null
  action: PaymentFailureAction
  reason: string | null
  message?: string
}

export async function failAwaitingDunningAttemptUnderLock(
  container: MedusaContainer,
  input: FailAwaitingDunningAttemptUnderLockInput
): Promise<RunDunningRetryStepOutput | null> {
  const startedAtMs = Date.now()
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

  const dunningCase = await loadDunningCase(container, input.dunning_case_id)

  if (!CHARGE_IN_FLIGHT_DUNNING_CASE_STATUSES.includes(dunningCase.status)) {
    return null
  }

  const attempts = await dunningModule.listDunningAttempts({
    dunning_case_id: dunningCase.id,
  })
  const latest = attempts.reduce<(typeof attempts)[number] | null>(
    (highest, attempt) =>
      !highest || attempt.attempt_no > highest.attempt_no ? attempt : highest,
    null
  )

  if (!latest || latest.id !== input.dunning_attempt_id) {
    return null
  }

  const onThisSession =
    input.session_id !== null && latest.payment_reference === input.session_id
  const inFlight =
    latest.status === DunningAttemptStatus.PROCESSING &&
    (onThisSession || latest.payment_reference === null)
  const halfFailed = latest.status === DunningAttemptStatus.FAILED && onThisSession

  if (!inFlight && !halfFailed) {
    return null
  }

  // Paid some other way meanwhile: the paid-case sweep recovers the case.
  if (await isOrderPaid(container, dunningCase.renewal_order_id)) {
    return null
  }

  const subscription = await subscriptionModule.retrieveSubscription(
    dunningCase.subscription_id
  )
  const correlationId = latest.metadata?.correlation_id
  const outcome = classifyReportedPaymentFailure({
    action: input.action,
    reason: input.reason,
    payment_reference: input.session_id,
  })

  return await settleDeclinedRetryAttempt(container, {
    dunningCase,
    subscription,
    attempt: latest,
    attemptNo: latest.attempt_no,
    consumedAttempts: dunningCase.attempt_count,
    outcome: input.message ? { ...outcome, error_message: input.message } : outcome,
    caseMetadata: dunningCase.metadata ?? {},
    finishedAt: new Date(),
    correlationId:
      typeof correlationId === "string"
        ? correlationId
        : createDunningCorrelationId("dunning-payment-failure"),
    startedAtMs,
    markCaseParked: () => {},
  })
}

export async function emitDunningAttemptOutcomeEvents(
  container: MedusaContainer,
  output: RunDunningRetryStepOutput
) {
  if (output.outcome === "retry_scheduled" && output.attempt_counted) {
    await emitDunningEvent(container, {
      eventName: DunningEvents.ATTEMPT_FAILED,
      data: {
        subscription_id: output.subscription_id,
        dunning_case_id: output.dunning_case_id,
        attempt_no: output.attempt_no,
        error_code: output.error_code,
        next_retry_at: output.next_retry_at,
      },
    })
  }

  if (output.outcome === "unrecovered" && output.settled_now) {
    await emitDunningEvent(container, {
      eventName: DunningEvents.PAYMENT_FAILED,
      data: {
        subscription_id: output.subscription_id,
        dunning_case_id: output.dunning_case_id,
        recovery_reason: output.recovery_reason,
      },
    })
  }

  if (output.outcome === "awaiting_manual_resolution") {
    await emitDunningEvent(container, {
      eventName: DunningEvents.PARKED,
      data: {
        subscription_id: output.subscription_id,
        dunning_case_id: output.dunning_case_id,
        attempt_no: output.attempt_no,
        park_reason: output.park_reason,
        error_code: output.error_code,
      },
    })
  }
}
