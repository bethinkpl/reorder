import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  findCapturedPaymentForCart,
  findLivePaymentForCart,
  resolveLatestSavedPaymentMethod,
} from "../resolve-captured-payment-method"

function buildContainer(paymentMethods: { id: string, data?: Record<string, unknown> }[]) {
  return {
    resolve(key: string) {
      if (key === ContainerRegistrationKeys.QUERY) {
        return {
          graph: async () => ({
            data: [
              {
                id: "cus_1",
                account_holders: [
                  { id: "acch_1", provider_id: "pp_stripe_stripe", data: { id: "cus_x" } },
                ],
              },
            ],
          }),
        }
      }

      if (key === Modules.PAYMENT) {
        return { listPaymentMethods: async () => paymentMethods }
      }

      throw new Error(`Unexpected resolve('${key}')`)
    },
  } as unknown as MedusaContainer
}

describe("resolveLatestSavedPaymentMethod", () => {
  it("falls back to the provider's list order when no method has 'created'", async () => {
    const container = buildContainer([{ id: "pm_first" }, { id: "pm_second" }])

    const result = await resolveLatestSavedPaymentMethod(container, {
      customer_id: "cus_1",
      provider_id: "pp_stripe_stripe",
    })

    expect(result).toEqual({
      account_holder_id: "acch_1",
      payment_method_id: "pm_first",
    })
  })

  it("picks the method with the higher 'created' regardless of position", async () => {
    const container = buildContainer([
      { id: "pm_older", data: { created: 100 } },
      { id: "pm_newer", data: { created: 200 } },
    ])

    const result = await resolveLatestSavedPaymentMethod(container, {
      customer_id: "cus_1",
      provider_id: "pp_stripe_stripe",
    })

    expect(result).toEqual({
      account_holder_id: "acch_1",
      payment_method_id: "pm_newer",
    })
  })

  it("returns null when there are no saved payment methods", async () => {
    const container = buildContainer([])

    const result = await resolveLatestSavedPaymentMethod(container, {
      customer_id: "cus_1",
      provider_id: "pp_stripe_stripe",
    })

    expect(result).toBeNull()
  })
})

type CartPaymentStub = {
  id: string
  captured_at: string | null
  canceled_at?: string | null
  amount?: number
  refunds?: { amount: number }[]
}

function buildCartPaymentsContainer(
  payments: CartPaymentStub[],
  options: { hasPaymentCollection?: boolean } = {}
) {
  const hasPaymentCollection = options.hasPaymentCollection ?? true

  return {
    resolve(key: string) {
      if (key === ContainerRegistrationKeys.QUERY) {
        return {
          graph: async ({ entity }: { entity: string }) => {
            if (entity === "cart_payment_collection") {
              return {
                data: hasPaymentCollection ? [{ payment_collection_id: "paycol_1" }] : [],
              }
            }

            if (entity === "payment") {
              return {
                data: payments.map((payment) => ({
                  id: payment.id,
                  payment_collection_id: "paycol_1",
                  captured_at: payment.captured_at,
                  canceled_at: payment.canceled_at ?? null,
                  amount: payment.amount ?? 1000,
                  refunds: payment.refunds ?? [],
                })),
              }
            }

            return { data: [] }
          },
        }
      }

      throw new Error(`Unexpected resolve('${key}')`)
    },
  } as unknown as MedusaContainer
}

describe("findCapturedPaymentForCart", () => {
  it("returns null when the cart never got a payment collection", async () => {
    const container = buildCartPaymentsContainer([], { hasPaymentCollection: false })

    expect(await findCapturedPaymentForCart(container, "cart_1")).toBeNull()
  })

  it("returns null when nothing on the cart has captured yet", async () => {
    const container = buildCartPaymentsContainer([{ id: "pay_1", captured_at: null }])

    expect(await findCapturedPaymentForCart(container, "cart_1")).toBeNull()
  })

  it("excludes a canceled payment even though it carries a captured_at", async () => {
    const container = buildCartPaymentsContainer([
      {
        id: "pay_1",
        captured_at: "2026-09-01T00:00:00.000Z",
        canceled_at: "2026-09-02T00:00:00.000Z",
      },
    ])

    expect(await findCapturedPaymentForCart(container, "cart_1")).toBeNull()
  })

  it("excludes a payment refunded in full", async () => {
    const container = buildCartPaymentsContainer([
      {
        id: "pay_1",
        captured_at: "2026-09-01T00:00:00.000Z",
        amount: 1000,
        refunds: [{ amount: 600 }, { amount: 400 }],
      },
    ])

    expect(await findCapturedPaymentForCart(container, "cart_1")).toBeNull()
  })

  it("keeps a payment that was only refunded in part", async () => {
    const container = buildCartPaymentsContainer([
      {
        id: "pay_1",
        captured_at: "2026-09-01T00:00:00.000Z",
        amount: 1000,
        refunds: [{ amount: 200 }],
      },
    ])

    const result = await findCapturedPaymentForCart(container, "cart_1")

    expect(result?.id).toBe("pay_1")
  })

  it("picks the newest of two captured payments on the cart", async () => {
    const container = buildCartPaymentsContainer([
      { id: "pay_older", captured_at: "2026-09-01T00:00:00.000Z" },
      { id: "pay_newer", captured_at: "2026-09-03T00:00:00.000Z" },
    ])

    const result = await findCapturedPaymentForCart(container, "cart_1")

    expect(result?.id).toBe("pay_newer")
  })
})

describe("findLivePaymentForCart", () => {
  it("returns null when the cart never got a payment collection", async () => {
    const container = buildCartPaymentsContainer([], { hasPaymentCollection: false })

    expect(await findLivePaymentForCart(container, "cart_1")).toBeNull()
  })

  it("returns the payment once it has been authorized but not yet captured or canceled", async () => {
    const container = buildCartPaymentsContainer([{ id: "pay_1", captured_at: null }])

    const result = await findLivePaymentForCart(container, "cart_1")

    expect(result).toEqual({ id: "pay_1", payment_collection_id: "paycol_1" })
  })

  it("returns null once the payment has captured", async () => {
    const container = buildCartPaymentsContainer([
      { id: "pay_1", captured_at: "2026-09-01T00:00:00.000Z" },
    ])

    expect(await findLivePaymentForCart(container, "cart_1")).toBeNull()
  })

  it("returns null once the payment has been canceled", async () => {
    const container = buildCartPaymentsContainer([
      { id: "pay_1", captured_at: null, canceled_at: "2026-09-01T00:00:00.000Z" },
    ])

    expect(await findLivePaymentForCart(container, "cart_1")).toBeNull()
  })
})
