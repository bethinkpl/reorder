import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { activateSubscriptionIfAlreadyPaid } from "../../../workflows/steps/activate-subscription-if-already-paid"
import { ensureNextRenewalCycleWorkflow } from "../../../workflows/ensure-next-renewal-cycle"
import { cancelAbandonedSubscription } from "./cancel-abandoned-subscription"
import { findLivePaymentForCart } from "./resolve-captured-payment-method"
import { SubscriptionStatus } from "../types"

export const DEFAULT_PENDING_PAYMENT_TTL_MINUTES = 24 * 60
export const DEFAULT_PENDING_PAYMENT_BATCH_SIZE = 200
export const DEFAULT_PENDING_PAYMENT_MAX_DEFER_MINUTES = 3 * 24 * 60

export type ReconcilePendingPaymentResult = {
  scanned: number
  activated: string[]
  expired: string[]
  deferred: string[]
  force_expired: string[]
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

export function resolvePendingPaymentBatchSize(
  raw: string | undefined = process.env.SUBSCRIPTION_PENDING_PAYMENT_BATCH_SIZE
): number {
  if (!raw) {
    return DEFAULT_PENDING_PAYMENT_BATCH_SIZE
  }

  const parsed = Number.parseInt(raw, 10)

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return DEFAULT_PENDING_PAYMENT_BATCH_SIZE
  }

  return parsed
}

export function resolvePendingPaymentMaxDeferMinutes(
  raw: string | undefined = process.env.SUBSCRIPTION_PENDING_PAYMENT_MAX_DEFER_MINUTES
): number {
  if (!raw) {
    return DEFAULT_PENDING_PAYMENT_MAX_DEFER_MINUTES
  }

  const parsed = Number.parseInt(raw, 10)

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return DEFAULT_PENDING_PAYMENT_MAX_DEFER_MINUTES
  }

  return parsed
}

/**
 * The backstop for both directions a webhook can go missing. `activate-subscription-on-payment-captured`
 * and `cancel-pending-subscription-on-payment-failure` cover the event-driven cases; this scans a bounded,
 * oldest-first batch of `pending_payment` rows (not just stale ones) so a lost `payment.captured` self-heals
 * quickly, and only falls back to cancelling once a row has sat there longer than the TTL. A row is left
 * pending (`deferred`) instead of cancelled when its cart still carries a live authorization — a payment
 * that has been authorized but not yet captured or canceled — so a delayed capture is not orphaned.
 * Deferral is bounded, though: a capture that never lands would otherwise defer forever and, since the
 * scan is oldest-first, could permanently crowd the batch window out for newer rows. Once a deferred row's
 * `created_at` is older than the max-defer window, it is force-expired instead and reported separately in
 * `force_expired` so an operator can check whether money is stuck authorized on a now-cancelled subscription.
 */
export async function reconcilePendingPaymentSubscriptions(
  container: MedusaContainer,
  options: { now?: Date, ttl_minutes?: number, batch_size?: number, max_defer_minutes?: number } = {}
): Promise<ReconcilePendingPaymentResult> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const now = options.now ?? new Date()
  const ttlMinutes = options.ttl_minutes ?? resolvePendingPaymentTtlMinutes()
  const batchSize = options.batch_size ?? resolvePendingPaymentBatchSize()
  const maxDeferMinutes = options.max_defer_minutes ?? resolvePendingPaymentMaxDeferMinutes()
  const cutoff = resolvePendingPaymentCutoff(now, ttlMinutes)
  const maxDeferCutoff = resolvePendingPaymentCutoff(now, maxDeferMinutes)

  const { data } = await query.graph({
    entity: "subscription",
    fields: ["id", "cart_id", "created_at", "metadata"],
    filters: {
      status: SubscriptionStatus.PENDING_PAYMENT,
    },
    pagination: {
      take: batchSize,
      order: { created_at: "ASC" },
    },
  })

  const subscriptions = (data as PendingSubscriptionRecord[]) ?? []
  const activated: string[] = []
  const expired: string[] = []
  const deferred: string[] = []
  const forceExpired: string[] = []
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
        const livePayment = subscription.cart_id
          ? await findLivePaymentForCart(container, subscription.cart_id)
          : null

        if (livePayment) {
          if (new Date(subscription.created_at).getTime() < maxDeferCutoff.getTime()) {
            await cancelAbandonedSubscription(container, subscription, now)

            expired.push(subscription.id)
            forceExpired.push(subscription.id)
          } else {
            deferred.push(subscription.id)
          }
        } else {
          await cancelAbandonedSubscription(container, subscription, now)

          expired.push(subscription.id)
        }
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
    deferred,
    force_expired: forceExpired,
    failed,
  }
}
