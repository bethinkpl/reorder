import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, PaymentEvents } from "@medusajs/framework/utils"
import { SUBSCRIPTION_MODULE } from "../modules/subscription"
import type SubscriptionModuleService from "../modules/subscription/service"
import {
  type SubscriptionPaymentContext,
  SubscriptionStatus,
  TERMINAL_SUBSCRIPTION_STATUSES,
} from "../modules/subscription/types"
import { findSubscriptionIdForPaymentCollection } from "../modules/subscription/utils/find-subscription-for-payment"
import { resolveLatestSavedPaymentMethod } from "../modules/subscription/utils/resolve-captured-payment-method"
import { ensureNextRenewalCycleWorkflow } from "../workflows/ensure-next-renewal-cycle"

type PaymentRecord = {
  id: string
  payment_collection_id: string | null
}

type SubscriptionRecord = {
  id: string
  customer_id: string
  status: SubscriptionStatus
  payment_context: SubscriptionPaymentContext | null
}

export default async function activateSubscriptionOnPaymentCapturedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  await activateSubscriptionOnPaymentCaptured(container, data.id)
}

export const config: SubscriberConfig = {
  event: PaymentEvents.CAPTURED,
}

export async function activateSubscriptionOnPaymentCaptured(
  container: MedusaContainer,
  paymentId: string
): Promise<void> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: payments } = await query.graph({
    entity: "payment",
    fields: ["id", "payment_collection_id"],
    filters: { id: paymentId },
  })
  const paymentCollectionId = (payments as PaymentRecord[])[0]?.payment_collection_id
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
    fields: ["id", "customer_id", "status", "payment_context"],
    filters: { id: subscriptionId },
  })
  const subscription = (subscriptions as SubscriptionRecord[])[0]
  if (!subscription) {
    return
  }

  const subscriptionModule = container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

  if (subscription.status === SubscriptionStatus.PENDING_PAYMENT) {
    await subscriptionModule.updateSubscriptions({
      id: subscription.id,
      status: SubscriptionStatus.ACTIVE,
    })

    await ensureNextRenewalCycleWorkflow(container).run({
      input: { subscription_id: subscription.id },
    })
  }

  if (TERMINAL_SUBSCRIPTION_STATUSES.includes(subscription.status)) {
    container.resolve("logger").error(
      JSON.stringify({
        domain: "subscriptions",
        event: "payment_captured_on_terminal_subscription",
        subscription_id: subscription.id,
        payment_id: paymentId,
        status: subscription.status,
        alertable: true,
      })
    )

    return
  }

  const paymentContext = subscription.payment_context
  const providerId = paymentContext?.payment_provider_id
  if (!providerId) {
    return
  }

  const resolved = await resolveLatestSavedPaymentMethod(container, {
    customer_id: subscription.customer_id,
    provider_id: providerId,
  })
  if (!resolved) {
    return
  }

  if (
    paymentContext?.payment_method_id === resolved.payment_method_id &&
    paymentContext?.account_holder_id === resolved.account_holder_id
  ) {
    return
  }

  await subscriptionModule.updateSubscriptions({
    id: subscription.id,
    payment_context: {
      payment_provider_id: providerId,
      account_holder_id: resolved.account_holder_id,
      payment_method_id: resolved.payment_method_id,
    } satisfies SubscriptionPaymentContext,
  })
}
