import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"

type CartPaymentCollectionRecord = { cart_id: string | null }

type OrderPaymentCollectionRecord = { order_id: string | null }

type OrderWithSubscription = { id: string, subscription?: { id: string } | null }

/**
 * Finds the subscription a payment collection belongs to.
 *
 * The collection the cart was completed with carries a cart link, but every later attempt
 * (`/store/orders/:id/payment-session`) gets a fresh collection linked only to the order, so the
 * cart lookup alone misses every retry.
 */
export async function findSubscriptionIdForPaymentCollection(
  container: MedusaContainer,
  paymentCollectionId: string
): Promise<string | null> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: cartLinks } = await query.graph({
    entity: "cart_payment_collection",
    fields: ["cart_id"],
    filters: { payment_collection_id: paymentCollectionId },
  })

  const cartId = (cartLinks as CartPaymentCollectionRecord[])[0]?.cart_id

  if (cartId) {
    const { data: subscriptions } = await query.graph({
      entity: "subscription",
      fields: ["id"],
      filters: { cart_id: cartId },
    })

    const subscriptionId = (subscriptions as Array<{ id: string }>)[0]?.id

    if (subscriptionId) {
      return subscriptionId
    }
  }

  const { data: orderLinks } = await query.graph({
    entity: "order_payment_collection",
    fields: ["order_id"],
    filters: { payment_collection_id: paymentCollectionId },
  })

  const orderId = (orderLinks as OrderPaymentCollectionRecord[])[0]?.order_id

  if (!orderId) {
    return null
  }

  const { data: orders } = await query.graph({
    entity: "order",
    fields: ["id", "subscription.id"],
    filters: { id: orderId },
  })

  return (orders as OrderWithSubscription[])[0]?.subscription?.id ?? null
}
