import type { MedusaContainer } from "@medusajs/framework/types"
import { SUBSCRIPTION_MODULE } from ".."
import type SubscriptionModuleService from "../service"
import { SubscriptionStatus } from "../types"

export const ABANDONED_CHECKOUT_REASON = "initial_payment_abandoned"

/**
 * Ends a subscription whose customer never completed the initial payment.
 *
 * `cancellation_reason` is what the storefront filters on to hide a checkout that was never a
 * subscription the customer had, so it has to be written here rather than left to the caller.
 */
export async function cancelAbandonedSubscription(
  container: MedusaContainer,
  subscription: { id: string, metadata: Record<string, unknown> | null },
  now: Date
): Promise<void> {
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

  await subscriptionModule.updateSubscriptions({
    id: subscription.id,
    status: SubscriptionStatus.CANCELLED,
    cancelled_at: now,
    cancel_effective_at: now,
    next_renewal_at: null,
    metadata: {
      ...(subscription.metadata ?? {}),
      cancel_context: {
        reason: ABANDONED_CHECKOUT_REASON,
        effective_at: "immediately",
        cancelled_at: now.toISOString(),
        triggered_by: null,
      },
      cancellation_reason: ABANDONED_CHECKOUT_REASON,
    },
  })
}
