import { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { DUNNING_MODULE } from "../modules/dunning"
import type DunningModuleService from "../modules/dunning/service"
import { DunningCaseStatus } from "../modules/dunning/types"
import { recoverDunningFromCapturedPaymentWorkflow } from "../workflows/recover-dunning-from-captured-payment"
import { loadOrderAmounts } from "../workflows/steps/run-dunning-retry"

const JOB_NAME = "reconcile-paid-dunning-cases"
const JOB_LOCK_KEY = "jobs:reconcile-paid-dunning-cases"
const BATCH_SIZE = 200

const OPEN_DUNNING_STATUSES = [
  DunningCaseStatus.OPEN,
  DunningCaseStatus.RETRY_SCHEDULED,
  DunningCaseStatus.AWAITING_MANUAL_RESOLUTION,
]

type DunningCaseRecord = {
  id: string
  renewal_order_id: string | null
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
  }

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
