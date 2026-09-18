import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { activateSubscriptionIfAlreadyPaid } from "../../../workflows/steps/activate-subscription-if-already-paid"
import { ensureNextRenewalCycleWorkflow } from "../../../workflows/ensure-next-renewal-cycle"
import { cancelAbandonedSubscription } from "./cancel-abandoned-subscription"
import { SubscriptionStatus } from "../types"

export const DEFAULT_PENDING_PAYMENT_TTL_MINUTES = 24 * 60

export type ReconcilePendingPaymentResult = {
  scanned: number
  activated: string[]
  expired: string[]
  failed: { id: string, message: string }[]
}

type PendingSubscriptionRecord = {
  id: string
  cart_id: string | null
  created_at: string | Date
  metadata: Record<string, unknown> | null
}

export function resolvePendingPaymentTtlMinutes(
  raw: string | undefined = process.env.SUBSCRIPTION_PENDING_PAYMENT_TTL_MINUTES
): number {
  if (!raw) {
    return DEFAULT_PENDING_PAYMENT_TTL_MINUTES
  }

  const parsed = Number.parseInt(raw, 10)

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return DEFAULT_PENDING_PAYMENT_TTL_MINUTES
  }

  return parsed
}

export function resolvePendingPaymentCutoff(now: Date, ttlMinutes: number): Date {
  return new Date(now.getTime() - ttlMinutes * 60 * 1000)
}

/**
 * The backstop for both directions a webhook can go missing. `activate-subscription-on-payment-captured`
 * and `cancel-pending-subscription-on-payment-failure` cover the event-driven cases; this scans every
 * `pending_payment` row (not just stale ones) so a lost `payment.captured` self-heals quickly, and only
 * falls back to cancelling once a row has sat there longer than the TTL.
 */
export async function reconcilePendingPaymentSubscriptions(
  container: MedusaContainer,
  options: { now?: Date, ttl_minutes?: number } = {}
): Promise<ReconcilePendingPaymentResult> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const now = options.now ?? new Date()
  const ttlMinutes = options.ttl_minutes ?? resolvePendingPaymentTtlMinutes()
  const cutoff = resolvePendingPaymentCutoff(now, ttlMinutes)

  const { data } = await query.graph({
    entity: "subscription",
    fields: ["id", "cart_id", "created_at", "metadata"],
    filters: {
      status: SubscriptionStatus.PENDING_PAYMENT,
    },
  })

  const subscriptions = (data as PendingSubscriptionRecord[]) ?? []
  const activated: string[] = []
  const expired: string[] = []
  const failed: { id: string, message: string }[] = []

  for (const subscription of subscriptions) {
    try {
      let wasActivated = false

      if (subscription.cart_id) {
        const { output } = await activateSubscriptionIfAlreadyPaid(container, {
          subscription_id: subscription.id,
          cart_id: subscription.cart_id,
        })

        if (output.activated) {
          await ensureNextRenewalCycleWorkflow(container).run({
            input: { subscription_id: subscription.id },
          })

          activated.push(subscription.id)
          wasActivated = true
        }
      }

      if (!wasActivated && new Date(subscription.created_at).getTime() < cutoff.getTime()) {
        await cancelAbandonedSubscription(container, subscription, now)

        expired.push(subscription.id)
      }
    } catch (error) {
      failed.push({
        id: subscription.id,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return {
    scanned: subscriptions.length,
    activated,
    expired,
    failed,
  }
}
