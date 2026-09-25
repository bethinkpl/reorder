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
  orderId: string,
  includeUnrecovered: boolean
) {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)

  const cases = (await dunningModule.listDunningCases(
    { renewal_order_id: orderId } as never,
    { order: { created_at: "DESC" } }
  )) as DunningCaseRecord[]

  return (
    cases.find((entry) => !CLOSED_DUNNING_STATUSES.includes(entry.status)) ??
    cases.find((entry) => entry.status === DunningCaseStatus.RECOVERED) ??
    (includeUnrecovered ? cases[0] ?? null : null)
  )
}

/**
 * Runs the recovery for whatever case the captured order carries. Answers whether one was found.
 *
 * Swallows its failures on purpose: a throwing subscriber is logged and dropped (the local bus
 * catches, the Redis bus defaults to a single attempt), so raising here would lose the recovery
 * rather than retry it. `reconcile-paid-dunning-cases` is what picks the case up afterwards.
 */
async function runDunningRecovery(
  container: MedusaContainer,
  input: {
    order_id: string
    subscription_id: string
    payment_id: string
    /** Only a churned subscription wants the settled case: the step's log names its remedy. */
    include_unrecovered?: boolean
  }
) {
  const dunningCase = await findDunningCaseForOrder(
    container,
    input.order_id,
    Boolean(input.include_unrecovered)
  )

  if (!dunningCase) {
    return false
  }

  try {
    await recoverDunningFromCapturedPaymentWorkflow(container).run({
      input: { dunning_case_id: dunningCase.id, payment_id: input.payment_id },
    })
  } catch (error) {
    container.resolve("logger").error(
      JSON.stringify({
        domain: "subscriptions",
        event: "dunning_recovery_from_capture_failed",
        subscription_id: input.subscription_id,
        dunning_case_id: dunningCase.id,
        payment_id: input.payment_id,
        alertable: true,
        message: error instanceof Error ? error.message : String(error),
      })
    )
  }

  return true
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
    // An involuntary churn the customer has just paid off: the case on that order names the
    // remedy (`reverseInvoluntaryChurnWorkflow`), which the generic line below cannot.
    if (
      subscription.status === SubscriptionStatus.PAYMENT_FAILED &&
      orderId &&
      (await runDunningRecovery(container, {
        order_id: orderId,
        subscription_id: subscription.id,
        payment_id: paymentId,
        include_unrecovered: true,
      }))
    ) {
      return
    }

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

  await runDunningRecovery(container, {
    order_id: orderId,
    subscription_id: subscription.id,
    payment_id: paymentId,
  })
}
