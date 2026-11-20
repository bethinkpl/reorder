import { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { PaymentAttemptErrorCode } from "../common/types/payment-attempt-error-code"
import { isLockBusyError } from "../common/utils/lock-busy-error"
import { DUNNING_MODULE } from "../modules/dunning"
import { DunningEvents } from "../modules/dunning/events"
import type DunningModuleService from "../modules/dunning/service"
import {
  ACTIVE_DUNNING_CASE_STATUSES,
  CLOSED_DUNNING_CASE_STATUSES,
  DunningAttemptStatus,
  DunningCaseStatus,
  DunningRecoveryReason,
} from "../modules/dunning/types"
import {
  createDunningCorrelationId,
  DunningLogEvents,
  getDunningErrorMessage,
  logDunningEvent,
} from "../modules/dunning/utils/observability"
import {
  isAwaitingPaymentOverdue,
  isOverdueAlertDue,
  resolveAwaitingPaymentAlertHours,
  resolveAwaitingPaymentResolveMinHours,
  withOverdueAlertMarker,
} from "../modules/renewal/utils/awaiting-payment-age"
import { renewalSubscriptionLockKey } from "../modules/renewal/utils/lock-key"
import { SUBSCRIPTION_MODULE } from "../modules/subscription"
import type SubscriptionModuleService from "../modules/subscription/service"
import { SubscriptionStatus } from "../modules/subscription/types"
import { activateSubscriptionOnPaymentCaptured } from "../subscribers/activate-subscription-on-payment-captured"
import { recoverDunningFromCapturedPaymentWorkflow } from "../workflows/recover-dunning-from-captured-payment"
import { emitDunningEvent } from "../workflows/steps/emit-dunning-event"
import {
  type DunningParkReason,
  loadOrderAmounts,
} from "../workflows/steps/run-dunning-retry"
import {
  applyRecordedDunningPaymentFailureUnderLock,
  emitDunningAttemptOutcomeEvents,
} from "../workflows/utils/fail-awaiting-dunning-attempt"
import { closeDunningCasesOnCancellation } from "../workflows/utils/close-dunning-cases-on-cancellation"
import { findCapturedPaymentId } from "../workflows/utils/late-payment-capture"
import { tryUnderLock } from "../workflows/utils/run-under-lock"
import { dunningCaseLockKey } from "../modules/dunning/utils/lock-key"

const JOB_NAME = "reconcile-paid-dunning-cases"
const JOB_LOCK_KEY = "jobs:reconcile-paid-dunning-cases"
const BATCH_SIZE = 200
const ALERT_LOCK_TIMEOUT_SECONDS = 5
const CASE_LOCK_HOLD_SECONDS = 120
/** Well past the 120 s a retry run holds its case's lock, so a run still in progress is never touched. */
const STALE_RETRY_MINUTES = 10

/** A running retry finds the paid order itself. */
const IDLE_DUNNING_CASE_STATUSES = ACTIVE_DUNNING_CASE_STATUSES.filter(
  (status) => status !== DunningCaseStatus.RETRYING
)

type DunningCaseRecord = {
  id: string
  subscription_id: string
  status: DunningCaseStatus
  renewal_order_id: string | null
}

type OverdueAlertInput = {
  now: Date
  alertHours: number
  correlationId: string
}

export type ReconcilePaidDunningCasesResult = {
  scanned: number
  recovered: number
  unpaid: number
  failed: number
  ended_cancelled: number
  late_captures: number
  stale_attempts_closed: number
  recorded_failures_applied: number
  stale_retries_reparked: number
  stale_retries_parked: number
}

async function findDueOverdueAlert(
  dunningModule: DunningModuleService,
  caseId: string,
  input: OverdueAlertInput
) {
  const dunningCase = await dunningModule.retrieveDunningCase(caseId)

  if (dunningCase.status !== DunningCaseStatus.AWAITING_PAYMENT) {
    return null
  }

  const [latest] = await dunningModule.listDunningAttempts(
    { dunning_case_id: dunningCase.id },
    { order: { attempt_no: "DESC" }, take: 1 }
  )
  const alertKey = latest?.id ?? dunningCase.id
  const submittedAt = latest?.started_at ?? dunningCase.updated_at

  if (
    !isOverdueAlertDue({
      metadata: dunningCase.metadata,
      alert_key: alertKey,
      submitted_at: submittedAt,
      now: input.now,
      limit_hours: input.alertHours,
    })
  ) {
    return null
  }

  return {
    dunningCase,
    alertKey,
    submittedAt: new Date(submittedAt).toISOString(),
    paymentSessionId: latest?.payment_reference ?? null,
  }
}

async function raiseOverdueAlertOnce(
  container: MedusaContainer,
  caseId: string,
  input: OverdueAlertInput
): Promise<boolean> {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)

  try {
    return await container.resolve(Modules.LOCKING).execute(
      dunningCaseLockKey(caseId),
      async () => {
        const due = await findDueOverdueAlert(dunningModule, caseId, input)

        if (!due) {
          return false
        }

        await dunningModule.updateDunningCases({
          id: caseId,
          metadata: withOverdueAlertMarker(due.dunningCase.metadata, due.alertKey),
        })

        logDunningEvent(container.resolve("logger"), "warn", {
          event: DunningLogEvents.AWAITING_PAYMENT_OVERDUE,
          outcome: "awaiting_payment",
          correlation_id: input.correlationId,
          dunning_case_id: caseId,
          subscription_id: due.dunningCase.subscription_id,
          renewal_cycle_id: due.dunningCase.renewal_cycle_id,
          job_name: JOB_NAME,
          alertable: true,
          message: `DunningCase '${caseId}' has awaited the payment of its retry for more than ${input.alertHours} hours`,
          metadata: {
            submitted_at: due.submittedAt,
            alert_hours: input.alertHours,
            payment_session_id: due.paymentSessionId,
          },
        })

        return true
      },
      { timeout: ALERT_LOCK_TIMEOUT_SECONDS }
    )
  } catch (error) {
    if (isLockBusyError(error)) {
      return false
    }

    throw error
  }
}

function reportCaseFailure(
  container: MedusaContainer,
  dunningCase: Pick<DunningCaseRecord, "id" | "renewal_order_id">,
  error: unknown
) {
  container.resolve("logger").error(
    JSON.stringify({
      domain: "subscriptions",
      event: `${JOB_NAME}.case_failed`,
      job_name: JOB_NAME,
      dunning_case_id: dunningCase.id,
      renewal_order_id: dunningCase.renewal_order_id,
      alertable: true,
      message: getDunningErrorMessage(error),
    })
  )
}

async function alertOverdueAwaitingCases(
  container: MedusaContainer,
  input: OverdueAlertInput,
  result: ReconcilePaidDunningCasesResult
): Promise<void> {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  let cursor: string | null = null

  while (true) {
    const cases = (await dunningModule.listDunningCases(
      {
        status: DunningCaseStatus.AWAITING_PAYMENT,
        ...(cursor ? { id: { $gt: cursor } } : {}),
      },
      { select: ["id", "renewal_order_id"], take: BATCH_SIZE, order: { id: "ASC" } }
    )) as DunningCaseRecord[]

    for (const dunningCase of cases) {
      if (!dunningCase.renewal_order_id) {
        continue
      }

      try {
        if (!(await findDueOverdueAlert(dunningModule, dunningCase.id, input))) {
          continue
        }

        const { pending } = await loadOrderAmounts(
          container,
          dunningCase.renewal_order_id
        )

        if (pending > 0) {
          await raiseOverdueAlertOnce(container, dunningCase.id, input)
        }
      } catch (error) {
        result.failed += 1
        reportCaseFailure(container, dunningCase, error)
      }
    }

    if (cases.length < BATCH_SIZE) {
      return
    }

    cursor = cases[cases.length - 1].id
  }
}

async function failStaleAttemptUnderLock(
  container: MedusaContainer,
  attemptId: string,
  input: OverdueAlertInput & { minHours: number }
): Promise<boolean> {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const [attempt] = await dunningModule.listDunningAttempts({
    id: attemptId,
    status: DunningAttemptStatus.PROCESSING,
  })
  const [dunningCase] = attempt
    ? await dunningModule.listDunningCases({ id: attempt.dunning_case_id })
    : []

  if (!attempt || !dunningCase || !CLOSED_DUNNING_CASE_STATUSES.includes(dunningCase.status)) {
    return false
  }

  const message = `No payment result arrived for this retry within ${input.minHours} hours of its submission, after its dunning case had closed`

  await dunningModule.updateDunningAttempts({
    id: attempt.id,
    status: DunningAttemptStatus.FAILED,
    finished_at: input.now,
    error_code: PaymentAttemptErrorCode.NO_PAYMENT_SIGNAL,
    error_message: message,
  })

  logDunningEvent(container.resolve("logger"), "warn", {
    event: DunningLogEvents.STALE_ATTEMPT_CLOSED,
    outcome: "failed",
    correlation_id: input.correlationId,
    dunning_case_id: dunningCase.id,
    subscription_id: dunningCase.subscription_id,
    attempt_no: attempt.attempt_no,
    job_name: JOB_NAME,
    alertable: false,
    message,
    metadata: { attempt_id: attempt.id, payment_session_id: attempt.payment_reference },
  })

  return true
}

async function underCaseLock<T>(
  container: MedusaContainer,
  caseId: string,
  job: () => Promise<T | null>
): Promise<T | null> {
  const run = await tryUnderLock(container, dunningCaseLockKey(caseId), job, {
    wait_seconds: ALERT_LOCK_TIMEOUT_SECONDS,
    hold_seconds: CASE_LOCK_HOLD_SECONDS,
  })

  return run.acquired ? run.result : null
}

/**
 * A case left open on a cancelled subscription is closed as the cancellation closes it, so its
 * charge, if any arrived, is reported for a refund by the closed-case pass instead of recovering
 * the case. Null when the subscription is not cancelled.
 */
async function closeCaseOfCancelledSubscription(
  container: MedusaContainer,
  dunningCase: Pick<DunningCaseRecord, "id" | "subscription_id">
): Promise<boolean | null> {
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
  const isCancelled = async () =>
    (await subscriptionModule.retrieveSubscription(dunningCase.subscription_id)).status ===
    SubscriptionStatus.CANCELLED

  if (!(await isCancelled())) {
    return null
  }

  const run = await tryUnderLock(
    container,
    renewalSubscriptionLockKey(dunningCase.subscription_id),
    async () => {
      if (!(await isCancelled())) {
        return false
      }

      const closed = await closeDunningCasesOnCancellation(container, {
        subscription_id: dunningCase.subscription_id,
        recovery_reason: DunningRecoveryReason.SUBSCRIPTION_NOT_RETRYABLE,
      })

      return closed.some(({ id }) => id === dunningCase.id)
    },
    { wait_seconds: ALERT_LOCK_TIMEOUT_SECONDS, hold_seconds: CASE_LOCK_HOLD_SECONDS }
  )

  return run.acquired && run.result
}

type StaleRetryOutcome =
  | { kind: "reparked" }
  | {
    kind: "parked"
    subscription_id: string
    attempt_no: number
    park_reason: DunningParkReason
    error_code: string | null
  }

function isStaleRetry(startedAt: Date | string, now: Date) {
  return now.getTime() - new Date(startedAt).getTime() >= STALE_RETRY_MINUTES * 60 * 1000
}

async function findLatestAttempt(dunningModule: DunningModuleService, caseId: string) {
  const [latest] = await dunningModule.listDunningAttempts(
    { dunning_case_id: caseId },
    { order: { attempt_no: "DESC" }, take: 1 }
  )

  return latest ?? null
}

async function settleStaleRetryUnderLock(
  container: MedusaContainer,
  caseId: string,
  input: OverdueAlertInput
): Promise<StaleRetryOutcome | null> {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const dunningCase = await dunningModule.retrieveDunningCase(caseId)

  if (dunningCase.status !== DunningCaseStatus.RETRYING) {
    return null
  }

  const latest = await findLatestAttempt(dunningModule, caseId)

  if (!isStaleRetry(latest?.started_at ?? dunningCase.updated_at, input.now)) {
    return null
  }

  const logger = container.resolve("logger")

  if (latest?.status === DunningAttemptStatus.PROCESSING && latest.payment_reference) {
    await dunningModule.updateDunningCases({
      id: caseId,
      status: DunningCaseStatus.AWAITING_PAYMENT,
      next_retry_at: null,
    })

    logDunningEvent(logger, "warn", {
      event: DunningLogEvents.STALE_RETRY,
      outcome: "awaiting_payment",
      correlation_id: input.correlationId,
      dunning_case_id: caseId,
      subscription_id: dunningCase.subscription_id,
      renewal_cycle_id: dunningCase.renewal_cycle_id,
      attempt_no: latest.attempt_no,
      job_name: JOB_NAME,
      alertable: false,
      message: `DunningCase '${caseId}' was left retrying with its charge submitted on payment session '${latest.payment_reference}'; it now awaits that payment`,
      metadata: { attempt_id: latest.id, payment_session_id: latest.payment_reference },
    })

    return { kind: "reparked" }
  }

  // Nothing tells whether this retry reached the provider, so another charge could take the money
  // twice: only an operator may decide.
  const parkReason: DunningParkReason = "indeterminate_provider_response"
  const attemptNo = latest?.attempt_no ?? dunningCase.attempt_count

  await dunningModule.updateDunningCases({
    id: caseId,
    status: DunningCaseStatus.AWAITING_MANUAL_RESOLUTION,
    next_retry_at: null,
    metadata: { ...(dunningCase.metadata ?? {}), park_reason: parkReason },
  })

  logDunningEvent(logger, "error", {
    event: DunningLogEvents.STALE_RETRY,
    outcome: "failed",
    correlation_id: input.correlationId,
    dunning_case_id: caseId,
    subscription_id: dunningCase.subscription_id,
    renewal_cycle_id: dunningCase.renewal_cycle_id,
    attempt_no: attemptNo,
    job_name: JOB_NAME,
    alertable: true,
    message: latest
      ? `DunningCase '${caseId}' was left retrying with its attempt '${latest.id}' ${latest.status} and no submitted charge to wait on; it awaits manual resolution`
      : `DunningCase '${caseId}' was left retrying without an attempt; it awaits manual resolution`,
    metadata: {
      retry_outcome: "awaiting_manual_resolution",
      park_reason: parkReason,
      attempt_id: latest?.id ?? null,
    },
  })

  return {
    kind: "parked",
    subscription_id: dunningCase.subscription_id,
    attempt_no: attemptNo,
    park_reason: parkReason,
    error_code: latest?.error_code ?? null,
  }
}

async function settleStaleRetries(
  container: MedusaContainer,
  input: OverdueAlertInput,
  result: ReconcilePaidDunningCasesResult
): Promise<void> {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  let cursor: string | null = null

  while (true) {
    const cases = (await dunningModule.listDunningCases(
      {
        status: DunningCaseStatus.RETRYING,
        ...(cursor ? { id: { $gt: cursor } } : {}),
      },
      {
        select: ["id", "renewal_order_id", "updated_at"],
        take: BATCH_SIZE,
        order: { id: "ASC" },
      }
    )) as (DunningCaseRecord & { updated_at: Date })[]

    for (const dunningCase of cases) {
      try {
        const latest = await findLatestAttempt(dunningModule, dunningCase.id)

        if (!isStaleRetry(latest?.started_at ?? dunningCase.updated_at, input.now)) {
          continue
        }

        const outcome = await underCaseLock(
          container,
          dunningCase.id,
          () => settleStaleRetryUnderLock(container, dunningCase.id, input)
        )

        if (outcome?.kind === "reparked") {
          result.stale_retries_reparked += 1
        }

        if (outcome?.kind === "parked") {
          result.stale_retries_parked += 1

          await emitDunningEvent(container, {
            eventName: DunningEvents.PARKED,
            data: {
              subscription_id: outcome.subscription_id,
              dunning_case_id: dunningCase.id,
              attempt_no: outcome.attempt_no,
              park_reason: outcome.park_reason,
              error_code: outcome.error_code,
            },
          })
        }
      } catch (error) {
        result.failed += 1
        reportCaseFailure(container, dunningCase, error)
      }
    }

    if (cases.length < BATCH_SIZE) {
      return
    }

    cursor = cases[cases.length - 1].id
  }
}

async function applyRecordedPaymentFailures(
  container: MedusaContainer,
  input: OverdueAlertInput,
  result: ReconcilePaidDunningCasesResult
): Promise<void> {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  let cursor: string | null = null

  while (true) {
    const attempts = await dunningModule.listDunningAttempts(
      {
        reported_payment_failure: { $ne: null },
        ...(cursor ? { id: { $gt: cursor } } : {}),
      } as never,
      { select: ["id", "dunning_case_id"], take: BATCH_SIZE, order: { id: "ASC" } }
    )

    for (const attempt of attempts) {
      try {
        const applied = await underCaseLock(
          container,
          attempt.dunning_case_id,
          () => applyRecordedDunningPaymentFailureUnderLock(container, attempt.id)
        )

        if (!applied) {
          continue
        }

        if (applied.output) {
          await emitDunningAttemptOutcomeEvents(container, applied.output)
        }

        if (applied.outcome === "applied") {
          result.recorded_failures_applied += 1
        }

        logDunningEvent(container.resolve("logger"), "info", {
          event: DunningLogEvents.RECORDED_PAYMENT_FAILURE,
          correlation_id: input.correlationId,
          dunning_case_id: attempt.dunning_case_id,
          job_name: JOB_NAME,
          alertable: false,
          message:
            applied.outcome === "applied"
              ? `Applied the payment failure recorded on attempt '${attempt.id}' while its case's lock was busy`
              : applied.outcome === "order_paid"
                ? `Dropped the payment failure recorded on attempt '${attempt.id}': its renewal order has been paid since`
                : `Dropped the payment failure recorded on attempt '${attempt.id}': nothing it names is still in flight`,
          metadata: { attempt_id: attempt.id },
        })
      } catch (error) {
        result.failed += 1
        reportCaseFailure(
          container,
          { id: attempt.dunning_case_id, renewal_order_id: null },
          error
        )
      }
    }

    if (attempts.length < BATCH_SIZE) {
      return
    }

    cursor = attempts[attempts.length - 1].id
  }
}

async function reconcileAttemptsOfClosedCases(
  container: MedusaContainer,
  input: OverdueAlertInput,
  result: ReconcilePaidDunningCasesResult
): Promise<void> {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const minHours = resolveAwaitingPaymentResolveMinHours()
  let cursor: string | null = null

  while (true) {
    const attempts = await dunningModule.listDunningAttempts(
      {
        status: DunningAttemptStatus.PROCESSING,
        ...(cursor ? { id: { $gt: cursor } } : {}),
      },
      { take: BATCH_SIZE, order: { id: "ASC" } }
    )
    const cases = attempts.length
      ? await dunningModule.listDunningCases({
          id: attempts.map((attempt) => attempt.dunning_case_id),
        })
      : []
    const casesById = new Map(cases.map((dunningCase) => [dunningCase.id, dunningCase]))

    for (const attempt of attempts) {
      const dunningCase = casesById.get(attempt.dunning_case_id)

      if (!dunningCase || !CLOSED_DUNNING_CASE_STATUSES.includes(dunningCase.status)) {
        continue
      }

      try {
        const capturedPaymentId = attempt.payment_reference
          ? await findCapturedPaymentId(container, attempt.payment_reference)
          : null

        if (capturedPaymentId) {
          await activateSubscriptionOnPaymentCaptured(container, capturedPaymentId)

          const [redelivered] = await dunningModule.listDunningAttempts({ id: attempt.id })

          if (redelivered?.status === DunningAttemptStatus.PROCESSING) {
            throw new Error(
              `Captured payment '${capturedPaymentId}' of attempt '${attempt.id}' was delivered again, but the attempt is still processing`
            )
          }

          result.late_captures += 1

          continue
        }

        if (!isAwaitingPaymentOverdue(attempt.started_at, input.now, minHours)) {
          continue
        }

        const closed = await container.resolve(Modules.LOCKING).execute(
          dunningCaseLockKey(dunningCase.id),
          () => failStaleAttemptUnderLock(container, attempt.id, { ...input, minHours }),
          { timeout: ALERT_LOCK_TIMEOUT_SECONDS }
        )

        if (closed) {
          result.stale_attempts_closed += 1
        }
      } catch (error) {
        if (isLockBusyError(error)) {
          continue
        }

        result.failed += 1
        reportCaseFailure(container, dunningCase, error)
      }
    }

    if (attempts.length < BATCH_SIZE) {
      return
    }

    cursor = attempts[attempts.length - 1].id
  }
}

/**
 * Closes dunning cases whose renewal order is already paid in full.
 *
 * The `payment.captured` subscriber is the fast path, but a subscriber that throws is logged and
 * dropped by both event buses, and a capture recorded by a provider webhook alone never reaches
 * one. Without this sweep such a case keeps retrying a card for money that has already arrived.
 *
 * Exported for unit tests: the scheduled entry point only adds the job lock around it.
 */
export async function reconcilePaidDunningCases(
  container: MedusaContainer
): Promise<ReconcilePaidDunningCasesResult> {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const alertInput: OverdueAlertInput = {
    now: new Date(Date.now()),
    alertHours: resolveAwaitingPaymentAlertHours(),
    correlationId: createDunningCorrelationId(JOB_NAME),
  }
  const result: ReconcilePaidDunningCasesResult = {
    scanned: 0,
    recovered: 0,
    unpaid: 0,
    failed: 0,
    ended_cancelled: 0,
    late_captures: 0,
    stale_attempts_closed: 0,
    recorded_failures_applied: 0,
    stale_retries_reparked: 0,
    stale_retries_parked: 0,
  }

  await applyRecordedPaymentFailures(container, alertInput, result)
  await settleStaleRetries(container, alertInput, result)

  const cases = (await dunningModule.listDunningCases(
    { status: IDLE_DUNNING_CASE_STATUSES } as never,
    { take: BATCH_SIZE, order: { updated_at: "ASC" } }
  )) as DunningCaseRecord[]

  result.scanned = cases.length

  for (const dunningCase of cases) {
    try {
      const endedCancelled = await closeCaseOfCancelledSubscription(container, dunningCase)

      if (endedCancelled !== null) {
        result.ended_cancelled += endedCancelled ? 1 : 0

        continue
      }

      if (!dunningCase.renewal_order_id) {
        continue
      }

      const { pending } = await loadOrderAmounts(
        container,
        dunningCase.renewal_order_id
      )

      if (pending > 0) {
        result.unpaid += 1

        continue
      }

      await recoverDunningFromCapturedPaymentWorkflow(container).run({
        input: { dunning_case_id: dunningCase.id, payment_id: null },
      })

      result.recovered += 1
    } catch (error) {
      result.failed += 1
      reportCaseFailure(container, dunningCase, error)
    }
  }

  await alertOverdueAwaitingCases(container, alertInput, result)
  await reconcileAttemptsOfClosedCases(container, alertInput, result)

  return result
}

export default async function reconcilePaidDunningCasesJob(
  container: MedusaContainer
) {
  const logger = container.resolve("logger")
  const locking = container.resolve(Modules.LOCKING)
  const startedAt = Date.now()

  try {
    await locking.execute(
      JOB_LOCK_KEY,
      async () => {
        const result = await reconcilePaidDunningCases(container)

        logger.info(
          `[${JOB_NAME}] scanned ${result.scanned} open dunning case(s), recovered ${result.recovered}, still unpaid ${result.unpaid}, closed for a cancelled subscription ${result.ended_cancelled}, late captures redelivered ${result.late_captures}, stale attempts closed ${result.stale_attempts_closed}, recorded payment failures applied ${result.recorded_failures_applied}, stale retries now awaiting their payment ${result.stale_retries_reparked}, stale retries parked ${result.stale_retries_parked}, failed ${result.failed} (batch ${BATCH_SIZE}) in ${Date.now() - startedAt}ms`
        )
      },
      {
        timeout: 1,
      }
    )
  } catch (error) {
    const message = getDunningErrorMessage(error)

    if (isLockBusyError(error)) {
      logger.warn(`[${JOB_NAME}] did not complete: ${message}`)
    } else {
      logger.error(`[${JOB_NAME}] did not complete: ${message}`)
    }
  }
}

export const config = {
  name: JOB_NAME,
  schedule: "*/30 * * * *",
}
