import jwt from "jsonwebtoken"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import type { MedusaContainer, PaymentSessionDTO } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules, PaymentEvents } from "@medusajs/framework/utils"
import processDunningRetriesJob from "../../src/jobs/process-dunning-retries"
import {
  DUNNING_AWAITING_PAYMENT_OVERDUE_EVENT,
  reconcilePaidDunningCases,
} from "../../src/jobs/reconcile-paid-dunning-cases"
import { getAdminCancellationDetail } from "../../src/modules/cancellation/utils/admin-query"
import { DUNNING_MODULE } from "../../src/modules/dunning"
import { DunningEvents } from "../../src/modules/dunning/events"
import type DunningModuleService from "../../src/modules/dunning/service"
import { DunningAttemptStatus, DunningCaseStatus } from "../../src/modules/dunning/types"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import { RenewalAttemptStatus, RenewalCycleStatus } from "../../src/modules/renewal/types"
import { DEFAULT_AWAITING_PAYMENT_ALERT_HOURS } from "../../src/modules/renewal/utils/awaiting-payment-age"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import activateSubscriptionOnPaymentCapturedHandler from "../../src/subscribers/activate-subscription-on-payment-captured"
import { cancelSubscriptionByCustomerWorkflow } from "../../src/workflows/cancel-subscription-by-customer"
import { startDunningWorkflow } from "../../src/workflows/start-dunning"
import { failAwaitingDunningAttempt } from "../../src/workflows/utils/fail-awaiting-dunning-attempt"
import { recordOrderCaptureTransactions } from "../../src/workflows/utils/record-order-capture-transactions"
import { createCancellationCaseSeed } from "../helpers/cancellation-fixtures"
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
import { RENEWAL_AMOUNT, answerAuthorizationWithNull } from "../helpers/renewal-charge-fixtures"

const mockCreateOrUpdateOrderPaymentCollectionRun = jest.fn()
const mockCreatePaymentSessionsRun = jest.fn()

jest.mock("@medusajs/medusa/core-flows", () => {
  const actual = jest.requireActual("@medusajs/medusa/core-flows")

  return {
    ...actual,
    createOrUpdateOrderPaymentCollectionWorkflow: () => ({
      run: mockCreateOrUpdateOrderPaymentCollectionRun,
    }),
    createPaymentSessionsWorkflow: () => ({ run: mockCreatePaymentSessionsRun }),
  }
})

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

type DunningCaseSeedOptions = {
  status?: DunningCaseStatus
  attempt_count?: number
  max_attempts?: number
  customer_id?: string
  /** Oldest first; the last one is attempt number `attempt_count`. Each gets its own marked session. */
  attempts?: DunningAttemptStatus[]
}

/** By default a case whose first retry was submitted and awaits the provider's answer. */
async function seedDunningCase(
  container: MedusaContainer,
  reference: string,
  options: DunningCaseSeedOptions = {}
) {
  const status = options.status ?? DunningCaseStatus.AWAITING_PAYMENT
  const attemptCount = options.attempt_count ?? 1
  const attemptStatuses = options.attempts ?? [DunningAttemptStatus.PROCESSING]
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const link = container.resolve(ContainerRegistrationKeys.LINK)
  const dueAt = new Date(Date.now() - 2 * DAY_MS)

  const subscription = await createSubscriptionSeed(container, {
    reference,
    status: SubscriptionStatus.PAST_DUE,
    customer_id: options.customer_id,
    next_renewal_at: dueAt,
    payment_context: {
      payment_provider_id: SYSTEM_PAYMENT_PROVIDER_ID,
      account_holder_id: `acch_${reference}`,
      payment_method_id: `pm_${reference}`,
    },
  })
  const order = await container.resolve(Modules.ORDER).createOrders({
    currency_code: "pln",
    email: "customer@example.com",
    metadata: { subscription_id: subscription.id },
    items: [{ title: "Subscription renewal", quantity: 1, unit_price: RENEWAL_AMOUNT }],
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
    status,
    attempt_count: attemptCount,
    max_attempts: options.max_attempts,
    next_retry_at:
      status === DunningCaseStatus.RETRY_SCHEDULED ? new Date(Date.now() - 60_000) : null,
  })
  const attempts: {
    attempt: Awaited<ReturnType<typeof createDunningAttemptSeed>>
    session: PaymentSessionDTO
  }[] = []

  for (const [index, attemptStatus] of attemptStatuses.entries()) {
    const attempt = await createDunningAttemptSeed(container, {
      dunning_case_id: dunningCase.id,
      attempt_no: attemptCount - attemptStatuses.length + index + 1,
      status: attemptStatus,
      finished_at: attemptStatus === DunningAttemptStatus.PROCESSING ? null : new Date(),
    })
    const { collection, session } = await createPaymentSessionFixture(container, {
      amount: RENEWAL_AMOUNT,
      context: { dunning_case_id: dunningCase.id, dunning_attempt_id: attempt.id },
    })

    await dunningModule.updateDunningAttempts({ id: attempt.id, payment_reference: session.id })
    await link.create({
      [Modules.ORDER]: { order_id: order.id },
      [Modules.PAYMENT]: { payment_collection_id: collection.id },
    })
    attempts.push({ attempt, session })
  }

  return { subscription, cycle, dunningCase, orderId: order.id, attempts }
}

type SeededDunningCase = Awaited<ReturnType<typeof seedDunningCase>>

async function readDunningState(container: MedusaContainer, seeded: SeededDunningCase) {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)

  return {
    dunningCase: await dunningModule.retrieveDunningCase(seeded.dunningCase.id),
    attempts: await dunningModule.listDunningAttempts(
      { dunning_case_id: seeded.dunningCase.id },
      { order: { attempt_no: "ASC" } }
    ),
    subscription: await container
      .resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
      .retrieveSubscription(seeded.subscription.id),
    cycle: await container
      .resolve<RenewalModuleService>(RENEWAL_MODULE)
      .retrieveRenewalCycle(seeded.cycle.id),
  }
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
  const emit = jest.spyOn(container.resolve(Modules.EVENT_BUS), "emit")

  const payloads = (name: string) =>
    emit.mock.calls
      .flatMap(([message]) => (Array.isArray(message) ? message : [message]))
      .filter((message) => message.name === name)
      .map((message) => message.data)

  return { payloads, count: (name: string) => payloads(name).length }
}

function watchLogs(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const spies = (["info", "warn", "error"] as const).map((level) => jest.spyOn(logger, level))

  return (match: Record<string, unknown>) =>
    spies
      .flatMap((spy) => spy.mock.calls.map(([line]) => String(line)))
      .flatMap((line): Record<string, unknown>[] => {
        try {
          return [JSON.parse(line)]
        } catch {
          return []
        }
      })
      .filter((entry) => Object.entries(match).every(([key, value]) => entry[key] === value))
}

async function captureOnOrder(container: MedusaContainer, orderId: string, sessionId: string) {
  const payment = await authorizeAndCapturePaymentSession(container, sessionId)

  await recordOrderCaptureTransactions(container, orderId, payment.id)

  return payment
}

async function deliverPaymentCaptured(container: MedusaContainer, paymentId: string) {
  await activateSubscriptionOnPaymentCapturedHandler({
    event: { name: PaymentEvents.CAPTURED, data: { id: paymentId } },
    container,
    pluginOptions: {},
  })
}

async function cancelByCustomer(container: MedusaContainer, seeded: SeededDunningCase) {
  await cancelSubscriptionByCustomerWorkflow(container).run({
    input: {
      subscription_id: seeded.subscription.id,
      reason: "Cannot pay right now",
      triggered_by: seeded.subscription.customer_id,
    },
  })
}

async function createStoreCustomerHeaders(container: MedusaContainer, customerId: string) {
  const apiKey = await container.resolve(Modules.API_KEY).createApiKeys({
    title: "Storefront",
    type: "publishable",
    created_by: "store-customer-headers",
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

  return { "authorization": `Bearer ${token}`, "x-publishable-api-key": apiKey.token }
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: { JWT_SECRET: "supersecret", COOKIE_SECRET: "supersecret" },
  testSuite: ({ api, getContainer }) => {
    describe("dunning retry awaiting the provider's answer", () => {
      beforeEach(() => {
        jest.restoreAllMocks()
        jest.clearAllMocks()
      })

      it("parks a due retry as awaiting the provider when its authorisation returns no payment, counts it as awaiting in the job and shows the case to an admin as the active one", async () => {
        const container = getContainer()
        const seeded = await seedDunningCase(container, "SUB-DUN-AWAIT-PARK", {
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 0,
          attempts: [],
        })
        const caseId = seeded.dunningCase.id
        const sessions = routeRetrySessionsToFixture(container)
        answerAuthorizationWithNull(container)
        const events = recordEvents(container)
        const logs = watchLogs(container)

        await processDunningRetriesJob(container)

        const state = await readDunningState(container, seeded)

        expect(sessions).toHaveLength(1)
        expect(state.dunningCase).toMatchObject({
          status: DunningCaseStatus.AWAITING_PAYMENT,
          next_retry_at: null,
          attempt_count: 1,
        })
        expect(state.attempts).toEqual([
          expect.objectContaining({
            attempt_no: 1,
            status: DunningAttemptStatus.PROCESSING,
            payment_reference: sessions[0].id,
            finished_at: null,
          }),
        ])
        expect(events.count(DunningEvents.ATTEMPT_FAILED)).toBe(0)
        expect(logs({ event: "dunning.job.case", dunning_case_id: caseId })).toEqual([
          expect.objectContaining({ outcome: "awaiting_payment", success_count: 0, failure_count: 0 }),
        ])
        expect(logs({ event: "dunning.job", outcome: "completed" })).toEqual([
          expect.objectContaining({
            processed_count: 1,
            recovered_count: 0,
            failure_count: 0,
            awaiting_count: 1,
          }),
        ])

        const cancellationCase = await createCancellationCaseSeed(container, {
          subscription_id: seeded.subscription.id,
          reason: "customer left",
        })
        const detail = await getAdminCancellationDetail(container, cancellationCase.id)

        expect(detail.cancellation.dunning).toMatchObject({
          dunning_case_id: caseId,
          status: DunningCaseStatus.AWAITING_PAYMENT,
        })

        await processDunningRetriesJob(container)

        expect(sessions).toHaveLength(1)
      })

      it("refuses a retry, a new schedule and a second case while the charge awaits the provider, shows the customer a retry in progress, and still lets the customer cancel", async () => {
        const container = getContainer()
        const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
        const customerId = "cus_dunning_awaiting_store"
        const seeded = await seedDunningCase(container, "SUB-DUN-AWAIT-REFUSALS", {
          customer_id: customerId,
        })
        const caseId = seeded.dunningCase.id
        const subscriptionId = seeded.subscription.id
        const admin = { headers: await createAdminAuthHeaders(container) }
        const store = { headers: await createStoreCustomerHeaders(container, customerId) }
        const storeUrl = `/store/customers/me/subscriptions/${subscriptionId}`

        await expect(api.post(`${storeUrl}/retry-payment`, {}, store)).rejects.toMatchObject({
          response: { status: 409, data: { blocked_reason: "payment_in_progress" } },
        })
        expect((await api.get(storeUrl, store)).data.subscription).toMatchObject({
          payment_status: "recovery_required",
          payment_recovery: {
            dunning_case_id: caseId,
            state: DunningCaseStatus.RETRYING,
            retry_eligible: false,
            retry_blocked_reason: "payment_in_progress",
          },
        })
        await expect(
          api.post(`/admin/dunning/${caseId}/retry-now`, {}, admin)
        ).rejects.toMatchObject({
          response: { status: 409, data: { message: expect.stringContaining("payment_in_progress") } },
        })
        await expect(
          api.post(
            `/admin/dunning/${caseId}/retry-schedule`,
            { reason: "shorter cadence", intervals: [60, 120, 240], max_attempts: 3 },
            admin
          )
        ).rejects.toMatchObject({ response: { status: 409 } })

        const laterCycle = await createRenewalCycleSeed(container, {
          subscription_id: subscriptionId,
          status: RenewalCycleStatus.FAILED,
        })

        await expect(
          startDunningWorkflow(container).run({
            input: {
              subscription_id: subscriptionId,
              renewal_cycle_id: laterCycle.id,
              payment_failure_source: "payment_provider",
              payment_error_code: "card_declined",
              payment_error_message: "Issuer declined the charge",
            },
          })
        ).rejects.toMatchObject({
          message: expect.stringMatching(/Duplicate active dunning case blocked/),
        })

        const refused = await readDunningState(container, seeded)

        expect(await dunningModule.listDunningCases({ subscription_id: subscriptionId })).toEqual([
          expect.objectContaining({ id: caseId, status: DunningCaseStatus.AWAITING_PAYMENT }),
        ])
        expect(refused.dunningCase).toMatchObject({
          status: DunningCaseStatus.AWAITING_PAYMENT,
          next_retry_at: null,
          attempt_count: 1,
          retry_schedule: defaultRetrySchedule,
        })
        expect(refused.attempts).toEqual([
          expect.objectContaining({ status: DunningAttemptStatus.PROCESSING }),
        ])

        await cancelByCustomer(container, seeded)

        expect(await dunningModule.retrieveDunningCase(caseId)).toMatchObject({
          status: DunningCaseStatus.UNRECOVERED,
          next_retry_at: null,
          recovery_reason: "subscription_cancelled_by_customer",
          closed_at: expect.anything(),
        })
      })

      it.each([
        {
          signal: "the capture of its own awaiting attempt",
          reference: "SUB-DUN-AWAIT-CAPTURED",
          deliver: deliverPaymentCaptured,
        },
        {
          signal: "the paid-order sweep when its capture event never arrived",
          reference: "SUB-DUN-AWAIT-SWEPT",
          deliver: async (container: MedusaContainer) => {
            await reconcilePaidDunningCases(container)
          },
        },
      ])(
        "recovers the awaiting case as its retry's recovery and settles the renewal cycle from $signal",
        async ({ reference, deliver }) => {
          const container = getContainer()
          const seeded = await seedDunningCase(container, reference)
          const [{ attempt, session }] = seeded.attempts
          const payment = await captureOnOrder(container, seeded.orderId, session.id)
          const events = recordEvents(container)

          await deliver(container, payment.id)

          const state = await readDunningState(container, seeded)
          const renewalAttempts = await container
            .resolve<RenewalModuleService>(RENEWAL_MODULE)
            .listRenewalAttempts({ renewal_cycle_id: seeded.cycle.id })

          expect(state.dunningCase).toMatchObject({
            status: DunningCaseStatus.RECOVERED,
            recovery_reason: "payment_recovered",
            next_retry_at: null,
          })
          expect(state.attempts).toEqual([
            expect.objectContaining({
              id: attempt.id,
              status: DunningAttemptStatus.SUCCEEDED,
              payment_reference: payment.id,
              finished_at: expect.anything(),
            }),
          ])
          expect(state.subscription.status).toEqual(SubscriptionStatus.ACTIVE)
          expect(state.cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
          expect(renewalAttempts).toContainEqual(
            expect.objectContaining({
              status: RenewalAttemptStatus.SUCCEEDED,
              metadata: expect.objectContaining({ source: "dunning_retry" }),
            })
          )
          expect(events.payloads(DunningEvents.RECOVERED)).toEqual([
            expect.objectContaining({
              dunning_case_id: seeded.dunningCase.id,
              recovery_reason: "payment_recovered",
            }),
          ])
        }
      )

      it("reschedules the next retry once when the awaiting charge fails, however often the failure is reported", async () => {
        const container = getContainer()
        const seeded = await seedDunningCase(container, "SUB-DUN-AWAIT-FAILED")
        const failure = {
          session_id: seeded.attempts[0].session.id,
          action: "failed",
          reason: "insufficient_funds",
        }
        const nextIntervalMs = defaultRetrySchedule.intervals[1] * 60 * 1000
        const events = recordEvents(container)

        const before = Date.now()
        await failAwaitingDunningAttempt(container, failure)
        const after = Date.now()

        const rescheduled = await readDunningState(container, seeded)

        await failAwaitingDunningAttempt(container, failure)

        const final = await readDunningState(container, seeded)
        const nextRetryAt = new Date(rescheduled.dunningCase.next_retry_at!).getTime()

        expect(rescheduled.dunningCase).toMatchObject({
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 1,
          last_payment_error_code: "insufficient_funds",
        })
        expect(nextRetryAt).toBeGreaterThanOrEqual(before + nextIntervalMs)
        expect(nextRetryAt).toBeLessThanOrEqual(after + nextIntervalMs)
        expect(final.dunningCase).toMatchObject({
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 1,
          next_retry_at: rescheduled.dunningCase.next_retry_at,
        })
        expect(final.attempts).toEqual([
          expect.objectContaining({
            status: DunningAttemptStatus.FAILED,
            error_code: "insufficient_funds",
            payment_reference: failure.session_id,
            finished_at: expect.anything(),
          }),
        ])
        expect(events.count(DunningEvents.ATTEMPT_FAILED)).toBe(1)
      })

      it.each([
        {
          title: "reschedules rather than settles the case when the awaiting charge is canceled",
          reference: "SUB-DUN-AWAIT-CANCELED",
          seed: {},
          report: { action: "canceled", reason: null },
          expected: {
            dunningCase: {
              status: DunningCaseStatus.RETRY_SCHEDULED,
              attempt_count: 1,
              next_retry_at: expect.anything(),
              closed_at: null,
              recovery_reason: null,
            },
            latestAttempt: { status: DunningAttemptStatus.FAILED },
            subscription: SubscriptionStatus.PAST_DUE,
            events: { attempt_failed: 1, payment_failed: 0 },
          },
        },
        {
          title: "closes the case as unrecovered when the charge of the last allowed attempt fails",
          reference: "SUB-DUN-AWAIT-LAST",
          seed: { attempt_count: 3, max_attempts: 3 },
          report: { action: "failed", reason: "insufficient_funds" },
          expected: {
            dunningCase: {
              status: DunningCaseStatus.UNRECOVERED,
              attempt_count: 3,
              next_retry_at: null,
              recovery_reason: "retry_limit_exhausted",
            },
            latestAttempt: { status: DunningAttemptStatus.FAILED },
            subscription: SubscriptionStatus.PAYMENT_FAILED,
            events: { attempt_failed: 0, payment_failed: 1 },
          },
        },
        {
          title: "ignores a failure reported for the session of an earlier attempt",
          reference: "SUB-DUN-AWAIT-EARLIER",
          seed: {
            attempt_count: 2,
            attempts: [DunningAttemptStatus.FAILED, DunningAttemptStatus.PROCESSING],
          },
          report: { action: "failed", reason: "insufficient_funds" },
          expected: {
            dunningCase: {
              status: DunningCaseStatus.AWAITING_PAYMENT,
              attempt_count: 2,
              next_retry_at: null,
            },
            latestAttempt: {
              status: DunningAttemptStatus.PROCESSING,
              finished_at: null,
              error_code: null,
            },
            subscription: SubscriptionStatus.PAST_DUE,
            events: { attempt_failed: 0, payment_failed: 0 },
          },
        },
      ])("$title", async ({ reference, seed, report, expected }) => {
        const container = getContainer()
        const seeded = await seedDunningCase(container, reference, seed)
        const events = recordEvents(container)

        await failAwaitingDunningAttempt(container, {
          session_id: seeded.attempts[0].session.id,
          ...report,
        })

        const state = await readDunningState(container, seeded)

        expect(state.dunningCase).toMatchObject(expected.dunningCase)
        expect(state.attempts[state.attempts.length - 1]).toMatchObject(expected.latestAttempt)
        expect(state.subscription.status).toEqual(expected.subscription)
        expect({
          attempt_failed: events.count(DunningEvents.ATTEMPT_FAILED),
          payment_failed: events.count(DunningEvents.PAYMENT_FAILED),
        }).toEqual(expected.events)
      })

      it("reschedules a case its retry left retrying when the charge fails, after which the customer's cancellation goes through", async () => {
        const container = getContainer()
        const seeded = await seedDunningCase(container, "SUB-DUN-LEFT-RETRYING", {
          status: DunningCaseStatus.RETRYING,
        })

        await failAwaitingDunningAttempt(container, {
          session_id: seeded.attempts[0].session.id,
          action: "failed",
          reason: "insufficient_funds",
        })

        const failed = await readDunningState(container, seeded)

        expect(failed.dunningCase).toMatchObject({
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 1,
          last_payment_error_code: "insufficient_funds",
        })
        expect(failed.attempts).toEqual([
          expect.objectContaining({
            status: DunningAttemptStatus.FAILED,
            error_code: "insufficient_funds",
          }),
        ])

        await cancelByCustomer(container, seeded)

        expect((await readDunningState(container, seeded)).dunningCase.status).toEqual(
          DunningCaseStatus.UNRECOVERED
        )
      })

      it("raises one overdue alert for a case awaiting its retry's payment past the limit, however many sweeps see it", async () => {
        const container = getContainer()
        const seeded = await seedDunningCase(container, "SUB-DUN-AWAIT-OVERDUE")
        const submittedAt = new Date(seeded.attempts[0].attempt.started_at).getTime()
        const logs = watchLogs(container)
        const overdueAlerts = () =>
          logs({ event: DUNNING_AWAITING_PAYMENT_OVERDUE_EVENT, alertable: true })
        const sweepAt = async (offsetMs: number) => {
          const clock = jest.spyOn(Date, "now").mockReturnValue(submittedAt + offsetMs)

          try {
            await reconcilePaidDunningCases(container)
          } finally {
            clock.mockRestore()
          }
        }

        await sweepAt((DEFAULT_AWAITING_PAYMENT_ALERT_HOURS - 1) * HOUR_MS)

        expect(overdueAlerts()).toHaveLength(0)

        await sweepAt((DEFAULT_AWAITING_PAYMENT_ALERT_HOURS + 1) * HOUR_MS)
        await sweepAt((DEFAULT_AWAITING_PAYMENT_ALERT_HOURS + 2) * HOUR_MS)

        const state = await readDunningState(container, seeded)

        expect(overdueAlerts()).toEqual([
          expect.objectContaining({ dunning_case_id: seeded.dunningCase.id }),
        ])
        expect(state.dunningCase.status).toEqual(DunningCaseStatus.AWAITING_PAYMENT)
        expect(state.attempts).toEqual([
          expect.objectContaining({ status: DunningAttemptStatus.PROCESSING }),
        ])
      })
    })
  },
})

jest.setTimeout(60 * 1000)
