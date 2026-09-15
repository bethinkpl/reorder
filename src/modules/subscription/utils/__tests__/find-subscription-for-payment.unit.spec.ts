import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { findSubscriptionIdForPaymentCollection } from "../find-subscription-for-payment"

type Staged = Record<string, unknown[]>

function buildContainer(staged: Staged) {
  return {
    resolve(key: string) {
      if (key === ContainerRegistrationKeys.QUERY) {
        return {
          graph: async ({ entity }: { entity: string }) => ({ data: staged[entity] ?? [] }),
        }
      }

      throw new Error(`Unexpected resolve('${key}')`)
    },
  } as unknown as MedusaContainer
}

const run = (staged: Staged) =>
  findSubscriptionIdForPaymentCollection(buildContainer(staged), "paycol_1")

describe("findSubscriptionIdForPaymentCollection", () => {
  it("resolves through the cart link of the collection the cart was completed with", async () => {
    const id = await run({
      cart_payment_collection: [{ cart_id: "cart_1" }],
      subscription: [{ id: "sub_1" }],
    })

    expect(id).toBe("sub_1")
  })

  it("resolves through the order link for a collection a later payment attempt created", async () => {
    const id = await run({
      cart_payment_collection: [],
      order_payment_collection: [{ order_id: "order_1" }],
      order: [{ id: "order_1", subscription: { id: "sub_1" } }],
    })

    expect(id).toBe("sub_1")
  })

  it("falls back to the order link when a cart link exists but carries no subscription", async () => {
    const id = await run({
      cart_payment_collection: [{ cart_id: "cart_1" }],
      subscription: [],
      order_payment_collection: [{ order_id: "order_1" }],
      order: [{ id: "order_1", subscription: { id: "sub_1" } }],
    })

    expect(id).toBe("sub_1")
  })

  it("answers null for a collection that belongs to no subscription", async () => {
    const id = await run({
      cart_payment_collection: [],
      order_payment_collection: [{ order_id: "order_1" }],
      order: [{ id: "order_1", subscription: null }],
    })

    expect(id).toBeNull()
  })

  it("answers null when the collection has neither link", async () => {
    expect(await run({})).toBeNull()
  })
})
