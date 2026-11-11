import type {
  IPaymentModuleService,
  MedusaContainer,
} from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

export const SYSTEM_PAYMENT_PROVIDER_ID = "pp_system_default"

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
