jest.mock("@medusajs/medusa/core-flows", () => ({
  createOrUpdateOrderPaymentCollectionWorkflow: jest.fn(),
  createPaymentSessionsWorkflow: jest.fn(),
}))

jest.mock("../../utils/settle-subscription-payment-failure", () => ({
  settleSubscriptionPaymentFailure: jest.fn(),
}))

import { MedusaError } from "@medusajs/framework/utils"
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
  caseStatus?: DunningCaseStatus
  caseMetadata?: Record<string, unknown> | null
  hasPaymentMethod?: boolean
}

function buildContainer(options: BuildContainerOptions = {}) {
  const dunningCase = {
    id: "dun_1",
    subscription_id: "sub_1",
    renewal_cycle_id: "rc_1",
    renewal_order_id: "order_1",
    status: options.caseStatus ?? DunningCaseStatus.RETRY_SCHEDULED,
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
    metadata: options.caseMetadata ?? null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
  }

  const subscription = {
    id: "sub_1",
    status: SubscriptionStatus.PAST_DUE,
    customer_id: "cus_1",
    payment_context: {
      payment_provider_id: "pp_stripe-checkout-session_stripe",
      payment_method_id: options.hasPaymentMethod === false ? null : "pm_1",
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

function mockPaymentSession(session: Record<string, unknown>) {
  ;(createPaymentSessionsWorkflow as unknown as jest.Mock).mockReturnValue({
    run: jest.fn().mockResolvedValue({ result: session }),
  })
}

function mockPaymentSessionError(error: unknown) {
  ;(createPaymentSessionsWorkflow as unknown as jest.Mock).mockReturnValue({
    run: jest.fn().mockRejectedValue(error),
  })
}

/** What the production provider raises for a real decline: it throws, so no session survives. */
function thrownDecline(code: string, message: string) {
  return new MedusaError(
    MedusaError.Types.PAYMENT_AUTHORIZATION_ERROR,
    message,
    code
  )
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
    ;(settleSubscriptionPaymentFailure as jest.Mock).mockResolvedValue({
      status: SubscriptionStatus.PAYMENT_FAILED,
      settled: true,
    })
    ;(
      createOrUpdateOrderPaymentCollectionWorkflow as unknown as jest.Mock
    ).mockReturnValue({
      run: jest.fn().mockResolvedValue({ result: [{ id: "paycol_1" }] }),
    })
    mockPaymentSession({
      id: "payses_1",
      status: "pending",
      context: {},
      data: { id: "pi_1" },
    })
  })

  it("reschedules and gives the attempt back when the session is never created", async () => {
    // A provider outage lasts minutes, not forever: parking every case that retried during one
    // would strand them all.
    const { container, updateDunningCases, updateDunningAttempts } =
      buildContainer()
    mockPaymentSessionError(new Error("provider is not registered"))

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
    })

    expect(response.output).toMatchObject({
      outcome: "retry_scheduled",
      next_retry_at: expect.any(String),
      park_reason: null,
    })
    expect(updateDunningAttempts).toHaveBeenCalledWith(
      expect.objectContaining({
        status: DunningAttemptStatus.ABORTED,
        error_code: "payment_session_setup_failed",
        payment_reference: null,
      })
    )

    const scheduled = caseUpdate(
      updateDunningCases,
      DunningCaseStatus.RETRY_SCHEDULED
    )

    expect(scheduled).toMatchObject({
      attempt_count: 0,
      metadata: expect.objectContaining({ setup_failure_streak: 1 }),
    })
    expect(
      scheduled.next_retry_at.getTime() - scheduled.last_attempt_at.getTime()
    ).toBe(60 * 60 * 1000)
    expect(settleSubscriptionPaymentFailure).not.toHaveBeenCalled()
  })

  it("parks a setup failure that keeps coming back", async () => {
    const { container, updateDunningCases, updateDunningAttempts } =
      buildContainer({ caseMetadata: { setup_failure_streak: 2 } })
    mockPaymentSessionError(new Error("provider is not registered"))

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
    })

    expect(response.output).toMatchObject({
      outcome: "awaiting_manual_resolution",
      park_reason: "setup_failure",
      next_retry_at: null,
    })
    expect(updateDunningAttempts).toHaveBeenCalledWith(
      expect.objectContaining({ status: DunningAttemptStatus.ABORTED })
    )
    expect(
      caseUpdate(updateDunningCases, DunningCaseStatus.AWAITING_MANUAL_RESOLUTION)
    ).toMatchObject({
      attempt_count: 0,
      next_retry_at: null,
      metadata: expect.objectContaining({
        park_reason: "setup_failure",
        setup_failure_streak: 3,
      }),
    })
    expect(
      caseUpdate(updateDunningCases, DunningCaseStatus.RETRY_SCHEDULED)
    ).toBeUndefined()
  })

  it("clears the setup failure streak once the provider answers", async () => {
    const { container, updateDunningCases } = buildContainer({
      caseMetadata: { setup_failure_streak: 2 },
    })
    mockPaymentSessionError(
      thrownDecline("card_declined", "Your card was declined.")
    )

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
    })

    expect(response.output.outcome).toBe("retry_scheduled")
    expect(
      caseUpdate(updateDunningCases, DunningCaseStatus.RETRY_SCHEDULED).metadata
    ).not.toHaveProperty("setup_failure_streak")
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
      settled_now: true,
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

  it("settles a thrown provider decline once the attempt budget is spent", async () => {
    // The provider throws on a real decline, so the current attempt never gets a session. Reading
    // that as our own setup failure would keep every declining subscription alive forever.
    const { container, updateDunningCases, updateDunningAttempts } = buildContainer({
      attemptCount: 2,
      maxAttempts: 3,
      attempts: [
        {
          attempt_no: 1,
          status: "failed",
          payment_reference: null,
          metadata: { provider_reached: true },
        },
        {
          attempt_no: 2,
          status: "failed",
          payment_reference: null,
          metadata: { provider_reached: true },
        },
      ],
    })
    mockPaymentSessionError(
      thrownDecline("insufficient_funds", "Your card has insufficient funds.")
    )

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
    })

    expect(response.output).toMatchObject({
      outcome: "unrecovered",
      settled_now: true,
      error_code: "insufficient_funds",
      recovery_reason: "retry_limit_exhausted",
      park_reason: null,
    })
    expect(updateDunningAttempts).toHaveBeenCalledWith(
      expect.objectContaining({
        status: DunningAttemptStatus.FAILED,
        error_code: "insufficient_funds",
        metadata: expect.objectContaining({ provider_reached: true }),
      })
    )
    expect(settleSubscriptionPaymentFailure).toHaveBeenCalledWith(
      container,
      expect.objectContaining({ recovery_reason: "retry_limit_exhausted" })
    )
    expect(
      caseUpdate(updateDunningCases, DunningCaseStatus.AWAITING_MANUAL_RESOLUTION)
    ).toBeUndefined()
  })

  it("keeps retrying a thrown provider decline while the budget lasts", async () => {
    // Stripe reports every soft decline as `card_declined` and keeps the reason in a `decline_code`
    // the provider drops, so this must not read as a dead card on the first attempt.
    const { container } = buildContainer()
    mockPaymentSessionError(
      thrownDecline("card_declined", "Your card was declined.")
    )

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
    })

    expect(response.output).toMatchObject({
      outcome: "retry_scheduled",
      error_code: "card_declined",
    })
    expect(settleSubscriptionPaymentFailure).not.toHaveBeenCalled()
  })

  it("gives the budget back when the provider itself was never reached", async () => {
    const { container, updateDunningCases, updateDunningAttempts } = buildContainer()
    mockPaymentSessionError(
      new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "An error occurred while processing payment",
        "api_connection_error"
      )
    )

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
    })

    expect(response.output).toMatchObject({
      outcome: "retry_scheduled",
      park_reason: null,
    })
    expect(updateDunningAttempts).toHaveBeenCalledWith(
      expect.objectContaining({
        status: DunningAttemptStatus.ABORTED,
        metadata: expect.objectContaining({ provider_reached: false }),
      })
    )
    expect(
      caseUpdate(updateDunningCases, DunningCaseStatus.RETRY_SCHEDULED)
    ).toMatchObject({ attempt_count: 0 })
    expect(settleSubscriptionPaymentFailure).not.toHaveBeenCalled()
  })

  it("parks a thrown authentication challenge instead of settling it", async () => {
    // Stripe words this decline like any other ("Your card was declined."), so only its code tells
    // the step that a human, not another retry, is what the charge is waiting on.
    const { container, updateDunningCases } = buildContainer()
    mockPaymentSessionError(
      thrownDecline(
        "authentication_required",
        "Your card was declined. This transaction requires authentication."
      )
    )

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
    })

    expect(response.output).toMatchObject({
      outcome: "awaiting_manual_resolution",
      park_reason: "requires_action",
      error_code: "authentication_required",
    })
    expect(
      caseUpdate(updateDunningCases, DunningCaseStatus.AWAITING_MANUAL_RESOLUTION)
    ).toMatchObject({ attempt_count: 1 })
    expect(settleSubscriptionPaymentFailure).not.toHaveBeenCalled()
  })

  it("settles a dead card the provider named by code", async () => {
    const { container } = buildContainer({
      attempts: [
        {
          attempt_no: 1,
          status: "failed",
          payment_reference: null,
          metadata: { provider_reached: true },
        },
      ],
    })
    mockPaymentSessionError(thrownDecline("expired_card", "Your card has expired."))

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
    })

    expect(response.output).toMatchObject({
      outcome: "unrecovered",
      settled_now: true,
      error_code: "expired_card",
      recovery_reason: "permanent_payment_failure",
    })
  })

  it("keeps retrying a decline whose code it doesn't know", async () => {
    const { container } = buildContainer()
    mockPaymentSessionError(
      thrownDecline("card_velocity_exceeded", "Your card was declined.")
    )

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
    })

    expect(response.output).toMatchObject({
      outcome: "retry_scheduled",
      error_code: "card_velocity_exceeded",
    })
    expect(settleSubscriptionPaymentFailure).not.toHaveBeenCalled()
  })

  it("reschedules an infrastructure error that only reads like a dead card", async () => {
    // "expired" in the text of a transport error must not settle a case whose session is still
    // pending: the card was never actually refused.
    const { container, authorizePaymentSession } = buildContainer()
    authorizePaymentSession.mockRejectedValue(
      new Error("Stripe request expired before it was answered")
    )

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
    })

    expect(response.output).toMatchObject({
      outcome: "retry_scheduled",
      next_retry_at: expect.any(String),
    })
    expect(settleSubscriptionPaymentFailure).not.toHaveBeenCalled()
  })

  it("parks an indeterminate provider response instead of charging again", async () => {
    const { container, updateDunningCases, updateDunningAttempts, authorizePaymentSession } =
      buildContainer()
    mockPaymentSession({ id: "payses_1", status: "pending", context: {}, data: {} })

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
    })

    expect(response.output).toMatchObject({
      outcome: "awaiting_manual_resolution",
      park_reason: "indeterminate_provider_response",
      error_code: "provider_response_indeterminate",
    })
    expect(authorizePaymentSession).not.toHaveBeenCalled()
    expect(updateDunningAttempts).toHaveBeenCalledWith(
      expect.objectContaining({
        status: DunningAttemptStatus.FAILED,
        payment_reference: "payses_1",
        metadata: expect.objectContaining({ provider_reached: true }),
      })
    )
    expect(
      caseUpdate(updateDunningCases, DunningCaseStatus.AWAITING_MANUAL_RESOLUTION)
    ).toMatchObject({
      attempt_count: 1,
      metadata: expect.objectContaining({
        park_reason: "indeterminate_provider_response",
      }),
    })
  })

  it("records the payment session on the attempt row before authorizing", async () => {
    const { container, updateDunningAttempts, authorizePaymentSession } =
      buildContainer()
    authorizePaymentSession.mockResolvedValue({ id: "pay_1", amount: 100 })

    await runDunningRetry(container, { dunning_case_id: "dun_1" })

    expect(updateDunningAttempts).toHaveBeenNthCalledWith(1, {
      id: "dunatt_1",
      payment_reference: "payses_1",
    })
  })

  it("returns a half-written park instead of rolling the case back", async () => {
    // The case is already parked, so the step reports it: throwing would roll it back to the
    // scheduler and skip the parked event the workflow raises off this output.
    const { container, updateDunningCases, updateDunningAttempts } = buildContainer({
      caseMetadata: { setup_failure_streak: 2 },
    })
    mockPaymentSessionError(new Error("provider is not registered"))
    updateDunningAttempts.mockImplementation(async (payload) => {
      if (payload.status === DunningAttemptStatus.ABORTED) {
        throw new Error("attempt row write failed")
      }

      return payload
    })

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
    })

    expect(response.output).toMatchObject({
      outcome: "awaiting_manual_resolution",
      park_reason: "setup_failure",
      settled_now: false,
      next_retry_at: null,
      recovery_reason: null,
    })

    const lastCaseUpdate =
      updateDunningCases.mock.calls[updateDunningCases.mock.calls.length - 1][0]

    expect(lastCaseUpdate).toMatchObject({
      status: DunningCaseStatus.AWAITING_MANUAL_RESOLUTION,
      metadata: expect.objectContaining({ park_reason: "setup_failure" }),
    })
    expect(
      caseUpdate(updateDunningCases, DunningCaseStatus.RETRY_SCHEDULED)
    ).toBeUndefined()
  })

  it("refuses an admin retry on a park the provider may already have charged", async () => {
    // A fresh session deletes the one the charge was taken against, so the money would move twice.
    const { container, updateDunningCases } = buildContainer({
      attemptCount: 1,
      caseStatus: DunningCaseStatus.AWAITING_MANUAL_RESOLUTION,
      caseMetadata: { park_reason: "indeterminate_provider_response" },
    })

    await expect(
      runDunningRetry(container, {
        dunning_case_id: "dun_1",
        ignore_schedule: true,
        triggered_by: "admin_1",
      })
    ).rejects.toThrow(/reconcile it manually/)

    expect(createPaymentSessionsWorkflow).not.toHaveBeenCalled()
    expect(
      caseUpdate(updateDunningCases, DunningCaseStatus.RETRYING)
    ).toBeUndefined()
  })

  it("lets an admin retry a case parked on its last budget slot", async () => {
    const { container, authorizePaymentSession } = buildContainer({
      attemptCount: 3,
      maxAttempts: 3,
      caseStatus: DunningCaseStatus.AWAITING_MANUAL_RESOLUTION,
      caseMetadata: { park_reason: "requires_action" },
    })
    authorizePaymentSession.mockResolvedValue({ id: "pay_1", amount: 100 })

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
      ignore_schedule: true,
      triggered_by: "admin_1",
    })

    expect(response.output).toMatchObject({ outcome: "recovered" })
  })

  it("still blocks an admin retry on a spent case that was never parked", async () => {
    const { container } = buildContainer({
      attemptCount: 3,
      maxAttempts: 3,
      caseStatus: DunningCaseStatus.AWAITING_MANUAL_RESOLUTION,
      caseMetadata: null,
    })

    await expect(
      runDunningRetry(container, {
        dunning_case_id: "dun_1",
        ignore_schedule: true,
        triggered_by: "admin_1",
      })
    ).rejects.toThrow(/max attempts exceeded/)
  })

  it("clears the park reason when the customer only has to add a card", async () => {
    const { container, updateDunningCases } = buildContainer({
      hasPaymentMethod: false,
      caseMetadata: { park_reason: "requires_action" },
    })

    await expect(
      runDunningRetry(container, { dunning_case_id: "dun_1" })
    ).rejects.toThrow(/no saved payment method/)

    expect(
      caseUpdate(updateDunningCases, DunningCaseStatus.AWAITING_MANUAL_RESOLUTION)
    ).toMatchObject({
      next_retry_at: null,
      metadata: expect.objectContaining({ park_reason: null }),
    })
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
      settled_now: false,
      error_code: null,
      next_retry_at: null,
      recovery_reason: "payment_recovered",
    })
  })
})
