import type { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { RENEWAL_MODULE } from "../modules/renewal"
import type RenewalModuleService from "../modules/renewal/service"
import { RenewalCycleStatus } from "../modules/renewal/types"
import {
  AWAITING_PAYMENT_OVERDUE_EVENT,
  isOverdueAlertDue,
  resolveAwaitingPaymentAlertHours,
  withOverdueAlertMarker,
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
const ALERT_LOCK_TIMEOUT_SECONDS = 5

type OverdueStatus = RenewalCycleStatus.AWAITING_PAYMENT | RenewalCycleStatus.PROCESSING

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
  | "processing_overdue",
  number
>

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isLockTimeout(message: string) {
  const lowered = message.toLowerCase()

  return lowered.includes("timed-out acquiring lock") || lowered.includes("timeout")
}

async function findDueOverdueAlert(
  renewalModule: RenewalModuleService,
  cycleId: string,
  status: OverdueStatus,
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
  status: OverdueStatus,
  input: OverdueAlertInput
): Promise<boolean> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)

  if (!(await findDueOverdueAlert(renewalModule, cycle.id, status, input))) {
    return false
  }

  try {
    return await container.resolve(Modules.LOCKING).execute(
      `renewal:subscription:${cycle.subscription_id}`,
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
          event: AWAITING_PAYMENT_OVERDUE_EVENT,
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
      { timeout: ALERT_LOCK_TIMEOUT_SECONDS }
    )
  } catch (error) {
    if (isLockTimeout(getErrorMessage(error))) {
      return false
    }

    throw error
  }
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
      message: getErrorMessage(error),
    })
  )
}

async function alertOverdueProcessingCycles(
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
        if (
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
  }
  let cursor: string | null = null

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

  await alertOverdueProcessingCycles(container, alertInput, result)

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
