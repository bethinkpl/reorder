import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { SUBSCRIPTION_MODULE } from ".."
import type SubscriptionModuleService from "../service"
import { SubscriptionStatus } from "../types"

export const ABANDONED_CHECKOUT_REASON = "initial_payment_abandoned"

export const DEFAULT_PENDING_PAYMENT_TTL_MINUTES = 24 * 60

export type ExpirePendingPaymentResult = {
  scanned: number
  expired: string[]
}

type PendingSubscriptionRecord = {
  id: string
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
 * Cancels subscriptions whose customer never came back from the payment provider.
 *
 * Nothing else closes them: the provider's `checkout.session.expired` webhook maps to
 * `PaymentActions.CANCELED`, which core's `processPaymentWorkflow` ignores.
 */
export async function expirePendingPaymentSubscriptions(
  container: MedusaContainer,
  options: { now?: Date, ttl_minutes?: number } = {}
): Promise<ExpirePendingPaymentResult> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

  const now = options.now ?? new Date()
  const ttlMinutes = options.ttl_minutes ?? resolvePendingPaymentTtlMinutes()
  const cutoff = resolvePendingPaymentCutoff(now, ttlMinutes)

  const { data } = await query.graph({
    entity: "subscription",
    fields: ["id", "created_at", "metadata"],
    filters: {
      status: SubscriptionStatus.PENDING_PAYMENT,
      created_at: { $lt: cutoff.toISOString() },
    },
  })

  const subscriptions = (data as PendingSubscriptionRecord[]) ?? []
  const expired: string[] = []

  for (const subscription of subscriptions) {
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

    expired.push(subscription.id)
  }

  return {
    scanned: subscriptions.length,
    expired,
  }
}
