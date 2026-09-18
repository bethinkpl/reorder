import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"

type CartPaymentCollectionRecord = { cart_id: string | null }

type OrderPaymentCollectionRecord = { order_id: string | null }

type OrderWithSubscription = {
  id: string
  subscription?: { id: string } | null
  metadata?: Record<string, unknown> | null
}

export type PaymentCollectionOwner = {
  subscription_id: string | null
  order_id: string | null
}

async function subscriptionExists(
  container: MedusaContainer,
  subscriptionId: string
) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data } = await query.graph({
    entity: "subscription",
    fields: ["id"],
    filters: { id: subscriptionId },
  })

  return Boolean((data as Array<{ id: string }>)[0]?.id)
}

/**
 * Finds the subscription and the order a payment collection belongs to.
 *
 * The collection the cart was completed with carries a cart link, but every later attempt
 * (`/store/orders/:id/payment-session`) gets a fresh collection linked only to the order, so the
 * cart lookup alone misses every retry.
 *
 * `order.metadata.subscription_id`, written when the order is created, is the last resort: it is
 * the only marker an order carries that predates this plugin linking renewal orders at creation.
 */
export async function findSubscriptionAndOrderForPaymentCollection(
  container: MedusaContainer,
  paymentCollectionId: string
): Promise<PaymentCollectionOwner> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: cartLinks } = await query.graph({
    entity: "cart_payment_collection",
    fields: ["cart_id"],
    filters: { payment_collection_id: paymentCollectionId },
  })

  const cartId = (cartLinks as CartPaymentCollectionRecord[])[0]?.cart_id
  let cartSubscriptionId: string | null = null

  if (cartId) {
    const { data: subscriptions } = await query.graph({
      entity: "subscription",
      fields: ["id"],
      filters: { cart_id: cartId },
    })

    cartSubscriptionId = (subscriptions as Array<{ id: string }>)[0]?.id ?? null
  }

  const { data: orderLinks } = await query.graph({
    entity: "order_payment_collection",
    fields: ["order_id"],
    filters: { payment_collection_id: paymentCollectionId },
  })

  const orderId = (orderLinks as OrderPaymentCollectionRecord[])[0]?.order_id ?? null

  if (!orderId) {
    return { subscription_id: cartSubscriptionId, order_id: null }
  }

  const { data: orders } = await query.graph({
    entity: "order",
    fields: ["id", "metadata", "subscription.id"],
    filters: { id: orderId },
  })

  const order = (orders as OrderWithSubscription[])[0]

  if (cartSubscriptionId) {
    return { subscription_id: cartSubscriptionId, order_id: orderId }
  }

  if (order?.subscription?.id) {
    return { subscription_id: order.subscription.id, order_id: orderId }
  }

  const metadataSubscriptionId = order?.metadata?.subscription_id

  if (
    typeof metadataSubscriptionId === "string" &&
    (await subscriptionExists(container, metadataSubscriptionId))
  ) {
    return { subscription_id: metadataSubscriptionId, order_id: orderId }
  }

  return { subscription_id: null, order_id: orderId }
}

export async function findSubscriptionIdForPaymentCollection(
  container: MedusaContainer,
  paymentCollectionId: string
): Promise<string | null> {
  const { subscription_id: subscriptionId } =
    await findSubscriptionAndOrderForPaymentCollection(
      container,
      paymentCollectionId
    )

  return subscriptionId
}
