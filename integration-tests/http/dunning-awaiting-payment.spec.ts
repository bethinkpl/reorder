import jwt from "jsonwebtoken"
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import type { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
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
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import { cancelSubscriptionByCustomerWorkflow } from "../../src/workflows/cancel-subscription-by-customer"
import { startDunningWorkflow } from "../../src/workflows/start-dunning"
import { failAwaitingDunningAttempt } from "../../src/workflows/utils/fail-awaiting-dunning-attempt"
import {
  type SeededDunningCase,
  createRetrySessionRouter,
  readDunningState,
  seedDunningCase,
} from "../helpers/awaiting-dunning-fixtures"
import { createCancellationCaseSeed } from "../helpers/cancellation-fixtures"
import {
  createAdminAuthHeaders,
  createRenewalCycleSeed,
  defaultRetrySchedule,
} from "../helpers/dunning-fixtures"
import { captureOnOrder, deliverCapture } from "../helpers/payment-fixtures"
import { answerAuthorizationWithNull } from "../helpers/renewal-charge-fixtures"
import { atTime, watchEvents, watchLogs } from "../helpers/spy-fixtures"

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

const routeRetrySessionsToFixture = createRetrySessionRouter({
  createOrUpdateOrderPaymentCollectionRun: mockCreateOrUpdateOrderPaymentCollectionRun,
  createPaymentSessionsRun: mockCreatePaymentSessionsRun,
})

const HOUR_MS = 60 * 60 * 1000

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
        const events = watchEvents(container)
        const logs = watchLogs(container)

        await processDunningRetriesJob(container)

        const state = await readDunningState(container, seeded.dunningCase.id)

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
        expect(events(DunningEvents.ATTEMPT_FAILED).length).toBe(0)
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

        const refused = await readDunningState(container, seeded.dunningCase.id)

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
          deliver: deliverCapture,
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
          const payment = await captureOnOrder(container, seeded.order.id, session.id)
          const events = watchEvents(container)

          await deliver(container, payment.id)

          const state = await readDunningState(container, seeded.dunningCase.id)
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
          expect(events(DunningEvents.RECOVERED).map((message) => message.data)).toEqual([
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
        const events = watchEvents(container)

        const before = Date.now()
        await failAwaitingDunningAttempt(container, failure)
        const after = Date.now()

        const rescheduled = await readDunningState(container, seeded.dunningCase.id)

        await failAwaitingDunningAttempt(container, failure)

        const final = await readDunningState(container, seeded.dunningCase.id)
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
        expect(events(DunningEvents.ATTEMPT_FAILED).length).toBe(1)
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
        const events = watchEvents(container)

        await failAwaitingDunningAttempt(container, {
          session_id: seeded.attempts[0].session.id,
          ...report,
        })

        const state = await readDunningState(container, seeded.dunningCase.id)

        expect(state.dunningCase).toMatchObject(expected.dunningCase)
        expect(state.attempts[state.attempts.length - 1]).toMatchObject(expected.latestAttempt)
        expect(state.subscription.status).toEqual(expected.subscription)
        expect({
          attempt_failed: events(DunningEvents.ATTEMPT_FAILED).length,
          payment_failed: events(DunningEvents.PAYMENT_FAILED).length,
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

        const failed = await readDunningState(container, seeded.dunningCase.id)

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

        expect((await readDunningState(container, seeded.dunningCase.id)).dunningCase.status).toEqual(
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
        const sweepAt = (offsetMs: number) =>
          atTime(submittedAt + offsetMs, () => reconcilePaidDunningCases(container))

        await sweepAt((DEFAULT_AWAITING_PAYMENT_ALERT_HOURS - 1) * HOUR_MS)

        expect(overdueAlerts()).toHaveLength(0)

        await sweepAt((DEFAULT_AWAITING_PAYMENT_ALERT_HOURS + 1) * HOUR_MS)
        await sweepAt((DEFAULT_AWAITING_PAYMENT_ALERT_HOURS + 2) * HOUR_MS)

        const state = await readDunningState(container, seeded.dunningCase.id)

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
