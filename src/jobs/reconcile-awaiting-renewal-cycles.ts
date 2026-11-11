import type { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { RENEWAL_MODULE } from "../modules/renewal"
import type RenewalModuleService from "../modules/renewal/service"
import { RenewalCycleStatus } from "../modules/renewal/types"
import {
  settleAwaitingRenewalCycle,
  type SettleAwaitingRenewalCycleOutcome,
} from "../workflows/utils/settle-awaiting-renewal-cycle"

const JOB_NAME = "reconcile-awaiting-renewal-cycles"
const JOB_LOCK_KEY = "jobs:reconcile-awaiting-renewal-cycles"
const BATCH_SIZE = 200

export type ReconcileAwaitingRenewalCyclesResult = Record<
  SettleAwaitingRenewalCycleOutcome | "scanned" | "failed",
  number
>

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isLockTimeout(message: string) {
  const lowered = message.toLowerCase()

  return lowered.includes("timed-out acquiring lock") || lowered.includes("timeout")
}

/**
 * A throwing `payment.captured` subscriber is logged and dropped, and the event is not delivered
 * again, so a paid cycle can stay awaiting until this sweep settles it.
 *
 * Walks every awaiting cycle by id: an unpaid one stays awaiting and would otherwise hold its place
 * at the head of a single batch.
 */
export async function reconcileAwaitingRenewalCycles(
  container: MedusaContainer
): Promise<ReconcileAwaitingRenewalCyclesResult> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const result: ReconcileAwaitingRenewalCyclesResult = {
    scanned: 0,
    settled: 0,
    closed_superseded: 0,
    not_awaiting: 0,
    order_unpaid: 0,
    subscription_terminal: 0,
    failed: 0,
  }
  let cursor: string | null = null

  while (true) {
    const cycles = await renewalModule.listRenewalCycles(
      {
        status: RenewalCycleStatus.AWAITING_PAYMENT,
        ...(cursor ? { id: { $gt: cursor } } : {}),
      },
      { select: ["id"], take: BATCH_SIZE, order: { id: "ASC" } }
    )

    for (const cycle of cycles) {
      result.scanned += 1

      try {
        const outcome = await settleAwaitingRenewalCycle(container, cycle.id)

        result[outcome] += 1
      } catch (error) {
        result.failed += 1

        container.resolve("logger").error(
          JSON.stringify({
            domain: "subscriptions",
            event: `${JOB_NAME}.cycle_failed`,
            job_name: JOB_NAME,
            renewal_cycle_id: cycle.id,
            alertable: true,
            message: getErrorMessage(error),
          })
        )
      }
    }

    if (cycles.length < BATCH_SIZE) {
      return result
    }

    cursor = cycles[cycles.length - 1].id
  }
}

export default async function reconcileAwaitingRenewalCyclesJob(
  container: MedusaContainer
) {
  const logger = container.resolve("logger")
  const locking = container.resolve(Modules.LOCKING)
  const startedAt = Date.now()

  try {
    await locking.execute(
      JOB_LOCK_KEY,
      async () => {
        const result = await reconcileAwaitingRenewalCycles(container)

        logger.info(
          `[${JOB_NAME}] scanned ${result.scanned} awaiting renewal cycle(s), settled ${result.settled}, closed without moving dates ${result.closed_superseded}, still unpaid ${result.order_unpaid}, terminal subscription ${result.subscription_terminal}, no longer awaiting ${result.not_awaiting}, failed ${result.failed} in ${Date.now() - startedAt}ms`
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
