import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { resolveLatestSavedPaymentMethod } from "../resolve-captured-payment-method"

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
