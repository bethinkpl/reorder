import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { SUBSCRIPTION_MODULE } from "../../../modules/subscription"
import { SubscriptionStatus } from "../../../modules/subscription/types"
import { activateSubscriptionIfAlreadyPaid } from "../activate-subscription-if-already-paid"

type Staged = Record<string, unknown[]>

const paymentContext = {
  payment_provider_id: "pp_stripe_stripe",
  account_holder_id: "acch_1",
  payment_method_id: null,
}

function buildContainer(options: {
  status: SubscriptionStatus
  staged: Staged
  captured: Record<string, unknown>[]
  paymentMethods?: { id: string, data?: Record<string, unknown> }[]
}) {
  const { status, staged, captured } = options
  const paymentMethods = options.paymentMethods ?? [
    { id: "pm_new", data: { created: 200 } },
  ]

  return {
    resolve(key: string) {
      if (key === ContainerRegistrationKeys.QUERY) {
        return {
          graph: async ({ entity }: { entity: string }) => ({
            data: staged[entity] ?? [],
          }),
        }
      }

      if (key === Modules.PAYMENT) {
        return { listPaymentMethods: async () => paymentMethods }
      }

      if (key === SUBSCRIPTION_MODULE) {
        return {
          retrieveSubscription: async () => ({
            id: "sub_1",
            customer_id: "cus_1",
            status,
            payment_context: paymentContext,
          }),
          updateSubscriptions: async (input: Record<string, unknown>) => {
            captured.push(input)

            return input
          },
        }
      }

      throw new Error(`Unexpected resolve('${key}')`)
    },
  } as unknown as MedusaContainer
}

function capturedPayment() {
  return {
    cart_payment_collection: [{ payment_collection_id: "paycol_1" }],
    payment: [{ id: "pay_1", captured_at: "2026-09-15T10:00:00.000Z" }],
    customer: [
      {
        id: "cus_1",
        account_holders: [
          { id: "acch_1", provider_id: "pp_stripe_stripe", data: { id: "cus_x" } },
        ],
      },
    ],
  }
}

describe("activateSubscriptionIfAlreadyPaid", () => {
  it("activates when the capture landed before the subscription existed", async () => {
    const captured: Record<string, unknown>[] = []
    const container = buildContainer({
      status: SubscriptionStatus.PENDING_PAYMENT,
      staged: capturedPayment(),
      captured,
    })

    const result = await activateSubscriptionIfAlreadyPaid(container, {
      subscription_id: "sub_1",
      cart_id: "cart_1",
    })

    expect(result.output.activated).toBe(true)
    expect(captured).toEqual([
      {
        id: "sub_1",
        status: SubscriptionStatus.ACTIVE,
        payment_context: {
          payment_provider_id: "pp_stripe_stripe",
          account_holder_id: "acch_1",
          payment_method_id: "pm_new",
        },
      },
    ])
  })

  it("leaves the subscription pending while nothing is captured yet", async () => {
    const captured: Record<string, unknown>[] = []
    const container = buildContainer({
      status: SubscriptionStatus.PENDING_PAYMENT,
      staged: {
        cart_payment_collection: [{ payment_collection_id: "paycol_1" }],
        payment: [{ id: "pay_1", captured_at: null }],
      },
      captured,
    })

    const result = await activateSubscriptionIfAlreadyPaid(container, {
      subscription_id: "sub_1",
      cart_id: "cart_1",
    })

    expect(result.output.activated).toBe(false)
    expect(captured).toEqual([])
  })

  it("does not touch a subscription that is no longer pending", async () => {
    const captured: Record<string, unknown>[] = []
    const container = buildContainer({
      status: SubscriptionStatus.ACTIVE,
      staged: capturedPayment(),
      captured,
    })

    const result = await activateSubscriptionIfAlreadyPaid(container, {
      subscription_id: "sub_1",
      cart_id: "cart_1",
    })

    expect(result.output.activated).toBe(false)
    expect(captured).toEqual([])
  })
})
