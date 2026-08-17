import type {
  IOrderModuleService,
  IPaymentModuleService,
  MedusaContainer,
} from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

type CaptureRecord = {
  id: string
  amount?: unknown
  raw_amount?: unknown
}

type CapturedPaymentRecord = {
  id: string
  currency_code: string
  captures?: CaptureRecord[] | null
}

/**
 * The `reference` value `capturePaymentWorkflow` writes its order transactions
 * under. Reusing it (together with the capture id as `reference_id`) is what
 * makes the provider webhook's later `addOrderTransactionStep` dedupe against
 * what we wrote here instead of double-counting it.
 */
const CAPTURE_TRANSACTION_REFERENCE = "capture"

/**
 * Records the order transactions for a payment's captures.
 *
 * Renewals capture through the payment module directly rather than through
 * `capturePaymentWorkflow`, because that workflow also emits
 * `PaymentEvents.CAPTURED` and the host app's subscribers on that event are not
 * all idempotent — the provider webhook already replays the workflow (and so the
 * event) once Stripe confirms, and emitting it a second time inline would
 * duplicate customer-facing side effects.
 *
 * Capturing through the module alone, though, writes no order transaction, so
 * `summary.pending_difference` keeps reporting the full total as outstanding.
 * That is what the reused-order guard in the renewal and dunning flows reads to
 * decide whether anything is still owed, so we write the same transactions the
 * workflow would have written — minus the event.
 *
 * Idempotent: mirrors `addOrderTransactionStep`'s dedupe on
 * `(order_id, reference, reference_id)`, so re-running this (a retry, or the
 * webhook getting there first) adds nothing.
 */
export async function recordOrderCaptureTransactions(
  container: MedusaContainer,
  orderId: string,
  paymentId: string
): Promise<void> {
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const orderModule = container.resolve<IOrderModuleService>(Modules.ORDER)

  // The capture rows are created by the module (on an auto-capturing provider
  // they already exist by the time `authorizePaymentSession` returns), and the
  // payment handed back by authorize/capture doesn't carry the relation.
  const payment = (await paymentModule.retrievePayment(paymentId, {
    select: ["id", "currency_code"],
    relations: ["captures"],
  })) as unknown as CapturedPaymentRecord

  const captures = payment.captures ?? []

  if (!captures.length) {
    return
  }

  const candidates = captures.map((capture) => ({
    order_id: orderId,
    amount: (capture.raw_amount ?? capture.amount) as any,
    currency_code: payment.currency_code,
    reference: CAPTURE_TRANSACTION_REFERENCE,
    reference_id: capture.id,
  }))

  const existing = await orderModule.listOrderTransactions(
    {
      $or: candidates.map((candidate) => ({
        order_id: candidate.order_id,
        reference: candidate.reference,
        reference_id: candidate.reference_id,
      })),
    } as any,
    { select: ["order_id", "reference", "reference_id"] }
  )

  const existingKeys = new Set(
    existing.map(
      (transaction) =>
        `${transaction.order_id}-${transaction.reference}-${transaction.reference_id}`
    )
  )

  const missing = candidates.filter(
    (candidate) =>
      !existingKeys.has(
        `${candidate.order_id}-${candidate.reference}-${candidate.reference_id}`
      )
  )

  if (!missing.length) {
    return
  }

  await orderModule.addOrderTransactions(missing)
}
