import type { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { RENEWAL_MODULE } from "../modules/renewal"
import type RenewalModuleService from "../modules/renewal/service"
import { RenewalCycleStatus } from "../modules/renewal/types"
import {
  AWAITING_PAYMENT_OVERDUE_EVENT,
  isAwaitingPaymentOverdue,
  resolveAwaitingPaymentAlertHours,
} from "../modules/renewal/utils/awaiting-payment-age"
import {
  createRenewalCorrelationId,
  logRenewalEvent,
} from "../modules/renewal/utils/observability"
import {
  settleAwaitingRenewalCycle,
  type SettleAwaitingRenewalCycleOutcome,
} from "../workflows/utils/settle-awaiting-renewal-cycle"

const JOB_NAME = "reconcile-awaiting-renewal-cycles"
const JOB_LOCK_KEY = "jobs:reconcile-awaiting-renewal-cycles"
const BATCH_SIZE = 200

export type ReconcileAwaitingRenewalCyclesResult = Record<
  | SettleAwaitingRenewalCycleOutcome
  | "scanned"
  | "failed"
  | "overdue"
  | "processing_overdue",
  number
>

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A run that submitted its charge but could not park the cycle leaves it `processing`, which no
 * other path looks at again. Alerts only: the capture's settlement is what closes it.
 */
async function alertOverdueSubmittedCharges(
  container: MedusaContainer,
  input: { now: Date, alertHours: number, correlationId: string }
): Promise<number> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const logger = container.resolve("logger")
  let overdue = 0
  let cursor: string | null = null

  while (true) {
    const cycles = await renewalModule.listRenewalCycles(
      {
        status: RenewalCycleStatus.PROCESSING,
        ...(cursor ? { id: { $gt: cursor } } : {}),
      },
      {
        select: ["id", "subscription_id", "updated_at"],
        take: BATCH_SIZE,
        order: { id: "ASC" },
      }
    )

    for (const cycle of cycles) {
      if (!isAwaitingPaymentOverdue(cycle.updated_at, input.now, input.alertHours)) {
        continue
      }

      const [latest] = await renewalModule.listRenewalAttempts(
        { renewal_cycle_id: cycle.id },
        { order: { attempt_no: "DESC" }, take: 1 }
      )

      if (!latest?.payment_reference) {
        continue
      }

      overdue += 1

      logRenewalEvent(logger, "warn", {
        event: AWAITING_PAYMENT_OVERDUE_EVENT,
        outcome: "awaiting_payment",
        correlation_id: input.correlationId,
        renewal_cycle_id: cycle.id,
        subscription_id: cycle.subscription_id,
        job_name: JOB_NAME,
        alertable: true,
        message: `RenewalCycle '${cycle.id}' has been processing the charge it submitted on payment session '${latest.payment_reference}' for more than ${input.alertHours} hours`,
        metadata: {
          processing_since: new Date(cycle.updated_at).toISOString(),
          alert_hours: input.alertHours,
          payment_session_id: latest.payment_reference,
        },
      })
    }

    if (cycles.length < BATCH_SIZE) {
      return overdue
    }

    cursor = cycles[cycles.length - 1].id
  }
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
  const logger = container.resolve("logger")
  const alertHours = resolveAwaitingPaymentAlertHours()
  const now = new Date(Date.now())
  const correlationId = createRenewalCorrelationId(JOB_NAME)
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
  }
  let cursor: string | null = null

  while (true) {
    const cycles = await renewalModule.listRenewalCycles(
      {
        status: RenewalCycleStatus.AWAITING_PAYMENT,
        ...(cursor ? { id: { $gt: cursor } } : {}),
      },
      {
        select: ["id", "subscription_id", "updated_at"],
        take: BATCH_SIZE,
        order: { id: "ASC" },
      }
    )

    for (const cycle of cycles) {
      result.scanned += 1

      try {
        const outcome = await settleAwaitingRenewalCycle(container, cycle.id)

        result[outcome] += 1

        if (
          outcome === "order_unpaid" &&
          isAwaitingPaymentOverdue(cycle.updated_at, now, alertHours)
        ) {
          result.overdue += 1

          logRenewalEvent(logger, "warn", {
            event: AWAITING_PAYMENT_OVERDUE_EVENT,
            outcome: "awaiting_payment",
            correlation_id: correlationId,
            renewal_cycle_id: cycle.id,
            subscription_id: cycle.subscription_id,
            job_name: JOB_NAME,
            alertable: true,
            message: `RenewalCycle '${cycle.id}' has awaited its payment for more than ${alertHours} hours`,
            metadata: {
              awaiting_since: new Date(cycle.updated_at).toISOString(),
              alert_hours: alertHours,
            },
          })
        }
      } catch (error) {
        result.failed += 1

        logger.error(
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
      break
    }

    cursor = cycles[cycles.length - 1].id
  }

  result.processing_overdue = await alertOverdueSubmittedCharges(container, {
    now,
    alertHours,
    correlationId,
  })

  return result
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
          `[${JOB_NAME}] scanned ${result.scanned} awaiting renewal cycle(s), settled ${result.settled}, closed without moving dates ${result.closed_superseded}, still unpaid ${result.order_unpaid} (overdue ${result.overdue}), submitted charges overdue while processing ${result.processing_overdue}, terminal subscription ${result.subscription_terminal}, no longer awaiting ${result.not_awaiting}, failed ${result.failed} in ${Date.now() - startedAt}ms`
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
