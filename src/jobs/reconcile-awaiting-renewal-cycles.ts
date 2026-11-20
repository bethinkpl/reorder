import type { MedusaContainer } from "@medusajs/framework/types"
import { PaymentAttemptErrorCode } from "../common/types/payment-attempt-error-code"
import { ActivityLogActorType } from "../modules/activity-log/types"
import { RENEWAL_MODULE } from "../modules/renewal"
import type RenewalModuleService from "../modules/renewal/service"
import {
  type ChargeInFlightRenewalCycleStatus,
  CLOSED_RENEWAL_CYCLE_STATUSES,
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../modules/renewal/types"
import {
  isAwaitingPaymentOverdue,
  isOverdueAlertDue,
  resolveAwaitingPaymentAlertHours,
  resolveAwaitingPaymentResolveMinHours,
  withOverdueAlertMarker,
} from "../modules/renewal/utils/awaiting-payment-age"
import {
  createRenewalCorrelationId,
  getRenewalErrorMessage,
  logRenewalEvent,
  RenewalLogEvents,
} from "../modules/renewal/utils/observability"
import { SUBSCRIPTION_MODULE } from "../modules/subscription"
import type SubscriptionModuleService from "../modules/subscription/service"
import { SubscriptionStatus } from "../modules/subscription/types"
import { activateSubscriptionOnPaymentCaptured } from "../subscribers/activate-subscription-on-payment-captured"
import { loadOrderAmounts } from "../workflows/steps/run-dunning-retry"
import { endAwaitingRenewalCyclesOnCancellation } from "../workflows/utils/end-awaiting-renewal-cycle-on-cancellation"
import { runUnderLock, tryUnderLock } from "../workflows/utils/run-under-lock"
import { applyRecordedRenewalPaymentFailureUnderLock } from "../workflows/utils/fail-awaiting-renewal-cycle"
import { findCapturedPaymentId } from "../workflows/utils/late-payment-capture"
import { isLockBusyError } from "../common/utils/lock-busy-error"
import {
  settleAwaitingRenewalCycle,
  settleAwaitingRenewalCycleUnderLock,
  type SettleAwaitingRenewalCycleOutcome,
} from "../workflows/utils/settle-awaiting-renewal-cycle"
import { renewalSubscriptionLockKey } from "../modules/renewal/utils/lock-key"

const JOB_NAME = "reconcile-awaiting-renewal-cycles"
const JOB_LOCK_KEY = "jobs:reconcile-awaiting-renewal-cycles"
/**
 * The lock is not renewed while held, so it lasts as long as a sweep realistically can, and expires
 * before the next scheduled run: a crashed run skips at most one tick, and a sweep that overruns it
 * only overlaps the next one, whose writes the per-cycle and per-case locks still serialise.
 */
const JOB_LOCK = { wait_seconds: 1, hold_seconds: 25 * 60 }
const BATCH_SIZE = 200
const ALERT_LOCK_TIMEOUT_SECONDS = 5
const RENEWAL_LOCK_TIMEOUT_SECONDS = 5
const RENEWAL_LOCK_HOLD_SECONDS = 120
/** Well past the 120 s a renewal run holds its lock, so a run still in progress is never touched. */
const STALE_PROCESSING_MINUTES = 10

type OverdueAlertInput = {
  now: Date
  alertHours: number
  correlationId: string
}

export type ReconcileAwaitingRenewalCyclesResult = Record<
  | SettleAwaitingRenewalCycleOutcome
  | "scanned"
  | "failed"
  | "overdue"
  | "processing_overdue"
  | "ended_cancelled"
  | "late_captures"
  | "stale_attempts_closed"
  | "recorded_failures_applied"
  | "processing_settled",
  number
>

async function findDueOverdueAlert(
  renewalModule: RenewalModuleService,
  cycleId: string,
  status: ChargeInFlightRenewalCycleStatus,
  input: OverdueAlertInput
) {
  const cycle = await renewalModule.retrieveRenewalCycle(cycleId)

  if (cycle.status !== status) {
    return null
  }

  const [latest] = await renewalModule.listRenewalAttempts(
    { renewal_cycle_id: cycle.id },
    { order: { attempt_no: "DESC" }, take: 1 }
  )
  const alertKey = latest?.id ?? cycle.id
  const submittedAt = latest?.started_at ?? cycle.updated_at

  if (
    !isOverdueAlertDue({
      metadata: cycle.metadata,
      alert_key: alertKey,
      submitted_at: submittedAt,
      now: input.now,
      limit_hours: input.alertHours,
    })
  ) {
    return null
  }

  return {
    cycle,
    alertKey,
    submittedAt: new Date(submittedAt).toISOString(),
    paymentSessionId: latest?.payment_reference ?? null,
  }
}

async function raiseOverdueAlertOnce(
  container: MedusaContainer,
  cycle: { id: string, subscription_id: string },
  status: ChargeInFlightRenewalCycleStatus,
  input: OverdueAlertInput
): Promise<boolean> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)

  if (!(await findDueOverdueAlert(renewalModule, cycle.id, status, input))) {
    return false
  }

  const run = await tryUnderLock(
    container,
    renewalSubscriptionLockKey(cycle.subscription_id),
    async () => {
      const due = await findDueOverdueAlert(renewalModule, cycle.id, status, input)

      if (!due) {
        return false
      }

      await renewalModule.updateRenewalCycles({
        id: cycle.id,
        metadata: withOverdueAlertMarker(due.cycle.metadata, due.alertKey),
      })

      logRenewalEvent(container.resolve("logger"), "warn", {
        event: RenewalLogEvents.AWAITING_PAYMENT_OVERDUE,
        outcome: "awaiting_payment",
        correlation_id: input.correlationId,
        renewal_cycle_id: cycle.id,
        subscription_id: cycle.subscription_id,
        job_name: JOB_NAME,
        alertable: true,
        message:
          status === RenewalCycleStatus.AWAITING_PAYMENT
            ? `RenewalCycle '${cycle.id}' has awaited its payment for more than ${input.alertHours} hours`
            : `RenewalCycle '${cycle.id}' has been processing for more than ${input.alertHours} hours${due.paymentSessionId ? ` with a charge submitted on payment session '${due.paymentSessionId}'` : ""}`,
        metadata: {
          submitted_at: due.submittedAt,
          alert_hours: input.alertHours,
          payment_session_id: due.paymentSessionId,
        },
      })

      return true
    },
    { wait_seconds: ALERT_LOCK_TIMEOUT_SECONDS, hold_seconds: RENEWAL_LOCK_HOLD_SECONDS }
  )

  return run.acquired && run.result
}

function reportCycleFailure(
  container: MedusaContainer,
  cycleId: string,
  error: unknown
) {
  container.resolve("logger").error(
    JSON.stringify({
      domain: "subscriptions",
      event: `${JOB_NAME}.cycle_failed`,
      job_name: JOB_NAME,
      renewal_cycle_id: cycleId,
      alertable: true,
      message: getRenewalErrorMessage(error),
    })
  )
}

async function underRenewalLock<T>(
  container: MedusaContainer,
  subscriptionId: string,
  job: () => Promise<T>,
  whenBusy: T
): Promise<T> {
  const run = await tryUnderLock(container, renewalSubscriptionLockKey(subscriptionId), job, {
    wait_seconds: RENEWAL_LOCK_TIMEOUT_SECONDS,
    hold_seconds: RENEWAL_LOCK_HOLD_SECONDS,
  })

  return run.acquired ? run.result : whenBusy
}

async function endCycleOfCancelledSubscription(
  container: MedusaContainer,
  cycle: { id: string, subscription_id: string }
): Promise<boolean> {
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
  const isCancelled = async () =>
    (await subscriptionModule.retrieveSubscription(cycle.subscription_id)).status ===
    SubscriptionStatus.CANCELLED

  if (!(await isCancelled())) {
    return false
  }

  return await underRenewalLock(
    container,
    cycle.subscription_id,
    async () => {
      if (!(await isCancelled())) {
        return false
      }

      const ended = await endAwaitingRenewalCyclesOnCancellation(container, {
        subscription: await subscriptionModule.retrieveSubscription(cycle.subscription_id),
        cancelled_at: new Date(),
        actor_id: null,
        actor_type: ActivityLogActorType.SYSTEM,
        reason: null,
        source: "scheduler",
      })

      return ended.some((entry) => entry.cycle.id === cycle.id)
    },
    false
  )
}

async function failStaleAttemptUnderLock(
  container: MedusaContainer,
  attemptId: string,
  input: OverdueAlertInput & { minHours: number }
): Promise<boolean> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const [attempt] = await renewalModule.listRenewalAttempts({
    id: attemptId,
    status: RenewalAttemptStatus.PROCESSING,
  })
  const [cycle] = attempt
    ? await renewalModule.listRenewalCycles({ id: attempt.renewal_cycle_id })
    : []

  if (!attempt || !cycle || !CLOSED_RENEWAL_CYCLE_STATUSES.includes(cycle.status)) {
    return false
  }

  const message = `No payment result arrived for this attempt within ${input.minHours} hours of its submission, after its renewal had closed`

  await renewalModule.updateRenewalAttempts({
    id: attempt.id,
    status: RenewalAttemptStatus.FAILED,
    finished_at: input.now,
    error_code: PaymentAttemptErrorCode.NO_PAYMENT_SIGNAL,
    error_message: message,
  })

  logRenewalEvent(container.resolve("logger"), "warn", {
    event: RenewalLogEvents.STALE_ATTEMPT_CLOSED,
    outcome: "failed",
    correlation_id: input.correlationId,
    renewal_cycle_id: cycle.id,
    subscription_id: cycle.subscription_id,
    job_name: JOB_NAME,
    alertable: false,
    message,
    metadata: { attempt_id: attempt.id, payment_session_id: attempt.payment_reference },
  })

  return true
}

async function assertAttemptClosed(
  renewalModule: RenewalModuleService,
  attemptId: string,
  paymentId: string
) {
  const [attempt] = await renewalModule.listRenewalAttempts({ id: attemptId })

  if (attempt?.status === RenewalAttemptStatus.PROCESSING) {
    throw new Error(
      `Captured payment '${paymentId}' of attempt '${attemptId}' was delivered again, but the attempt is still processing`
    )
  }
}

async function applyRecordedPaymentFailures(
  container: MedusaContainer,
  input: OverdueAlertInput,
  result: ReconcileAwaitingRenewalCyclesResult
): Promise<void> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  let cursor: string | null = null

  while (true) {
    const attempts = await renewalModule.listRenewalAttempts(
      {
        reported_payment_failure: { $ne: null },
        ...(cursor ? { id: { $gt: cursor } } : {}),
      } as never,
      { select: ["id", "renewal_cycle_id"], take: BATCH_SIZE, order: { id: "ASC" } }
    )
    const cycles = attempts.length
      ? await renewalModule.listRenewalCycles(
          { id: attempts.map((attempt) => attempt.renewal_cycle_id) },
          { select: ["id", "subscription_id"] }
        )
      : []
    const cyclesById = new Map(cycles.map((cycle) => [cycle.id, cycle]))

    for (const attempt of attempts) {
      const cycle = cyclesById.get(attempt.renewal_cycle_id)

      if (!cycle) {
        continue
      }

      try {
        const outcome = await underRenewalLock(
          container,
          cycle.subscription_id,
          () => applyRecordedRenewalPaymentFailureUnderLock(container, attempt.id),
          null
        )

        if (!outcome) {
          continue
        }

        if (outcome === "applied") {
          result.recorded_failures_applied += 1
        }

        logRenewalEvent(container.resolve("logger"), "info", {
          event: RenewalLogEvents.RECORDED_PAYMENT_FAILURE,
          correlation_id: input.correlationId,
          renewal_cycle_id: cycle.id,
          subscription_id: cycle.subscription_id,
          job_name: JOB_NAME,
          alertable: false,
          message:
            outcome === "applied"
              ? `Applied the payment failure recorded on attempt '${attempt.id}' while its renewal lock was busy`
              : outcome === "order_paid"
                ? `Dropped the payment failure recorded on attempt '${attempt.id}': its renewal order has been paid since`
                : `Dropped the payment failure recorded on attempt '${attempt.id}': nothing it names is still in flight`,
          metadata: { attempt_id: attempt.id },
        })
      } catch (error) {
        result.failed += 1
        reportCycleFailure(container, cycle.id, error)
      }
    }

    if (attempts.length < BATCH_SIZE) {
      return
    }

    cursor = attempts[attempts.length - 1].id
  }
}

async function reconcileAttemptsOfClosedCycles(
  container: MedusaContainer,
  input: OverdueAlertInput,
  result: ReconcileAwaitingRenewalCyclesResult
): Promise<void> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const minHours = resolveAwaitingPaymentResolveMinHours()
  let cursor: string | null = null

  while (true) {
    const attempts = await renewalModule.listRenewalAttempts(
      {
        status: RenewalAttemptStatus.PROCESSING,
        ...(cursor ? { id: { $gt: cursor } } : {}),
      },
      { take: BATCH_SIZE, order: { id: "ASC" } }
    )
    const cycles = attempts.length
      ? await renewalModule.listRenewalCycles({
          id: attempts.map((attempt) => attempt.renewal_cycle_id),
        })
      : []
    const cyclesById = new Map(cycles.map((cycle) => [cycle.id, cycle]))

    for (const attempt of attempts) {
      const cycle = cyclesById.get(attempt.renewal_cycle_id)

      if (!cycle || !CLOSED_RENEWAL_CYCLE_STATUSES.includes(cycle.status)) {
        continue
      }

      try {
        const capturedPaymentId = attempt.payment_reference
          ? await findCapturedPaymentId(container, attempt.payment_reference)
          : null

        if (capturedPaymentId) {
          await activateSubscriptionOnPaymentCaptured(container, capturedPaymentId)
          await assertAttemptClosed(renewalModule, attempt.id, capturedPaymentId)
          result.late_captures += 1
        } else if (
          isAwaitingPaymentOverdue(attempt.started_at, input.now, minHours) &&
          (await underRenewalLock(
            container,
            cycle.subscription_id,
            () => failStaleAttemptUnderLock(container, attempt.id, { ...input, minHours }),
            false
          ))
        ) {
          result.stale_attempts_closed += 1
        }
      } catch (error) {
        result.failed += 1
        reportCycleFailure(container, cycle.id, error)
      }
    }

    if (attempts.length < BATCH_SIZE) {
      return
    }

    cursor = attempts[attempts.length - 1].id
  }
}

async function findPaidStaleCharge(
  container: MedusaContainer,
  cycleId: string,
  now: Date
) {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const cycle = await renewalModule.retrieveRenewalCycle(cycleId)

  if (cycle.status !== RenewalCycleStatus.PROCESSING) {
    return null
  }

  const [latest] = await renewalModule.listRenewalAttempts(
    { renewal_cycle_id: cycle.id },
    { order: { attempt_no: "DESC" }, take: 1 }
  )
  const orderId = cycle.generated_order_id ?? latest?.order_id

  if (
    latest?.status !== RenewalAttemptStatus.PROCESSING ||
    now.getTime() - new Date(latest.started_at).getTime() < STALE_PROCESSING_MINUTES * 60 * 1000 ||
    !orderId ||
    (await loadOrderAmounts(container, orderId)).pending > 0
  ) {
    return null
  }

  return latest
}

/**
 * Nothing else settles a paid processing cycle: a capture that met the run's lock, or never
 * arrived, is not delivered again. The paid order decides, since the attempt's session may be
 * missing when the run could not record it.
 */
async function settlePaidProcessingCycle(
  container: MedusaContainer,
  cycle: { id: string, subscription_id: string },
  input: OverdueAlertInput
): Promise<boolean> {
  if (!(await findPaidStaleCharge(container, cycle.id, input.now))) {
    return false
  }

  const outcome = await underRenewalLock(
    container,
    cycle.subscription_id,
    async () => {
      const charge = await findPaidStaleCharge(container, cycle.id, input.now)

      return charge
        ? await settleAwaitingRenewalCycleUnderLock(container, cycle.id, {
            processing_signal: { session_id: charge.payment_reference, attempt_id: charge.id },
          })
        : null
    },
    null
  )

  if (outcome !== "settled" && outcome !== "closed_superseded") {
    return false
  }

  logRenewalEvent(container.resolve("logger"), "warn", {
    event: RenewalLogEvents.PROCESSING_SETTLEMENT,
    outcome: "succeeded",
    correlation_id: input.correlationId,
    renewal_cycle_id: cycle.id,
    subscription_id: cycle.subscription_id,
    job_name: JOB_NAME,
    alertable: false,
    message: `RenewalCycle '${cycle.id}' was left processing with its renewal order paid; settled by the sweep`,
  })

  return true
}

async function reconcileProcessingCycles(
  container: MedusaContainer,
  input: OverdueAlertInput,
  result: ReconcileAwaitingRenewalCyclesResult
): Promise<void> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  let cursor: string | null = null

  while (true) {
    const cycles = await renewalModule.listRenewalCycles(
      {
        status: RenewalCycleStatus.PROCESSING,
        ...(cursor ? { id: { $gt: cursor } } : {}),
      },
      {
        select: ["id", "subscription_id"],
        take: BATCH_SIZE,
        order: { id: "ASC" },
      }
    )

    for (const cycle of cycles) {
      try {
        if (await settlePaidProcessingCycle(container, cycle, input)) {
          result.processing_settled += 1
        } else if (
          await raiseOverdueAlertOnce(
            container,
            cycle,
            RenewalCycleStatus.PROCESSING,
            input
          )
        ) {
          result.processing_overdue += 1
        }
      } catch (error) {
        result.failed += 1
        reportCycleFailure(container, cycle.id, error)
      }
    }

    if (cycles.length < BATCH_SIZE) {
      return
    }

    cursor = cycles[cycles.length - 1].id
  }
}

/**
 * A throwing `payment.captured` subscriber is logged and dropped, and the event is not delivered
 * again, so a paid cycle can stay awaiting until this sweep settles it.
 */
export async function reconcileAwaitingRenewalCycles(
  container: MedusaContainer
): Promise<ReconcileAwaitingRenewalCyclesResult> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const alertInput: OverdueAlertInput = {
    now: new Date(Date.now()),
    alertHours: resolveAwaitingPaymentAlertHours(),
    correlationId: createRenewalCorrelationId(JOB_NAME),
  }
  const result: ReconcileAwaitingRenewalCyclesResult = {
    scanned: 0,
    settled: 0,
    closed_superseded: 0,
    not_awaiting: 0,
    order_unpaid: 0,
    subscription_terminal: 0,
    failed: 0,
    overdue: 0,
    processing_overdue: 0,
    ended_cancelled: 0,
    late_captures: 0,
    stale_attempts_closed: 0,
    recorded_failures_applied: 0,
    processing_settled: 0,
  }
  let cursor: string | null = null

  await applyRecordedPaymentFailures(container, alertInput, result)

  while (true) {
    const cycles = await renewalModule.listRenewalCycles(
      {
        status: RenewalCycleStatus.AWAITING_PAYMENT,
        ...(cursor ? { id: { $gt: cursor } } : {}),
      },
      {
        select: ["id", "subscription_id"],
        take: BATCH_SIZE,
        order: { id: "ASC" },
      }
    )

    for (const cycle of cycles) {
      result.scanned += 1

      try {
        if (await endCycleOfCancelledSubscription(container, cycle)) {
          result.ended_cancelled += 1

          continue
        }

        const outcome = await settleAwaitingRenewalCycle(container, cycle.id)

        result[outcome] += 1

        if (
          outcome === "order_unpaid" &&
          (await raiseOverdueAlertOnce(
            container,
            cycle,
            RenewalCycleStatus.AWAITING_PAYMENT,
            alertInput
          ))
        ) {
          result.overdue += 1
        }
      } catch (error) {
        result.failed += 1
        reportCycleFailure(container, cycle.id, error)
      }
    }

    if (cycles.length < BATCH_SIZE) {
      break
    }

    cursor = cycles[cycles.length - 1].id
  }

  await reconcileProcessingCycles(container, alertInput, result)
  await reconcileAttemptsOfClosedCycles(container, alertInput, result)

  return result
}

export default async function reconcileAwaitingRenewalCyclesJob(
  container: MedusaContainer
) {
  const logger = container.resolve("logger")
  const startedAt = Date.now()

  try {
    await runUnderLock(
      container,
      JOB_LOCK_KEY,
      async () => {
        const result = await reconcileAwaitingRenewalCycles(container)

        logger.info(
          `[${JOB_NAME}] scanned ${result.scanned} awaiting renewal cycle(s), settled ${result.settled}, closed without moving dates ${result.closed_superseded}, still unpaid ${result.order_unpaid} (overdue ${result.overdue}), processing cycles settled on a paid order ${result.processing_settled}, submitted charges overdue while processing ${result.processing_overdue}, terminal subscription ${result.subscription_terminal}, ended for a cancelled subscription ${result.ended_cancelled}, late captures redelivered ${result.late_captures}, stale attempts closed ${result.stale_attempts_closed}, recorded payment failures applied ${result.recorded_failures_applied}, no longer awaiting ${result.not_awaiting}, failed ${result.failed} in ${Date.now() - startedAt}ms`
        )
      },
      JOB_LOCK
    )
  } catch (error) {
    const message = getRenewalErrorMessage(error)

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
