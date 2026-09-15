import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import { SubscriptionStatus } from "../../modules/subscription/types"
import { activateSubscriptionOnPaymentCaptured } from "../activate-subscription-on-payment-captured"

type Staged = Record<string, unknown[]>

type UpdateCall = { id: string, status?: unknown, payment_context?: unknown }

type PaymentMethodStub = { id: string, data?: Record<string, unknown> }

const activationCall = { id: "sub_1", status: SubscriptionStatus.ACTIVE }

function defaultStaged(): Staged {
  return {
    payment: [{ id: "pay_1", payment_collection_id: "paycol_1" }],
    cart_payment_collection: [{ cart_id: "cart_1" }],
    subscription: [
      {
        id: "sub_1",
        customer_id: "cus_1",
        status: SubscriptionStatus.PENDING_PAYMENT,
        payment_context: {
          payment_provider_id: "pp_stripe_stripe",
          account_holder_id: "acch_1",
          payment_method_id: null,
        },
      },
    ],
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

function stagedSubscription(staged: Staged) {
  return staged.subscription[0] as Record<string, unknown>
}

function buildContainer(options: {
  staged: Staged
  paymentMethods: PaymentMethodStub[]
  captured: UpdateCall[]
}) {
  const { staged, paymentMethods, captured } = options

  const query = {
    graph: async ({ entity }: { entity: string }) => ({ data: staged[entity] ?? [] }),
  }
  const paymentModule = {
    listPaymentMethods: async () => paymentMethods,
  }
  const subscriptionModule = {
    updateSubscriptions: async (input: UpdateCall) => {
      captured.push(input)

      return input
    },
  }

  // Medusa's container is an awilix instance; this test-only stub is cast at the boundary.
  return {
    resolve(key: string) {
      if (key === ContainerRegistrationKeys.QUERY) {
        return query
      }

      if (key === Modules.PAYMENT) {
        return paymentModule
      }

      if (key === SUBSCRIPTION_MODULE) {
        return subscriptionModule
      }

      throw new Error(`Unexpected resolve('${key}')`)
    },
  } as unknown as MedusaContainer
}

describe("activateSubscriptionOnPaymentCaptured", () => {
  it("activates the subscription and writes the latest saved method back onto it", async () => {
    const captured: UpdateCall[] = []
    const container = buildContainer({
      staged: defaultStaged(),
      paymentMethods: [
        { id: "pm_new", data: { created: 200 } },
        { id: "pm_old", data: { created: 100 } },
      ],
      captured,
    })

    await activateSubscriptionOnPaymentCaptured(container, "pay_1")

    expect(captured).toEqual([
      activationCall,
      {
        id: "sub_1",
        payment_context: {
          payment_provider_id: "pp_stripe_stripe",
          account_holder_id: "acch_1",
          payment_method_id: "pm_new",
        },
      },
    ])
  })

  it("still activates when the provider exposes no saved method", async () => {
    const captured: UpdateCall[] = []
    const container = buildContainer({
      staged: defaultStaged(),
      paymentMethods: [],
      captured,
    })

    await activateSubscriptionOnPaymentCaptured(container, "pay_1")

    expect(captured).toEqual([activationCall])
  })

  it("still activates when the subscription carries no payment provider", async () => {
    const captured: UpdateCall[] = []
    const staged = defaultStaged()
    stagedSubscription(staged).payment_context = null
    const container = buildContainer({
      staged,
      paymentMethods: [{ id: "pm_new", data: { created: 200 } }],
      captured,
    })

    await activateSubscriptionOnPaymentCaptured(container, "pay_1")

    expect(captured).toEqual([activationCall])
  })

  it("leaves an already active subscription's status alone", async () => {
    const captured: UpdateCall[] = []
    const staged = defaultStaged()
    stagedSubscription(staged).status = SubscriptionStatus.ACTIVE
    const container = buildContainer({
      staged,
      paymentMethods: [{ id: "pm_new", data: { created: 200 } }],
      captured,
    })

    await activateSubscriptionOnPaymentCaptured(container, "pay_1")

    expect(captured).toEqual([
      {
        id: "sub_1",
        payment_context: {
          payment_provider_id: "pp_stripe_stripe",
          account_holder_id: "acch_1",
          payment_method_id: "pm_new",
        },
      },
    ])
  })

  it("does not resurrect a cancelled subscription", async () => {
    const captured: UpdateCall[] = []
    const staged = defaultStaged()
    stagedSubscription(staged).status = SubscriptionStatus.CANCELLED
    const container = buildContainer({
      staged,
      paymentMethods: [],
      captured,
    })

    await activateSubscriptionOnPaymentCaptured(container, "pay_1")

    expect(captured).toEqual([])
  })

  it("does nothing when the cart maps to no subscription", async () => {
    const captured: UpdateCall[] = []
    const staged = defaultStaged()
    staged.subscription = []
    const container = buildContainer({
      staged,
      paymentMethods: [{ id: "pm_new", data: { created: 200 } }],
      captured,
    })

    await activateSubscriptionOnPaymentCaptured(container, "pay_1")

    expect(captured).toEqual([])
  })

  it("is idempotent when the resolved method already matches the stored context", async () => {
    const captured: UpdateCall[] = []
    const staged = defaultStaged()
    stagedSubscription(staged).status = SubscriptionStatus.ACTIVE
    stagedSubscription(staged).payment_context = {
      payment_provider_id: "pp_stripe_stripe",
      account_holder_id: "acch_1",
      payment_method_id: "pm_new",
    }
    const container = buildContainer({
      staged,
      paymentMethods: [
        { id: "pm_new", data: { created: 200 } },
        { id: "pm_old", data: { created: 100 } },
      ],
      captured,
    })

    await activateSubscriptionOnPaymentCaptured(container, "pay_1")

    expect(captured).toEqual([])
  })
})
