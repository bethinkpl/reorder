import type { IPaymentModuleService, MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

export type CapturedPaymentRecord = {
  id: string
  payment_collection_id: string | null
  captured_at: string | Date | null
}

export type LivePaymentRecord = {
  id: string
  payment_collection_id: string | null
}

type CartPaymentCollectionRecord = { payment_collection_id: string | null }

type CartPaymentRecord = {
  id: string
  payment_collection_id: string | null
  captured_at: string | Date | null
  canceled_at: string | Date | null
  amount: number | string | null
  refunds?: { amount: number | string | null }[] | null
}

type CustomerAccountHolderRecord = {
  account_holders?:
    | {
      id: string
      provider_id: string
      data?: Record<string, unknown> | null
    }[]
    | null
}

export type ResolvedSavedPaymentMethod = {
  account_holder_id: string
  payment_method_id: string
}

/**
 * Resolves the card a subscription should be charged with: the newest method saved on the
 * customer's account holder for the provider. A customer who re-enters a card at checkout, or
 * replaces an expired one, ends up with that card as the newest, so the subscription follows it.
 */
export async function resolveLatestSavedPaymentMethod(
  container: MedusaContainer,
  input: { customer_id: string, provider_id: string }
): Promise<ResolvedSavedPaymentMethod | null> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: customers } = await query.graph({
    entity: "customer",
    fields: [
      "id",
      "account_holders.id",
      "account_holders.provider_id",
      "account_holders.data",
    ],
    filters: { id: input.customer_id },
  })

  const accountHolder = (customers as CustomerAccountHolderRecord[])[0]?.account_holders?.find(
    (entry) => entry.provider_id === input.provider_id
  )

  if (!accountHolder?.id) {
    return null
  }

  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const paymentMethods = await paymentModule.listPaymentMethods({
    provider_id: input.provider_id,
    context: {
      account_holder: {
        ...accountHolder,
        data: accountHolder.data ?? {},
      },
    },
  })

  const latest = paymentMethods.slice().sort((left, right) => {
    const leftCreated = Number(left.data?.created) || 0
    const rightCreated = Number(right.data?.created) || 0

    return rightCreated - leftCreated
  })[0]

  if (!latest?.id) {
    return null
  }

  return {
    account_holder_id: accountHolder.id,
    payment_method_id: latest.id,
  }
}

async function listPaymentsForCart(
  container: MedusaContainer,
  cartId: string
): Promise<CartPaymentRecord[]> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: cartLinks } = await query.graph({
    entity: "cart_payment_collection",
    fields: ["payment_collection_id"],
    filters: { cart_id: cartId },
  })

  const collectionIds = (cartLinks as CartPaymentCollectionRecord[])
    .map((link) => link.payment_collection_id)
    .filter((id): id is string => !!id)

  if (!collectionIds.length) {
    return []
  }

  const { data: payments } = await query.graph({
    entity: "payment",
    fields: [
      "id",
      "payment_collection_id",
      "captured_at",
      "canceled_at",
      "amount",
      "refunds.amount",
    ],
    filters: { payment_collection_id: collectionIds },
  })

  return payments as CartPaymentRecord[]
}

function isRefundedInFull(payment: CartPaymentRecord): boolean {
  const amount = Number(payment.amount) || 0
  const refunded = (payment.refunds ?? []).reduce(
    (sum, refund) => sum + (Number(refund.amount) || 0),
    0
  )

  return amount > 0 && refunded >= amount
}

/**
 * Finds a captured payment on the collection the cart was completed with. Excludes a payment
 * that was later voided or refunded in full, and picks the most recently captured one when the
 * cart carries more than one (a retried authorization after a decline, for example).
 */
export async function findCapturedPaymentForCart(
  container: MedusaContainer,
  cartId: string
): Promise<CapturedPaymentRecord | null> {
  const payments = await listPaymentsForCart(container, cartId)

  const captured = payments.filter(
    (payment) => !!payment.captured_at && !payment.canceled_at && !isRefundedInFull(payment)
  )

  if (!captured.length) {
    return null
  }

  const newest = captured.reduce((latest, payment) =>
    new Date(payment.captured_at as string).getTime() >
      new Date(latest.captured_at as string).getTime()
      ? payment
      : latest
  )

  return {
    id: newest.id,
    payment_collection_id: newest.payment_collection_id,
    captured_at: newest.captured_at,
  }
}

/**
 * Finds a payment on the cart that has been authorized but not yet captured or canceled. A
 * `payment` row only exists once its session has been authorized, so `captured_at` and
 * `canceled_at` both unset is exactly that live window — the whole life of a delayed-capture
 * method (SEPA, bank debit, manual capture) before it settles. The `pending_payment` sweeper
 * defers expiring a subscription while one of these is outstanding so a late capture is not
 * orphaned.
 */
export async function findLivePaymentForCart(
  container: MedusaContainer,
  cartId: string
): Promise<LivePaymentRecord | null> {
  const payments = await listPaymentsForCart(container, cartId)

  const live = payments.find((payment) => !payment.captured_at && !payment.canceled_at)

  if (!live) {
    return null
  }

  return { id: live.id, payment_collection_id: live.payment_collection_id }
}
