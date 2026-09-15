import type { IPaymentModuleService, MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

export type CapturedPaymentRecord = {
  id: string
  payment_collection_id: string | null
  captured_at: string | Date | null
}

type CartPaymentCollectionRecord = { payment_collection_id: string | null }

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

/**
 * Finds a captured payment on the collection the cart was completed with.
 */
export async function findCapturedPaymentForCart(
  container: MedusaContainer,
  cartId: string
): Promise<CapturedPaymentRecord | null> {
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
    return null
  }

  const { data: payments } = await query.graph({
    entity: "payment",
    fields: ["id", "payment_collection_id", "captured_at"],
    filters: { payment_collection_id: collectionIds },
  })

  return (
    (payments as CapturedPaymentRecord[]).find((payment) => !!payment.captured_at) ??
    null
  )
}
