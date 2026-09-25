import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  findSubscriptionAndOrderForPaymentCollection,
  findSubscriptionIdForPaymentCollection,
} from "../find-subscription-for-payment"

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

  it("falls back to the subscription id the renewal order carries in its metadata", async () => {
    const id = await run({
      cart_payment_collection: [],
      order_payment_collection: [{ order_id: "order_1" }],
      order: [
        { id: "order_1", subscription: null, metadata: { subscription_id: "sub_1" } },
      ],
      subscription: [{ id: "sub_1" }],
    })

    expect(id).toBe("sub_1")
  })

  it("ignores a metadata subscription id that resolves to nothing", async () => {
    const id = await run({
      cart_payment_collection: [],
      order_payment_collection: [{ order_id: "order_1" }],
      order: [
        { id: "order_1", subscription: null, metadata: { subscription_id: "sub_gone" } },
      ],
      subscription: [],
    })

    expect(id).toBeNull()
  })

  it("prefers the order link over the order metadata", async () => {
    const id = await run({
      cart_payment_collection: [],
      order_payment_collection: [{ order_id: "order_1" }],
      order: [
        {
          id: "order_1",
          subscription: { id: "sub_linked" },
          metadata: { subscription_id: "sub_meta" },
        },
      ],
      subscription: [{ id: "sub_meta" }],
    })

    expect(id).toBe("sub_linked")
  })

  it("reports the order the collection belongs to alongside the subscription", async () => {
    const owner = await findSubscriptionAndOrderForPaymentCollection(
      buildContainer({
        cart_payment_collection: [],
        order_payment_collection: [{ order_id: "order_1" }],
        order: [
          { id: "order_1", subscription: null, metadata: { subscription_id: "sub_1" } },
        ],
        subscription: [{ id: "sub_1" }],
      }),
      "paycol_1"
    )

    expect(owner).toEqual({ subscription_id: "sub_1", order_id: "order_1" })
  })
})
