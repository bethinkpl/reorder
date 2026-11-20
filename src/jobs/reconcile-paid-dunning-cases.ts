import { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { isLockBusyError } from "../common/utils/lock-busy-error"
import { DUNNING_MODULE } from "../modules/dunning"
import type DunningModuleService from "../modules/dunning/service"
import {
  CLOSED_DUNNING_CASE_STATUSES,
  DunningAttemptStatus,
  DunningCaseStatus,
} from "../modules/dunning/types"
import {
  createDunningCorrelationId,
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
import { activateSubscriptionOnPaymentCaptured } from "../subscribers/activate-subscription-on-payment-captured"
import { recoverDunningFromCapturedPaymentWorkflow } from "../workflows/recover-dunning-from-captured-payment"
import { loadOrderAmounts } from "../workflows/steps/run-dunning-retry"
import {
  findCapturedPaymentId,
  NO_PAYMENT_SIGNAL_ERROR_CODE,
} from "../workflows/utils/late-payment-capture"

const JOB_NAME = "reconcile-paid-dunning-cases"
const JOB_LOCK_KEY = "jobs:reconcile-paid-dunning-cases"
const BATCH_SIZE = 200
const ALERT_LOCK_TIMEOUT_SECONDS = 5

export const DUNNING_AWAITING_PAYMENT_OVERDUE_EVENT =
  "dunning.awaiting_payment_overdue"

const OPEN_DUNNING_STATUSES = [
  DunningCaseStatus.OPEN,
  DunningCaseStatus.RETRY_SCHEDULED,
  DunningCaseStatus.AWAITING_PAYMENT,
  DunningCaseStatus.AWAITING_MANUAL_RESOLUTION,
]

type DunningCaseRecord = {
  id: string
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
  late_captures: number
  stale_attempts_closed: number
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

  if (!(await findDueOverdueAlert(dunningModule, caseId, input))) {
    return false
  }

  try {
    return await container.resolve(Modules.LOCKING).execute(
      `dunning:${caseId}`,
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
          event: DUNNING_AWAITING_PAYMENT_OVERDUE_EVENT,
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
    error_code: NO_PAYMENT_SIGNAL_ERROR_CODE,
    error_message: message,
  })

  logDunningEvent(container.resolve("logger"), "warn", {
    event: "dunning.stale_attempt_closed",
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

/**
 * A retry attempt a customer's cancellation left processing on its closed case: a captured
 * payment whose event was lost is delivered again, and an attempt with no result past the minimum
 * age is failed.
 */
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

          // Left processing, it would otherwise be delivered again on every run.
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
          `dunning:${dunningCase.id}`,
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

  const cases = (await dunningModule.listDunningCases(
    { status: OPEN_DUNNING_STATUSES } as never,
    { take: BATCH_SIZE, order: { updated_at: "ASC" } }
  )) as DunningCaseRecord[]

  const result: ReconcilePaidDunningCasesResult = {
    scanned: cases.length,
    recovered: 0,
    unpaid: 0,
    failed: 0,
    late_captures: 0,
    stale_attempts_closed: 0,
  }
  const alertInput: OverdueAlertInput = {
    now: new Date(Date.now()),
    alertHours: resolveAwaitingPaymentAlertHours(),
    correlationId: createDunningCorrelationId(JOB_NAME),
  }

  for (const dunningCase of cases) {
    if (!dunningCase.renewal_order_id) {
      continue
    }

    try {
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
          `[${JOB_NAME}] scanned ${result.scanned} open dunning case(s), recovered ${result.recovered}, still unpaid ${result.unpaid}, late captures redelivered ${result.late_captures}, stale attempts closed ${result.stale_attempts_closed}, failed ${result.failed} (batch ${BATCH_SIZE}) in ${Date.now() - startedAt}ms`
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
