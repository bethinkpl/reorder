import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, PaymentEvents } from "@medusajs/framework/utils"
import { DUNNING_MODULE } from "../modules/dunning"
import type DunningModuleService from "../modules/dunning/service"
import { DunningCaseStatus } from "../modules/dunning/types"
import { SUBSCRIPTION_MODULE } from "../modules/subscription"
import type SubscriptionModuleService from "../modules/subscription/service"
import {
  type SubscriptionPaymentContext,
  SubscriptionStatus,
  TERMINAL_SUBSCRIPTION_STATUSES,
} from "../modules/subscription/types"
import { findSubscriptionAndOrderForPaymentCollection } from "../modules/subscription/utils/find-subscription-for-payment"
import { refreshSubscriptionPaymentContext } from "../modules/subscription/utils/resolve-captured-payment-method"
import { ensureNextRenewalCycleWorkflow } from "../workflows/ensure-next-renewal-cycle"
import { recoverDunningFromCapturedPaymentWorkflow } from "../workflows/recover-dunning-from-captured-payment"

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

type DunningCaseRecord = {
  id: string
  status: DunningCaseStatus
}

const CLOSED_DUNNING_STATUSES: readonly DunningCaseStatus[] = [
  DunningCaseStatus.RECOVERED,
  DunningCaseStatus.UNRECOVERED,
]

export default async function activateSubscriptionOnPaymentCapturedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  await activateSubscriptionOnPaymentCaptured(container, data.id)
}

export const config: SubscriberConfig = {
  event: PaymentEvents.CAPTURED,
}

/**
 * The case this capture should close: the newest open one on the order, or - failing that - the
 * newest closed-as-recovered one, whose renewal cycle may still be waiting to be settled.
 */
async function findDunningCaseForOrder(
  container: MedusaContainer,
  orderId: string
) {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)

  const cases = (await dunningModule.listDunningCases(
    { renewal_order_id: orderId } as never,
    { order: { created_at: "DESC" } }
  )) as DunningCaseRecord[]

  return (
    cases.find((entry) => !CLOSED_DUNNING_STATUSES.includes(entry.status)) ??
    cases.find((entry) => entry.status === DunningCaseStatus.RECOVERED) ??
    null
  )
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

  const { subscription_id: subscriptionId, order_id: orderId } =
    await findSubscriptionAndOrderForPaymentCollection(
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

  // Runs before the recovery below, and independently of it: the card the customer just paid with
  // has to land on the subscription even if closing the dunning case throws.
  await refreshSubscriptionPaymentContext(container, subscription)

  if (!orderId) {
    return
  }

  const dunningCase = await findDunningCaseForOrder(container, orderId)

  if (!dunningCase) {
    return
  }

  // Deliberately unguarded: a failure here has to reach the event bus, which redelivers.
  await recoverDunningFromCapturedPaymentWorkflow(container).run({
    input: { dunning_case_id: dunningCase.id, payment_id: paymentId },
  })
}
