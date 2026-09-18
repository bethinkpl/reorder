jest.mock("@medusajs/medusa/core-flows", () => ({
  createOrUpdateOrderPaymentCollectionWorkflow: jest.fn(),
  createPaymentSessionsWorkflow: jest.fn(),
}))

jest.mock("../../utils/settle-subscription-payment-failure", () => ({
  settleSubscriptionPaymentFailure: jest.fn(),
}))

jest.mock("../../utils/settle-renewal-cycle-succeeded", () => ({
  settleRenewalCycleSucceeded: jest.fn(async () => ({ settled: true })),
}))

jest.mock("../../ensure-next-renewal-cycle", () => ({
  ensureNextRenewalCycleWorkflow: jest.fn(() => ({
    run: jest.fn(async () => ({ result: {} })),
  })),
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

const MINUTE = 60 * 1000

type PaymentCollectionFixture = {
  id: string
  status?: string
  payment_sessions?: Record<string, unknown>[]
}

type BuildContainerOptions = {
  caseStatus?: DunningCaseStatus
  attemptCount?: number
  caseMetadata?: Record<string, unknown> | null
  paymentCollections?: PaymentCollectionFixture[]
}

/** A session the host app's own checkout opened: no dunning marker, created just now. */
function customerSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "payses_customer",
    status: "pending",
    context: {},
    data: { id: "cs_live_1" },
    created_at: new Date(Date.now() - 5 * MINUTE),
    ...overrides,
  }
}

function buildContainer(options: BuildContainerOptions = {}) {
  const dunningCase = {
    id: "dun_1",
    subscription_id: "sub_1",
    renewal_cycle_id: "rc_1",
    renewal_order_id: "order_1",
    status: options.caseStatus ?? DunningCaseStatus.RETRY_SCHEDULED,
    attempt_count: options.attemptCount ?? 1,
    max_attempts: 3,
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

  const dunningModule = {
    retrieveDunningCase: jest.fn(async () => dunningCase),
    listDunningAttempts: jest.fn(async () => []),
    updateDunningCases,
    createDunningAttempts,
    updateDunningAttempts,
  }

  const subscriptionModule = {
    retrieveSubscription: jest.fn(async () => subscription),
    updateSubscriptions: jest.fn(async () => undefined),
  }

  const authorizePaymentSession = jest
    .fn()
    .mockResolvedValue({ id: "pay_1", amount: 100 })
  const paymentModule = {
    authorizePaymentSession,
    capturePayment: jest.fn(async () => undefined),
    retrievePayment: jest.fn(async () => ({
      id: "pay_1",
      currency_code: "pln",
      captures: [],
    })),
    listPaymentSessions: jest.fn(async () => [
      { id: "payses_1", status: "pending" },
    ]),
  }

  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }

  // The guard asks for the order's collections and sessions; every other read is the amounts one.
  const graph = jest.fn(async ({ fields }: { fields: string[] }) =>
    fields.some((field) => field.startsWith("payment_collections"))
      ? {
          data: [
            {
              id: "order_1",
              payment_collections: options.paymentCollections ?? [],
            },
          ],
        }
      : {
          data: [
            { id: "order_1", total: 100, summary: { pending_difference: 100 } },
          ],
        }
  )

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
          return { graph }
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
    logger,
    authorizePaymentSession,
    updateDunningCases,
    updateDunningAttempts,
  }
}

function mockPaymentCollection() {
  const run = jest.fn().mockResolvedValue({ result: [{ id: "paycol_1" }] })
  ;(
    createOrUpdateOrderPaymentCollectionWorkflow as unknown as jest.Mock
  ).mockReturnValue({ run })

  return run
}

function mockPaymentSession(session: Record<string, unknown>) {
  const run = jest.fn().mockResolvedValue({ result: session })
  ;(createPaymentSessionsWorkflow as unknown as jest.Mock).mockReturnValue({
    run,
  })

  return run
}

function mockPaymentSessionError(error: unknown) {
  const run = jest.fn().mockRejectedValue(error)
  ;(createPaymentSessionsWorkflow as unknown as jest.Mock).mockReturnValue({
    run,
  })

  return run
}

function caseUpdate(mock: jest.Mock, status: DunningCaseStatus) {
  return mock.mock.calls
    .map((call) => call[0])
    .find((payload) => payload.status === status)
}

describe("runDunningRetry - customer payment session guard", () => {
  let collectionRun: jest.Mock
  let sessionRun: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    ;(settleSubscriptionPaymentFailure as jest.Mock).mockResolvedValue({
      status: SubscriptionStatus.PAYMENT_FAILED,
      settled: true,
    })
    collectionRun = mockPaymentCollection()
    sessionRun = mockPaymentSession({
      id: "payses_1",
      status: "pending",
      context: {},
      data: { id: "pi_1" },
    })
  })

  it("steps aside while the customer is paying the renewal order themselves", async () => {
    const { container, updateDunningCases, updateDunningAttempts } =
      buildContainer({
        caseMetadata: { setup_failure_streak: 2 },
        paymentCollections: [
          { id: "paycol_1", status: "awaiting", payment_sessions: [customerSession()] },
        ],
      })

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
    })

    expect(collectionRun).not.toHaveBeenCalled()
    expect(sessionRun).not.toHaveBeenCalled()
    expect(response.output).toMatchObject({
      outcome: "retry_scheduled",
      park_reason: null,
      settled_now: false,
      recovered_now: false,
      attempt_counted: false,
      error_code: "customer_payment_in_progress",
    })
    expect(updateDunningAttempts).toHaveBeenCalledWith(
      expect.objectContaining({
        status: DunningAttemptStatus.ABORTED,
        error_code: "customer_payment_in_progress",
        payment_reference: null,
      })
    )

    const scheduled = caseUpdate(
      updateDunningCases,
      DunningCaseStatus.RETRY_SCHEDULED
    )

    expect(scheduled).toMatchObject({
      attempt_count: 1,
      metadata: expect.objectContaining({
        session_conflict_count: 1,
        // Untouched: a customer paying is not a fault of ours, so it never walks the case to a park.
        setup_failure_streak: 2,
        park_reason: null,
      }),
    })
    expect(
      scheduled.next_retry_at.getTime() - scheduled.last_attempt_at.getTime()
    ).toBe(60 * MINUTE)
    expect(
      caseUpdate(updateDunningCases, DunningCaseStatus.AWAITING_MANUAL_RESOLUTION)
    ).toBeUndefined()
    expect(settleSubscriptionPaymentFailure).not.toHaveBeenCalled()
  })

  it("steps aside for a sibling collection somebody else authorized", async () => {
    const { container, updateDunningCases } = buildContainer({
      paymentCollections: [
        { id: "paycol_1", status: "not_paid", payment_sessions: [] },
        {
          id: "paycol_2",
          status: "authorized",
          payment_sessions: [customerSession({ status: "authorized" })],
        },
      ],
    })

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
    })

    expect(collectionRun).not.toHaveBeenCalled()
    expect(sessionRun).not.toHaveBeenCalled()
    expect(response.output).toMatchObject({
      outcome: "retry_scheduled",
      park_reason: null,
      error_code: "customer_payment_in_progress",
    })
    expect(
      caseUpdate(updateDunningCases, DunningCaseStatus.RETRY_SCHEDULED)
    ).toMatchObject({ attempt_count: 1 })
  })

  it("retries an order our own earlier attempt left authorized", async () => {
    // The sequence that used to deadlock: our retry authorized, the capture threw, the collection
    // stayed `authorized` with money still owed. Nothing but another tick can clear that, so it
    // must not read as a payment to step aside for.
    const { container } = buildContainer({
      paymentCollections: [
        {
          id: "paycol_1",
          status: "authorized",
          payment_sessions: [
            {
              id: "payses_ours",
              status: "authorized",
              context: {
                dunning_case_id: "dun_1",
                dunning_attempt_id: "dunatt_0",
              },
              data: { id: "pi_0" },
              created_at: new Date(Date.now() - 5 * MINUTE),
            },
          ],
        },
      ],
    })

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
    })

    expect(collectionRun).toHaveBeenCalled()
    expect(sessionRun).toHaveBeenCalled()
    expect(response.output.outcome).toBe("recovered")
  })

  it("hands the case over once the customer has stalled for a day", async () => {
    const { container, updateDunningCases, updateDunningAttempts } =
      buildContainer({
        caseMetadata: { session_conflict_count: 23 },
        paymentCollections: [
          { id: "paycol_1", status: "awaiting", payment_sessions: [customerSession()] },
        ],
      })

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
    })

    expect(sessionRun).not.toHaveBeenCalled()
    expect(response.output).toMatchObject({
      outcome: "awaiting_manual_resolution",
      park_reason: "customer_payment_stalled",
      next_retry_at: null,
      attempt_counted: false,
    })
    expect(updateDunningAttempts).toHaveBeenCalledWith(
      expect.objectContaining({
        status: DunningAttemptStatus.ABORTED,
        payment_reference: null,
      })
    )
    expect(
      caseUpdate(updateDunningCases, DunningCaseStatus.AWAITING_MANUAL_RESOLUTION)
    ).toMatchObject({
      attempt_count: 1,
      metadata: expect.objectContaining({
        park_reason: "customer_payment_stalled",
        session_conflict_count: 24,
      }),
    })
    expect(
      caseUpdate(updateDunningCases, DunningCaseStatus.RETRY_SCHEDULED)
    ).toBeUndefined()
  })

  it("skips an admin retry-now just the same", async () => {
    // An operator must not be able to kill the customer's session either.
    const { container, updateDunningCases } = buildContainer({
      paymentCollections: [
        { id: "paycol_1", status: "awaiting", payment_sessions: [customerSession()] },
      ],
    })

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
      ignore_schedule: true,
      triggered_by: "admin_1",
    })

    expect(sessionRun).not.toHaveBeenCalled()
    expect(response.output).toMatchObject({
      outcome: "retry_scheduled",
      park_reason: null,
      error_code: "customer_payment_in_progress",
    })
    expect(
      caseUpdate(updateDunningCases, DunningCaseStatus.RETRY_SCHEDULED)
    ).toMatchObject({ attempt_count: 1 })
  })

  it("marks the session it creates as its own", async () => {
    const { container } = buildContainer()

    await runDunningRetry(container, { dunning_case_id: "dun_1" })

    expect(sessionRun).toHaveBeenCalledWith({
      input: expect.objectContaining({
        context: {
          dunning_case_id: "dun_1",
          dunning_attempt_id: "dunatt_1",
        },
      }),
    })
  })

  it("reschedules when the host refuses to delete a session the customer completed", async () => {
    // The host provider throws from the session delete inside `createPaymentSessionsWorkflow` when
    // the customer's checkout is already complete at the provider but its webhook has yet to land.
    // Nothing was created and nothing was declined, so the attempt owes its slot back.
    const { container, updateDunningCases, updateDunningAttempts } =
      buildContainer()
    mockPaymentSessionError(
      new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Payment session 'payses_customer' is already complete"
      )
    )

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
    })

    expect(response.output).toMatchObject({
      outcome: "retry_scheduled",
      park_reason: null,
      attempt_counted: false,
      error_code: "payment_session_setup_failed",
    })
    expect(updateDunningAttempts).toHaveBeenCalledWith(
      expect.objectContaining({
        status: DunningAttemptStatus.ABORTED,
        payment_reference: null,
      })
    )

    const scheduled = caseUpdate(
      updateDunningCases,
      DunningCaseStatus.RETRY_SCHEDULED
    )

    expect(scheduled).toMatchObject({
      attempt_count: 1,
      metadata: expect.objectContaining({ setup_failure_streak: 1 }),
    })
    expect(
      scheduled.next_retry_at.getTime() - scheduled.last_attempt_at.getTime()
    ).toBe(60 * MINUTE)
    expect(
      caseUpdate(updateDunningCases, DunningCaseStatus.AWAITING_MANUAL_RESOLUTION)
    ).toBeUndefined()
  })

  it("lets an operator retry a stalled case that has spent its budget", async () => {
    const { container } = buildContainer({
      caseStatus: DunningCaseStatus.AWAITING_MANUAL_RESOLUTION,
      attemptCount: 3,
      caseMetadata: {
        park_reason: "customer_payment_stalled",
        session_conflict_count: 24,
      },
    })

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
      ignore_schedule: true,
      triggered_by: "admin_1",
    })

    expect(sessionRun).toHaveBeenCalled()
    expect(response.output.outcome).toBe("recovered")
  })

  it("counts the attempt when the provider declined it", async () => {
    // The budget paid for this one, so the customer is told about it and the next tick has one
    // attempt less to spend.
    const { container, authorizePaymentSession, updateDunningCases } =
      buildContainer()
    authorizePaymentSession.mockRejectedValue(new Error("Try again later"))

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
    })

    expect(response.output).toMatchObject({
      outcome: "retry_scheduled",
      attempt_counted: true,
    })
    expect(
      caseUpdate(updateDunningCases, DunningCaseStatus.RETRYING)
    ).toMatchObject({ attempt_count: 2 })
  })

  it("forgets the conflict count once the provider answers again", async () => {
    const { container, updateDunningCases } = buildContainer({
      caseMetadata: { session_conflict_count: 2 },
    })

    const response = await runDunningRetry(container, {
      dunning_case_id: "dun_1",
    })

    expect(response.output.outcome).toBe("recovered")
    expect(
      caseUpdate(updateDunningCases, DunningCaseStatus.RECOVERED).metadata
    ).not.toHaveProperty("session_conflict_count")
  })
})
