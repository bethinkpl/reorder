import type { MedusaContainer } from "@medusajs/framework/types"
import { isLockBusyError } from "../../common/utils/lock-busy-error"
import { isOverdueAlertDue } from "../../modules/renewal/utils/awaiting-payment-age"
import { activateSubscriptionOnPaymentCaptured } from "../../subscribers/activate-subscription-on-payment-captured"
import { findCapturedPaymentId } from "./late-payment-capture"
import { runUnderLock } from "./run-under-lock"

export const SWEEP_BATCH_SIZE = 200
/**
 * The lock is not renewed while held, so it lasts as long as a sweep realistically can, and expires
 * before the next scheduled run: a crashed run skips at most one tick, and a sweep that overruns it
 * only overlaps the next one, whose writes the per-cycle and per-case locks still serialise.
 */
const SWEEP_JOB_LOCK = { wait_seconds: 1, hold_seconds: 25 * 60 }
export const SWEEP_PARENT_LOCK = { wait_seconds: 5, hold_seconds: 120 }

export type OverdueAlertInput = {
  now: Date
  alertHours: number
  correlationId: string
}

export async function forEachPage<T extends { id: string }>(
  list: (after: { id?: { $gt: string } }, page: { take: number, order: { id: "ASC" } }) => Promise<T[]>,
  handle: (rows: T[]) => Promise<void>
): Promise<void> {
  let cursor: string | null = null

  while (true) {
    const rows = await list(cursor ? { id: { $gt: cursor } } : {}, { take: SWEEP_BATCH_SIZE, order: { id: "ASC" } })

    await handle(rows)

    if (rows.length < SWEEP_BATCH_SIZE) {
      return
    }

    cursor = rows[rows.length - 1].id
  }
}

export function dueOverdueAlert<P extends {
  id: string
  metadata: Record<string, unknown> | null
  updated_at: Date | string
}>(
  parent: P,
  latest: { id: string, started_at: Date | string, payment_reference: string | null } | undefined | null,
  input: OverdueAlertInput
) {
  const alertKey = latest?.id ?? parent.id
  const submittedAt = latest?.started_at ?? parent.updated_at

  if (
    !isOverdueAlertDue({
      metadata: parent.metadata,
      alert_key: alertKey,
      submitted_at: submittedAt,
      now: input.now,
      limit_hours: input.alertHours,
    })
  ) {
    return null
  }

  return {
    parent,
    alertKey,
    submittedAt: new Date(submittedAt).toISOString(),
    paymentSessionId: latest?.payment_reference ?? null,
  }
}

export async function redeliverLostCapture(
  container: MedusaContainer,
  attempt: { id: string, payment_reference: string | null },
  stillProcessing: () => Promise<boolean>
): Promise<boolean> {
  const capturedPaymentId = attempt.payment_reference
    ? await findCapturedPaymentId(container, attempt.payment_reference)
    : null

  if (!capturedPaymentId) {
    return false
  }

  await activateSubscriptionOnPaymentCaptured(container, capturedPaymentId)

  if (await stillProcessing()) {
    throw new Error(
      `Captured payment '${capturedPaymentId}' of attempt '${attempt.id}' was delivered again, but the attempt is still processing`
    )
  }

  return true
}

export async function runSweepJob(
  container: MedusaContainer,
  job: { name: string, lockKey: string, errorMessage: (error: unknown) => string },
  sweep: () => Promise<string>
) {
  const logger = container.resolve("logger")
  const startedAt = Date.now()

  try {
    await runUnderLock(
      container,
      job.lockKey,
      async () => {
        logger.info(`[${job.name}] ${await sweep()} in ${Date.now() - startedAt}ms`)
      },
      SWEEP_JOB_LOCK
    )
  } catch (error) {
    const message = job.errorMessage(error)

    if (isLockBusyError(error)) {
      logger.warn(`[${job.name}] did not complete: ${message}`)
    } else {
      logger.error(`[${job.name}] did not complete: ${message}`)
    }
  }
}
