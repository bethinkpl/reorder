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
import { TERMINAL_SUBSCRIPTION_STATUSES } from "../modules/subscription/types"
import { loadOrderAmounts } from "../workflows/steps/run-dunning-retry"
import {
  dueOverdueAlert,
  forEachPage,
  type OverdueAlertInput,
  redeliverLostCapture,
  runSweepJob,
  SWEEP_PARENT_LOCK,
} from "../workflows/utils/awaiting-charge-sweep"
import { endAwaitingRenewalCyclesOnCancellation } from "../workflows/utils/end-awaiting-renewal-cycle-on-cancellation"
import { tryUnderLock } from "../workflows/utils/run-under-lock"
import { applyRecordedRenewalPaymentFailureUnderLock } from "../workflows/utils/fail-awaiting-renewal-cycle"
import { isSubmittedSessionGone } from "../workflows/utils/late-payment-capture"
import {
  settleAwaitingRenewalCycle,
  settleAwaitingRenewalCycleUnderLock,
  type SettleAwaitingRenewalCycleOutcome,
} from "../workflows/utils/settle-awaiting-renewal-cycle"
import { renewalSubscriptionLockKey } from "../modules/renewal/utils/lock-key"

const JOB_NAME = "reconcile-awaiting-renewal-cycles"
/** Well past the 120 s a renewal run holds its lock, so a run still in progress is never touched. */
const STALE_PROCESSING_MINUTES = 10

export type ReconcileAwaitingRenewalCyclesResult = Record<
  | SettleAwaitingRenewalCycleOutcome
  | "scanned"
  | "failed"
  | "overdue"
  | "processing_overdue"
  | "ended_cancelled"
  | "session_missing"
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

  return dueOverdueAlert(cycle, latest, input)
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
        metadata: withOverdueAlertMarker(due.parent.metadata, due.alertKey),
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
    SWEEP_PARENT_LOCK
  )

  return run.acquired && run.result
}

async function reportMissingSession(
  container: MedusaContainer,
  cycle: { id: string, subscription_id: string },
  input: OverdueAlertInput
): Promise<boolean> {
  const [latest] = await container
    .resolve<RenewalModuleService>(RENEWAL_MODULE)
    .listRenewalAttempts(
      { renewal_cycle_id: cycle.id },
      { order: { attempt_no: "DESC" }, take: 1 }
    )
  const sessionId = latest?.payment_reference

  if (
    latest?.status !== RenewalAttemptStatus.PROCESSING ||
    !sessionId ||
    !(await isSubmittedSessionGone(container, sessionId))
  ) {
    return false
  }

  logRenewalEvent(container.resolve("logger"), "error", {
    event: RenewalLogEvents.AWAITING_PAYMENT_SESSION_MISSING,
    outcome: "awaiting_payment",
    correlation_id: input.correlationId,
    renewal_cycle_id: cycle.id,
    subscription_id: cycle.subscription_id,
    job_name: JOB_NAME,
    alertable: true,
    message: `RenewalCycle '${cycle.id}' awaits a charge whose payment session '${sessionId}' no longer exists and has nothing captured on it, so its result can't arrive; resolve it once it may be failed`,
    metadata: { attempt_id: latest.id, payment_session_id: sessionId },
  })

  return true
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
  const run = await tryUnderLock(
    container,
    renewalSubscriptionLockKey(subscriptionId),
    job,
    SWEEP_PARENT_LOCK
  )

  return run.acquired ? run.result : whenBusy
}

async function endCycleOfEndedSubscription(
  container: MedusaContainer,
  cycle: { id: string, subscription_id: string }
): Promise<boolean> {
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
  const hasEnded = async () =>
    TERMINAL_SUBSCRIPTION_STATUSES.includes(
      (await subscriptionModule.retrieveSubscription(cycle.subscription_id)).status
    )

  if (!(await hasEnded())) {
    return false
  }

  return await underRenewalLock(
    container,
    cycle.subscription_id,
    async () => {
      if (!(await hasEnded())) {
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

async function applyRecordedPaymentFailures(
  container: MedusaContainer,
  input: OverdueAlertInput,
  result: ReconcileAwaitingRenewalCyclesResult
): Promise<void> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)

  await forEachPage(
    (after, page) =>
      renewalModule.listRenewalAttempts(
        { reported_payment_failure: { $ne: null }, ...after } as never,
        { select: ["id", "renewal_cycle_id"], ...page }
      ),
    async (attempts) => {
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
    }
  )
}

async function reconcileAttemptsOfClosedCycles(
  container: MedusaContainer,
  input: OverdueAlertInput,
  result: ReconcileAwaitingRenewalCyclesResult
): Promise<void> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const minHours = resolveAwaitingPaymentResolveMinHours()

  await forEachPage(
    (after, page) =>
      renewalModule.listRenewalAttempts({ status: RenewalAttemptStatus.PROCESSING, ...after }, page),
    async (attempts) => {
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
          if (
            await redeliverLostCapture(container, attempt, async () =>
              (await renewalModule.listRenewalAttempts({ id: attempt.id }))[0]?.status ===
              RenewalAttemptStatus.PROCESSING
            )
          ) {
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
    }
  )
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

  await forEachPage(
    (after, page) =>
      renewalModule.listRenewalCycles(
        { status: RenewalCycleStatus.PROCESSING, ...after },
        { select: ["id", "subscription_id"], ...page }
      ),
    async (cycles) => {
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
    }
  )
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
    session_missing: 0,
    late_captures: 0,
    stale_attempts_closed: 0,
    recorded_failures_applied: 0,
    processing_settled: 0,
  }

  await applyRecordedPaymentFailures(container, alertInput, result)

  await forEachPage(
    (after, page) =>
      renewalModule.listRenewalCycles(
        { status: RenewalCycleStatus.AWAITING_PAYMENT, ...after },
        { select: ["id", "subscription_id"], ...page }
      ),
    async (cycles) => {
      for (const cycle of cycles) {
        result.scanned += 1

        try {
          if (await endCycleOfEndedSubscription(container, cycle)) {
            result.ended_cancelled += 1

            continue
          }

          const outcome = await settleAwaitingRenewalCycle(container, cycle.id)

          result[outcome] += 1

          if (outcome !== "order_unpaid") {
            continue
          }

          if (await reportMissingSession(container, cycle, alertInput)) {
            result.session_missing += 1
          }

          if (
            await raiseOverdueAlertOnce(
              container,
              cycle,
              RenewalCycleStatus.AWAITING_PAYMENT,
              alertInput
            )
          ) {
            result.overdue += 1
          }
        } catch (error) {
          result.failed += 1
          reportCycleFailure(container, cycle.id, error)
        }
      }
    }
  )

  await reconcileProcessingCycles(container, alertInput, result)
  await reconcileAttemptsOfClosedCycles(container, alertInput, result)

  return result
}

export default async function reconcileAwaitingRenewalCyclesJob(
  container: MedusaContainer
) {
  await runSweepJob(
    container,
    { name: JOB_NAME, lockKey: "jobs:reconcile-awaiting-renewal-cycles", errorMessage: getRenewalErrorMessage },
    async () => {
      const result = await reconcileAwaitingRenewalCycles(container)

      return `scanned ${result.scanned} awaiting renewal cycle(s), settled ${result.settled}, closed without moving dates ${result.closed_superseded}, still unpaid ${result.order_unpaid} (overdue ${result.overdue}, payment session gone ${result.session_missing}), processing cycles settled on a paid order ${result.processing_settled}, submitted charges overdue while processing ${result.processing_overdue}, terminal subscription ${result.subscription_terminal}, ended for a cancelled subscription ${result.ended_cancelled}, late captures redelivered ${result.late_captures}, stale attempts closed ${result.stale_attempts_closed}, recorded payment failures applied ${result.recorded_failures_applied}, no longer awaiting ${result.not_awaiting}, failed ${result.failed}`
    }
  )
}

export const config = {
  name: JOB_NAME,
  schedule: "*/30 * * * *",
}
