import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import type { IPaymentModuleService, MedusaContainer } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
  PaymentActions,
  PaymentWebhookEvents,
} from "@medusajs/framework/utils"
import { SubscriptionStatus } from "../modules/subscription/types"
import { cancelAbandonedSubscription } from "../modules/subscription/utils/cancel-abandoned-subscription"
import { findSubscriptionIdForPaymentCollection } from "../modules/subscription/utils/find-subscription-for-payment"
import { failAwaitingDunningAttempt } from "../workflows/utils/fail-awaiting-dunning-attempt"
import { failAwaitingRenewalCycle } from "../workflows/utils/fail-awaiting-renewal-cycle"

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
  context: Record<string, unknown> | null
}

type DecodedWebhookData = {
  session_id?: string
  reason?: unknown
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

/** Rethrows after logging, so that the event bus delivers the failure again. */
async function reportingFailure(
  container: MedusaContainer,
  context: {
    event: string
    payment_session_id: string
    renewal_cycle_id?: string
    dunning_case_id?: string
  },
  run: () => Promise<unknown>
) {
  try {
    await run()
  } catch (error) {
    container.resolve("logger").error(
      JSON.stringify({
        domain: "subscriptions",
        ...context,
        alertable: true,
        message: error instanceof Error ? error.message : String(error),
      })
    )

    throw error
  }
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
  const decoded = processed?.data as DecodedWebhookData | undefined
  const sessionId = decoded?.session_id

  if (!processed?.action || !FAILURE_ACTIONS.includes(processed.action) || !sessionId) {
    return
  }

  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: sessions } = await query.graph({
    entity: "payment_session",
    fields: ["id", "payment_collection_id", "context"],
    filters: { id: sessionId },
  })

  const session: PaymentSessionRecord | undefined = sessions[0]
  const renewalCycleId = session?.context?.renewal_cycle_id
  const dunningCaseId = session?.context?.dunning_case_id
  const reason =
    typeof decoded?.reason === "string" && decoded.reason ? decoded.reason : null

  if (typeof renewalCycleId === "string" && renewalCycleId) {
    await reportingFailure(
      container,
      {
        event: "renewal_payment_failure_handling_failed",
        payment_session_id: sessionId,
        renewal_cycle_id: renewalCycleId,
      },
      () =>
        failAwaitingRenewalCycle(container, {
          renewal_cycle_id: renewalCycleId,
          session_id: sessionId,
          action: processed.action,
          reason,
        })
    )

    return
  }

  if (typeof dunningCaseId === "string" && dunningCaseId) {
    await reportingFailure(
      container,
      {
        event: "dunning_payment_failure_handling_failed",
        payment_session_id: sessionId,
        dunning_case_id: dunningCaseId,
      },
      () =>
        failAwaitingDunningAttempt(container, {
          session_id: sessionId,
          action: processed.action,
          reason,
        })
    )

    return
  }

  const paymentCollectionId = session?.payment_collection_id

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
