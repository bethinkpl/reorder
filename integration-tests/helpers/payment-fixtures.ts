import type {
  IPaymentModuleService,
  MedusaContainer,
} from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
  PaymentActions,
  PaymentEvents,
  PaymentWebhookEvents,
} from "@medusajs/framework/utils"
import activateSubscriptionOnPaymentCapturedHandler from "../../src/subscribers/activate-subscription-on-payment-captured"
import cancelPendingSubscriptionOnPaymentFailureHandler from "../../src/subscribers/cancel-pending-subscription-on-payment-failure"
import { recordOrderCaptureTransactions } from "../../src/workflows/utils/record-order-capture-transactions"

export const SYSTEM_PAYMENT_PROVIDER_ID = "pp_system_default"

const webhookEvent = {
  provider: "pp_test_provider",
  payload: { data: {}, rawData: Buffer.from("{}"), headers: {} },
}

type PaymentSessionFixtureInput = {
  amount?: number
  currency_code?: string
  context?: Record<string, unknown>
}

export async function createPaymentSessionFixture(
  container: MedusaContainer,
  input: PaymentSessionFixtureInput = {}
) {
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const amount = input.amount ?? 100
  const currencyCode = input.currency_code ?? "pln"

  const collection = await paymentModule.createPaymentCollections({
    currency_code: currencyCode,
    amount,
  })
  const session = await paymentModule.createPaymentSession(collection.id, {
    provider_id: SYSTEM_PAYMENT_PROVIDER_ID,
    currency_code: currencyCode,
    amount,
    data: {},
    context: input.context ?? {},
  })

  return { collection, session }
}

export async function authorizeAndCapturePaymentSession(
  container: MedusaContainer,
  sessionId: string
) {
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const payment = await paymentModule.authorizePaymentSession(sessionId, {})

  return await paymentModule.capturePayment({
    payment_id: payment.id,
    amount: payment.amount,
  })
}

export async function captureOnOrder(
  container: MedusaContainer,
  orderId: string,
  sessionId: string,
  options: { linkCollection?: boolean } = {}
) {
  if (options.linkCollection) {
    const session = await container
      .resolve<IPaymentModuleService>(Modules.PAYMENT)
      .retrievePaymentSession(sessionId)

    await container.resolve(ContainerRegistrationKeys.LINK).create({
      [Modules.ORDER]: { order_id: orderId },
      [Modules.PAYMENT]: { payment_collection_id: session.payment_collection_id },
    })
  }

  const payment = await authorizeAndCapturePaymentSession(container, sessionId)

  await recordOrderCaptureTransactions(container, orderId, payment.id)

  return payment
}

export async function deliverCapture(container: MedusaContainer, paymentId: string) {
  await activateSubscriptionOnPaymentCapturedHandler({
    event: { name: PaymentEvents.CAPTURED, data: { id: paymentId } },
    container,
    pluginOptions: {},
  })
}

export async function deliverFailure(
  container: MedusaContainer,
  sessionId: string,
  { action = PaymentActions.FAILED, reason }: { action?: string, reason?: string } = {}
) {
  const decoder: jest.SpyInstance = jest.spyOn(
    container.resolve<IPaymentModuleService>(Modules.PAYMENT),
    "getWebhookActionAndData"
  )

  decoder.mockResolvedValue({
    action,
    data: { session_id: sessionId, ...(reason ? { reason } : {}) },
  })

  await cancelPendingSubscriptionOnPaymentFailureHandler({
    event: { name: PaymentWebhookEvents.WebhookReceived, data: webhookEvent },
    container,
    pluginOptions: {},
  })
}
