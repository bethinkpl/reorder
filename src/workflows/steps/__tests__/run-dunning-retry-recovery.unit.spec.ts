jest.mock("@medusajs/medusa/core-flows", () => ({
  createOrUpdateOrderPaymentCollectionWorkflow: jest.fn(),
  createPaymentSessionsWorkflow: jest.fn(),
}))

jest.mock("../../ensure-next-renewal-cycle", () => ({
  ensureNextRenewalCycleWorkflow: jest.fn(() => ({
    run: ensureNextRenewalCycleRun,
  })),
}))

jest.mock("../../utils/settle-renewal-cycle-succeeded", () => ({
  settleRenewalCycleSucceeded: jest.fn(async () => ({ settled: true })),
}))

import {
  createOrUpdateOrderPaymentCollectionWorkflow,
  createPaymentSessionsWorkflow,
} from "@medusajs/medusa/core-flows"
import { DunningCaseStatus } from "../../../modules/dunning/types"
import { SubscriptionStatus } from "../../../modules/subscription/types"
import { settleRenewalCycleSucceeded } from "../../utils/settle-renewal-cycle-succeeded"
import { runDunningRetry } from "../run-dunning-retry"

const ensureNextRenewalCycleRun = jest.fn(async () => ({ result: {} }))

const retrySchedule = {
  strategy: "fixed_intervals",
  intervals: [1440, 4320, 10080],
  timezone: "UTC",
  source: "default_policy",
}

type BuildContainerOptions = {
  caseStatus?: DunningCaseStatus
  pendingDifference?: number
  paymentMethods?: { id: string, data?: Record<string, unknown> }[]
}

function buildContainer(options: BuildContainerOptions = {}) {
  const dunningCase = {
    id: "dun_1",
    subscription_id: "sub_1",
    renewal_cycle_id: "rc_1",
    renewal_order_id: "order_1",
    status: options.caseStatus ?? DunningCaseStatus.RETRY_SCHEDULED,
    attempt_count: 1,
    max_attempts: 3,
    retry_schedule: retrySchedule,
    next_retry_at: new Date("2026-01-01T00:00:00.000Z"),
    last_payment_error_code: "card_declined",
    last_payment_error_message: "declined",
    last_attempt_at: null,
    recovered_at: null,
    closed_at: null,
    recovery_reason: null,
    metadata: { park_reason: "setup_failure", setup_failure_streak: 2 },
    created_at: new Date("2026-01-01T00:00:00.000Z"),
  }

  const subscription = {
    id: "sub_1",
    status: SubscriptionStatus.PAST_DUE,
    customer_id: "cus_1",
    payment_context: {
      payment_provider_id: "pp_stripe_stripe",
      account_holder_id: "acch_1",
      payment_method_id: "pm_old",
    },
  }

  const updateDunningCases = jest.fn(async (payload: Record<string, unknown>) => ({
    ...dunningCase,
    ...payload,
  }))
  const updateSubscriptions = jest.fn(async () => undefined)

  const graph = jest.fn(async ({ entity }: { entity: string }) => {
    if (entity === "customer") {
      return {
        data: [
          {
            id: "cus_1",
            account_holders: [
              { id: "acch_1", provider_id: "pp_stripe_stripe", data: {} },
            ],
          },
        ],
      }
    }

    return {
      data: [
        {
          id: "order_1",
          total: 100,
          summary: { pending_difference: options.pendingDifference ?? 100 },
        },
      ],
    }
  })

  const container = {
    resolve: (key: string) => {
      switch (key) {
        case "logger":
          return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
        case "dunning":
          return {
            retrieveDunningCase: jest.fn(async () => dunningCase),
            listDunningAttempts: jest.fn(async () => [
              { id: "dunatt_prev", attempt_no: 1 },
            ]),
            updateDunningCases,
            createDunningAttempts: jest.fn(async (payload: Record<string, unknown>) => ({
              id: "dunatt_1",
              ...payload,
            })),
            updateDunningAttempts: jest.fn(async () => undefined),
          }
        case "subscription":
          return {
            retrieveSubscription: jest.fn(async () => subscription),
            updateSubscriptions,
          }
        case "query":
          return { graph }
        case "payment":
          return {
            authorizePaymentSession: jest.fn(async () => ({ id: "pay_1", amount: 100 })),
            capturePayment: jest.fn(async () => undefined),
            retrievePayment: jest.fn(async () => ({
              id: "pay_1",
              currency_code: "pln",
              captures: [],
            })),
            listPaymentSessions: jest.fn(async () => [
              { id: "payses_1", status: "pending" },
            ]),
            listPaymentMethods: jest.fn(async () => options.paymentMethods ?? []),
          }
        case "order":
          return {
            listOrderTransactions: jest.fn(async () => []),
            addOrderTransactions: jest.fn(async () => []),
          }
      }

      throw new Error(`Unexpected resolve('${key}')`)
    },
  } as any

  return { container, updateDunningCases, updateSubscriptions }
}

describe("runDunningRetry - recovery branch", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(createPaymentSessionsWorkflow as unknown as jest.Mock).mockReturnValue({
      run: jest.fn().mockResolvedValue({
        result: { id: "payses_1", status: "pending", context: {}, data: { id: "pi_1" } },
      }),
    })
    ;(
      createOrUpdateOrderPaymentCollectionWorkflow as unknown as jest.Mock
    ).mockReturnValue({
      run: jest.fn().mockResolvedValue({ result: [{ id: "paycol_1" }] }),
    })
  })

  it("closes the case, settles the renewal cycle and schedules the next one", async () => {
    const { container, updateDunningCases, updateSubscriptions } = buildContainer()

    const response = await runDunningRetry(container, { dunning_case_id: "dun_1" })

    expect(response.output).toMatchObject({
      outcome: "recovered",
      recovery_reason: "payment_recovered",
      renewal_order_id: "order_1",
    })
    expect(updateDunningCases).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "dun_1",
        status: DunningCaseStatus.RECOVERED,
        recovery_reason: "payment_recovered",
        metadata: expect.objectContaining({
          park_reason: null,
          recovery_payment_reference: "pay_1",
        }),
      })
    )
    expect(updateSubscriptions).toHaveBeenCalledWith({
      id: "sub_1",
      status: SubscriptionStatus.ACTIVE,
    })
    expect(settleRenewalCycleSucceeded).toHaveBeenCalledWith(
      container,
      expect.objectContaining({
        renewal_cycle_id: "rc_1",
        subscription_id: "sub_1",
        order_id: "order_1",
      })
    )
    expect(ensureNextRenewalCycleRun).toHaveBeenCalledWith({
      input: { subscription_id: "sub_1" },
    })
  })

  it("drops the setup failure streak the case was carrying", async () => {
    const { container, updateDunningCases } = buildContainer()

    await runDunningRetry(container, { dunning_case_id: "dun_1" })

    const write = updateDunningCases.mock.calls
      .map(([payload]) => payload)
      .find((payload) => payload.status === DunningCaseStatus.RECOVERED)!

    expect(write.metadata).not.toHaveProperty("setup_failure_streak")
  })

  it("adopts the newest saved card when someone else paid the order", async () => {
    // Nothing was charged here, so the card that settled the order is not the one on the
    // subscription: the customer paid it themselves with a new one.
    const { container, updateSubscriptions } = buildContainer({
      pendingDifference: 0,
      paymentMethods: [{ id: "pm_new", data: { created: 200 } }],
    })

    await runDunningRetry(container, { dunning_case_id: "dun_1" })

    expect(updateSubscriptions).toHaveBeenCalledWith({
      id: "sub_1",
      payment_context: {
        payment_provider_id: "pp_stripe_stripe",
        account_holder_id: "acch_1",
        payment_method_id: "pm_new",
      },
    })
  })

  it("leaves the subscription's card alone when the retry itself collected", async () => {
    const { container, updateSubscriptions } = buildContainer({
      paymentMethods: [{ id: "pm_new", data: { created: 200 } }],
    })

    await runDunningRetry(container, { dunning_case_id: "dun_1" })

    expect(updateSubscriptions).not.toHaveBeenCalledWith(
      expect.objectContaining({ payment_context: expect.anything() })
    )
  })

  it("is a no-op on a case the customer's own payment already closed", async () => {
    const { container, updateDunningCases, updateSubscriptions } = buildContainer({
      caseStatus: DunningCaseStatus.RECOVERED,
      pendingDifference: 0,
    })

    const response = await runDunningRetry(container, { dunning_case_id: "dun_1" })

    expect(response.output).toMatchObject({
      outcome: "recovered",
      dunning_attempt_id: "dunatt_prev",
      renewal_order_id: "order_1",
    })
    expect(updateDunningCases).not.toHaveBeenCalled()
    expect(updateSubscriptions).not.toHaveBeenCalled()
  })

  it("still refuses a recovered case whose order is not paid", async () => {
    const { container } = buildContainer({
      caseStatus: DunningCaseStatus.RECOVERED,
      pendingDifference: 40,
    })

    await expect(
      runDunningRetry(container, { dunning_case_id: "dun_1" })
    ).rejects.toThrow(/already recovered/)
  })
})
