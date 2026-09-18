import { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import {
  reconcilePendingPaymentSubscriptions,
  resolvePendingPaymentTtlMinutes,
} from "../modules/subscription/utils/reconcile-pending-payment"

const JOB_NAME = "reconcile-pending-payment-subscriptions"
const JOB_LOCK_KEY = "jobs:reconcile-pending-payment-subscriptions"

function getLogger(container: MedusaContainer) {
  return container.resolve("logger")
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isLockTimeout(message: string) {
  const lowered = message.toLowerCase()

  return lowered.includes("timed-out acquiring lock") || lowered.includes("timeout")
}

export default async function reconcilePendingPaymentSubscriptionsJob(
  container: MedusaContainer
) {
  const logger = getLogger(container)
  const locking = container.resolve(Modules.LOCKING)
  const ttlMinutes = resolvePendingPaymentTtlMinutes()
  const startedAt = Date.now()

  try {
    await locking.execute(
      JOB_LOCK_KEY,
      async () => {
        const result = await reconcilePendingPaymentSubscriptions(container, {
          ttl_minutes: ttlMinutes,
        })

        logger.info(
          `[${JOB_NAME}] scanned ${result.scanned} pending_payment subscription(s), activated ${result.activated.length}, expired ${result.expired.length}, failed ${result.failed.length} (ttl ${ttlMinutes}m) in ${Date.now() - startedAt}ms`
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
  schedule: "*/5 * * * *",
}
