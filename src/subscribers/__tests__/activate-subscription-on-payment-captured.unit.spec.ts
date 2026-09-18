import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import { SubscriptionStatus } from "../../modules/subscription/types"
import { activateSubscriptionOnPaymentCaptured } from "../activate-subscription-on-payment-captured"

const ensureNextRenewalCycleRun = jest.fn(
  async (_input: { input: { subscription_id: string } }) => ({ result: {} })
)

jest.mock("../../workflows/ensure-next-renewal-cycle", () => ({
  ensureNextRenewalCycleWorkflow: () => ({
    run: (input: { input: { subscription_id: string } }) =>
      ensureNextRenewalCycleRun(input),
  }),
}))

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
  errorLogs?: string[]
}) {
  const { staged, paymentMethods, captured, errorLogs = [] } = options

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
  const logger = {
    info: () => {},
    warn: () => {},
    error: (message: string) => {
      errorLogs.push(message)
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

      if (key === "logger") {
        return logger
      }

      throw new Error(`Unexpected resolve('${key}')`)
    },
  } as unknown as MedusaContainer
}

describe("activateSubscriptionOnPaymentCaptured", () => {
  beforeEach(() => {
    ensureNextRenewalCycleRun.mockClear()
  })

  it("activates the subscription and writes the latest saved method back onto it", async () => {
    const captured: UpdateCall[] = []
    const container = buildContainer({
      staged: defaultStaged(),
      paymentMethods: [{ id: "pm_new", data: { created: 200 } }],
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

  it("schedules the first renewal cycle when it activates the subscription", async () => {
    const captured: UpdateCall[] = []
    const container = buildContainer({
      staged: defaultStaged(),
      paymentMethods: [{ id: "pm_new", data: { created: 200 } }],
      captured,
    })

    await activateSubscriptionOnPaymentCaptured(container, "pay_1")

    expect(ensureNextRenewalCycleRun).toHaveBeenCalledTimes(1)
    expect(ensureNextRenewalCycleRun).toHaveBeenCalledWith({
      input: { subscription_id: "sub_1" },
    })
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
    expect(ensureNextRenewalCycleRun).not.toHaveBeenCalled()
  })

  it("does not resurrect a cancelled subscription", async () => {
    const captured: UpdateCall[] = []
    const errorLogs: string[] = []
    const staged = defaultStaged()
    stagedSubscription(staged).status = SubscriptionStatus.CANCELLED
    const container = buildContainer({
      staged,
      paymentMethods: [{ id: "pm_new", data: { created: 200 } }],
      captured,
      errorLogs,
    })

    await activateSubscriptionOnPaymentCaptured(container, "pay_1")

    expect(captured).toEqual([])
    expect(errorLogs).toHaveLength(1)
  })

  it("logs an alertable line when a capture lands on a terminal subscription", async () => {
    const captured: UpdateCall[] = []
    const errorLogs: string[] = []
    const staged = defaultStaged()
    stagedSubscription(staged).status = SubscriptionStatus.PAYMENT_FAILED
    const container = buildContainer({
      staged,
      paymentMethods: [{ id: "pm_new", data: { created: 200 } }],
      captured,
      errorLogs,
    })

    await activateSubscriptionOnPaymentCaptured(container, "pay_1")

    expect(captured).toEqual([])
    expect(errorLogs).toEqual([
      JSON.stringify({
        domain: "subscriptions",
        event: "payment_captured_on_terminal_subscription",
        subscription_id: "sub_1",
        payment_id: "pay_1",
        status: SubscriptionStatus.PAYMENT_FAILED,
        alertable: true,
      }),
    ])
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
      paymentMethods: [{ id: "pm_new", data: { created: 200 } }],
      captured,
    })

    await activateSubscriptionOnPaymentCaptured(container, "pay_1")

    expect(captured).toEqual([])
  })
})
