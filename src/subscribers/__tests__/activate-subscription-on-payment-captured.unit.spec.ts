import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { DUNNING_MODULE } from "../../modules/dunning"
import { DunningCaseStatus } from "../../modules/dunning/types"
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

const recoverDunningRun = jest.fn(
  async (_input: { input: { dunning_case_id: string, payment_id: string } }) => ({
    result: {},
  })
)

jest.mock("../../workflows/recover-dunning-from-captured-payment", () => ({
  recoverDunningFromCapturedPaymentWorkflow: () => ({
    run: (input: { input: { dunning_case_id: string, payment_id: string } }) =>
      recoverDunningRun(input),
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
  dunningCases?: { id: string, status: DunningCaseStatus }[]
}) {
  const { staged, paymentMethods, captured, errorLogs = [], dunningCases = [] } = options

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

      if (key === DUNNING_MODULE) {
        return { listDunningCases: async () => dunningCases }
      }

      if (key === "logger") {
        return logger
      }

      throw new Error(`Unexpected resolve('${key}')`)
    },
  } as unknown as MedusaContainer
}

function pastDueStaged(): Staged {
  const staged = defaultStaged()

  stagedSubscription(staged).status = SubscriptionStatus.PAST_DUE
  staged.cart_payment_collection = []
  staged.order_payment_collection = [{ order_id: "order_1" }]
  staged.order = [
    { id: "order_1", subscription: null, metadata: { subscription_id: "sub_1" } },
  ]

  return staged
}

describe("activateSubscriptionOnPaymentCaptured", () => {
  beforeEach(() => {
    ensureNextRenewalCycleRun.mockClear()
    recoverDunningRun.mockClear()
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

  it("recovers the dunning case a past_due renewal order still has open", async () => {
    const captured: UpdateCall[] = []
    const container = buildContainer({
      staged: pastDueStaged(),
      paymentMethods: [{ id: "pm_new", data: { created: 200 } }],
      captured,
      dunningCases: [{ id: "dun_1", status: DunningCaseStatus.OPEN }],
    })

    await activateSubscriptionOnPaymentCaptured(container, "pay_1")

    // The new card lands first, so a failing recovery cannot cost the subscription its card.
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
    expect(recoverDunningRun).toHaveBeenCalledTimes(1)
    expect(recoverDunningRun).toHaveBeenCalledWith({
      input: { dunning_case_id: "dun_1", payment_id: "pay_1" },
    })
  })

  it("heals the newest recovered case when no case is open any more", async () => {
    const container = buildContainer({
      staged: pastDueStaged(),
      paymentMethods: [],
      captured: [],
      dunningCases: [
        { id: "dun_2", status: DunningCaseStatus.RECOVERED },
        { id: "dun_1", status: DunningCaseStatus.UNRECOVERED },
      ],
    })

    await activateSubscriptionOnPaymentCaptured(container, "pay_1")

    expect(recoverDunningRun).toHaveBeenCalledWith({
      input: { dunning_case_id: "dun_2", payment_id: "pay_1" },
    })
  })

  it("runs no recovery for an order that never entered dunning", async () => {
    const container = buildContainer({
      staged: pastDueStaged(),
      paymentMethods: [],
      captured: [],
      dunningCases: [],
    })

    await activateSubscriptionOnPaymentCaptured(container, "pay_1")

    expect(recoverDunningRun).not.toHaveBeenCalled()
  })

  it("runs no recovery for a checkout payment that has no order", async () => {
    const container = buildContainer({
      staged: defaultStaged(),
      paymentMethods: [{ id: "pm_new", data: { created: 200 } }],
      captured: [],
      dunningCases: [{ id: "dun_1", status: DunningCaseStatus.OPEN }],
    })

    await activateSubscriptionOnPaymentCaptured(container, "pay_1")

    expect(ensureNextRenewalCycleRun).toHaveBeenCalledTimes(1)
    expect(recoverDunningRun).not.toHaveBeenCalled()
  })

  it("logs one alertable line and keeps going when the recovery workflow throws", async () => {
    // A throwing subscriber is logged and dropped by both event buses, so this must not raise.
    const errorLogs: string[] = []
    const container = buildContainer({
      staged: pastDueStaged(),
      paymentMethods: [],
      captured: [],
      errorLogs,
      dunningCases: [{ id: "dun_1", status: DunningCaseStatus.OPEN }],
    })
    recoverDunningRun.mockRejectedValueOnce(new Error("lock timeout"))

    await activateSubscriptionOnPaymentCaptured(container, "pay_1")

    expect(errorLogs).toHaveLength(1)
    expect(JSON.parse(errorLogs[0])).toEqual({
      domain: "subscriptions",
      event: "dunning_recovery_from_capture_failed",
      subscription_id: "sub_1",
      dunning_case_id: "dun_1",
      payment_id: "pay_1",
      alertable: true,
      message: "lock timeout",
    })
  })

  it("routes a payment on a churned subscription to the case that names the remedy", async () => {
    const errorLogs: string[] = []
    const staged = pastDueStaged()
    stagedSubscription(staged).status = SubscriptionStatus.PAYMENT_FAILED
    const container = buildContainer({
      staged,
      paymentMethods: [{ id: "pm_new", data: { created: 200 } }],
      captured: [],
      errorLogs,
      dunningCases: [{ id: "dun_1", status: DunningCaseStatus.UNRECOVERED }],
    })

    await activateSubscriptionOnPaymentCaptured(container, "pay_1")

    expect(recoverDunningRun).toHaveBeenCalledWith({
      input: { dunning_case_id: "dun_1", payment_id: "pay_1" },
    })
    // The step's own alert names `reverseInvoluntaryChurnWorkflow`; the generic one does not.
    expect(errorLogs).toEqual([])
  })

  it("keeps the generic alert for a churned subscription with no case on the order", async () => {
    const errorLogs: string[] = []
    const staged = pastDueStaged()
    stagedSubscription(staged).status = SubscriptionStatus.PAYMENT_FAILED
    const container = buildContainer({
      staged,
      paymentMethods: [],
      captured: [],
      errorLogs,
      dunningCases: [],
    })

    await activateSubscriptionOnPaymentCaptured(container, "pay_1")

    expect(recoverDunningRun).not.toHaveBeenCalled()
    expect(errorLogs).toHaveLength(1)
    expect(JSON.parse(errorLogs[0]).event).toBe(
      "payment_captured_on_terminal_subscription"
    )
  })

  it("never runs a recovery for a cancelled subscription", async () => {
    const errorLogs: string[] = []
    const staged = pastDueStaged()
    stagedSubscription(staged).status = SubscriptionStatus.CANCELLED
    const container = buildContainer({
      staged,
      paymentMethods: [],
      captured: [],
      errorLogs,
      dunningCases: [{ id: "dun_1", status: DunningCaseStatus.OPEN }],
    })

    await activateSubscriptionOnPaymentCaptured(container, "pay_1")

    expect(recoverDunningRun).not.toHaveBeenCalled()
    expect(errorLogs).toHaveLength(1)
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
