jest.mock("@medusajs/medusa/core-flows", () => ({
  createOrUpdateOrderPaymentCollectionWorkflow: jest.fn(),
  createPaymentSessionsWorkflow: jest.fn(),
}))

jest.mock("../../utils/settle-subscription-payment-failure", () => ({
  settleSubscriptionPaymentFailure: jest.fn(),
}))

import {
  createOrUpdateOrderPaymentCollectionWorkflow,
  createPaymentSessionsWorkflow,
} from "@medusajs/medusa/core-flows"
import {
  DunningAttemptStatus,
  DunningCaseStatus,
} from "../../../modules/dunning/types"
import { SubscriptionStatus } from "../../../modules/subscription/types"
import { settleSubscriptionPaymentFailure } from "../../utils/settle-subscription-payment-failure"
import { runDunningRetry } from "../run-dunning-retry"

const retrySchedule = {
  strategy: "fixed_intervals",
  intervals: [1440, 4320, 10080],
  timezone: "UTC",
  source: "default_policy",
}

type BuildContainerOptions = {
  attemptCount?: number
  maxAttempts?: number
  attempts?: Record<string, unknown>[]
  paymentSessionStatus?: string
}

function buildContainer(options: BuildContainerOptions = {}) {
  const dunningCase = {
    id: "dun_1",
    subscription_id: "sub_1",
    renewal_cycle_id: "rc_1",
    renewal_order_id: "order_1",
    status: DunningCaseStatus.RETRY_SCHEDULED,
    attempt_count: options.attemptCount ?? 0,
    max_attempts: options.maxAttempts ?? 3,
    retry_schedule: retrySchedule,
    next_retry_at: new Date("2026-01-01T00:00:00.000Z"),
    last_payment_error_code: null,
    last_payment_error_message: null,
    last_attempt_at: null,
    recovered_at: null,
    closed_at: null,
    recovery_reason: null,
    metadata: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
  }

  const subscription = {
    id: "sub_1",
    status: SubscriptionStatus.PAST_DUE,
    customer_id: "cus_1",
    payment_context: {
      payment_provider_id: "pp_stripe-checkout-session_stripe",
      payment_method_id: "pm_1",
    },
  }

  const updateDunningCases = jest.fn(async (payload: Record<string, unknown>) => ({
    ...dunningCase,
    ...payload,
  }))
  const createDunningAttempts = jest.fn(
    async (payload: Record<string, unknown>) => ({ id: "dunatt_1", ...payload })
  )
  const updateDunningAttempts = jest.fn(
    async (payload: Record<string, unknown>) => payload
  )
  const listDunningAttempts = jest.fn(async () => options.attempts ?? [])

  const dunningModule = {
    retrieveDunningCase: jest.fn(async () => dunningCase),
    listDunningAttempts,
    updateDunningCases,
    createDunningAttempts,
    updateDunningAttempts,
  }

  const subscriptionModule = {
    retrieveSubscription: jest.fn(async () => subscription),
    updateSubscriptions: jest.fn(async () => undefined),
  }

  const authorizePaymentSession = jest.fn()
  const paymentModule = {
    authorizePaymentSession,
    capturePayment: jest.fn(async () => undefined),
    retrievePayment: jest.fn(async () => ({
      id: "pay_1",
      currency_code: "pln",
      captures: [],
    })),
    listPaymentSessions: jest.fn(async () => [
      { id: "payses_1", status: options.paymentSessionStatus ?? "pending" },
    ]),
  }

  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }

  const queryModule = {
    graph: jest.fn(async () => ({
      data: [
        { id: "order_1", total: 100, summary: { pending_difference: 100 } },
      ],
    })),
  }

  const orderModule = {
    listOrderTransactions: jest.fn(async () => []),
    addOrderTransactions: jest.fn(async () => []),
  }

  const container = {
    resolve: (key: string) => {
      switch (key) {
        case "logger":
          return logger
        case "dunning":
          return dunningModule
        case "subscription":
          return subscriptionModule
        case "query":
          return queryModule
        case "payment":
          return paymentModule
        case "order":
          return orderModule
      }

      throw new Error(`Unexpected resolve('${key}')`)
    },
  } as any

  return {
    container,
    updateDunningCases,
    createDunningAttempts,
    updateDunningAttempts,
    authorizePaymentSession,
  }
}

function caseUpdate(mock: jest.Mock, status: DunningCaseStatus) {
  return mock.mock.calls
    .map((call) => call[0])
    .find((payload) => payload.status === status)
}

function declineError() {
  return Object.assign(new Error("Your card has insufficient funds."), {
    code: "insufficient_funds",
  })
}

describe("runDunningRetry - parking instead of churning", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(settleSubscriptionPaymentFailure as jest.Mock).mockResolvedValue(
      SubscriptionStatus.PAYMENT_FAILED
    )
    ;(
      createOrUpdateOrderPaymentCollectionWorkflow as unknown as jest.Mock
    ).mockReturnValue({
      run: jest.fn().mockResolvedValue({ result: [{ id: "paycol_1" }] }),
    })
    ;(createPaymentSessionsWorkflow as unknown as jest.Mock).mockReturnValue({
      run: jest.fn().mockResolvedValue({
        result: { id: "payses_1", status: "pending", context: {} },
      }),
    })
  })

  it("parks the case and gives the attempt back when the session is never created", async () => {
    const { container, updateDunningCases, updateDunningAttempts } =
      buildContainer()
    ;(createPaymentSessionsWorkflow as unknown as jest.Mock).mockReturnValue({
      run: jest.fn().mockRejectedValue(new Error("provider is not registered")),
    })

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
    })

    expect(response.output.outcome).toBe("awaiting_manual_resolution")
    expect(updateDunningAttempts).toHaveBeenCalledWith(
      expect.objectContaining({
        status: DunningAttemptStatus.ABORTED,
        error_code: "payment_session_setup_failed",
        payment_reference: null,
      })
    )
    expect(
      caseUpdate(updateDunningCases, DunningCaseStatus.AWAITING_MANUAL_RESOLUTION)
    ).toMatchObject({
      attempt_count: 0,
      next_retry_at: null,
      metadata: expect.objectContaining({ park_reason: "setup_failure" }),
    })
    expect(settleSubscriptionPaymentFailure).not.toHaveBeenCalled()
  })

  it("parks the case on an SCA challenge instead of settling it", async () => {
    const { container, updateDunningCases, updateDunningAttempts, authorizePaymentSession } =
      buildContainer({ paymentSessionStatus: "requires_more" })
    authorizePaymentSession.mockRejectedValue(
      new Error("Payment session requires more action")
    )

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
    })

    expect(response.output.outcome).toBe("awaiting_manual_resolution")
    expect(updateDunningAttempts).toHaveBeenCalledWith(
      expect.objectContaining({
        status: DunningAttemptStatus.FAILED,
        error_code: "requires_more",
        payment_reference: "payses_1",
      })
    )
    expect(
      caseUpdate(updateDunningCases, DunningCaseStatus.AWAITING_MANUAL_RESOLUTION)
    ).toMatchObject({
      attempt_count: 1,
      next_retry_at: null,
      metadata: expect.objectContaining({ park_reason: "requires_action" }),
    })
    expect(settleSubscriptionPaymentFailure).not.toHaveBeenCalled()
  })

  it("still settles a real decline once the attempt budget is spent", async () => {
    const { container, updateDunningCases, authorizePaymentSession } =
      buildContainer({
        attemptCount: 2,
        maxAttempts: 3,
        attempts: [
          { attempt_no: 1, status: "failed", payment_reference: "payses_0" },
          { attempt_no: 2, status: "failed", payment_reference: "payses_0" },
        ],
      })
    authorizePaymentSession.mockRejectedValue(declineError())

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
    })

    expect(response.output.outcome).toBe("unrecovered")
    expect(response.output).toMatchObject({
      subscription_id: "sub_1",
      subscription_status: SubscriptionStatus.PAYMENT_FAILED,
      error_code: "insufficient_funds",
      next_retry_at: null,
      recovery_reason: "retry_limit_exhausted",
    })
    expect(settleSubscriptionPaymentFailure).toHaveBeenCalledWith(
      container,
      expect.objectContaining({ recovery_reason: "retry_limit_exhausted" })
    )
    expect(
      caseUpdate(updateDunningCases, DunningCaseStatus.UNRECOVERED)
    ).toMatchObject({ last_payment_error_code: "insufficient_funds" })
  })

  it("parks rather than settles when no attempt ever reached the provider", async () => {
    // The static mock ignores the row written moments earlier, which is the only way to reach the
    // guard: with a session in hand the current attempt always carries a payment_reference, so in
    // production this branch is an invariant check rather than a path a live retry can take.
    const { container, updateDunningCases, authorizePaymentSession } =
      buildContainer({
        attemptCount: 2,
        maxAttempts: 3,
        attempts: [
          { attempt_no: 1, status: "failed", payment_reference: null },
          { attempt_no: 2, status: "failed", payment_reference: null },
        ],
      })
    authorizePaymentSession.mockRejectedValue(declineError())

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
    })

    expect(response.output.outcome).toBe("awaiting_manual_resolution")
    expect(
      caseUpdate(updateDunningCases, DunningCaseStatus.AWAITING_MANUAL_RESOLUTION)
    ).toMatchObject({
      metadata: expect.objectContaining({ park_reason: "unreached_provider" }),
    })
    expect(settleSubscriptionPaymentFailure).not.toHaveBeenCalled()
  })

  it("spends one budget slot on the first retry of a fresh case", async () => {
    const { container, updateDunningCases, createDunningAttempts, authorizePaymentSession } =
      buildContainer()
    authorizePaymentSession.mockRejectedValue(declineError())

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
    })

    expect(response.output).toMatchObject({
      outcome: "retry_scheduled",
      subscription_id: "sub_1",
      error_code: "insufficient_funds",
      next_retry_at: expect.any(String),
      recovery_reason: null,
    })
    expect(
      caseUpdate(updateDunningCases, DunningCaseStatus.RETRYING)
    ).toMatchObject({
      attempt_count: 1,
      metadata: expect.objectContaining({ park_reason: null }),
    })
    expect(createDunningAttempts).toHaveBeenCalledWith(
      expect.objectContaining({ attempt_no: 1 })
    )

    const scheduled = caseUpdate(
      updateDunningCases,
      DunningCaseStatus.RETRY_SCHEDULED
    )

    expect(
      scheduled.next_retry_at.getTime() - scheduled.last_attempt_at.getTime()
    ).toBe(retrySchedule.intervals[1] * 60 * 1000)
  })

  it("keeps the budget where it was when the previous row was aborted", async () => {
    const { container, updateDunningCases, createDunningAttempts, authorizePaymentSession } =
      buildContainer({
        attempts: [
          { attempt_no: 1, status: "aborted", payment_reference: null },
        ],
      })
    authorizePaymentSession.mockRejectedValue(declineError())

    await runDunningRetry(container, { dunning_case_id: "dun_1" })

    // The row number has to keep climbing past the aborted attempt, but the budget has not moved.
    expect(createDunningAttempts).toHaveBeenCalledWith(
      expect.objectContaining({ attempt_no: 2 })
    )
    expect(
      caseUpdate(updateDunningCases, DunningCaseStatus.RETRYING)
    ).toMatchObject({ attempt_count: 1 })

    const scheduled = caseUpdate(
      updateDunningCases,
      DunningCaseStatus.RETRY_SCHEDULED
    )

    expect(
      scheduled.next_retry_at.getTime() - scheduled.last_attempt_at.getTime()
    ).toBe(retrySchedule.intervals[1] * 60 * 1000)
  })

  it("reports a recovered retry without an error or a next retry", async () => {
    const { container, authorizePaymentSession } = buildContainer()
    authorizePaymentSession.mockResolvedValue({ id: "pay_1", amount: 100 })

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
    })

    expect(response.output).toMatchObject({
      outcome: "recovered",
      subscription_id: "sub_1",
      subscription_status: SubscriptionStatus.ACTIVE,
      error_code: null,
      next_retry_at: null,
      recovery_reason: "payment_recovered",
    })
  })
})
