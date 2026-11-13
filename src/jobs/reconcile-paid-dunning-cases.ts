import { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { DUNNING_MODULE } from "../modules/dunning"
import type DunningModuleService from "../modules/dunning/service"
import { DunningCaseStatus } from "../modules/dunning/types"
import {
  createDunningCorrelationId,
  logDunningEvent,
} from "../modules/dunning/utils/observability"
import {
  isOverdueAlertDue,
  resolveAwaitingPaymentAlertHours,
  withOverdueAlertMarker,
} from "../modules/renewal/utils/awaiting-payment-age"
import { recoverDunningFromCapturedPaymentWorkflow } from "../workflows/recover-dunning-from-captured-payment"
import { loadOrderAmounts } from "../workflows/steps/run-dunning-retry"

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
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isLockTimeout(message: string) {
  const lowered = message.toLowerCase()

  return lowered.includes("timed-out acquiring lock") || lowered.includes("timeout")
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
    if (isLockTimeout(getErrorMessage(error))) {
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
      message: getErrorMessage(error),
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
          `[${JOB_NAME}] scanned ${result.scanned} open dunning case(s), recovered ${result.recovered}, still unpaid ${result.unpaid}, failed ${result.failed} (batch ${BATCH_SIZE}) in ${Date.now() - startedAt}ms`
        )
      },
      {
        timeout: 1,
      }
    )
  } catch (error) {
    const message = getErrorMessage(error)

    if (isLockTimeout(message)) {
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
