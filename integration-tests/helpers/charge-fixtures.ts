import type { IOrderModuleService, IPaymentModuleService, MedusaContainer, PaymentSessionDTO } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
  PaymentActions,
  PaymentEvents,
  PaymentSessionStatus,
  PaymentWebhookEvents,
} from "@medusajs/framework/utils"
import { SystemPaymentProvider } from "@medusajs/payment/dist/providers/system"
import activateSubscriptionOnPaymentCapturedHandler from "../../src/subscribers/activate-subscription-on-payment-captured"
import cancelPendingSubscriptionOnPaymentFailureHandler from "../../src/subscribers/cancel-pending-subscription-on-payment-failure"
import { processRenewalCycleWorkflow } from "../../src/workflows"
import { recordOrderCaptureTransactions } from "../../src/workflows/utils/record-order-capture-transactions"
import { chargeMocks } from "./core-flow-mocks"

export const RENEWAL_AMOUNT = 129
export const SYSTEM_PAYMENT_PROVIDER_ID = "pp_system_default"

type GraphInput = { entity: string, filters?: { id?: string[] } }
type GraphQuery = { graph: (input: GraphInput, options?: unknown) => Promise<{ data: unknown[] }> }
type SessionInput = { payment_collection_id: string, data?: Record<string, unknown>, context?: Record<string, unknown> }

export async function createUnpaidOrder(container: MedusaContainer) {
  return await container.resolve<IOrderModuleService>(Modules.ORDER).createOrders({
    currency_code: "pln",
    email: "customer@example.com",
    items: [{ title: "Subscription renewal", quantity: 1, unit_price: RENEWAL_AMOUNT }],
  })
}

export async function createOrderPaymentCollection(container: MedusaContainer, orderId: string, amount = RENEWAL_AMOUNT) {
  const payments = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const collection = await payments.createPaymentCollections({ currency_code: "pln", amount })

  await container.resolve(ContainerRegistrationKeys.LINK).create({
    [Modules.ORDER]: { order_id: orderId },
    [Modules.PAYMENT]: { payment_collection_id: collection.id },
  })

  return collection
}

export async function createSystemPaymentSession(container: MedusaContainer, input: SessionInput) {
  const payments = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const { amount, currency_code } = await payments.retrievePaymentCollection(input.payment_collection_id)

  return await payments.createPaymentSession(input.payment_collection_id, {
    provider_id: SYSTEM_PAYMENT_PROVIDER_ID,
    currency_code,
    amount,
    data: input.data ?? {},
    context: input.context ?? {},
  })
}

export function routeChargesToFixtures(container: MedusaContainer) {
  const query = container.resolve<GraphQuery>(ContainerRegistrationKeys.QUERY)
  const graph = query.graph.bind(query)
  const charges = { orders: [] as string[], sessions: [] as PaymentSessionDTO[] }
  const cart = (id?: string) => ({
    id,
    region_id: "reg_test",
    sales_channel_id: "sc_test",
    currency_code: "pln",
    shipping_address: { first_name: "Jan", last_name: "Kowalski", country_code: "PL" },
    items: [{ title: "Cart Item", quantity: 1, unit_price: RENEWAL_AMOUNT }],
    shipping_methods: [],
  })

  jest.spyOn(query, "graph").mockImplementation(async (input, options) =>
    input.entity === "cart" ? { data: [cart(input.filters?.id?.[0])] } : await graph(input, options)
  )
  chargeMocks.createOrderRun.mockImplementation(async () => {
    const order = await createUnpaidOrder(container)

    charges.orders.push(order.id)

    return { result: order }
  })
  chargeMocks.createOrUpdateOrderPaymentCollectionRun.mockImplementation(
    async ({ input }: { input: { order_id: string, amount: number } }) => ({
      result: [await createOrderPaymentCollection(container, input.order_id, input.amount)],
    })
  )
  chargeMocks.createPaymentSessionsRun.mockImplementation(async ({ input }: { input: SessionInput }) => {
    const session = await createSystemPaymentSession(container, input)

    charges.sessions.push(session)

    return { result: session }
  })

  return charges
}

// Medusa >= 2.17.2 marks the session `pending_authorization` and answers `null` when the provider does.
export function answerAuthorizationWithNull() {
  return jest
    .spyOn(SystemPaymentProvider.prototype, "authorizePayment")
    .mockResolvedValue({ data: {}, status: PaymentSessionStatus.PENDING_AUTHORIZATION })
}

export async function runRenewal(
  container: MedusaContainer,
  renewalCycleId: string,
  { trigger_type = "scheduler", correlation_id }: { trigger_type?: "scheduler" | "manual", correlation_id?: string } = {}
) {
  const { result } = await processRenewalCycleWorkflow(container).run({
    input: { renewal_cycle_id: renewalCycleId, trigger_type, correlation_id },
  })

  return result
}

export async function captureOnOrder(container: MedusaContainer, orderId: string, sessionId: string) {
  const payments = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const payment = await payments.authorizePaymentSession(sessionId, {})

  if (!payment) {
    throw new Error(`Session '${sessionId}' is still pending authorisation`)
  }

  await payments.capturePayment({ payment_id: payment.id, amount: payment.amount })
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
  { reason }: { reason?: string } = {}
) {
  const decoder: jest.SpyInstance = jest.spyOn(container.resolve(Modules.PAYMENT), "getWebhookActionAndData")

  decoder.mockResolvedValue({ action: PaymentActions.FAILED, data: { session_id: sessionId, ...(reason ? { reason } : {}) } })

  await cancelPendingSubscriptionOnPaymentFailureHandler({
    event: {
      name: PaymentWebhookEvents.WebhookReceived,
      data: { provider: "pp_test_provider", payload: { data: {}, rawData: Buffer.from("{}"), headers: {} } },
    },
    container,
    pluginOptions: {},
  })
}
