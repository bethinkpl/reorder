import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import type { IPaymentModuleService, MedusaContainer } from "@medusajs/framework/types"
import { MedusaError, Modules, PaymentSessionStatus } from "@medusajs/framework/utils"
import { FrequencyInterval } from "../../src/common/types/frequency-interval"
import processDunningRetriesJob from "../../src/jobs/process-dunning-retries"
import processRenewalCyclesJob from "../../src/jobs/process-renewal-cycles"
import reconcileInFlightChargesJob from "../../src/jobs/reconcile-in-flight-charges"
import { CANCELLATION_MODULE } from "../../src/modules/cancellation"
import type CancellationModuleService from "../../src/modules/cancellation/service"
import { CancellationCaseStatus, RetentionOfferType } from "../../src/modules/cancellation/types"
import { DUNNING_MODULE } from "../../src/modules/dunning"
import { DunningEvents } from "../../src/modules/dunning/events"
import type DunningModuleService from "../../src/modules/dunning/service"
import { DunningAttemptStatus, DunningCaseStatus } from "../../src/modules/dunning/types"
import { dunningErrors } from "../../src/modules/dunning/utils/errors"
import { RetryBlockedReason } from "../../src/modules/dunning/utils/retry-eligibility"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import { RenewalAttemptStatus, RenewalCycleStatus } from "../../src/modules/renewal/types"
import { renewalErrors } from "../../src/modules/renewal/utils/errors"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import { LatePaymentCapturedReason, SubscriptionEvents } from "../../src/modules/subscription/events"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import {
  cancelSubscriptionByCustomerWorkflow,
  ensureNextRenewalCycleWorkflow,
  forceRenewalCycleWorkflow,
  startDunningWorkflow,
} from "../../src/workflows"
import { RENEWAL_PAYMENT_IN_PROGRESS } from "../../src/workflows/utils/assert-no-charge-in-flight"
import {
  oneMonthAfter,
  readDunningState,
  readRenewalState,
  seedAwaitingRenewal,
  seedDueRenewal,
  seedDunningCase,
} from "../helpers/async-payment-fixtures"
import { createCancellationCaseSeed } from "../helpers/cancellation-fixtures"
import {
  RENEWAL_AMOUNT,
  answerAuthorizationWithNull,
  captureOnOrder,
  createSystemPaymentSession,
  deliverCapture,
  deliverFailure,
  routeChargesToFixtures,
  runRenewal,
} from "../helpers/charge-fixtures"
import { createDunningCaseSeed } from "../helpers/dunning-fixtures"
import { createAdminAuthHeaders, createRenewalCycleSeed } from "../helpers/renewal-fixtures"
import { atTime, failOnce, lockRequested, watchEvents, watchLogs, whileLockHeld } from "../helpers/spy-fixtures"
import { createStoreCustomerHeaders } from "../helpers/subscription-fixtures"

jest.mock("@medusajs/medusa/core-flows", () => require("../helpers/core-flow-mocks").coreFlowsMock())

jest.setTimeout(120 * 1000)

const DUE_AT = new Date("2026-05-10T10:00:00.000Z")
const SETTLED_AT = new Date("2026-05-10T10:10:00.000Z")
const RESUME_AT = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
const WRITE_FAILURE = "database connection lost"
const RELEASE_FAILURE = "lock store unavailable"
const READ_FAILURE = "query read timeout"
const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS

const ACTIVE_DUNNING_STATUSES = [
  DunningCaseStatus.OPEN,
  DunningCaseStatus.RETRY_SCHEDULED,
  DunningCaseStatus.RETRYING,
  DunningCaseStatus.AWAITING_PAYMENT,
  DunningCaseStatus.AWAITING_MANUAL_RESOLUTION,
]

const LATER_STEP_FAILURES = [
  { name: "parked", failPark: false, status: RenewalCycleStatus.AWAITING_PAYMENT },
  { name: "whose park could not be written", failPark: true, status: RenewalCycleStatus.PROCESSING },
]

function writes(data: unknown, field: string, value?: unknown) {
  return Object.entries(Object(data)).some(
    ([key, written]) => key === field && (value === undefined || written === value)
  )
}

async function forceRenewal(container: MedusaContainer, renewalCycleId: string) {
  await forceRenewalCycleWorkflow(container).run({
    input: { renewal_cycle_id: renewalCycleId, triggered_by: "user_async_admin" },
  })
}

async function seedParkedDunningCase(container: MedusaContainer, reference: string, attempt_count?: number, status?: DunningCaseStatus) {
  const { attempt, session, ...seeded } = await seedDunningCase(container, { reference, attempt_count, status })

  if (!attempt || !session) {
    throw new Error(`Dunning case '${seeded.dunningCase.id}' has no charge in flight`)
  }

  return { ...seeded, attempt, session }
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: { JWT_SECRET: "supersecret", COOKIE_SECRET: "supersecret" },
  testSuite: ({ api, getContainer }) => {
    const renewals = () => getContainer().resolve<RenewalModuleService>(RENEWAL_MODULE)
    const dunning = () => getContainer().resolve<DunningModuleService>(DUNNING_MODULE)
    const subscriptions = () => getContainer().resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
    const payments = () => getContainer().resolve<IPaymentModuleService>(Modules.PAYMENT)
    const cancellations = () => getContainer().resolve<CancellationModuleService>(CANCELLATION_MODULE)

    let admin: { headers: Record<string, string> }

    beforeAll(async () => {
      admin = { headers: await createAdminAuthHeaders(getContainer()) }
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    describe("a renewal whose charge the provider confirms later", () => {
      it("parks the cycle on a pending authorisation with its order and charge context, and refuses to run it again", async () => {
        const container = getContainer()
        const seeded = await seedDueRenewal(container, { reference: "SUB-ASYNC-PARK", due_at: DUE_AT })
        const charges = routeChargesToFixtures(container)
        answerAuthorizationWithNull()

        const result = await runRenewal(container, seeded.cycle.id, { correlation_id: "corr-async-park" })

        const state = await readRenewalState(container, seeded)
        const [orderId] = charges.orders
        const [session] = charges.sessions

        expect(result.renewal_cycle).toMatchObject({ status: RenewalCycleStatus.AWAITING_PAYMENT })
        expect(state.cycle).toMatchObject({
          status: RenewalCycleStatus.AWAITING_PAYMENT,
          generated_order_id: orderId,
          attempt_count: 1,
        })
        expect(state.attempts).toEqual([
          expect.objectContaining({
            status: RenewalAttemptStatus.PROCESSING,
            order_id: orderId,
            payment_reference: session.id,
            finished_at: null,
          }),
        ])
        expect(state.attempts[0].metadata?.charge_context).toEqual({
          correlation_id: "corr-async-park",
          trigger_type: "scheduler",
          triggered_by: null,
          reason: null,
          operation_started_at: expect.any(Number),
          scheduled_for: DUE_AT.toISOString(),
          previous_state: {
            status: RenewalCycleStatus.SCHEDULED,
            attempt_count: 0,
            processed_at: null,
            generated_order_id: null,
            last_error: null,
          },
          source_snapshot: null,
        })
        expect(await payments().retrievePaymentSession(session.id)).toMatchObject({
          status: PaymentSessionStatus.PENDING_AUTHORIZATION,
          context: { renewal_cycle_id: seeded.cycle.id, renewal_attempt_id: state.attempts[0].id },
        })
        expect(state.subscription).toMatchObject({ next_renewal_at: DUE_AT, last_renewal_at: null })
        expect(state).toMatchObject({ otherCycles: [], cases: [], succeededLogs: [], failedLogs: [] })

        const refusal = {
          type: MedusaError.Types.CONFLICT,
          message: renewalErrors.alreadyProcessing(seeded.cycle.id).message,
        }

        await expect(forceRenewal(container, seeded.cycle.id)).rejects.toMatchObject(refusal)
        await expect(runRenewal(container, seeded.cycle.id, { trigger_type: "manual" })).rejects.toMatchObject(refusal)
        expect(await readRenewalState(container, seeded)).toEqual(state)
        expect(charges.sessions).toHaveLength(1)

        const control = await createRenewalCycleSeed(container, {
          subscription_id: "sub_async_control",
          scheduled_for: DUE_AT,
        })
        const due = await renewals().listDueRenewalCyclesForWindow({ dueBefore: new Date(), cursor: "", limit: 100 })

        expect(due.map(({ id }) => id)).toEqual([control.id])

        await subscriptions().updateSubscriptions({
          id: seeded.subscription.id,
          pending_update_data: {
            variant_id: "variant_async_pending",
            variant_title: "Pending Variant",
            sku: "PENDING-SKU",
            frequency_interval: FrequencyInterval.MONTH,
            frequency_value: 1,
            effective_at: null,
            requested_at: new Date().toISOString(),
            requested_by: null,
          },
        })
        await ensureNextRenewalCycleWorkflow(container).run({ input: { subscription_id: seeded.subscription.id } })

        expect(await renewals().retrieveRenewalCycle(seeded.cycle.id)).toMatchObject({
          status: RenewalCycleStatus.AWAITING_PAYMENT,
          approval_required: false,
          approval_status: null,
        })
      })

      it.each(LATER_STEP_FAILURES)(
        "keeps a charge $name in flight when a later step of its run fails, never charges it again, and settles it once on its capture",
        async ({ failPark, status }) => {
          const container = getContainer()
          const seeded = await seedDueRenewal(container, { reference: "SUB-ASYNC-LATER-FAILURE", due_at: DUE_AT })
          const charges = routeChargesToFixtures(container)
          const authorize = answerAuthorizationWithNull()
          const lockKey = `renewal:subscription:${seeded.subscription.id}`

          if (failPark) {
            failOnce(
              renewals(),
              "updateRenewalCycles",
              (data) => writes(data, "status", RenewalCycleStatus.AWAITING_PAYMENT),
              WRITE_FAILURE
            )
          }

          failOnce(container.resolve(Modules.LOCKING), "release", (keys) => [keys].flat().includes(lockKey), RELEASE_FAILURE)

          await expect(runRenewal(container, seeded.cycle.id)).rejects.toMatchObject({
            message: expect.stringContaining(RELEASE_FAILURE),
          })

          const state = await readRenewalState(container, seeded)

          expect(state.cycle).toMatchObject({ status, generated_order_id: charges.orders[0] })
          expect(state.attempts).toEqual([
            expect.objectContaining({
              status: RenewalAttemptStatus.PROCESSING,
              payment_reference: charges.sessions[0].id,
              finished_at: null,
            }),
          ])
          expect(state.subscription).toMatchObject({ next_renewal_at: DUE_AT, last_renewal_at: null })
          expect(state).toMatchObject({ otherCycles: [], cases: [], succeededLogs: [], failedLogs: [] })

          await processRenewalCyclesJob(container)

          expect(charges.sessions).toHaveLength(1)
          expect(authorize).toHaveBeenCalledTimes(1)
          expect(await readRenewalState(container, seeded)).toEqual(state)

          authorize.mockRestore()
          const capture = await captureOnOrder(container, charges.orders[0], charges.sessions[0].id)
          await atTime(DUE_AT.getTime() + 600_000, () => deliverCapture(container, capture.id))

          const settled = await readRenewalState(container, seeded)

          expect(settled.cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
          expect(settled.attempts).toEqual([expect.objectContaining({ status: RenewalAttemptStatus.SUCCEEDED })])
          expect(settled.subscription.next_renewal_at).toEqual(oneMonthAfter(DUE_AT))
          expect(settled.succeededLogs).toHaveLength(1)
          expect(settled.otherCycles).toEqual([
            expect.objectContaining({ status: RenewalCycleStatus.SCHEDULED, scheduled_for: oneMonthAfter(DUE_AT) }),
          ])
        }
      )

      it("fails the cycle before any session exists, without dunning, when its charge context can't be written", async () => {
        const container = getContainer()
        const seeded = await seedDueRenewal(container, { reference: "SUB-ASYNC-INTENT", due_at: DUE_AT })
        const charges = routeChargesToFixtures(container)
        const authorize = answerAuthorizationWithNull()

        failOnce(
          renewals(),
          "updateRenewalAttempts",
          (data) => writes(Object(data).metadata, "charge_context"),
          WRITE_FAILURE
        )

        await expect(runRenewal(container, seeded.cycle.id)).rejects.toMatchObject({
          message: expect.stringContaining(WRITE_FAILURE),
        })

        const state = await readRenewalState(container, seeded)

        expect(state.cycle).toMatchObject({
          status: RenewalCycleStatus.FAILED,
          generated_order_id: charges.orders[0],
          last_error: WRITE_FAILURE,
        })
        expect(state.attempts).toEqual([
          expect.objectContaining({ status: RenewalAttemptStatus.FAILED, payment_reference: null }),
        ])
        expect(charges.sessions).toEqual([])
        expect(authorize).not.toHaveBeenCalled()
        expect(state.cases).toEqual([])
      })
    })

    describe("renewal runs while a charge of the subscription is in flight", () => {
      it("refuses scheduled and forced runs of a scheduled or failed cycle while a dunning case of any active status is open, and runs it once the case closes", async () => {
        const container = getContainer()
        const charges = routeChargesToFixtures(container)
        const owned: { seeded: Awaited<ReturnType<typeof seedDueRenewal>>, caseId: string }[] = []

        for (const [index, status] of ACTIVE_DUNNING_STATUSES.entries()) {
          const failed = index % 2 === 1
          const seeded = await seedDueRenewal(container, {
            reference: `SUB-ASYNC-OWNED-${index}`,
            cycle_status: failed ? RenewalCycleStatus.FAILED : RenewalCycleStatus.SCHEDULED,
            attempt_count: failed ? 1 : 0,
          })
          const { id: caseId } = await createDunningCaseSeed(container, {
            subscription_id: seeded.subscription.id,
            renewal_cycle_id: seeded.cycle.id,
            status,
          })
          const before = await readRenewalState(container, seeded)
          const refusal = {
            type: MedusaError.Types.CONFLICT,
            message: renewalErrors.dunningOwnsCycle(seeded.cycle.id, caseId).message,
          }

          await expect(runRenewal(container, seeded.cycle.id)).rejects.toMatchObject(refusal)
          await expect(forceRenewal(container, seeded.cycle.id)).rejects.toMatchObject(refusal)
          expect(await readRenewalState(container, seeded)).toEqual(before)
          owned.push({ seeded, caseId })
        }

        expect(charges.orders).toEqual([])

        for (const [index, closed] of [DunningCaseStatus.RECOVERED, DunningCaseStatus.UNRECOVERED].entries()) {
          const { seeded, caseId } = owned[index]

          await dunning().updateDunningCases({ id: caseId, status: closed })
          await runRenewal(container, seeded.cycle.id)

          expect((await readRenewalState(container, seeded)).cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        }

        expect(charges.sessions).toHaveLength(2)
      })

      it("refuses scheduled and forced runs of a sibling cycle at the same date while the subscription's charge is parked", async () => {
        const container = getContainer()
        const parked = await seedAwaitingRenewal(container, { reference: "SUB-ASYNC-SIBLING", due_at: DUE_AT })
        const sibling = await createRenewalCycleSeed(container, {
          subscription_id: parked.subscription.id,
          scheduled_for: DUE_AT,
        })
        const refs = { subscription: parked.subscription, cycle: sibling }
        const before = await readRenewalState(container, refs)
        const refusal = {
          type: MedusaError.Types.CONFLICT,
          message: renewalErrors.alreadyProcessing(sibling.id).message,
        }

        await expect(runRenewal(container, sibling.id)).rejects.toMatchObject(refusal)
        await expect(forceRenewal(container, sibling.id)).rejects.toMatchObject(refusal)

        expect(await readRenewalState(container, refs)).toEqual(before)
        expect(before.otherCycles).toEqual([
          expect.objectContaining({ id: parked.cycle.id, status: RenewalCycleStatus.AWAITING_PAYMENT }),
        ])
        expect(parked.charges.sessions).toHaveLength(1)
      })
    })

    describe("a dunning retry whose charge the provider confirms later", () => {
      it("parks the case, counts it as awaiting, never charges it again, shows the customer a retry in progress and refuses a second case", async () => {
        const container = getContainer()
        const seeded = await seedDunningCase(container, {
          reference: "SUB-ASYNC-RETRY",
          status: DunningCaseStatus.RETRY_SCHEDULED,
        })
        const caseId = seeded.dunningCase.id
        const charges = routeChargesToFixtures(container)
        answerAuthorizationWithNull()
        const logs = watchLogs(container)
        const emitted = watchEvents(container)

        await processDunningRetriesJob(container)

        expect(await readDunningState(container, caseId)).toMatchObject({
          dunningCase: { status: DunningCaseStatus.AWAITING_PAYMENT, next_retry_at: null, attempt_count: 1 },
          attempts: [
            {
              attempt_no: 1,
              status: DunningAttemptStatus.PROCESSING,
              payment_reference: charges.sessions[0].id,
              finished_at: null,
            },
          ],
        })
        expect(Object.values(DunningEvents).flatMap(emitted)).toEqual([])
        expect(logs({ event: "dunning.job", outcome: "completed" })).toEqual([
          expect.objectContaining({
            processed_count: 1,
            failure_count: 0,
            metadata: expect.objectContaining({ awaiting_count: 1 }),
          }),
        ])

        await processDunningRetriesJob(container)

        expect(charges.sessions).toHaveLength(1)

        const store = { headers: await createStoreCustomerHeaders(container, seeded.subscription.customer_id) }
        const storeUrl = `/store/customers/me/subscriptions/${seeded.subscription.id}`
        const retryInProgress = {
          dunning_case_id: caseId,
          state: DunningCaseStatus.RETRYING,
          retry_eligible: false,
          retry_blocked_reason: RetryBlockedReason.RETRY_IN_PROGRESS,
        }

        const detail = await api.get(storeUrl, store)
        const list = await api.get("/store/customers/me/subscriptions", store)
        const retry = await api
          .post(`${storeUrl}/retry-payment`, {}, store)
          .catch((error: { response: unknown }) => error.response)

        expect(detail.data.subscription).toMatchObject({
          payment_status: "recovery_required",
          payment_recovery: retryInProgress,
        })
        expect(list.data.subscriptions).toEqual([
          expect.objectContaining({ payment_recovery: expect.objectContaining(retryInProgress) }),
        ])
        expect(retry).toMatchObject({
          status: 409,
          data: { type: MedusaError.Types.CONFLICT, blocked_reason: RetryBlockedReason.RETRY_IN_PROGRESS },
        })

        const laterCycle = await createRenewalCycleSeed(container, {
          subscription_id: seeded.subscription.id,
          status: RenewalCycleStatus.FAILED,
        })

        await expect(
          startDunningWorkflow(container).run({
            input: {
              subscription_id: seeded.subscription.id,
              renewal_cycle_id: laterCycle.id,
              payment_failure_source: "payment_provider",
              payment_error_code: "card_declined",
              payment_error_message: "Issuer declined the charge",
            },
          })
        ).rejects.toMatchObject({
          message: dunningErrors.duplicateActiveCaseBlocked(seeded.subscription.id, caseId).message,
        })
        expect(await dunning().listDunningCases({ subscription_id: seeded.subscription.id })).toEqual([
          expect.objectContaining({ id: caseId, status: DunningCaseStatus.AWAITING_PAYMENT }),
        ])
      })

      it.each([DunningCaseStatus.AWAITING_PAYMENT, DunningCaseStatus.RETRYING])(
        "refuses to mark a %s case recovered or unrecovered, writing nothing",
        async (status) => {
          const container = getContainer()
          const seeded = await seedDunningCase(container, { reference: "SUB-ASYNC-MARK", status })
          const caseId = seeded.dunningCase.id
          const before = await readDunningState(container, caseId)
          const emitted = watchEvents(container)

          for (const [action, body] of [
            ["mark-recovered", {}],
            ["mark-unrecovered", { reason: "customer unreachable" }],
          ] as const) {
            await expect(api.post(`/admin/dunning/${caseId}/${action}`, body, admin)).rejects.toMatchObject({
              response: { status: 409, data: { type: MedusaError.Types.CONFLICT } },
            })
          }

          expect(await readDunningState(container, caseId)).toEqual(before)
          expect([DunningEvents.RECOVERED, DunningEvents.PAYMENT_FAILED].flatMap(emitted)).toEqual([])
        }
      )
    })

    describe("a capture of a charge in flight", () => {
      it.each([
        { name: "once", deliveries: 1 },
        { name: "twice at once", deliveries: 2 },
      ])(
        "settles a parked renewal once, billing the next period from its due date, when its capture is delivered $name",
        async ({ deliveries }) => {
          const container = getContainer()
          const parked = await seedAwaitingRenewal(container, { reference: "SUB-ASYNC-SETTLE", due_at: DUE_AT })
          const capture = await captureOnOrder(container, parked.order_id, parked.session.id)
          const lockKey = `renewal:subscription:${parked.subscription.id}`
          const attemptWrites = jest.spyOn(renewals(), "updateRenewalAttempts")

          await atTime(SETTLED_AT.getTime(), async () => {
            const [delivered] = await whileLockHeld(container, lockKey, async () => {
              const queued = lockRequested(container, lockKey, deliveries)
              const pending = Promise.all(Array.from({ length: deliveries }, () => deliverCapture(container, capture.id)))

              await Promise.race([queued, pending])

              return [pending]
            })

            await delivered
          }, false)

          const state = await readRenewalState(container, parked)

          expect(state.cycle).toMatchObject({ status: RenewalCycleStatus.SUCCEEDED, processed_at: SETTLED_AT })
          expect(state.attempts).toEqual([
            expect.objectContaining({ id: parked.attempt.id, status: RenewalAttemptStatus.SUCCEEDED, finished_at: SETTLED_AT }),
          ])
          expect(attemptWrites.mock.calls.filter(([data]) => writes(data, "status", RenewalAttemptStatus.SUCCEEDED)))
            .toHaveLength(1)
          expect(state.subscription).toMatchObject({ next_renewal_at: oneMonthAfter(DUE_AT), last_renewal_at: SETTLED_AT })
          expect(state.succeededLogs).toHaveLength(1)
          expect(state.otherCycles).toEqual([
            expect.objectContaining({ status: RenewalCycleStatus.SCHEDULED, scheduled_for: oneMonthAfter(DUE_AT) }),
          ])
        }
      )

      it("recovers a parked dunning case from its capture, closing the retry's attempt and announcing the recovery once", async () => {
        const container = getContainer()
        const parked = await seedParkedDunningCase(container, "SUB-ASYNC-RECOVER")
        const capture = await captureOnOrder(container, parked.order.id, parked.session.id)
        const emitted = watchEvents(container)

        await deliverCapture(container, capture.id)

        expect(await readDunningState(container, parked.dunningCase.id)).toMatchObject({
          dunningCase: { status: DunningCaseStatus.RECOVERED, recovery_reason: "customer_payment", next_retry_at: null },
          attempts: [{ id: parked.attempt.id, status: DunningAttemptStatus.SUCCEEDED, finished_at: expect.any(Date) }],
          subscription: { status: SubscriptionStatus.ACTIVE },
          cycle: { status: RenewalCycleStatus.SUCCEEDED },
        })
        expect(emitted(DunningEvents.RECOVERED).map(({ data }) => data)).toEqual([
          expect.objectContaining({ dunning_case_id: parked.dunningCase.id }),
        ])
        expect(emitted(SubscriptionEvents.LATE_PAYMENT_CAPTURED)).toEqual([])
      })
    })

    describe("a failure reported for a charge in flight", () => {
      it.each([
        {
          kind: "renewal",
          event: DunningEvents.STARTED,
          seed: async (container: MedusaContainer) => {
            const parked = await seedAwaitingRenewal(container, { reference: "SUB-ASYNC-HALF-RENEWAL" })

            failOnce(renewals(), "updateRenewalCycles", (data) => writes(data, "status", RenewalCycleStatus.FAILED), WRITE_FAILURE)

            return { sessionId: parked.session.id, read: () => readRenewalState(container, parked) }
          },
          halfWritten: { cycle: { status: RenewalCycleStatus.AWAITING_PAYMENT }, cases: [] },
          completed: { cycle: { status: RenewalCycleStatus.FAILED }, cases: [{ status: DunningCaseStatus.RETRY_SCHEDULED }] },
        },
        {
          kind: "dunning",
          event: DunningEvents.ATTEMPT_FAILED,
          seed: async (container: MedusaContainer) => {
            const parked = await seedParkedDunningCase(container, "SUB-ASYNC-HALF-DUNNING", 2)
            const rescheduled = DunningCaseStatus.RETRY_SCHEDULED

            failOnce(dunning(), "updateDunningCases", (data) => writes(data, "status", rescheduled), WRITE_FAILURE)

            return { sessionId: parked.session.id, read: () => readDunningState(container, parked.dunningCase.id) }
          },
          halfWritten: { dunningCase: { status: DunningCaseStatus.AWAITING_PAYMENT, attempt_count: 2 } },
          completed: { dunningCase: { status: DunningCaseStatus.RETRY_SCHEDULED, attempt_count: 2 } },
        },
      ])(
        "applies a $kind failure once when it is delivered again after its first delivery stopped between the attempt and the parent write",
        async ({ seed, event, halfWritten, completed }) => {
          const container = getContainer()
          const { sessionId, read } = await seed(container)
          const emitted = watchEvents(container)
          const deliver = () => deliverFailure(container, sessionId, { reason: "insufficient_funds" })

          await expect(deliver()).rejects.toThrow(WRITE_FAILURE)

          expect(await read()).toMatchObject({ ...halfWritten, attempts: [{ status: RenewalAttemptStatus.FAILED }] })
          expect(emitted(event)).toEqual([])

          await deliver()

          const applied = await read()

          expect(applied).toMatchObject({ ...completed, attempts: [{ status: RenewalAttemptStatus.FAILED }] })
          expect(emitted(event)).toHaveLength(1)

          await deliver()

          expect(await read()).toEqual(applied)
          expect(emitted(event)).toHaveLength(1)
        }
      )

      it.each([
        {
          name: "a decline of the last allowed attempt closes it unrecovered",
          attempt_count: 3,
          dunningCase: { status: DunningCaseStatus.UNRECOVERED, next_retry_at: null, recovery_reason: "retry_limit_exhausted" },
          subscription: SubscriptionStatus.PAYMENT_FAILED,
          event: DunningEvents.PAYMENT_FAILED,
        },
      ])("applies to a parked dunning case $name, once however often it is delivered", async ({ attempt_count, dunningCase, subscription, event }) => {
        const container = getContainer()
        const parked = await seedParkedDunningCase(container, "SUB-ASYNC-DECLINE", attempt_count)
        const emitted = watchEvents(container)
        const deliver = () => deliverFailure(container, parked.session.id, { reason: "insufficient_funds" })

        await deliver()

        const applied = await readDunningState(container, parked.dunningCase.id)

        await deliver()

        expect(await readDunningState(container, parked.dunningCase.id)).toEqual(applied)
        expect(applied).toMatchObject({
          dunningCase: { ...dunningCase, attempt_count, last_payment_error_code: "insufficient_funds" },
          attempts: [{ id: parked.attempt.id, status: DunningAttemptStatus.FAILED, error_code: "insufficient_funds" }],
          subscription: { status: subscription },
        })

        const outcomes = [DunningEvents.ATTEMPT_FAILED, DunningEvents.PAYMENT_FAILED, DunningEvents.PARKED].flatMap(emitted)

        expect(outcomes.map(({ name }) => name)).toEqual([event])
      })

      it("applies a failure reported while the renewal run still holds its lock once the run has parked the charge and let go", async () => {
        const container = getContainer()
        const seeded = await seedDueRenewal(container, { reference: "SUB-ASYNC-EARLY-FAILURE" })
        const charges = routeChargesToFixtures(container)
        const lockKey = `renewal:subscription:${seeded.subscription.id}`
        const early: { delivered?: Promise<void>, duringRun?: Awaited<ReturnType<typeof readRenewalState>> } = {}

        answerAuthorizationWithNull().mockImplementationOnce(async () => {
          const queued = lockRequested(container, lockKey, 1)

          early.delivered = deliverFailure(container, charges.sessions[0].id, { reason: "card_declined" })
          await Promise.race([queued, early.delivered])
          early.duringRun = await readRenewalState(container, seeded)

          return { data: {}, status: PaymentSessionStatus.PENDING_AUTHORIZATION }
        })

        const result = await runRenewal(container, seeded.cycle.id)

        await early.delivered

        const state = await readRenewalState(container, seeded)

        expect(result.renewal_cycle).toMatchObject({ status: RenewalCycleStatus.AWAITING_PAYMENT })
        expect(early.duringRun).toMatchObject({ cycle: { status: RenewalCycleStatus.PROCESSING }, cases: [], failedLogs: [] })
        expect(state.cycle).toMatchObject({ status: RenewalCycleStatus.FAILED, last_error: expect.stringContaining("card_declined") })
        expect(state.attempts).toEqual([expect.objectContaining({ status: RenewalAttemptStatus.FAILED })])
        expect(state.cases).toEqual([
          expect.objectContaining({ renewal_cycle_id: seeded.cycle.id, last_payment_error_code: "card_declined" }),
        ])
        expect(state.failedLogs).toHaveLength(1)
      })
    })

    describe("a capture reaching a subscription that has ended", () => {
      const cancelByAdmin = (id: string) => api.post(`/admin/subscriptions/${id}/cancel`, { reason: "Fraud review" }, admin)
      const reportedLate = (payment_id: string, refs: Record<string, string>) => ({
        attempt: {
          error_code: "captured_after_close",
          metadata: expect.objectContaining({ late_payment_captured: { payment_id } }),
        },
        reported: [
          {
            ...refs,
            payment_id,
            reason: LatePaymentCapturedReason.SUBSCRIPTION_TERMINAL,
            refund_amount: RENEWAL_AMOUNT,
            currency_code: "pln",
          },
        ],
      })

      it.each([
        {
          name: "reports once for a refund the capture of a dunning charge whose case the customer's cancellation closed",
          alerts: 0,
          arrange: async (container: MedusaContainer) => {
            const { subscription, order, cycle, dunningCase, attempt, session } =
              await seedParkedDunningCase(container, "SUB-ASYNC-LATE-DUNNING")

            await cancelSubscriptionByCustomerWorkflow(container).run({
              input: { subscription_id: subscription.id, reason: "Cannot pay", triggered_by: subscription.customer_id },
            })

            const capture = await captureOnOrder(container, order.id, session.id)
            const refs = { subscription_id: subscription.id, order_id: order.id, renewal_cycle_id: cycle.id }

            return {
              capture,
              read: () => readDunningState(container, dunningCase.id),
              parent: { dunningCase: { status: DunningCaseStatus.UNRECOVERED } },
              ...reportedLate(capture.id, {
                ...refs,
                payment_collection_id: session.payment_collection_id,
                dunning_case_id: dunningCase.id,
                dunning_attempt_id: attempt.id,
              }),
            }
          },
        },
        {
          name: "reports once for a refund the capture of a renewal charge an admin cancellation left awaiting, and ends its cycle",
          alerts: 0,
          arrange: async (container: MedusaContainer) => {
            const parked = await seedAwaitingRenewal(container, { reference: "SUB-ASYNC-LATE-RENEWAL" })
            const { subscription, cycle, order_id, session } = parked

            await cancelByAdmin(subscription.id)

            const capture = await captureOnOrder(container, order_id, session.id)
            const ended = { status: RenewalCycleStatus.FAILED, last_error: expect.stringContaining(SubscriptionStatus.CANCELLED) }

            return {
              capture,
              read: () => readRenewalState(container, parked),
              parent: { cycle: ended },
              ...reportedLate(capture.id, {
                subscription_id: subscription.id,
                order_id,
                payment_collection_id: session.payment_collection_id,
                renewal_cycle_id: cycle.id,
              }),
            }
          },
        },
        {
          name: "never reports a capture its renewal run applied, redelivered after an admin cancellation",
          alerts: 2,
          arrange: async (container: MedusaContainer) => {
            const seeded = await seedDueRenewal(container, { reference: "SUB-ASYNC-APPLIED" })
            const charges = routeChargesToFixtures(container)

            await runRenewal(container, seeded.cycle.id)

            const [capture] = await payments().listPayments({ payment_session_id: charges.sessions[0].id })

            await deliverCapture(container, capture.id)
            await cancelByAdmin(seeded.subscription.id)

            return {
              capture,
              read: () => readRenewalState(container, seeded),
              parent: { cycle: { status: RenewalCycleStatus.SUCCEEDED } },
              attempt: { error_code: null },
              reported: [],
            }
          },
        },
      ])("$name, however often it is delivered", async ({ arrange, alerts }) => {
        const container = getContainer()
        const { capture, read, parent, attempt, reported } = await arrange(container)
        const emitted = watchEvents(container)
        const logs = watchLogs(container)

        await deliverCapture(container, capture.id)

        const state = await read()

        await deliverCapture(container, capture.id)

        expect(await read()).toEqual(state)
        expect(state).toMatchObject({ ...parent, attempts: [{ status: RenewalAttemptStatus.SUCCEEDED, ...attempt }] })
        expect(emitted(SubscriptionEvents.LATE_PAYMENT_CAPTURED).map(({ data }) => data)).toEqual(reported)
        expect(emitted(DunningEvents.RECOVERED)).toEqual([])
        expect(logs({ event: "payment_captured_on_terminal_subscription" })).toHaveLength(alerts)
      })
    })

    describe("the sweep of charges in flight", () => {
      type Watch = { logs: ReturnType<typeof watchLogs>, emitted: ReturnType<typeof watchEvents> }
      type SweepRow = { name: string, alerts?: string[], events?: string[], run: (container: MedusaContainer, watch: Watch) => Promise<void> }

      const swept = (checked: number, skipped = 0, failed = 0) => ({ checked, skipped, failed })
      const after = ({ started_at }: { started_at: Date | string }, ms: number) => new Date(started_at).getTime() + ms
      const payAnotherWay = async (container: MedusaContainer, orderId: string, { payment_collection_id }: { payment_collection_id: string }) =>
        await captureOnOrder(container, orderId, (await createSystemPaymentSession(container, { payment_collection_id })).id)
      const settled = ({ dueAt }: { dueAt: Date }, attempts: object[]) =>
        ({ cycle: { status: RenewalCycleStatus.SUCCEEDED }, attempts, subscription: { next_renewal_at: oneMonthAfter(dueAt) } })
      const recovered = (attempt: object) =>
        ({ dunningCase: { status: DunningCaseStatus.RECOVERED }, attempts: [attempt], cycle: { status: RenewalCycleStatus.SUCCEEDED } })

      async function sweep(at?: number) {
        const summaries = () => watchLogs(getContainer())({ event: "charge_sweep_completed" })
        const seen = summaries().length
        const run = () => reconcileInFlightChargesJob(getContainer())

        await (at === undefined ? run() : atTime(at, run))

        return summaries()[seen]
      }

      async function sweepRow({ run, alerts = [], events = [] }: SweepRow) {
        const container = getContainer()
        const watch = { logs: watchLogs(container), emitted: watchEvents(container) }

        await run(container, watch)

        expect(watch.logs({ alertable: true }).map(({ event }) => event)).toEqual(alerts)
        expect([DunningEvents.RECOVERED, SubscriptionEvents.LATE_PAYMENT_CAPTURED].flatMap(watch.emitted).map(({ name }) => name)).toEqual(events)
      }

      it.each<SweepRow>([
        {
          name: "settles the lost capture of a parked renewal whose session was never recorded, finding the session by its marker",
          run: async (container) => {
            failOnce(renewals(), "updateRenewalAttempts", (data) => writes(data, "payment_reference"), WRITE_FAILURE)
            const parked = await seedAwaitingRenewal(container, { reference: "SUB-SWEEP-UNRECORDED" })

            expect(parked.attempt.payment_reference).toBeNull()
            await captureOnOrder(container, parked.order_id, parked.session.id)
            expect(await sweep()).toMatchObject(swept(1))
            expect(await readRenewalState(container, parked)).toMatchObject(
              settled(parked, [{ id: parked.attempt.id, status: RenewalAttemptStatus.SUCCEEDED, payment_reference: null }])
            )
          },
        },
        {
          name: "leaves a renewal left processing on an order paid another way to its run for ten minutes, then settles it, keeping its attempt open",
          run: async (container) => {
            const parked = await seedAwaitingRenewal(container, { reference: "SUB-SWEEP-PROCESSING" })
            const read = () => readRenewalState(container, parked)

            await renewals().updateRenewalCycles({ id: parked.cycle.id, status: RenewalCycleStatus.PROCESSING })
            await payAnotherWay(container, parked.order_id, parked.session)
            const before = await read()

            expect(await sweep(after(parked.attempt, 9 * MINUTE_MS))).toMatchObject(swept(0))
            expect(await read()).toEqual(before)
            expect(await sweep(after(parked.attempt, 11 * MINUTE_MS))).toMatchObject(swept(1))
            expect(await read()).toMatchObject(settled(parked, [
              { id: parked.attempt.id, status: RenewalAttemptStatus.PROCESSING },
              { status: RenewalAttemptStatus.SUCCEEDED, metadata: { source: "customer_payment" } },
            ]))
          },
        },
        {
          name: "ends a parked renewal of a subscription that failed payment, then reports its lost capture once for a refund",
          events: [SubscriptionEvents.LATE_PAYMENT_CAPTURED],
          run: async (container, { emitted }) => {
            const parked = await seedAwaitingRenewal(container, { reference: "SUB-SWEEP-ENDED" })
            const read = () => readRenewalState(container, parked)

            await subscriptions().updateSubscriptions({ id: parked.subscription.id, status: SubscriptionStatus.PAYMENT_FAILED })

            expect(await sweep()).toMatchObject(swept(1))
            expect(await read()).toMatchObject({
              cycle: { status: RenewalCycleStatus.FAILED, last_error: expect.stringContaining(SubscriptionStatus.PAYMENT_FAILED) },
              attempts: [{ status: RenewalAttemptStatus.PROCESSING }],
            })

            const capture = await captureOnOrder(container, parked.order_id, parked.session.id)

            expect(await sweep(after(parked.attempt, 11 * MINUTE_MS))).toMatchObject(swept(1))
            expect(emitted(SubscriptionEvents.LATE_PAYMENT_CAPTURED).map(({ data }) => data)).toEqual([
              expect.objectContaining({ payment_id: capture.id, renewal_cycle_id: parked.cycle.id, refund_amount: RENEWAL_AMOUNT }),
            ])
            await deliverCapture(container, capture.id)
            expect((await read()).attempts).toMatchObject([{ status: RenewalAttemptStatus.SUCCEEDED, error_code: "captured_after_close" }])
          },
        },
        {
          name: "raises one overdue alert for a parked renewal still unpaid past the hours the environment sets",
          alerts: ["charge_awaiting_payment_overdue"],
          run: async (container) => {
            const parked = await seedAwaitingRenewal(container, { reference: "SUB-SWEEP-OVERDUE" })
            const env = process.env

            process.env = { ...env, RENEWAL_AWAITING_PAYMENT_ALERT_HOURS: "2" }
            try {
              expect(await sweep(after(parked.attempt, 3 * HOUR_MS))).toMatchObject(swept(1))
              expect(await sweep(after(parked.attempt, 4 * HOUR_MS))).toMatchObject(swept(1))
            } finally {
              process.env = env
            }

            expect(await readRenewalState(container, parked)).toMatchObject({
              cycle: { status: RenewalCycleStatus.AWAITING_PAYMENT },
              attempts: [{ status: RenewalAttemptStatus.PROCESSING, metadata: { overdue_alerted_at: expect.any(String) } }],
            })
          },
        },
        {
          name: "skips without an alert a parked renewal whose lock is held, and settles its lost capture once the lock is free",
          run: async (container) => {
            const parked = await seedAwaitingRenewal(container, { reference: "SUB-SWEEP-HELD" })
            const read = () => readRenewalState(container, parked)

            await captureOnOrder(container, parked.order_id, parked.session.id)
            const before = await read()

            expect(await whileLockHeld(container, `renewal:subscription:${parked.subscription.id}`, sweep)).toMatchObject(swept(1, 1))
            expect(await read()).toEqual(before)
            expect(await sweep()).toMatchObject(swept(1))
            expect(await read()).toMatchObject(settled(parked, [{ id: parked.attempt.id, status: RenewalAttemptStatus.SUCCEEDED }]))
          },
        },
        {
          name: "fails a parked renewal whose reported failure reached only its attempt, into one dunning case",
          alerts: ["charge_reconcile_failed", "renewal.execution"],
          run: async (container) => {
            const parked = await seedAwaitingRenewal(container, { reference: "SUB-SWEEP-HALF-FAILED" })

            failOnce(renewals(), "updateRenewalCycles", (data) => writes(data, "status", RenewalCycleStatus.FAILED), WRITE_FAILURE)
            await expect(deliverFailure(container, parked.session.id, { reason: "insufficient_funds" })).rejects.toThrow(WRITE_FAILURE)
            expect(await sweep()).toMatchObject(swept(1))
            expect(await readRenewalState(container, parked)).toMatchObject({
              cycle: { status: RenewalCycleStatus.FAILED },
              attempts: [{ id: parked.attempt.id, status: RenewalAttemptStatus.FAILED }],
              cases: [{ renewal_order_id: parked.order_id, status: DunningCaseStatus.RETRY_SCHEDULED }],
            })
          },
        },
        {
          name: "keeps sweeping past a renewal it cannot read, with one alert for it",
          alerts: ["charge_reconcile_failed"],
          events: [DunningEvents.RECOVERED],
          run: async (container, { logs }) => {
            const unreadable = await seedAwaitingRenewal(container, { reference: "SUB-SWEEP-UNREADABLE" })
            const readable = await seedParkedDunningCase(container, "SUB-SWEEP-READABLE")

            await captureOnOrder(container, readable.order.id, readable.session.id)
            failOnce(renewals(), "retrieveRenewalAttempt", (id) => id === unreadable.attempt.id, READ_FAILURE)

            expect(await sweep()).toMatchObject(swept(2, 0, 1))
            expect(logs({ event: "charge_reconcile_failed" })).toMatchObject([{ attempt_id: unreadable.attempt.id, message: READ_FAILURE }])
            expect(await readDunningState(container, readable.dunningCase.id)).toMatchObject(
              recovered({ id: readable.attempt.id, status: DunningAttemptStatus.SUCCEEDED })
            )
          },
        },
      ])("$name", sweepRow)

      it.each<SweepRow>([
        {
          name: "recovers a retrying case whose charge was captured without its event, once the retry is ten minutes old",
          events: [DunningEvents.RECOVERED],
          run: async (container) => {
            const seeded = await seedParkedDunningCase(container, "SUB-SWEEP-RETRYING", 1, DunningCaseStatus.RETRYING)
            const read = () => readDunningState(container, seeded.dunningCase.id)

            await captureOnOrder(container, seeded.order.id, seeded.session.id)
            expect(await sweep(after(seeded.attempt, 9 * MINUTE_MS))).toMatchObject(swept(0))
            expect((await read()).dunningCase.status).toEqual(DunningCaseStatus.RETRYING)
            expect(await sweep(after(seeded.attempt, 11 * MINUTE_MS))).toMatchObject(swept(1))
            expect(await read()).toMatchObject(recovered({ id: seeded.attempt.id, status: DunningAttemptStatus.SUCCEEDED }))
          },
        },
        {
          name: "recovers an awaiting case whose order was paid another way, keeping its attempt open",
          events: [DunningEvents.RECOVERED],
          run: async (container) => {
            const seeded = await seedParkedDunningCase(container, "SUB-SWEEP-PAID-ELSEWHERE")

            await payAnotherWay(container, seeded.order.id, seeded.session)
            expect(await sweep()).toMatchObject(swept(1))
            expect(await readDunningState(container, seeded.dunningCase.id)).toMatchObject(
              recovered({ id: seeded.attempt.id, status: DunningAttemptStatus.PROCESSING })
            )
          },
        },
        {
          name: "closes an awaiting case of a cancelled subscription, keeping its charge in flight",
          run: async (container) => {
            const seeded = await seedParkedDunningCase(container, "SUB-SWEEP-CANCELLED")

            await subscriptions().updateSubscriptions({ id: seeded.subscription.id, status: SubscriptionStatus.CANCELLED })
            expect(await sweep()).toMatchObject(swept(1))
            expect(await readDunningState(container, seeded.dunningCase.id)).toMatchObject({
              dunningCase: { status: DunningCaseStatus.UNRECOVERED, closed_at: expect.any(Date) },
              attempts: [{ id: seeded.attempt.id, status: DunningAttemptStatus.PROCESSING }],
            })
          },
        },
        {
          name: "fails as unanswered the charge of a closed case once it is past the alert hours",
          run: async (container) => {
            const { subscription, dunningCase, attempt } = await seedParkedDunningCase(container, "SUB-SWEEP-CLOSED")
            const read = () => readDunningState(container, dunningCase.id)

            await cancelSubscriptionByCustomerWorkflow(container).run({
              input: { subscription_id: subscription.id, reason: "Cannot pay", triggered_by: subscription.customer_id },
            })
            expect(await sweep(after(attempt, 11 * MINUTE_MS))).toMatchObject(swept(1))
            expect(await read()).toMatchObject({ dunningCase: { status: DunningCaseStatus.UNRECOVERED }, attempts: [{ status: DunningAttemptStatus.PROCESSING }] })
            expect(await sweep(after(attempt, 97 * HOUR_MS))).toMatchObject(swept(1))
            expect((await read()).attempts).toMatchObject([{ id: attempt.id, status: DunningAttemptStatus.FAILED, error_code: "no_payment_signal" }])
          },
        },
      ])("$name", sweepRow)
    })

    describe("pause, resume and the pause offer while a charge is in flight", () => {
      type GuardedCall = { id: string, store: { headers: Record<string, string> }, offerCaseId: string }
      const storeUrl = "/store/customers/me/subscriptions"
      const pauseOffer = {
        offer_type: RetentionOfferType.PAUSE_OFFER,
        offer_payload: { pause_offer: { pause_cycles: 1, resume_at: null, note: null } },
      }
      const calls = {
        "an admin pause": ({ id }: GuardedCall) => api.post(`/admin/subscriptions/${id}/pause`, {}, admin),
        "a store pause": ({ id, store }: GuardedCall) => api.post(`${storeUrl}/${id}/pause`, {}, store),
        "a pause offer": ({ offerCaseId }: GuardedCall) =>
          api.post(`/admin/cancellations/${offerCaseId}/apply-offer`, pauseOffer, admin),
        "an admin resume with a date": ({ id }: GuardedCall) =>
          api.post(`/admin/subscriptions/${id}/resume`, { resume_at: RESUME_AT.toISOString() }, admin),
        "a store resume": ({ id, store }: GuardedCall) => api.post(`${storeUrl}/${id}/resume`, {}, store),
      }
      const adminRefusal = { type: MedusaError.Types.CONFLICT }
      const storeRefusal = { ...adminRefusal, code: RENEWAL_PAYMENT_IN_PROGRESS }

      it.each([
        { call: "an admin pause", charge: "dunning", paused: false, refusal: adminRefusal },
        { call: "a store pause", charge: "renewal", paused: false, refusal: storeRefusal },
        { call: "a pause offer", charge: "renewal", paused: false, refusal: adminRefusal },
        { call: "an admin resume with a date", charge: "renewal", paused: true, refusal: adminRefusal },
        { call: "a store resume", charge: "renewal", paused: true, refusal: storeRefusal },
      ] as const)(
        "refuses $call while a $charge charge is in flight, writing nothing, and allows it once the charge settled",
        async ({ call, charge, paused, refusal }) => {
          const container = getContainer()
          const parked = charge === "dunning"
            ? await seedParkedDunningCase(container, "SUB-ASYNC-GUARD").then((seeded) => ({ ...seeded, order_id: seeded.order.id }))
            : await seedAwaitingRenewal(container, { reference: "SUB-ASYNC-GUARD" })
          const id = parked.subscription.id

          if (paused) {
            await subscriptions().updateSubscriptions({ id, status: SubscriptionStatus.PAUSED, paused_at: new Date() })
          }

          const offerCase = await createCancellationCaseSeed(container, {
            subscription_id: id,
            status: CancellationCaseStatus.EVALUATING_RETENTION,
          })
          const store = { headers: await createStoreCustomerHeaders(container, parked.subscription.customer_id) }
          const request = () => calls[call]({ id, store, offerCaseId: offerCase.id })
          const written = async () => ({
            subscription: await subscriptions().retrieveSubscription(id),
            cycles: await renewals().listRenewalCycles({ subscription_id: id }, { order: { id: "ASC" } }),
            cancellation: await cancellations().retrieveCancellationCase(offerCase.id, { relations: ["offer_events"] }),
          })
          const before = await written()

          await expect(request()).rejects.toMatchObject({ response: { status: 409, data: refusal } })
          expect(await written()).toEqual(before)

          await deliverCapture(container, (await captureOnOrder(container, parked.order_id, parked.session.id)).id)

          expect((await request()).status).toEqual(200)
          expect((await subscriptions().retrieveSubscription(id)).status).toEqual(
            paused ? SubscriptionStatus.ACTIVE : SubscriptionStatus.PAUSED
          )
        }
      )
    })
  },
})
