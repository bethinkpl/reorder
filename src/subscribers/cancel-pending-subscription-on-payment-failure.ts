import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import type { IPaymentModuleService, MedusaContainer } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
  PaymentActions,
  PaymentWebhookEvents,
} from "@medusajs/framework/utils"
import { SubscriptionStatus } from "../modules/subscription/types"
import { cancelAbandonedSubscription } from "../modules/subscription/utils/expire-pending-payment"
import { findSubscriptionIdForPaymentCollection } from "../modules/subscription/utils/find-subscription-for-payment"

type WebhookEventData = {
  provider: string
  payload: {
    data: unknown
    rawData: Buffer | { type: string, data: number[] }
    headers: Record<string, unknown>
  }
}

type PaymentSessionRecord = {
  id: string
  payment_collection_id: string | null
}

type SubscriptionRecord = {
  id: string
  status: SubscriptionStatus
  metadata: Record<string, unknown> | null
}

const FAILURE_ACTIONS: string[] = [PaymentActions.CANCELED, PaymentActions.FAILED]

export default async function cancelPendingSubscriptionOnPaymentFailureHandler({
  event,
  container,
}: SubscriberArgs<WebhookEventData>) {
  await cancelPendingSubscriptionOnPaymentFailure(container, event.data)
}

export const config: SubscriberConfig = {
  event: PaymentWebhookEvents.WebhookReceived,
  context: {
    subscriberId: "cancel-pending-subscription-on-payment-failure",
  },
}

export async function cancelPendingSubscriptionOnPaymentFailure(
  container: MedusaContainer,
  data: WebhookEventData
): Promise<void> {
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)

  const input = { ...data, payload: { ...data.payload } }

  // The event round-trips through the bus, which serialises the raw body.
  if ((input.payload.rawData as { type?: string })?.type === "Buffer") {
    input.payload.rawData = Buffer.from(
      (input.payload.rawData as { data: number[] }).data
    )
  }

  const processed = await paymentModule.getWebhookActionAndData(input as never)
  const sessionId = (processed?.data as { session_id?: string } | undefined)?.session_id

  if (!processed?.action || !FAILURE_ACTIONS.includes(processed.action) || !sessionId) {
    return
  }

  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: sessions } = await query.graph({
    entity: "payment_session",
    fields: ["id", "payment_collection_id"],
    filters: { id: sessionId },
  })

  const paymentCollectionId = (sessions as PaymentSessionRecord[])[0]?.payment_collection_id

  if (!paymentCollectionId) {
    return
  }

  const subscriptionId = await findSubscriptionIdForPaymentCollection(
    container,
    paymentCollectionId
  )

  if (!subscriptionId) {
    return
  }

  const { data: subscriptions } = await query.graph({
    entity: "subscription",
    fields: ["id", "status", "metadata"],
    filters: { id: subscriptionId },
  })

  const subscription = (subscriptions as SubscriptionRecord[])[0]

  if (!subscription || subscription.status !== SubscriptionStatus.PENDING_PAYMENT) {
    return
  }

  await cancelAbandonedSubscription(container, subscription, new Date())

  container.resolve("logger").info(
    `Cancelled subscription '${subscription.id}' after the provider reported '${processed.action}' for its initial payment`
  )
}
