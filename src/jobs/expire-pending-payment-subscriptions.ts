import { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import {
  expirePendingPaymentSubscriptions,
  resolvePendingPaymentTtlMinutes,
} from "../modules/subscription/utils/expire-pending-payment"

const JOB_NAME = "expire-pending-payment-subscriptions"
const JOB_LOCK_KEY = "jobs:expire-pending-payment-subscriptions"

function getLogger(container: MedusaContainer) {
  return container.resolve("logger")
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export default async function expirePendingPaymentSubscriptionsJob(
  container: MedusaContainer
) {
  const logger = getLogger(container)
  const locking = container.resolve(Modules.LOCKING)
  const startedAt = Date.now()

  try {
    await locking.execute(
      JOB_LOCK_KEY,
      async () => {
        const result = await expirePendingPaymentSubscriptions(container)

        logger.info(
          `[${JOB_NAME}] scanned ${result.scanned} subscription(s) past the ${resolvePendingPaymentTtlMinutes()} minute payment window, cancelled ${result.expired.length} in ${Date.now() - startedAt}ms`
        )
      },
      {
        timeout: 1,
      }
    )
  } catch (error) {
    logger.warn(`[${JOB_NAME}] did not complete: ${getErrorMessage(error)}`)
  }
}

export const config = {
  name: JOB_NAME,
  schedule: "*/30 * * * *",
}
