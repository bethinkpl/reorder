import jwt from "jsonwebtoken"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import type {
  IApiKeyModuleService,
  IEventBusModuleService,
  IOrderModuleService,
  IPaymentModuleService,
  MedusaContainer,
  PaymentSessionDTO,
} from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
  PaymentEvents,
} from "@medusajs/framework/utils"
import { reconcilePaidDunningCases } from "../../src/jobs/reconcile-paid-dunning-cases"
import { DUNNING_MODULE } from "../../src/modules/dunning"
import { DunningEvents } from "../../src/modules/dunning/events"
import type DunningModuleService from "../../src/modules/dunning/service"
import {
  DunningAttemptStatus,
  DunningCaseStatus,
} from "../../src/modules/dunning/types"
import { listDueDunningCasesForProcessing } from "../../src/modules/dunning/utils/scheduler-query"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import {
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../src/modules/renewal/types"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import activateSubscriptionOnPaymentCapturedHandler from "../../src/subscribers/activate-subscription-on-payment-captured"
import { cancelSubscriptionByCustomerWorkflow } from "../../src/workflows/cancel-subscription-by-customer"
import { runDunningRetryWorkflow } from "../../src/workflows/run-dunning-retry"
import { startDunningWorkflow } from "../../src/workflows/start-dunning"
import { failAwaitingDunningAttempt } from "../../src/workflows/utils/fail-awaiting-dunning-attempt"
import { recordOrderCaptureTransactions } from "../../src/workflows/utils/record-order-capture-transactions"
import {
  createAdminAuthHeaders,
  createDunningAttemptSeed,
  createDunningCaseSeed,
  createRenewalCycleSeed,
  createSubscriptionSeed,
  defaultRetrySchedule,
} from "../helpers/dunning-fixtures"
import {
  SYSTEM_PAYMENT_PROVIDER_ID,
  authorizeAndCapturePaymentSession,
  createPaymentSessionFixture,
} from "../helpers/payment-fixtures"

const mockCreateOrUpdateOrderPaymentCollectionRun = jest.fn()
const mockCreatePaymentSessionsRun = jest.fn()

jest.mock("@medusajs/medusa/core-flows", () => {
  const actual = jest.requireActual("@medusajs/medusa/core-flows")

  return {
    ...actual,
    createOrUpdateOrderPaymentCollectionWorkflow: () => ({
      run: mockCreateOrUpdateOrderPaymentCollectionRun,
    }),
    createPaymentSessionsWorkflow: () => ({
      run: mockCreatePaymentSessionsRun,
    }),
  }
})

const RENEWAL_AMOUNT = 129
const DAY_MS = 24 * 60 * 60 * 1000

type DunningScenario = {
  subscription: Awaited<ReturnType<typeof createSubscriptionSeed>>
  cycle: Awaited<ReturnType<typeof createRenewalCycleSeed>>
  dunningCase: Awaited<ReturnType<typeof createDunningCaseSeed>>
  orderId: string
}

async function seedDunningScenario(
  container: MedusaContainer,
  input: {
    reference: string
    case_status: DunningCaseStatus
    attempt_count: number
    max_attempts?: number
    customer_id?: string
  }
): Promise<DunningScenario> {
  const orderModule = container.resolve<IOrderModuleService>(Modules.ORDER)
  const dueAt = new Date(Date.now() - 2 * DAY_MS)

  const subscription = await createSubscriptionSeed(container, {
    reference: input.reference,
    status: SubscriptionStatus.PAST_DUE,
    customer_id: input.customer_id,
    next_renewal_at: dueAt,
    payment_context: {
      payment_provider_id: SYSTEM_PAYMENT_PROVIDER_ID,
      account_holder_id: `acch_${input.reference}`,
      payment_method_id: `pm_${input.reference}`,
    },
  })
  const order = await orderModule.createOrders({
    currency_code: "pln",
    email: "customer@example.com",
    metadata: { subscription_id: subscription.id },
    items: [
      {
        title: "Subscription renewal",
        quantity: 1,
        unit_price: RENEWAL_AMOUNT,
      },
    ],
  })
  const cycle = await createRenewalCycleSeed(container, {
    subscription_id: subscription.id,
    status: RenewalCycleStatus.FAILED,
    scheduled_for: dueAt,
    generated_order_id: order.id,
  })
  const dunningCase = await createDunningCaseSeed(container, {
    subscription_id: subscription.id,
    renewal_cycle_id: cycle.id,
    renewal_order_id: order.id,
    status: input.case_status,
    attempt_count: input.attempt_count,
    max_attempts: input.max_attempts ?? 3,
    retry_schedule: defaultRetrySchedule,
    next_retry_at:
      input.case_status === DunningCaseStatus.RETRY_SCHEDULED
        ? new Date(Date.now() - 60_000)
        : null,
  })

  return { subscription, cycle, dunningCase, orderId: order.id }
}

/** An attempt whose charge went to the provider on a session carrying the retry's markers. */
async function seedRetryAttempt(
  container: MedusaContainer,
  scenario: DunningScenario,
  input: { attempt_no: number, status: DunningAttemptStatus }
) {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const link = container.resolve(ContainerRegistrationKeys.LINK)

  const attempt = await createDunningAttemptSeed(container, {
    dunning_case_id: scenario.dunningCase.id,
    attempt_no: input.attempt_no,
    status: input.status,
    finished_at:
      input.status === DunningAttemptStatus.PROCESSING ? null : new Date(),
  })
  const { collection, session } = await createPaymentSessionFixture(container, {
    amount: RENEWAL_AMOUNT,
    context: {
      dunning_case_id: scenario.dunningCase.id,
      dunning_attempt_id: attempt.id,
    },
  })

  await dunningModule.updateDunningAttempts({
    id: attempt.id,
    payment_reference: session.id,
  })
  await link.create({
    [Modules.ORDER]: { order_id: scenario.orderId },
    [Modules.PAYMENT]: { payment_collection_id: collection.id },
  })

  return { attempt, session }
}

async function seedAwaitingCase(
  container: MedusaContainer,
  input: {
    reference: string
    attempt_count: number
    max_attempts?: number
    customer_id?: string
  }
) {
  const scenario = await seedDunningScenario(container, {
    ...input,
    case_status: DunningCaseStatus.AWAITING_PAYMENT,
  })
  const { attempt, session } = await seedRetryAttempt(container, scenario, {
    attempt_no: input.attempt_count,
    status: DunningAttemptStatus.PROCESSING,
  })

  return { ...scenario, attempt, session }
}

function routeRetrySessionsToFixture(container: MedusaContainer) {
  const sessions: PaymentSessionDTO[] = []

  mockCreateOrUpdateOrderPaymentCollectionRun.mockResolvedValue({
    result: [{ id: "paycol_retry" }],
  })
  mockCreatePaymentSessionsRun.mockImplementation(async ({ input }) => {
    const { session } = await createPaymentSessionFixture(container, {
      amount: RENEWAL_AMOUNT,
      context: input.context,
    })

    sessions.push(session)

    // The system provider keeps no data on a session, which a retry reads as an indeterminate answer.
    return { result: { ...session, data: { reference: session.id } } }
  })

  return sessions
}

function recordEvents(container: MedusaContainer) {
  const eventBus = container.resolve<IEventBusModuleService>(Modules.EVENT_BUS)
  const emit = jest.spyOn(eventBus, "emit")

  const payloads = (name: string) =>
    emit.mock.calls
      .flatMap(([message]) => (Array.isArray(message) ? message : [message]))
      .filter((message) => message.name === name)
      .map((message) => message.data)

  return {
    payloads,
    count: (name: string) => payloads(name).length,
  }
}

async function captureWithOrderTransaction(
  container: MedusaContainer,
  orderId: string,
  sessionId: string
) {
  const payment = await authorizeAndCapturePaymentSession(container, sessionId)

  await recordOrderCaptureTransactions(container, orderId, payment.id)

  return payment
}

async function deliverPaymentCaptured(
  container: MedusaContainer,
  paymentId: string
) {
  await activateSubscriptionOnPaymentCapturedHandler({
    event: { name: PaymentEvents.CAPTURED, data: { id: paymentId } },
    container,
    pluginOptions: {},
  })
}

async function createStoreCustomerHeaders(
  container: MedusaContainer,
  customerId: string
) {
  const apiKeyModule = container.resolve<IApiKeyModuleService>(Modules.API_KEY)
  const apiKey = await apiKeyModule.createApiKeys({
    title: "Storefront",
    type: "publishable",
    created_by: "dunning-awaiting-payment-spec",
  })
  const token = jwt.sign(
    {
      actor_id: customerId,
      actor_type: "customer",
      auth_identity_id: `authid_${customerId}`,
      app_metadata: { customer_id: customerId },
      user_metadata: {},
    },
    process.env.JWT_SECRET || "supersecret",
    { expiresIn: "1d" }
  )

  return {
    "authorization": `Bearer ${token}`,
    "x-publishable-api-key": apiKey.token,
  }
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ api, getContainer }) => {
    describe("dunning retry awaiting the provider's answer", () => {
      beforeEach(() => {
        jest.restoreAllMocks()
        jest.clearAllMocks()
      })

      it("leaves the case awaiting the provider when the retry's authorisation returns no payment", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const paymentModule = container.resolve<IPaymentModuleService>(
          Modules.PAYMENT
        )

        const scenario = await seedDunningScenario(container, {
          reference: "SUB-DUN-AWAIT-001",
          case_status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 0,
        })
        const sessions = routeRetrySessionsToFixture(container)
        jest
          .spyOn(paymentModule, "authorizePaymentSession")
          .mockResolvedValue(null as never)
        const events = recordEvents(container)

        await runDunningRetryWorkflow(container).run({
          input: { dunning_case_id: scenario.dunningCase.id },
        })

        const updatedCase = await dunningModule.retrieveDunningCase(
          scenario.dunningCase.id
        )
        const attempts = await dunningModule.listDunningAttempts({
          dunning_case_id: scenario.dunningCase.id,
        })

        expect(sessions).toHaveLength(1)
        expect(updatedCase).toMatchObject({
          status: DunningCaseStatus.AWAITING_PAYMENT,
          next_retry_at: null,
          attempt_count: 1,
        })
        expect(attempts).toHaveLength(1)
        expect(attempts[0]).toMatchObject({
          attempt_no: 1,
          status: DunningAttemptStatus.PROCESSING,
          payment_reference: sessions[0].id,
          finished_at: null,
        })
        expect(events.count(DunningEvents.ATTEMPT_FAILED)).toBe(0)
      })

      it("refuses to retry or reschedule a case awaiting the provider and shows it to the customer as a retry in progress", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const customerId = "cus_dunning_awaiting_store"

        const scenario = await seedAwaitingCase(container, {
          reference: "SUB-DUN-AWAIT-002",
          attempt_count: 1,
          customer_id: customerId,
        })
        const caseId = scenario.dunningCase.id
        const subscriptionId = scenario.subscription.id
        const adminHeaders = await createAdminAuthHeaders(container)
        const storeHeaders = await createStoreCustomerHeaders(
          container,
          customerId
        )

        const due = await listDueDunningCasesForProcessing(container, {
          limit: 100,
          now: new Date(Date.now() + 365 * DAY_MS),
        })

        expect(due.cases.map((dueCase) => dueCase.id)).not.toContain(caseId)

        await expect(
          api.post(
            `/store/customers/me/subscriptions/${subscriptionId}/retry-payment`,
            {},
            { headers: storeHeaders }
          )
        ).rejects.toMatchObject({
          response: {
            status: 409,
            data: { blocked_reason: "payment_in_progress" },
          },
        })

        const storeDetail = await api.get(
          `/store/customers/me/subscriptions/${subscriptionId}`,
          { headers: storeHeaders }
        )

        expect(storeDetail.data.subscription).toMatchObject({
          payment_status: "recovery_required",
          payment_recovery: {
            dunning_case_id: caseId,
            state: DunningCaseStatus.RETRYING,
            retry_eligible: false,
            retry_blocked_reason: "payment_in_progress",
          },
        })

        await expect(
          api.post(
            `/admin/dunning/${caseId}/retry-now`,
            {},
            { headers: adminHeaders }
          )
        ).rejects.toMatchObject({
          response: {
            status: 409,
            data: { message: expect.stringContaining("payment_in_progress") },
          },
        })

        await expect(
          api.post(
            `/admin/dunning/${caseId}/retry-schedule`,
            {
              reason: "shorter cadence",
              intervals: [60, 120, 240],
              max_attempts: 3,
            },
            { headers: adminHeaders }
          )
        ).rejects.toMatchObject({
          response: { status: 409 },
        })

        const updatedCase = await dunningModule.retrieveDunningCase(caseId)
        const attempts = await dunningModule.listDunningAttempts({
          dunning_case_id: caseId,
        })

        expect(updatedCase).toMatchObject({
          status: DunningCaseStatus.AWAITING_PAYMENT,
          next_retry_at: null,
          attempt_count: 1,
          retry_schedule: defaultRetrySchedule,
        })
        expect(attempts).toHaveLength(1)
        expect(attempts[0].status).toEqual(DunningAttemptStatus.PROCESSING)
      })

      it("opens no second case for the subscription while a charge awaits the provider", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)

        const scenario = await seedAwaitingCase(container, {
          reference: "SUB-DUN-AWAIT-003",
          attempt_count: 1,
        })
        const laterCycle = await createRenewalCycleSeed(container, {
          subscription_id: scenario.subscription.id,
          status: RenewalCycleStatus.FAILED,
        })

        await expect(
          startDunningWorkflow(container).run({
            input: {
              subscription_id: scenario.subscription.id,
              renewal_cycle_id: laterCycle.id,
              payment_failure_source: "payment_provider",
              payment_error_code: "card_declined",
              payment_error_message: "Issuer declined the charge",
            },
          })
        ).rejects.toMatchObject({
          message: expect.stringMatching(/Duplicate active dunning case blocked/),
        })

        const cases = await dunningModule.listDunningCases({
          subscription_id: scenario.subscription.id,
        })

        expect(cases).toHaveLength(1)
        expect(cases[0]).toMatchObject({
          id: scenario.dunningCase.id,
          status: DunningCaseStatus.AWAITING_PAYMENT,
        })
      })

      it("recovers the case from the capture of its own awaiting attempt and settles the renewal cycle", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

        const scenario = await seedAwaitingCase(container, {
          reference: "SUB-DUN-AWAIT-004",
          attempt_count: 1,
        })
        const payment = await captureWithOrderTransaction(
          container,
          scenario.orderId,
          scenario.session.id
        )
        const events = recordEvents(container)

        await deliverPaymentCaptured(container, payment.id)

        const updatedCase = await dunningModule.retrieveDunningCase(
          scenario.dunningCase.id
        )
        const attempts = await dunningModule.listDunningAttempts({
          dunning_case_id: scenario.dunningCase.id,
        })
        const subscription = await subscriptionModule.retrieveSubscription(
          scenario.subscription.id
        )
        const cycle = await renewalModule.retrieveRenewalCycle(scenario.cycle.id)
        const renewalAttempts = await renewalModule.listRenewalAttempts({
          renewal_cycle_id: scenario.cycle.id,
        })

        expect(updatedCase).toMatchObject({
          status: DunningCaseStatus.RECOVERED,
          recovery_reason: "payment_recovered",
          next_retry_at: null,
        })
        expect(attempts).toHaveLength(1)
        expect(attempts[0]).toMatchObject({
          id: scenario.attempt.id,
          status: DunningAttemptStatus.SUCCEEDED,
          payment_reference: payment.id,
        })
        expect(attempts[0].finished_at).toBeTruthy()
        expect(subscription.status).toEqual(SubscriptionStatus.ACTIVE)
        expect(cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(renewalAttempts).toContainEqual(
          expect.objectContaining({
            status: RenewalAttemptStatus.SUCCEEDED,
            metadata: expect.objectContaining({ source: "dunning_retry" }),
          })
        )
        expect(events.payloads(DunningEvents.RECOVERED)).toEqual([
          expect.objectContaining({
            dunning_case_id: scenario.dunningCase.id,
            recovery_reason: "payment_recovered",
          }),
        ])
      })

      it("reschedules the next retry once when the awaiting charge fails, however often the failure is reported", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)

        const scenario = await seedAwaitingCase(container, {
          reference: "SUB-DUN-AWAIT-005",
          attempt_count: 1,
        })
        const failure = {
          session_id: scenario.session.id,
          action: "failed",
          reason: "insufficient_funds",
        }
        const nextIntervalMs = defaultRetrySchedule.intervals[1] * 60 * 1000
        const events = recordEvents(container)

        const before = Date.now()
        await failAwaitingDunningAttempt(container, failure)
        const after = Date.now()

        const rescheduledCase = await dunningModule.retrieveDunningCase(
          scenario.dunningCase.id
        )

        await failAwaitingDunningAttempt(container, failure)

        const finalCase = await dunningModule.retrieveDunningCase(
          scenario.dunningCase.id
        )
        const attempts = await dunningModule.listDunningAttempts({
          dunning_case_id: scenario.dunningCase.id,
        })
        const nextRetryAt = new Date(rescheduledCase.next_retry_at!).getTime()

        expect(rescheduledCase).toMatchObject({
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 1,
          last_payment_error_code: "insufficient_funds",
        })
        expect(nextRetryAt).toBeGreaterThanOrEqual(before + nextIntervalMs)
        expect(nextRetryAt).toBeLessThanOrEqual(after + nextIntervalMs)
        expect(finalCase).toMatchObject({
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 1,
          next_retry_at: rescheduledCase.next_retry_at,
        })
        expect(attempts).toHaveLength(1)
        expect(attempts[0]).toMatchObject({
          status: DunningAttemptStatus.FAILED,
          error_code: "insufficient_funds",
          payment_reference: scenario.session.id,
        })
        expect(attempts[0].finished_at).toBeTruthy()
        expect(events.count(DunningEvents.ATTEMPT_FAILED)).toBe(1)
      })

      it("closes the case as unrecovered when the charge of the last allowed attempt fails", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

        const scenario = await seedAwaitingCase(container, {
          reference: "SUB-DUN-AWAIT-006",
          attempt_count: 3,
          max_attempts: 3,
        })
        const events = recordEvents(container)

        await failAwaitingDunningAttempt(container, {
          session_id: scenario.session.id,
          action: "failed",
          reason: "insufficient_funds",
        })

        const updatedCase = await dunningModule.retrieveDunningCase(
          scenario.dunningCase.id
        )
        const attempts = await dunningModule.listDunningAttempts({
          dunning_case_id: scenario.dunningCase.id,
        })
        const subscription = await subscriptionModule.retrieveSubscription(
          scenario.subscription.id
        )

        expect(updatedCase).toMatchObject({
          status: DunningCaseStatus.UNRECOVERED,
          attempt_count: 3,
          next_retry_at: null,
          recovery_reason: "retry_limit_exhausted",
        })
        expect(attempts[0].status).toEqual(DunningAttemptStatus.FAILED)
        expect(subscription.status).toEqual(SubscriptionStatus.PAYMENT_FAILED)
        expect(events.count(DunningEvents.PAYMENT_FAILED)).toBe(1)
      })

      it("reschedules rather than settles the case when the awaiting charge is canceled", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

        const scenario = await seedAwaitingCase(container, {
          reference: "SUB-DUN-AWAIT-007",
          attempt_count: 1,
        })

        await failAwaitingDunningAttempt(container, {
          session_id: scenario.session.id,
          action: "canceled",
          reason: null,
        })

        const updatedCase = await dunningModule.retrieveDunningCase(
          scenario.dunningCase.id
        )
        const attempts = await dunningModule.listDunningAttempts({
          dunning_case_id: scenario.dunningCase.id,
        })
        const subscription = await subscriptionModule.retrieveSubscription(
          scenario.subscription.id
        )

        expect(updatedCase).toMatchObject({
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 1,
          closed_at: null,
          recovery_reason: null,
        })
        expect(updatedCase.next_retry_at).toBeTruthy()
        expect(attempts[0].status).toEqual(DunningAttemptStatus.FAILED)
        expect(subscription.status).toEqual(SubscriptionStatus.PAST_DUE)
      })

      it("ignores a failure reported for the session of an earlier attempt", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)

        const scenario = await seedDunningScenario(container, {
          reference: "SUB-DUN-AWAIT-008",
          case_status: DunningCaseStatus.AWAITING_PAYMENT,
          attempt_count: 2,
        })
        const earlier = await seedRetryAttempt(container, scenario, {
          attempt_no: 1,
          status: DunningAttemptStatus.FAILED,
        })
        const awaiting = await seedRetryAttempt(container, scenario, {
          attempt_no: 2,
          status: DunningAttemptStatus.PROCESSING,
        })
        const events = recordEvents(container)

        await failAwaitingDunningAttempt(container, {
          session_id: earlier.session.id,
          action: "failed",
          reason: "insufficient_funds",
        })

        const updatedCase = await dunningModule.retrieveDunningCase(
          scenario.dunningCase.id
        )
        const updatedAwaiting = await dunningModule.retrieveDunningAttempt(
          awaiting.attempt.id
        )

        expect(updatedCase).toMatchObject({
          status: DunningCaseStatus.AWAITING_PAYMENT,
          next_retry_at: null,
          attempt_count: 2,
        })
        expect(updatedAwaiting).toMatchObject({
          status: DunningAttemptStatus.PROCESSING,
          finished_at: null,
          error_code: null,
        })
        expect(events.count(DunningEvents.ATTEMPT_FAILED)).toBe(0)
      })

      it("ignores a failure reported for a retry whose authorisation already failed", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)

        const scenario = await seedDunningScenario(container, {
          reference: "SUB-DUN-AWAIT-009",
          case_status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 1,
        })
        const failed = await seedRetryAttempt(container, scenario, {
          attempt_no: 1,
          status: DunningAttemptStatus.FAILED,
        })
        const events = recordEvents(container)

        await failAwaitingDunningAttempt(container, {
          session_id: failed.session.id,
          action: "failed",
          reason: "insufficient_funds",
        })

        const updatedCase = await dunningModule.retrieveDunningCase(
          scenario.dunningCase.id
        )

        expect(updatedCase).toMatchObject({
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 1,
          next_retry_at: scenario.dunningCase.next_retry_at,
        })
        expect(events.count(DunningEvents.ATTEMPT_FAILED)).toBe(0)
      })

      it("closes an awaiting case when the customer cancels the subscription", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)

        const scenario = await seedAwaitingCase(container, {
          reference: "SUB-DUN-AWAIT-010",
          attempt_count: 1,
        })

        await cancelSubscriptionByCustomerWorkflow(container).run({
          input: {
            subscription_id: scenario.subscription.id,
            reason: "Cannot pay right now",
            triggered_by: scenario.subscription.customer_id,
          },
        })

        const updatedCase = await dunningModule.retrieveDunningCase(
          scenario.dunningCase.id
        )

        expect(updatedCase).toMatchObject({
          status: DunningCaseStatus.UNRECOVERED,
          next_retry_at: null,
          recovery_reason: "subscription_cancelled_by_customer",
        })
        expect(updatedCase.closed_at).toBeTruthy()
      })

      it("recovers an awaiting case through the paid-order sweep when its capture event never arrived", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)

        const scenario = await seedAwaitingCase(container, {
          reference: "SUB-DUN-AWAIT-011",
          attempt_count: 1,
        })

        await captureWithOrderTransaction(
          container,
          scenario.orderId,
          scenario.session.id
        )
        await reconcilePaidDunningCases(container)

        const updatedCase = await dunningModule.retrieveDunningCase(
          scenario.dunningCase.id
        )

        expect(updatedCase.status).toEqual(DunningCaseStatus.RECOVERED)
      })

      it("recovers the case at once when the retry's authorisation returns a payment", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const paymentModule = container.resolve<IPaymentModuleService>(
          Modules.PAYMENT
        )

        const scenario = await seedDunningScenario(container, {
          reference: "SUB-DUN-AWAIT-012",
          case_status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 0,
        })
        const sessions = routeRetrySessionsToFixture(container)
        const events = recordEvents(container)

        await runDunningRetryWorkflow(container).run({
          input: { dunning_case_id: scenario.dunningCase.id },
        })

        const payments = await paymentModule.listPayments({
          payment_session_id: sessions[0].id,
        })
        const updatedCase = await dunningModule.retrieveDunningCase(
          scenario.dunningCase.id
        )
        const attempts = await dunningModule.listDunningAttempts({
          dunning_case_id: scenario.dunningCase.id,
        })
        const subscription = await subscriptionModule.retrieveSubscription(
          scenario.subscription.id
        )
        const cycle = await renewalModule.retrieveRenewalCycle(scenario.cycle.id)

        expect(payments).toHaveLength(1)
        expect(updatedCase).toMatchObject({
          status: DunningCaseStatus.RECOVERED,
          recovery_reason: "payment_recovered",
          attempt_count: 1,
        })
        expect(attempts).toHaveLength(1)
        expect(attempts[0]).toMatchObject({
          status: DunningAttemptStatus.SUCCEEDED,
          payment_reference: payments[0].id,
        })
        expect(subscription.status).toEqual(SubscriptionStatus.ACTIVE)
        expect(cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(events.count(DunningEvents.RECOVERED)).toBe(1)
      })

      it("counts a thrown authorisation as a failed attempt and schedules the next retry", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const paymentModule = container.resolve<IPaymentModuleService>(
          Modules.PAYMENT
        )

        const scenario = await seedDunningScenario(container, {
          reference: "SUB-DUN-AWAIT-013",
          case_status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 0,
        })
        const sessions = routeRetrySessionsToFixture(container)
        jest
          .spyOn(paymentModule, "authorizePaymentSession")
          .mockRejectedValue(new Error("Temporary network timeout"))
        const events = recordEvents(container)

        await runDunningRetryWorkflow(container).run({
          input: { dunning_case_id: scenario.dunningCase.id },
        })

        const updatedCase = await dunningModule.retrieveDunningCase(
          scenario.dunningCase.id
        )
        const attempts = await dunningModule.listDunningAttempts({
          dunning_case_id: scenario.dunningCase.id,
        })

        expect(updatedCase).toMatchObject({
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 1,
        })
        expect(updatedCase.next_retry_at).toBeTruthy()
        expect(attempts).toHaveLength(1)
        expect(attempts[0]).toMatchObject({
          status: DunningAttemptStatus.FAILED,
          payment_reference: sessions[0].id,
        })
        expect(events.count(DunningEvents.ATTEMPT_FAILED)).toBe(1)
      })
    })
  },
})

jest.setTimeout(60 * 1000)
