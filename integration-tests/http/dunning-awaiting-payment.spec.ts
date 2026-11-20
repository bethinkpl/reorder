import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import type { MedusaContainer } from "@medusajs/framework/types"
import { Modules, PaymentActions } from "@medusajs/framework/utils"
import { PaymentAttemptErrorCode } from "../../src/common/types/payment-attempt-error-code"
import processDunningRetriesJob from "../../src/jobs/process-dunning-retries"
import { reconcilePaidDunningCases } from "../../src/jobs/reconcile-paid-dunning-cases"
import { ACTIVITY_LOG_MODULE } from "../../src/modules/activity-log"
import type ActivityLogModuleService from "../../src/modules/activity-log/service"
import { ActivityLogEventType } from "../../src/modules/activity-log/types"
import { CANCELLATION_MODULE } from "../../src/modules/cancellation"
import type CancellationModuleService from "../../src/modules/cancellation/service"
import { CancellationCaseStatus, CancellationFinalOutcome } from "../../src/modules/cancellation/types"
import { getAdminCancellationDetail } from "../../src/modules/cancellation/utils/admin-query"
import { DUNNING_MODULE } from "../../src/modules/dunning"
import { DunningEvents } from "../../src/modules/dunning/events"
import type DunningModuleService from "../../src/modules/dunning/service"
import {
  DunningAttemptStatus,
  DunningCaseStatus,
  DunningRecoveryReason,
} from "../../src/modules/dunning/types"
import { dunningCaseLockKey } from "../../src/modules/dunning/utils/lock-key"
import { RetryBlockedReason } from "../../src/modules/dunning/utils/retry-eligibility"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import {
  RenewalAttemptStatus,
  RenewalCycleStatus,
  RenewalSettlementSource,
} from "../../src/modules/renewal/types"
import {
  AWAITING_PAYMENT_ALERT_HOURS_ENV,
  AWAITING_PAYMENT_RESOLVE_MIN_HOURS_ENV,
  DEFAULT_AWAITING_PAYMENT_ALERT_HOURS,
  DEFAULT_AWAITING_PAYMENT_RESOLVE_MIN_HOURS,
} from "../../src/modules/renewal/utils/awaiting-payment-age"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import {
  LatePaymentCapturedReason,
  SubscriptionEvents,
} from "../../src/modules/subscription/events"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import {
  cancelSubscriptionByCustomerWorkflow,
  cancelSubscriptionWorkflow,
  finalizeCancellationWorkflow,
  recoverDunningFromCapturedPaymentWorkflow,
} from "../../src/workflows"
import { skipNextDeliveryWorkflow } from "../../src/workflows/skip-next-delivery"
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
  createDunningCaseSeed,
  createRenewalCycleSeed,
  defaultRetrySchedule,
} from "../helpers/dunning-fixtures"
import { createStoreCustomerHeaders } from "../helpers/subscription-fixtures"
import {
  captureOnOrder,
  createPaymentSessionFixture,
  deliverCapture,
  deliverFailure,
} from "../helpers/payment-fixtures"
import { RENEWAL_AMOUNT, answerAuthorizationWithNull } from "../helpers/renewal-charge-fixtures"
import { atTime, watchEvents, watchLogs } from "../helpers/spy-fixtures"
import { DunningLogEvents } from "../../src/modules/dunning/utils/observability"

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
        expect(logs({ event: DunningLogEvents.JOB_CASE, dunning_case_id: caseId })).toEqual([
          expect.objectContaining({ outcome: "awaiting_payment", success_count: 0, failure_count: 0 }),
        ])
        expect(logs({ event: DunningLogEvents.JOB, outcome: "completed" })).toEqual([
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
          response: { status: 409, data: { blocked_reason: RetryBlockedReason.RETRY_IN_PROGRESS } },
        })
        expect((await api.get(storeUrl, store)).data.subscription).toMatchObject({
          payment_status: "recovery_required",
          payment_recovery: {
            dunning_case_id: caseId,
            state: DunningCaseStatus.RETRYING,
            retry_eligible: false,
            retry_blocked_reason: RetryBlockedReason.RETRY_IN_PROGRESS,
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
        ).rejects.toMatchObject({
          response: {
            status: 409,
            data: {
              type: "conflict",
              message: `DunningCase '${caseId}' can't update retry schedule while retry is in flight`,
            },
          },
        })

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
          recovery_reason: DunningRecoveryReason.SUBSCRIPTION_CANCELLED_BY_CUSTOMER,
          closed_at: expect.anything(),
        })
      })

      it("never shows the storefront the admin's payment_in_progress reason: the list, the detail and the retry refusal all report a retry in progress", async () => {
        const container = getContainer()
        const customerId = "cus_dunning_awaiting_store_vocabulary"
        const seeded = await seedDunningCase(container, "SUB-DUN-AWAIT-STORE-VOCAB", {
          customer_id: customerId,
        })
        const admin = { headers: await createAdminAuthHeaders(container) }
        const store = { headers: await createStoreCustomerHeaders(container, customerId) }
        const storeUrl = `/store/customers/me/subscriptions/${seeded.subscription.id}`
        const retryInProgress = {
          state: DunningCaseStatus.RETRYING,
          retry_eligible: false,
          retry_blocked_reason: RetryBlockedReason.RETRY_IN_PROGRESS,
        }

        const list = await api.get("/store/customers/me/subscriptions", store)
        const detail = await api.get(storeUrl, store)
        const refusal = await api
          .post(`${storeUrl}/retry-payment`, {}, store)
          .catch((error: { response: { status: number, data: Record<string, unknown> } }) => error.response)

        expect(list.data.subscriptions).toEqual([
          expect.objectContaining({ payment_recovery: expect.objectContaining(retryInProgress) }),
        ])
        expect(detail.data.subscription.payment_recovery).toMatchObject(retryInProgress)
        expect(refusal).toMatchObject({
          status: 409,
          data: {
            blocked_reason: RetryBlockedReason.RETRY_IN_PROGRESS,
            message: expect.stringContaining(`(${RetryBlockedReason.RETRY_IN_PROGRESS})`),
          },
        })

        for (const body of [list.data, detail.data, refusal.data]) {
          expect(JSON.stringify(body)).not.toMatch(/"payment_in_progress"|\(payment_in_progress\)/)
        }

        expect(
          (await api.get(`/admin/dunning/${seeded.dunningCase.id}`, admin)).data.dunning_case
        ).toMatchObject({ retry_blocked_reason: RetryBlockedReason.PAYMENT_IN_PROGRESS })
      })

      it("answers a storefront retry that finds another run holding the case as a retry in progress, as the eligibility check does", async () => {
        const container = getContainer()
        const customerId = "cus_dunning_store_retry_locked"
        const seeded = await seedDunningCase(container, "SUB-DUN-STORE-RETRY-LOCKED", {
          customer_id: customerId,
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempts: [DunningAttemptStatus.FAILED],
        })
        const caseId = seeded.dunningCase.id
        const store = { headers: await createStoreCustomerHeaders(container, customerId) }
        const before = await readDunningState(container, caseId)

        const refusal = await whileLockHeld(container, dunningCaseLockKey(caseId), () =>
          api
            .post(`/store/customers/me/subscriptions/${seeded.subscription.id}/retry-payment`, {}, store)
            .catch((error: { response: unknown }) => error.response)
        )

        expect(refusal).toMatchObject({
          status: 409,
          data: {
            type: "conflict",
            blocked_reason: RetryBlockedReason.RETRY_IN_PROGRESS,
            message: expect.stringContaining(`(${RetryBlockedReason.RETRY_IN_PROGRESS})`),
          },
        })
        expect(await readDunningState(container, caseId)).toEqual(before)
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
        "recovers the awaiting case as its retry's recovery and settles the renewal cycle from $signal, keeping a skip the customer requested while the case was open",
        async ({ reference, deliver }) => {
          const container = getContainer()
          const seeded = await seedDunningCase(container, reference)
          const [{ attempt, session }] = seeded.attempts
          const payment = await captureOnOrder(container, seeded.order.id, session.id)
          const events = watchEvents(container)

          await skipNextDeliveryWorkflow(container).run({ input: { id: seeded.subscription.id } })
          await deliver(container, payment.id)

          const state = await readDunningState(container, seeded.dunningCase.id)
          const renewalAttempts = await container
            .resolve<RenewalModuleService>(RENEWAL_MODULE)
            .listRenewalAttempts({ renewal_cycle_id: seeded.cycle.id })

          expect(state.dunningCase).toMatchObject({
            status: DunningCaseStatus.RECOVERED,
            recovery_reason: DunningRecoveryReason.PAYMENT_RECOVERED,
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
          expect(state.subscription).toMatchObject({
            status: SubscriptionStatus.ACTIVE,
            skip_next_cycle: true,
          })
          expect(state.cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
          expect(renewalAttempts).toContainEqual(
            expect.objectContaining({
              status: RenewalAttemptStatus.SUCCEEDED,
              metadata: expect.objectContaining({ source: RenewalSettlementSource.DUNNING_RETRY }),
            })
          )
          expect(events(DunningEvents.RECOVERED).map((message) => message.data)).toEqual([
            expect.objectContaining({
              dunning_case_id: seeded.dunningCase.id,
              recovery_reason: DunningRecoveryReason.PAYMENT_RECOVERED,
            }),
          ])
        }
      )

      it("reschedules the next retry once when the awaiting charge fails, however often the failure is reported", async () => {
        const container = getContainer()
        const seeded = await seedDunningCase(container, "SUB-DUN-AWAIT-FAILED")
        const failure = {
          session_id: seeded.attempts[0].session.id,
          action: PaymentActions.FAILED,
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
          report: { action: PaymentActions.CANCELED, reason: null },
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
          report: { action: PaymentActions.FAILED, reason: "insufficient_funds" },
          expected: {
            dunningCase: {
              status: DunningCaseStatus.UNRECOVERED,
              attempt_count: 3,
              next_retry_at: null,
              recovery_reason: DunningRecoveryReason.RETRY_LIMIT_EXHAUSTED,
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
          report: { action: PaymentActions.FAILED, reason: "insufficient_funds" },
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
          action: PaymentActions.FAILED,
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

      it("leaves a case whose order the customer paid meanwhile for the sweep to recover, rescheduling nothing", async () => {
        const container = getContainer()
        const seeded = await seedDunningCase(container, "SUB-DUN-FAIL-PAID-ELSEWHERE")
        const customer = await createPaymentSessionFixture(container, { amount: RENEWAL_AMOUNT })

        await captureOnOrder(container, seeded.order.id, customer.session.id, { linkCollection: true })

        const before = await readDunningState(container, seeded.dunningCase.id)
        const events = watchEvents(container)

        await deliverFailure(container, seeded.attempts[0].session.id, { reason: "insufficient_funds" })

        expect(await readDunningState(container, seeded.dunningCase.id)).toEqual(before)
        expect(events(DunningEvents.ATTEMPT_FAILED)).toHaveLength(0)

        await reconcilePaidDunningCases(container)

        expect((await readDunningState(container, seeded.dunningCase.id)).dunningCase).toMatchObject({
          status: DunningCaseStatus.RECOVERED,
          recovery_reason: DunningRecoveryReason.CUSTOMER_PAYMENT,
        })
      })

      it("raises one overdue alert for a case awaiting its retry's payment past the limit, however many sweeps see it", async () => {
        const container = getContainer()
        const seeded = await seedDunningCase(container, "SUB-DUN-AWAIT-OVERDUE")
        const submittedAt = new Date(seeded.attempts[0].attempt.started_at).getTime()
        const logs = watchLogs(container)
        const overdueAlerts = () =>
          logs({ event: DunningLogEvents.AWAITING_PAYMENT_OVERDUE, alertable: true })
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

    describe("a case a retry left retrying", () => {
      const MINUTE_MS = 60 * 1000

      beforeEach(() => {
        jest.restoreAllMocks()
        jest.clearAllMocks()
      })

      async function sweepAfter(seeded: SeededDunningCase, offsetMs: number) {
        const startedAt = new Date(seeded.attempts[0].attempt.started_at).getTime()

        return await atTime(startedAt + offsetMs, () => reconcilePaidDunningCases(getContainer()))
      }

      it("leaves a young one to its run, then makes one with a submitted charge await it, so a failure of that charge reschedules the case", async () => {
        const container = getContainer()
        const seeded = await seedDunningCase(container, "SUB-DUN-STALE-RETRY-CHARGED", {
          status: DunningCaseStatus.RETRYING,
        })

        expect(await sweepAfter(seeded, 5 * MINUTE_MS)).toMatchObject({
          stale_retries_reparked: 0,
          stale_retries_parked: 0,
        })
        expect((await readDunningState(container, seeded.dunningCase.id)).dunningCase.status).toEqual(
          DunningCaseStatus.RETRYING
        )

        expect(await sweepAfter(seeded, 11 * MINUTE_MS)).toMatchObject({
          stale_retries_reparked: 1,
          stale_retries_parked: 0,
          failed: 0,
        })
        expect(await readDunningState(container, seeded.dunningCase.id)).toMatchObject({
          dunningCase: { status: DunningCaseStatus.AWAITING_PAYMENT, next_retry_at: null },
          attempts: [{ status: DunningAttemptStatus.PROCESSING }],
        })

        await deliverFailure(container, seeded.attempts[0].session.id, { reason: "insufficient_funds" })

        expect((await readDunningState(container, seeded.dunningCase.id)).dunningCase).toMatchObject({
          status: DunningCaseStatus.RETRY_SCHEDULED,
          last_payment_error_code: "insufficient_funds",
        })
      })

      it("recovers one whose submitted charge was captured without its event in the same sweep that makes it await the charge", async () => {
        const container = getContainer()
        const seeded = await seedDunningCase(container, "SUB-DUN-STALE-RETRY-PAID", {
          status: DunningCaseStatus.RETRYING,
        })
        const payment = await captureOnOrder(
          container,
          seeded.order.id,
          seeded.attempts[0].session.id
        )

        expect(await sweepAfter(seeded, 11 * MINUTE_MS)).toMatchObject({
          stale_retries_reparked: 1,
          recovered: 1,
          failed: 0,
        })
        expect(await readDunningState(container, seeded.dunningCase.id)).toMatchObject({
          dunningCase: { status: DunningCaseStatus.RECOVERED, recovery_reason: DunningRecoveryReason.PAYMENT_RECOVERED },
          attempts: [{ status: DunningAttemptStatus.SUCCEEDED, payment_reference: payment.id }],
        })
      })

      it("hands one with no submitted charge to an operator once, with an alert and a parked event, and keeps the customer from retrying it", async () => {
        const container = getContainer()
        const customerId = "cus_dunning_stale_retry"
        const seeded = await seedDunningCase(container, "SUB-DUN-STALE-RETRY-UNCHARGED", {
          status: DunningCaseStatus.RETRYING,
          customer_id: customerId,
        })
        const emitted = watchEvents(container)
        const logs = watchLogs(container)

        await container.resolve<DunningModuleService>(DUNNING_MODULE).updateDunningAttempts({
          id: seeded.attempts[0].attempt.id,
          payment_reference: null,
        })

        expect(await sweepAfter(seeded, 11 * MINUTE_MS)).toMatchObject({
          stale_retries_reparked: 0,
          stale_retries_parked: 1,
          failed: 0,
        })
        expect(await sweepAfter(seeded, 12 * MINUTE_MS)).toMatchObject({
          stale_retries_parked: 0,
        })

        const state = await readDunningState(container, seeded.dunningCase.id)

        expect(state.dunningCase).toMatchObject({
          status: DunningCaseStatus.AWAITING_MANUAL_RESOLUTION,
          metadata: expect.objectContaining({ park_reason: "indeterminate_provider_response" }),
        })
        expect(emitted(DunningEvents.PARKED)).toEqual([
          expect.objectContaining({
            data: expect.objectContaining({
              dunning_case_id: seeded.dunningCase.id,
              park_reason: "indeterminate_provider_response",
            }),
          }),
        ])
        expect(
          logs({ event: DunningLogEvents.STALE_RETRY, alertable: true, dunning_case_id: seeded.dunningCase.id })
        ).toHaveLength(1)

        await expect(
          api.post(`/store/customers/me/subscriptions/${seeded.subscription.id}/retry-payment`, {}, {
            headers: await createStoreCustomerHeaders(container, customerId),
          })
        ).rejects.toMatchObject({
          response: { status: 409, data: { blocked_reason: "manual_resolution_required" } },
        })
      })
    })

    describe("a retry charge still in flight when its case closes", () => {
      beforeEach(() => {
        jest.restoreAllMocks()
        jest.clearAllMocks()
      })

      it("keeps the charge of a case the customer cancelled in flight, and reports its late capture once for a refund without settling anything", async () => {
        const container = getContainer()
        const seeded = await seedDunningCase(container, "SUB-DUN-CANCEL-LATE-CAPTURE")
        const caseId = seeded.dunningCase.id
        const [{ attempt, session }] = seeded.attempts

        await cancelByCustomer(container, seeded)

        const cancelled = await readDunningState(container, caseId)
        const payment = await captureOnOrder(container, seeded.order.id, session.id)
        const events = watchEvents(container)

        await deliverCapture(container, payment.id)
        await deliverCapture(container, payment.id)

        const after = await readDunningState(container, caseId)

        expect(cancelled.attempts).toEqual([
          expect.objectContaining({ id: attempt.id, status: DunningAttemptStatus.PROCESSING }),
        ])
        expect(after).toEqual({
          ...cancelled,
          attempts: [
            {
              ...cancelled.attempts[0],
              status: DunningAttemptStatus.SUCCEEDED,
              error_code: PaymentAttemptErrorCode.CAPTURED_AFTER_CLOSE,
              error_message: expect.stringContaining(payment.id),
              finished_at: expect.any(Date),
              updated_at: expect.any(Date),
              metadata: expect.objectContaining({
                late_payment_captured: expect.objectContaining({
                  payment_id: payment.id,
                  reason: LatePaymentCapturedReason.SUBSCRIPTION_TERMINAL,
                }),
              }),
            },
          ],
        })
        expect(after.subscription.status).toEqual(SubscriptionStatus.CANCELLED)
        expect(after.dunningCase.status).toEqual(DunningCaseStatus.UNRECOVERED)
        expect(after.cycle.status).toEqual(RenewalCycleStatus.FAILED)
        expect(events(SubscriptionEvents.LATE_PAYMENT_CAPTURED).map((message) => message.data)).toEqual([
          {
            subscription_id: seeded.subscription.id,
            payment_id: payment.id,
            order_id: seeded.order.id,
            payment_collection_id: session.payment_collection_id,
            renewal_cycle_id: seeded.cycle.id,
            dunning_case_id: caseId,
            dunning_attempt_id: attempt.id,
            reason: LatePaymentCapturedReason.SUBSCRIPTION_TERMINAL,
            refund_amount: RENEWAL_AMOUNT,
            currency_code: "pln",
          },
        ])
        expect(events(DunningEvents.RECOVERED)).toHaveLength(0)
      })

      it.each([
        { submitted: "with its charge's session recorded", recorded: true },
        { submitted: "before recording its charge's session", recorded: false },
      ])(
        "closes a case its retry left retrying $submitted when the customer cancels, keeping that charge tracked so its capture is reported once for a refund",
        async ({ recorded }) => {
          const container = getContainer()
          const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
          const seeded = await seedDunningCase(container, `SUB-DUN-CANCEL-RETRYING-${recorded}`, {
            status: DunningCaseStatus.RETRYING,
          })
          const caseId = seeded.dunningCase.id
          const [{ attempt, session }] = seeded.attempts

          if (!recorded) {
            await dunningModule.updateDunningAttempts({ id: attempt.id, payment_reference: null })
          }

          await cancelByCustomer(container, seeded)

          const cancelled = await readDunningState(container, caseId)
          const payment = await captureOnOrder(container, seeded.order.id, session.id)
          const events = watchEvents(container)

          await deliverCapture(container, payment.id)
          await deliverCapture(container, payment.id)

          expect(cancelled.dunningCase).toMatchObject({
            status: DunningCaseStatus.UNRECOVERED,
            closed_at: expect.any(Date),
          })
          expect(cancelled.attempts).toEqual([
            expect.objectContaining({
              id: attempt.id,
              status: DunningAttemptStatus.PROCESSING,
              payment_reference: recorded ? session.id : null,
            }),
          ])
          expect((await readDunningState(container, caseId)).attempts).toEqual([
            expect.objectContaining({
              id: attempt.id,
              status: DunningAttemptStatus.SUCCEEDED,
              error_code: PaymentAttemptErrorCode.CAPTURED_AFTER_CLOSE,
            }),
          ])
          expect(events(SubscriptionEvents.LATE_PAYMENT_CAPTURED).map((message) => message.data)).toEqual([
            expect.objectContaining({
              payment_id: payment.id,
              dunning_attempt_id: attempt.id,
              reason: LatePaymentCapturedReason.SUBSCRIPTION_TERMINAL,
            }),
          ])
        }
      )

      it("closes the attempt as failed, with no reschedule and no event, when the charge of a case the customer cancelled fails afterwards", async () => {
        const container = getContainer()
        const seeded = await seedDunningCase(container, "SUB-DUN-CANCEL-LATE-FAIL")
        const caseId = seeded.dunningCase.id
        const [{ session }] = seeded.attempts

        await cancelByCustomer(container, seeded)

        const cancelled = await readDunningState(container, caseId)
        const events = watchEvents(container)

        await deliverFailure(container, session.id, { reason: "insufficient_funds" })
        await deliverFailure(container, session.id, { reason: "insufficient_funds" })

        expect(await readDunningState(container, caseId)).toEqual({
          ...cancelled,
          attempts: [
            {
              ...cancelled.attempts[0],
              status: DunningAttemptStatus.FAILED,
              error_code: "insufficient_funds",
              error_message: expect.stringMatching(/after its dunning case had closed/),
              finished_at: expect.any(Date),
              updated_at: expect.any(Date),
            },
          ],
        })
        expect({
          attempt_failed: events(DunningEvents.ATTEMPT_FAILED).length,
          payment_failed: events(DunningEvents.PAYMENT_FAILED).length,
          late_payment_captured: events(SubscriptionEvents.LATE_PAYMENT_CAPTURED).length,
        }).toEqual({ attempt_failed: 0, payment_failed: 0, late_payment_captured: 0 })
      })

      it("closes the attempt of a churned subscription's case its capture pays off, without asking for a refund the churn reversal would keep", async () => {
        const container = getContainer()
        const seeded = await seedDunningCase(container, "SUB-DUN-CHURN-LATE-CAPTURE", {
          status: DunningCaseStatus.UNRECOVERED,
        })
        const [{ attempt, session }] = seeded.attempts

        await container
          .resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
          .updateSubscriptions({ id: seeded.subscription.id, status: SubscriptionStatus.PAYMENT_FAILED })

        const payment = await captureOnOrder(container, seeded.order.id, session.id)
        const events = watchEvents(container)
        const logs = watchLogs(container)

        await deliverCapture(container, payment.id)

        const state = await readDunningState(container, seeded.dunningCase.id)

        expect(state.attempts).toEqual([
          expect.objectContaining({
            id: attempt.id,
            status: DunningAttemptStatus.SUCCEEDED,
            error_code: PaymentAttemptErrorCode.CAPTURED_AFTER_CLOSE,
          }),
        ])
        expect(state.dunningCase.status).toEqual(DunningCaseStatus.UNRECOVERED)
        expect(state.subscription.status).toEqual(SubscriptionStatus.PAYMENT_FAILED)
        expect(logs({ event: DunningLogEvents.CUSTOMER_RECOVERY, outcome: "blocked" })).toHaveLength(1)
        expect(events(SubscriptionEvents.LATE_PAYMENT_CAPTURED)).toHaveLength(0)
      })

      async function seedChurnedCase(reference: string) {
        const container = getContainer()
        const seeded = await seedDunningCase(container, reference, {
          status: DunningCaseStatus.UNRECOVERED,
        })

        await container
          .resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
          .updateSubscriptions({ id: seeded.subscription.id, status: SubscriptionStatus.PAYMENT_FAILED })

        return seeded
      }

      it("reports the capture of a churned subscription's case once for a refund when the customer's own cancellation stands, so the churn can't be reversed", async () => {
        const container = getContainer()
        const seeded = await seedChurnedCase("SUB-DUN-CHURN-CUSTOMER-LEFT")
        const [{ attempt, session }] = seeded.attempts

        await createCancellationCaseSeed(container, {
          subscription_id: seeded.subscription.id,
          status: CancellationCaseStatus.CANCELED,
          final_outcome: CancellationFinalOutcome.CANCELED,
          reason: "Too expensive",
          metadata: { dunning_case_id: seeded.dunningCase.id },
        })

        const payment = await captureOnOrder(container, seeded.order.id, session.id)
        const events = watchEvents(container)

        await deliverCapture(container, payment.id)
        await deliverCapture(container, payment.id)

        expect((await readDunningState(container, seeded.dunningCase.id)).attempts).toEqual([
          expect.objectContaining({
            id: attempt.id,
            status: DunningAttemptStatus.SUCCEEDED,
            error_code: PaymentAttemptErrorCode.CAPTURED_AFTER_CLOSE,
          }),
        ])
        expect(events(SubscriptionEvents.LATE_PAYMENT_CAPTURED).map((message) => message.data)).toEqual([
          expect.objectContaining({
            payment_id: payment.id,
            dunning_attempt_id: attempt.id,
            reason: LatePaymentCapturedReason.SUBSCRIPTION_TERMINAL,
          }),
        ])
      })

      it("leaves the capture of a churned subscription's case for the sweep when its recovery fails, which keeps it for the churn reversal", async () => {
        const container = getContainer()
        const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
        const seeded = await seedChurnedCase("SUB-DUN-CHURN-RECOVERY-FAILS")
        const [{ attempt, session }] = seeded.attempts
        const payment = await captureOnOrder(container, seeded.order.id, session.id)
        const events = watchEvents(container)

        jest
          .spyOn(dunningModule, "retrieveDunningCase")
          .mockRejectedValueOnce(new Error("the database connection was lost"))

        await deliverCapture(container, payment.id)

        const afterFailedRecovery = await readDunningState(container, seeded.dunningCase.id)

        expect(await reconcilePaidDunningCases(container)).toMatchObject({ late_captures: 1, failed: 0 })
        expect(afterFailedRecovery.attempts).toEqual([
          expect.objectContaining({ id: attempt.id, status: DunningAttemptStatus.PROCESSING }),
        ])
        expect((await readDunningState(container, seeded.dunningCase.id)).attempts).toEqual([
          expect.objectContaining({
            id: attempt.id,
            status: DunningAttemptStatus.SUCCEEDED,
            error_code: PaymentAttemptErrorCode.CAPTURED_AFTER_CLOSE,
          }),
        ])
        expect(events(SubscriptionEvents.LATE_PAYMENT_CAPTURED)).toHaveLength(0)
      })

      it("reports the retry's capture as the surplus once when the customer paid the renewal order while the retry charge was in flight", async () => {
        const container = getContainer()
        const seeded = await seedDunningCase(container, "SUB-DUN-PAID-TWICE")
        const caseId = seeded.dunningCase.id
        const [{ attempt, session }] = seeded.attempts
        const customerSession = await createPaymentSessionFixture(container, { amount: RENEWAL_AMOUNT })
        const customerPayment = await captureOnOrder(container, seeded.order.id, customerSession.session.id, {
          linkCollection: true,
        })

        await deliverCapture(container, customerPayment.id)

        const recovered = await readDunningState(container, caseId)
        const retryPayment = await captureOnOrder(container, seeded.order.id, session.id)
        const events = watchEvents(container)

        await deliverCapture(container, retryPayment.id)
        await deliverCapture(container, retryPayment.id)

        const state = await readDunningState(container, caseId)

        expect(recovered.dunningCase).toMatchObject({
          status: DunningCaseStatus.RECOVERED,
          recovery_reason: DunningRecoveryReason.CUSTOMER_PAYMENT,
        })
        expect(recovered.attempts).toEqual([
          expect.objectContaining({ id: attempt.id, status: DunningAttemptStatus.PROCESSING }),
        ])
        expect(state.dunningCase).toMatchObject({
          status: DunningCaseStatus.RECOVERED,
          recovery_reason: DunningRecoveryReason.CUSTOMER_PAYMENT,
        })
        expect(state.attempts).toEqual([
          expect.objectContaining({
            id: attempt.id,
            status: DunningAttemptStatus.SUCCEEDED,
            error_code: PaymentAttemptErrorCode.CAPTURED_AFTER_CLOSE,
          }),
        ])
        expect(events(SubscriptionEvents.LATE_PAYMENT_CAPTURED).map((message) => message.data)).toEqual([
          expect.objectContaining({
            payment_id: retryPayment.id,
            dunning_case_id: caseId,
            dunning_attempt_id: attempt.id,
            reason: LatePaymentCapturedReason.CASE_CLOSED,
            refund_amount: RENEWAL_AMOUNT,
            currency_code: "pln",
          }),
        ])
      })

      it("fails the charge of a case the customer cancelled once it is past the minimum age with no signal, and leaves a younger one alone", async () => {
        const container = getContainer()
        const seeded = await seedDunningCase(container, "SUB-DUN-CANCEL-STALE")
        const submittedAt = new Date(seeded.attempts[0].attempt.started_at).getTime()

        await cancelByCustomer(container, seeded)

        const logs = watchLogs(container)
        const sweepAt = (offsetMs: number) =>
          atTime(submittedAt + offsetMs, () => reconcilePaidDunningCases(container))

        expect(await sweepAt((DEFAULT_AWAITING_PAYMENT_RESOLVE_MIN_HOURS - 1) * HOUR_MS)).toMatchObject({
          stale_attempts_closed: 0,
        })
        expect(await sweepAt((DEFAULT_AWAITING_PAYMENT_RESOLVE_MIN_HOURS + 1) * HOUR_MS)).toMatchObject({
          stale_attempts_closed: 1,
        })
        expect(await sweepAt((DEFAULT_AWAITING_PAYMENT_RESOLVE_MIN_HOURS + 2) * HOUR_MS)).toMatchObject({
          stale_attempts_closed: 0,
        })

        expect((await readDunningState(container, seeded.dunningCase.id)).attempts).toEqual([
          expect.objectContaining({
            status: DunningAttemptStatus.FAILED,
            error_code: PaymentAttemptErrorCode.NO_PAYMENT_SIGNAL,
          }),
        ])
        expect(logs({ event: DunningLogEvents.STALE_ATTEMPT_CLOSED })).toEqual([
          expect.objectContaining({ dunning_case_id: seeded.dunningCase.id, alertable: false }),
        ])
      })

      it("delivers again the lost capture of a charge a customer's cancellation left in flight, reporting it once for a refund", async () => {
        const container = getContainer()
        const seeded = await seedDunningCase(container, "SUB-DUN-CANCEL-SWEPT-CAPTURE")
        const [{ session }] = seeded.attempts

        await cancelByCustomer(container, seeded)

        const payment = await captureOnOrder(container, seeded.order.id, session.id)
        const events = watchEvents(container)

        expect(await reconcilePaidDunningCases(container)).toMatchObject({ late_captures: 1 })
        expect(await reconcilePaidDunningCases(container)).toMatchObject({ late_captures: 0 })

        expect((await readDunningState(container, seeded.dunningCase.id)).attempts).toEqual([
          expect.objectContaining({
            status: DunningAttemptStatus.SUCCEEDED,
            error_code: PaymentAttemptErrorCode.CAPTURED_AFTER_CLOSE,
          }),
        ])
        expect(events(SubscriptionEvents.LATE_PAYMENT_CAPTURED).map((message) => message.data)).toEqual([
          expect.objectContaining({
            payment_id: payment.id,
            reason: LatePaymentCapturedReason.SUBSCRIPTION_TERMINAL,
          }),
        ])
      })
    })

    describe("an admin cancellation while a retry charge is in flight", () => {
      beforeEach(() => {
        jest.restoreAllMocks()
        jest.clearAllMocks()
      })

      const cancelBy = {
        admin: async (container: MedusaContainer, seeded: SeededDunningCase) => {
          await cancelSubscriptionWorkflow(container).run({
            input: { id: seeded.subscription.id, reason: "Fraud review" },
          })
        },
        finalize: async (container: MedusaContainer, seeded: SeededDunningCase) => {
          const cancellationCase = await createCancellationCaseSeed(container, {
            subscription_id: seeded.subscription.id,
            reason: "Too expensive",
          })

          await finalizeCancellationWorkflow(container).run({
            input: { cancellation_case_id: cancellationCase.id },
          })
        },
      }

      async function deliverInOrder(
        container: MedusaContainer,
        paymentId: string,
        first: "subscriber" | "sweep"
      ) {
        const subscriber = () => deliverCapture(container, paymentId)
        const sweep = () => reconcilePaidDunningCases(container)

        for (const deliver of first === "subscriber" ? [subscriber, sweep] : [sweep, subscriber]) {
          await deliver()
        }

        await subscriber()
        await sweep()
      }

      it.each([
        { flow: "admin" as const, first: "subscriber" as const },
        { flow: "admin" as const, first: "sweep" as const },
        { flow: "finalize" as const, first: "subscriber" as const },
        { flow: "finalize" as const, first: "sweep" as const },
      ])(
        "the $flow cancellation closes the case and keeps its charge in flight; a capture reaching the $first first is reported once for a refund, recovering nothing",
        async ({ flow, first }) => {
          const container = getContainer()
          const seeded = await seedDunningCase(container, `SUB-DUN-ADMIN-${flow}-${first}`)
          const caseId = seeded.dunningCase.id
          const [{ attempt, session }] = seeded.attempts

          await cancelBy[flow](container, seeded)

          const cancelled = await readDunningState(container, caseId)
          const payment = await captureOnOrder(container, seeded.order.id, session.id)
          const events = watchEvents(container)

          await deliverInOrder(container, payment.id, first)

          expect(cancelled.dunningCase).toMatchObject({
            status: DunningCaseStatus.UNRECOVERED,
            next_retry_at: null,
            closed_at: expect.any(Date),
          })
          expect(cancelled.attempts).toEqual([
            expect.objectContaining({ id: attempt.id, status: DunningAttemptStatus.PROCESSING }),
          ])
          expect(cancelled.subscription).toMatchObject({
            status: SubscriptionStatus.CANCELLED,
            next_renewal_at: null,
          })
          expect(await readDunningState(container, caseId)).toEqual({
            ...cancelled,
            attempts: [
              {
                ...cancelled.attempts[0],
                status: DunningAttemptStatus.SUCCEEDED,
                error_code: PaymentAttemptErrorCode.CAPTURED_AFTER_CLOSE,
                error_message: expect.stringContaining(payment.id),
                finished_at: expect.any(Date),
                updated_at: expect.any(Date),
                metadata: expect.objectContaining({
                  late_payment_captured: expect.objectContaining({
                    payment_id: payment.id,
                    reason: LatePaymentCapturedReason.SUBSCRIPTION_TERMINAL,
                  }),
                }),
              },
            ],
          })
          expect(events(SubscriptionEvents.LATE_PAYMENT_CAPTURED).map((message) => message.data)).toEqual([
            expect.objectContaining({
              payment_id: payment.id,
              dunning_case_id: caseId,
              dunning_attempt_id: attempt.id,
              reason: LatePaymentCapturedReason.SUBSCRIPTION_TERMINAL,
              refund_amount: RENEWAL_AMOUNT,
            }),
          ])
          expect(events(DunningEvents.RECOVERED)).toHaveLength(0)
        }
      )

      it.each(["admin" as const, "finalize" as const])(
        "the %s cancellation leaves a charge that fails afterwards closed as failed, with no reschedule and no event",
        async (flow) => {
          const container = getContainer()
          const seeded = await seedDunningCase(container, `SUB-DUN-ADMIN-${flow}-LATE-FAIL`)
          const [{ session }] = seeded.attempts

          await cancelBy[flow](container, seeded)

          const cancelled = await readDunningState(container, seeded.dunningCase.id)
          const events = watchEvents(container)

          await deliverFailure(container, session.id, { reason: "insufficient_funds" })
          await deliverFailure(container, session.id, { reason: "insufficient_funds" })
          await reconcilePaidDunningCases(container)

          expect(cancelled.dunningCase.status).toEqual(DunningCaseStatus.UNRECOVERED)
          expect(await readDunningState(container, seeded.dunningCase.id)).toEqual({
            ...cancelled,
            attempts: [
              {
                ...cancelled.attempts[0],
                status: DunningAttemptStatus.FAILED,
                error_code: "insufficient_funds",
                error_message: expect.stringMatching(/after its dunning case had closed/),
                finished_at: expect.any(Date),
                updated_at: expect.any(Date),
              },
            ],
          })
          expect({
            attempt_failed: events(DunningEvents.ATTEMPT_FAILED).length,
            payment_failed: events(DunningEvents.PAYMENT_FAILED).length,
            late_payment_captured: events(SubscriptionEvents.LATE_PAYMENT_CAPTURED).length,
          }).toEqual({ attempt_failed: 0, payment_failed: 0, late_payment_captured: 0 })
        }
      )

      describe("a case an earlier cancellation left open", () => {
        async function seedOpenCaseOnCancelledSubscription(reference: string) {
          const container = getContainer()
          const seeded = await seedDunningCase(container, reference)

          await container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE).updateSubscriptions({
            id: seeded.subscription.id,
            status: SubscriptionStatus.CANCELLED,
            cancelled_at: new Date(),
            next_renewal_at: null,
          })

          return seeded
        }

        it.each(["subscriber" as const, "sweep" as const])(
          "is closed by the sweep, and a capture reaching the %s first is reported once for a refund, recovering nothing and writing no dates",
          async (first) => {
            const container = getContainer()
            const seeded = await seedOpenCaseOnCancelledSubscription(`SUB-DUN-LEFT-OPEN-${first}`)
            const caseId = seeded.dunningCase.id
            const [{ attempt, session }] = seeded.attempts
            const before = await readDunningState(container, caseId)
            const payment = await captureOnOrder(container, seeded.order.id, session.id)
            const events = watchEvents(container)

            await deliverInOrder(container, payment.id, first)

            const after = await readDunningState(container, caseId)

            expect(after.dunningCase).toMatchObject({
              status: DunningCaseStatus.UNRECOVERED,
              next_retry_at: null,
              closed_at: expect.any(Date),
            })
            expect(after.subscription).toEqual(before.subscription)
            expect(after.cycle).toEqual(before.cycle)
            expect(after.attempts).toEqual([
              expect.objectContaining({
                id: attempt.id,
                status: DunningAttemptStatus.SUCCEEDED,
                error_code: PaymentAttemptErrorCode.CAPTURED_AFTER_CLOSE,
              }),
            ])
            expect(events(SubscriptionEvents.LATE_PAYMENT_CAPTURED).map((message) => message.data)).toEqual([
              expect.objectContaining({
                payment_id: payment.id,
                dunning_case_id: caseId,
                reason: LatePaymentCapturedReason.SUBSCRIPTION_TERMINAL,
              }),
            ])
            expect(events(DunningEvents.RECOVERED)).toHaveLength(0)
          }
        )

        it("is closed by the sweep while its order stays unpaid, keeping the charge in flight", async () => {
          const container = getContainer()
          const seeded = await seedOpenCaseOnCancelledSubscription("SUB-DUN-LEFT-OPEN-UNPAID")
          const before = await readDunningState(container, seeded.dunningCase.id)

          expect(await reconcilePaidDunningCases(container)).toMatchObject({ ended_cancelled: 1, recovered: 0 })
          expect(await reconcilePaidDunningCases(container)).toMatchObject({ ended_cancelled: 0 })

          const after = await readDunningState(container, seeded.dunningCase.id)

          expect(after.dunningCase).toMatchObject({ status: DunningCaseStatus.UNRECOVERED, closed_at: expect.any(Date) })
          expect(after.attempts).toEqual(before.attempts)
          expect(after.subscription).toEqual(before.subscription)
        })

        it("is never recovered by a captured payment, which leaves the case for the sweep to close", async () => {
          const container = getContainer()
          const seeded = await seedOpenCaseOnCancelledSubscription("SUB-DUN-LEFT-OPEN-RECOVER")
          const before = await readDunningState(container, seeded.dunningCase.id)
          const payment = await captureOnOrder(container, seeded.order.id, seeded.attempts[0].session.id)

          const { result } = await recoverDunningFromCapturedPaymentWorkflow(container).run({
            input: { dunning_case_id: seeded.dunningCase.id, payment_id: payment.id },
          })

          expect(result).toMatchObject({ recovered: false, reason: "subscription_cancelled" })
          expect(await readDunningState(container, seeded.dunningCase.id)).toEqual(before)
        })
      })

      describe("when a write inside the cancellation fails", () => {
        function failOnce<T extends object>(
          service: T,
          method: keyof T & string,
          matches: (data: Record<string, unknown>) => boolean,
          message: string
        ) {
          const original = (service[method] as (...args: unknown[]) => Promise<unknown>).bind(service)
          let failed = false

          jest.spyOn(service, method as never).mockImplementation(((data: Record<string, unknown>, ...rest: unknown[]) => {
            if (!failed && matches(data ?? {})) {
              failed = true

              return Promise.reject(new Error(message))
            }

            return original(data, ...rest)
          }) as never)

          return { message }
        }

        async function withCaseMetadata(container: MedusaContainer, caseId: string) {
          await container.resolve<DunningModuleService>(DUNNING_MODULE).updateDunningCases({
            id: caseId,
            metadata: { seeded_note: "kept" },
          })
        }

        it.each([
          {
            flow: "admin" as const,
            fails: "its activity log",
            inject: (container: MedusaContainer) =>
              failOnce(
                container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE),
                "createSubscriptionLogs",
                (data) => data.event_type === ActivityLogEventType.SUBSCRIPTION_CANCELED,
                "the cancellation log could not be written"
              ),
          },
          {
            flow: "finalize" as const,
            fails: "the cancellation case",
            inject: (container: MedusaContainer) =>
              failOnce(
                container.resolve<CancellationModuleService>(CANCELLATION_MODULE),
                "updateCancellationCases",
                (data) => data.status === CancellationCaseStatus.CANCELED,
                "the cancellation case could not be written"
              ),
          },
        ])(
          "leaves the case and its in-flight attempt as they were when the $flow cancellation fails writing $fails, and a second attempt closes the case",
          async ({ flow, inject }) => {
            const container = getContainer()
            const seeded = await seedDunningCase(container, `SUB-DUN-ADMIN-${flow}-ROLLBACK`)

            await withCaseMetadata(container, seeded.dunningCase.id)

            const before = await readDunningState(container, seeded.dunningCase.id)
            const failure = inject(container)

            await expect(cancelBy[flow](container, seeded)).rejects.toMatchObject(failure)

            const after = await readDunningState(container, seeded.dunningCase.id)

            expect(after.dunningCase).toEqual({ ...before.dunningCase, updated_at: expect.any(Date) })
            expect(after.subscription).toEqual({ ...before.subscription, updated_at: expect.any(Date) })
            expect(after.attempts).toEqual(before.attempts)

            await cancelBy[flow](container, seeded)

            expect((await readDunningState(container, seeded.dunningCase.id)).dunningCase.status).toEqual(
              DunningCaseStatus.UNRECOVERED
            )
          }
        )

        it("restores every case it closed when closing a later one fails", async () => {
          const container = getContainer()
          const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
          const seeded = await seedDunningCase(container, "SUB-DUN-ADMIN-ROLLBACK-TWO-CASES")
          const second = await createDunningCaseSeed(container, {
            subscription_id: seeded.subscription.id,
            renewal_cycle_id: seeded.cycle.id,
            renewal_order_id: seeded.order.id,
            status: DunningCaseStatus.RETRY_SCHEDULED,
          })

          await withCaseMetadata(container, seeded.dunningCase.id)
          await withCaseMetadata(container, second.id)

          const before = await dunningModule.listDunningCases(
            { subscription_id: seeded.subscription.id },
            { order: { id: "ASC" } }
          )
          let closes = 0
          const failure = failOnce(
            dunningModule,
            "updateDunningCases",
            (data) => data.status === DunningCaseStatus.UNRECOVERED && ++closes === 2,
            "the second case could not be closed"
          )

          await expect(cancelBy.admin(container, seeded)).rejects.toMatchObject(failure)

          expect(closes).toEqual(2)
          expect(
            await dunningModule.listDunningCases(
              { subscription_id: seeded.subscription.id },
              { order: { id: "ASC" } }
            )
          ).toEqual(before.map((dunningCase) => ({ ...dunningCase, updated_at: expect.any(Date) })))
        })
      })
    })

    describe("admin actions on a case whose retry charge is in flight", () => {
      beforeEach(() => {
        jest.restoreAllMocks()
        jest.clearAllMocks()
      })

      it.each([DunningCaseStatus.AWAITING_PAYMENT, DunningCaseStatus.RETRYING])(
        "refuses to mark a %s case recovered or unrecovered with a conflict that says why, writing nothing",
        async (status) => {
          const container = getContainer()
          const admin = { headers: await createAdminAuthHeaders(container) }
          const seeded = await seedDunningCase(container, `SUB-DUN-MARK-${status}`, { status })
          const caseId = seeded.dunningCase.id
          const before = await readDunningState(container, caseId)
          const events = watchEvents(container)

          for (const [action, body] of [
            ["mark-recovered", {}],
            ["mark-unrecovered", { reason: "customer unreachable" }],
          ] as const) {
            await expect(api.post(`/admin/dunning/${caseId}/${action}`, body, admin)).rejects.toMatchObject({
              response: {
                status: 409,
                data: {
                  type: "conflict",
                  message: `DunningCase '${caseId}' can't be marked ${action === "mark-recovered" ? "recovered" : "unrecovered"} while retry is in flight`,
                },
              },
            })
          }

          expect(await readDunningState(container, caseId)).toEqual(before)
          expect(events(DunningEvents.RECOVERED)).toHaveLength(0)
          expect(events(DunningEvents.PAYMENT_FAILED)).toHaveLength(0)
        }
      )

      it("marks a case recovered only once the case's lock is free, answering a readable conflict while a retry holds it", async () => {
        const container = getContainer()
        const admin = { headers: await createAdminAuthHeaders(container) }
        const seeded = await seedDunningCase(container, "SUB-DUN-MARK-LOCKED", {
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempts: [DunningAttemptStatus.FAILED],
        })
        const caseId = seeded.dunningCase.id
        const before = await readDunningState(container, caseId)
        const markRecovered = () => api.post(`/admin/dunning/${caseId}/mark-recovered`, {}, admin)

        const refusal = await whileLockHeld(container, dunningCaseLockKey(caseId), () =>
          markRecovered().catch((error: { response?: unknown }) => error.response)
        )

        expect(refusal).toMatchObject({
          status: 409,
          data: { type: "conflict", message: expect.stringMatching(/being updated by a retry or a payment/) },
        })
        expect(await readDunningState(container, caseId)).toEqual(before)

        expect((await markRecovered()).status).toEqual(200)
        expect((await readDunningState(container, caseId)).dunningCase.status).toEqual(
          DunningCaseStatus.RECOVERED
        )
      })
    })

    describe("POST /admin/dunning/:id/resolve-awaiting-payment", () => {
      const route = (caseId: string) => `/admin/dunning/${caseId}/resolve-awaiting-payment`

      beforeEach(() => {
        jest.restoreAllMocks()
        jest.clearAllMocks()
      })

      async function ageInFlightAttempt(container: MedusaContainer, seeded: SeededDunningCase, hours: number) {
        const attempt = seeded.attempts[seeded.attempts.length - 1].attempt

        await container.resolve<DunningModuleService>(DUNNING_MODULE).updateDunningAttempts({
          id: attempt.id,
          started_at: new Date(Date.now() - hours * HOUR_MS),
        })
      }

      it("rejects an unauthenticated request, an invalid body, an unknown case and a case that is not awaiting its retry's payment, and answers that an unpaid young charge may still arrive, writing nothing", async () => {
        const container = getContainer()
        const admin = { headers: await createAdminAuthHeaders(container) }
        const young = await seedDunningCase(container, "SUB-DUN-RESOLVE-YOUNG")
        const scheduled = await seedDunningCase(container, "SUB-DUN-RESOLVE-SCHEDULED", {
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempts: [DunningAttemptStatus.FAILED],
        })
        const before = [
          await readDunningState(container, young.dunningCase.id),
          await readDunningState(container, scheduled.dunningCase.id),
        ]
        const events = watchEvents(container)

        await ageInFlightAttempt(container, young, DEFAULT_AWAITING_PAYMENT_RESOLVE_MIN_HOURS - 1)
        before[0] = await readDunningState(container, young.dunningCase.id)

        await expect(api.post(route(young.dunningCase.id), {})).rejects.toMatchObject({
          response: { status: 401 },
        })
        await expect(api.post(route(young.dunningCase.id), { reason: "" }, admin)).rejects.toMatchObject({
          response: { status: 400 },
        })
        await expect(api.post(route("dcase_missing"), {}, admin)).rejects.toMatchObject({
          response: { status: 404, data: { type: "not_found" } },
        })
        await expect(api.post(route(scheduled.dunningCase.id), {}, admin)).rejects.toMatchObject({
          response: {
            status: 409,
            data: { type: "conflict", message: expect.stringMatching(/isn't awaiting the payment of its retry/) },
          },
        })
        await expect(api.post(route(young.dunningCase.id), {}, admin)).rejects.toMatchObject({
          response: {
            status: 409,
            data: {
              type: "conflict",
              message: expect.stringMatching(
                new RegExp(`payment may still arrive.*${DEFAULT_AWAITING_PAYMENT_RESOLVE_MIN_HOURS} hours`)
              ),
            },
          },
        })

        expect([
          await readDunningState(container, young.dunningCase.id),
          await readDunningState(container, scheduled.dunningCase.id),
        ]).toEqual(before)
        expect(events(DunningEvents.RECOVERED)).toHaveLength(0)
        expect(events(DunningEvents.ATTEMPT_FAILED)).toHaveLength(0)
      })

      it("shows on the case detail when its awaiting charge was submitted and after when it can be failed, by the resolve minimum age, not the alert hours", async () => {
        const container = getContainer()
        const admin = { headers: await createAdminAuthHeaders(container) }
        const awaiting = await seedDunningCase(container, "SUB-DUN-DETAIL-AWAITING")
        const retrying = await seedDunningCase(container, "SUB-DUN-DETAIL-RETRYING", {
          status: DunningCaseStatus.RETRYING,
        })
        const scheduled = await seedDunningCase(container, "SUB-DUN-DETAIL-SCHEDULED", {
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempts: [DunningAttemptStatus.FAILED],
        })

        await ageInFlightAttempt(container, awaiting, 3)

        const [attempt] = (await readDunningState(container, awaiting.dunningCase.id)).attempts
        const submittedAt = new Date(attempt.started_at)
        const detail = async (caseId: string) =>
          (await api.get(`/admin/dunning/${caseId}`, admin)).data.dunning_case
        const awaitingPayment = (minHours: number) => ({
          submitted_at: submittedAt.toISOString(),
          can_fail_after: new Date(submittedAt.getTime() + minHours * HOUR_MS).toISOString(),
        })

        try {
          process.env[AWAITING_PAYMENT_ALERT_HOURS_ENV] = "1"

          expect((await detail(awaiting.dunningCase.id)).awaiting_payment).toEqual(
            awaitingPayment(DEFAULT_AWAITING_PAYMENT_RESOLVE_MIN_HOURS)
          )
          expect((await detail(retrying.dunningCase.id)).awaiting_payment).toBeNull()
          expect((await detail(scheduled.dunningCase.id)).awaiting_payment).toBeNull()

          process.env[AWAITING_PAYMENT_RESOLVE_MIN_HOURS_ENV] = "2"

          expect((await detail(awaiting.dunningCase.id)).awaiting_payment).toEqual(awaitingPayment(2))

          const resolved = await api.post(route(awaiting.dunningCase.id), {}, admin)

          expect(resolved.data).toMatchObject({
            resolution: "failed",
            dunning_case: { status: DunningCaseStatus.RETRY_SCHEDULED, awaiting_payment: null },
          })
        } finally {
          delete process.env[AWAITING_PAYMENT_ALERT_HOURS_ENV]
          delete process.env[AWAITING_PAYMENT_RESOLVE_MIN_HOURS_ENV]
        }
      })

      it("recovers the case through its in-flight attempt when the renewal order is already paid, however young the charge", async () => {
        const container = getContainer()
        const admin = { headers: await createAdminAuthHeaders(container) }
        const seeded = await seedDunningCase(container, "SUB-DUN-RESOLVE-PAID")
        const [{ attempt, session }] = seeded.attempts
        const payment = await captureOnOrder(container, seeded.order.id, session.id)
        const events = watchEvents(container)

        const response = await api.post(route(seeded.dunningCase.id), { reason: "provider confirmed" }, admin)
        const state = await readDunningState(container, seeded.dunningCase.id)

        expect(response.status).toEqual(200)
        expect(response.data).toMatchObject({
          resolution: "recovered",
          dunning_case: { id: seeded.dunningCase.id, status: DunningCaseStatus.RECOVERED },
        })
        expect(state.dunningCase).toMatchObject({
          status: DunningCaseStatus.RECOVERED,
          recovery_reason: DunningRecoveryReason.PAYMENT_RECOVERED,
        })
        expect(state.attempts).toEqual([
          expect.objectContaining({
            id: attempt.id,
            status: DunningAttemptStatus.SUCCEEDED,
            payment_reference: payment.id,
          }),
        ])
        expect(state.subscription.status).toEqual(SubscriptionStatus.ACTIVE)
        expect(state.cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(events(DunningEvents.RECOVERED).map((message) => message.data)).toEqual([
          expect.objectContaining({ dunning_case_id: seeded.dunningCase.id, recovery_reason: DunningRecoveryReason.PAYMENT_RECOVERED }),
        ])
      })

      it.each([
        {
          title: "fails the in-flight attempt and reschedules the next retry",
          reference: "SUB-DUN-RESOLVE-RESCHEDULE",
          seed: {},
          expected: {
            dunningCase: { status: DunningCaseStatus.RETRY_SCHEDULED, next_retry_at: expect.anything() },
            subscription: SubscriptionStatus.PAST_DUE,
            events: { attempt_failed: 1, payment_failed: 0 },
          },
        },
        {
          title: "fails the last allowed attempt and closes the case as unrecovered",
          reference: "SUB-DUN-RESOLVE-LAST",
          seed: { attempt_count: 3, max_attempts: 3 },
          expected: {
            dunningCase: { status: DunningCaseStatus.UNRECOVERED, recovery_reason: DunningRecoveryReason.RETRY_LIMIT_EXHAUSTED },
            subscription: SubscriptionStatus.PAYMENT_FAILED,
            events: { attempt_failed: 0, payment_failed: 1 },
          },
        },
      ])(
        "$title, as a failure webhook would, once an unpaid charge has waited past the minimum age",
        async ({ reference, seed, expected }) => {
          const container = getContainer()
          const admin = { headers: await createAdminAuthHeaders(container) }
          const seeded = await seedDunningCase(container, reference, seed)
          const { attempt, session } = seeded.attempts[0]

          await ageInFlightAttempt(container, seeded, DEFAULT_AWAITING_PAYMENT_RESOLVE_MIN_HOURS + 1)

          const events = watchEvents(container)
          const response = await api.post(
            route(seeded.dunningCase.id),
            { reason: "bank confirmed no transfer" },
            admin
          )
          const state = await readDunningState(container, seeded.dunningCase.id)

          expect(response.status).toEqual(200)
          expect(response.data).toMatchObject({
            resolution: "failed",
            dunning_case: { id: seeded.dunningCase.id, status: expected.dunningCase.status },
          })
          expect(state.dunningCase).toMatchObject(expected.dunningCase)
          expect(state.attempts).toEqual([
            expect.objectContaining({
              id: attempt.id,
              status: DunningAttemptStatus.FAILED,
              payment_reference: session.id,
              error_message: expect.stringContaining("bank confirmed no transfer"),
            }),
          ])
          expect(state.subscription.status).toEqual(expected.subscription)
          expect({
            attempt_failed: events(DunningEvents.ATTEMPT_FAILED).length,
            payment_failed: events(DunningEvents.PAYMENT_FAILED).length,
          }).toEqual(expected.events)
        }
      )
    })
  },
})

async function whileLockHeld<T>(container: MedusaContainer, key: string, run: () => Promise<T>) {
  const locking = container.resolve(Modules.LOCKING)
  const ownerId = `test-holder-${key}`

  await locking.acquire(key, { ownerId, expire: 60 })

  try {
    return await run()
  } finally {
    await locking.release(key, { ownerId })
  }
}

jest.setTimeout(60 * 1000)
