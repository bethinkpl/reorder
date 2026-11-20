import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import { MedusaError } from "@medusajs/framework/utils"
import { createStep, createWorkflow, type WorkflowData, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { DateTime } from "luxon"
import processRenewalCyclesJob from "../../src/jobs/process-renewal-cycles"
import { reconcileAwaitingRenewalCycles } from "../../src/jobs/reconcile-awaiting-renewal-cycles"
import { ACTIVITY_LOG_MODULE } from "../../src/modules/activity-log"
import type ActivityLogModuleService from "../../src/modules/activity-log/service"
import { ActivityLogActorType, ActivityLogEventType } from "../../src/modules/activity-log/types"
import { CANCELLATION_MODULE } from "../../src/modules/cancellation"
import type CancellationModuleService from "../../src/modules/cancellation/service"
import { CancellationCaseStatus } from "../../src/modules/cancellation/types"
import { DunningEvents } from "../../src/modules/dunning/events"
import { DunningCaseStatus } from "../../src/modules/dunning/types"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import { RenewalAttemptStatus, RenewalCycleStatus } from "../../src/modules/renewal/types"
import {
  AWAITING_PAYMENT_ALERT_HOURS_ENV,
  AWAITING_PAYMENT_OVERDUE_EVENT,
  AWAITING_PAYMENT_RESOLVE_MIN_HOURS_ENV,
  DEFAULT_AWAITING_PAYMENT_RESOLVE_MIN_HOURS,
} from "../../src/modules/renewal/utils/awaiting-payment-age"
import { renewalErrors } from "../../src/modules/renewal/utils/errors"
import { renewalSubscriptionLockKey } from "../../src/modules/renewal/utils/lock-key"
import {
  LatePaymentCapturedReason,
  SubscriptionEvents,
} from "../../src/modules/subscription/events"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import {
  cancelSubscriptionByCustomerWorkflow,
  cancelSubscriptionWorkflow,
  finalizeCancellationWorkflow,
  forceRenewalCycleWorkflow,
  processRenewalCycleWorkflow,
} from "../../src/workflows"
import {
  AWAITING_ORDER_TOTAL,
  type RenewalRefs,
  readRenewalState,
  seedAwaitingRenewal,
  whileRenewalLockHeld,
} from "../helpers/awaiting-renewal-fixtures"
import { createCancellationCaseSeed } from "../helpers/cancellation-fixtures"
import { createDunningCaseSeed } from "../helpers/dunning-fixtures"
import { captureOnOrder, deliverCapture, deliverFailure } from "../helpers/payment-fixtures"
import { answerAuthorizationWithNull, createRenewalChargeStub } from "../helpers/renewal-charge-fixtures"
import {
  createAdminAuthHeaders,
  createRenewalAttemptSeed,
  createRenewalCycleSeed,
  createSubscriptionSeed,
} from "../helpers/renewal-fixtures"
import { atTime, watchEvents, watchLogs } from "../helpers/spy-fixtures"
import { createStoreCustomerHeaders } from "../helpers/subscription-fixtures"
import {
  CAPTURED_AFTER_CLOSE_ERROR_CODE,
  NO_PAYMENT_SIGNAL_ERROR_CODE,
} from "../../src/workflows/utils/late-payment-capture"

jest.setTimeout(120 * 1000)

const HOUR_MS = 60 * 60 * 1000
const LATER_STEP_FAILURE = { message: "a later step failed after the cancellation" }

const mockCreateOrderRun = jest.fn()
const mockCreateOrUpdateOrderPaymentCollectionRun = jest.fn()
const mockCreatePaymentSessionsRun = jest.fn()

jest.mock("@medusajs/medusa/core-flows", () => ({
  ...jest.requireActual("@medusajs/medusa/core-flows"),
  createOrderWorkflow: () => ({ run: mockCreateOrderRun }),
  createOrUpdateOrderPaymentCollectionWorkflow: () => ({ run: mockCreateOrUpdateOrderPaymentCollectionRun }),
  createPaymentSessionsWorkflow: () => ({ run: mockCreatePaymentSessionsRun }),
}))

const stubRenewalCharge = createRenewalChargeStub({
  createOrderRun: mockCreateOrderRun,
  createOrUpdateOrderPaymentCollectionRun: mockCreateOrUpdateOrderPaymentCollectionRun,
  createPaymentSessionsRun: mockCreatePaymentSessionsRun,
})

type CancellationInput = Record<
  "id" | "subscription_id" | "cancellation_case_id" | "renewal_cycle_id" | "reason",
  string
>

let cycleStatusWhenLaterStepRan: RenewalCycleStatus | null = null

const failingStep = createStep(
  "awaiting-lifecycle-failing-step",
  async function (input: { renewal_cycle_id: string }, { container }) {
    const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)

    cycleStatusWhenLaterStepRan = (await renewalModule.retrieveRenewalCycle(input.renewal_cycle_id)).status

    throw new Error(LATER_STEP_FAILURE.message)
  }
)

function failingAfter(name: string, run: (input: CancellationInput) => WorkflowData) {
  return createWorkflow(`awaiting-lifecycle-${name}-then-fail`, function (input: CancellationInput) {
    run(input)
    failingStep(input)

    return new WorkflowResponse(undefined)
  })
}

const STEPS_THEN_FAIL = [
  {
    name: "cancel-subscription",
    workflow: failingAfter("cancel", (input) => cancelSubscriptionWorkflow.runAsStep({ input })),
  },
  {
    name: "finalize-cancellation",
    workflow: failingAfter("finalize", (input) => finalizeCancellationWorkflow.runAsStep({ input })),
  },
]

function asStep(name: string, run: (input: CancellationInput) => WorkflowData) {
  return createWorkflow(`awaiting-lifecycle-${name}-as-step`, function (input: CancellationInput) {
    return new WorkflowResponse(run(input))
  })
}

const cancelAsStep = asStep("cancel", (input) => cancelSubscriptionWorkflow.runAsStep({ input }))
const finalizeAsStep = asStep("finalize", (input) => finalizeCancellationWorkflow.runAsStep({ input }))
const customerCancelAsStep = asStep("customer-cancel", (input) =>
  cancelSubscriptionByCustomerWorkflow.runAsStep({ input })
)

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: { JWT_SECRET: "supersecret", COOKIE_SECRET: "supersecret" },
  testSuite: ({ api, getContainer }) => {
    let emitted: ReturnType<typeof watchEvents>

    beforeEach(() => {
      emitted = watchEvents(getContainer())
    })

    afterEach(() => {
      jest.restoreAllMocks()
      jest.clearAllMocks()
      delete process.env[AWAITING_PAYMENT_ALERT_HOURS_ENV]
      delete process.env[AWAITING_PAYMENT_RESOLVE_MIN_HOURS_ENV]
    })

    async function seedFailedCycle(reference: string, caseStatus?: DunningCaseStatus) {
      const container = getContainer()
      const dueAt = new Date(Date.now() - HOUR_MS)
      const subscription = await createSubscriptionSeed(container, { reference, next_renewal_at: dueAt })
      const cycle = await createRenewalCycleSeed(container, {
        subscription_id: subscription.id,
        scheduled_for: dueAt,
        status: RenewalCycleStatus.FAILED,
        attempt_count: 1,
        last_error: "card declined",
      })

      await createRenewalAttemptSeed(container, {
        renewal_cycle_id: cycle.id,
        status: RenewalAttemptStatus.FAILED,
      })

      if (caseStatus) {
        await createDunningCaseSeed(container, {
          subscription_id: subscription.id,
          renewal_cycle_id: cycle.id,
          renewal_order_id: `ord_${reference}`,
          status: caseStatus,
        })
      }

      return { subscription, cycle }
    }

    async function cancellationInputFor({ subscription, cycle }: RenewalRefs): Promise<CancellationInput> {
      const cancellationCase = await createCancellationCaseSeed(getContainer(), {
        subscription_id: subscription.id,
        reason: "customer left",
      })

      return {
        id: subscription.id,
        subscription_id: subscription.id,
        cancellation_case_id: cancellationCase.id,
        renewal_cycle_id: cycle.id,
        reason: "customer left",
      }
    }

    async function sweepAt(offsetMs: number) {
      await atTime(Date.now() + offsetMs, () => reconcileAwaitingRenewalCycles(getContainer()))
    }

    describe("cancelling a subscription whose renewal awaits payment", () => {
      it.each([
        { name: "cancellation", finalize: false },
        { name: "finalised cancellation", finalize: true },
      ])(
        "refuses an admin $name with a conflict and writes nothing while a renewal holds the lock, then ends the cycle without dunning, keeps its charge in flight, and reports a capture that arrives afterwards once for a refund",
        async ({ finalize }) => {
          const container = getContainer()
          const headers = await createAdminAuthHeaders(container)
          const seeded = await seedAwaitingRenewal(container, { reference: `SUB-AWL-CANCEL-${finalize}` })
          const input = await cancellationInputFor(seeded)
          const cancel = () =>
            finalize
              ? api.post(`/admin/cancellations/${input.cancellation_case_id}/finalize`, {}, { headers })
              : api.post(`/admin/subscriptions/${input.id}/cancel`, { reason: input.reason }, { headers })
          const before = await readRenewalState(container, seeded)

          const refusal = (await whileRenewalLockHeld(container, input.id, () => cancel().catch((error: unknown) => error))) as {
            response?: unknown
          }

          expect(refusal.response).toMatchObject({
            status: 409,
            data: { type: "conflict", message: expect.stringMatching(/being updated by a renewal or a payment/) },
          })
          expect(await readRenewalState(container, seeded)).toEqual(before)

          const response = await cancel()
          const cancelled = await readRenewalState(container, seeded)

          expect(response.status).toEqual(200)
          expect(cancelled).toMatchObject({
            subscription: { status: SubscriptionStatus.CANCELLED, next_renewal_at: null },
            cycle: {
              status: RenewalCycleStatus.FAILED,
              last_error: expect.stringMatching(/cancel/i),
              generated_order_id: seeded.order.id,
            },
            attempts: [
              { id: seeded.attempt.id, status: RenewalAttemptStatus.PROCESSING, finished_at: null },
            ],
          })
          expect(cancelled.failedLogs).toHaveLength(1)
          expect(cancelled.succeededLogs).toHaveLength(0)
          expect(cancelled.cases).toHaveLength(0)

          const payment = await captureOnOrder(container, seeded.order.id, seeded.session.id)
          await deliverCapture(container, payment.id)
          await deliverCapture(container, payment.id)

          expect(await readRenewalState(container, seeded)).toEqual({
            ...cancelled,
            attempts: [
              {
                ...cancelled.attempts[0],
                status: RenewalAttemptStatus.SUCCEEDED,
                error_code: CAPTURED_AFTER_CLOSE_ERROR_CODE,
                error_message: expect.stringContaining(payment.id),
                finished_at: expect.any(Date),
                updated_at: expect.any(Date),
                metadata: {
                  late_payment_captured: expect.objectContaining({
                    payment_id: payment.id,
                    reason: LatePaymentCapturedReason.SUBSCRIPTION_TERMINAL,
                  }),
                },
              },
            ],
          })
          expect(emitted(SubscriptionEvents.LATE_PAYMENT_CAPTURED).map((message) => message.data)).toEqual([
            {
              subscription_id: seeded.subscription.id,
              payment_id: payment.id,
              order_id: seeded.order.id,
              payment_collection_id: seeded.session.payment_collection_id,
              renewal_cycle_id: seeded.cycle.id,
              reason: LatePaymentCapturedReason.SUBSCRIPTION_TERMINAL,
              refund_amount: AWAITING_ORDER_TOTAL,
              currency_code: "pln",
            },
          ])
          expect(emitted(DunningEvents.STARTED)).toHaveLength(0)
        }
      )

      it("closes the in-flight attempt as failed, with no dunning and no event, when the charge of a renewal the customer cancelled fails afterwards", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, { reference: "SUB-AWL-CUSTOMER-LATE-FAIL" })

        await cancelSubscriptionByCustomerWorkflow(container).run({
          input: { subscription_id: seeded.subscription.id, reason: "moving abroad" },
        })

        const cancelled = await readRenewalState(container, seeded)

        await deliverFailure(container, seeded.session.id, { reason: "insufficient_funds" })
        await deliverFailure(container, seeded.session.id, { reason: "insufficient_funds" })

        const after = await readRenewalState(container, seeded)

        expect(cancelled.attempts).toEqual([
          expect.objectContaining({ id: seeded.attempt.id, status: RenewalAttemptStatus.PROCESSING }),
        ])
        expect(after).toEqual({
          ...cancelled,
          attempts: [
            {
              ...cancelled.attempts[0],
              status: RenewalAttemptStatus.FAILED,
              error_code: "insufficient_funds",
              error_message: expect.stringMatching(/after the renewal had closed/),
              finished_at: expect.any(Date),
              updated_at: expect.any(Date),
            },
          ],
        })
        expect(after.subscription.status).toEqual(SubscriptionStatus.CANCELLED)
        expect(after.cases).toHaveLength(0)
        expect(emitted(DunningEvents.STARTED)).toHaveLength(0)
        expect(emitted(SubscriptionEvents.LATE_PAYMENT_CAPTURED)).toHaveLength(0)
      })

      it.each(STEPS_THEN_FAIL)(
        "the $name workflow restores the awaiting cycle and attempt when a later step fails",
        async ({ name, workflow }) => {
          const container = getContainer()
          const seeded = await seedAwaitingRenewal(container, { reference: `SUB-AWL-ROLLBACK-${name}` })
          const input = await cancellationInputFor(seeded)
          const before = await readRenewalState(container, seeded)

          cycleStatusWhenLaterStepRan = null

          await expect(workflow(container).run({ input })).rejects.toMatchObject(LATER_STEP_FAILURE)

          const after = await readRenewalState(container, seeded)

          expect(cycleStatusWhenLaterStepRan).toEqual(RenewalCycleStatus.FAILED)
          expect(before.cycle.status).toEqual(RenewalCycleStatus.AWAITING_PAYMENT)
          expect(after.subscription.status).toEqual(SubscriptionStatus.ACTIVE)
          expect(after.cycle).toEqual({ ...before.cycle, updated_at: expect.any(Date) })
          expect(after.attempts).toEqual([{ ...before.attempts[0], updated_at: expect.any(Date) }])
          expect(after.cases).toHaveLength(0)
          expect(after.failedLogs).toHaveLength(0)
        }
      )

      it("leaves an earlier failed cycle as it was when either step is rolled back and when the cancellation succeeds", async () => {
        const container = getContainer()
        const failed = await seedFailedCycle("SUB-AWL-NOOP")
        const input = await cancellationInputFor(failed)
        const before = await readRenewalState(container, failed)

        for (const { workflow } of STEPS_THEN_FAIL) {
          await expect(workflow(container).run({ input })).rejects.toMatchObject(LATER_STEP_FAILURE)

          const afterRollback = await readRenewalState(container, failed)

          expect(afterRollback.cycle).toEqual(before.cycle)
          expect(afterRollback.attempts).toEqual(before.attempts)
        }

        await cancelSubscriptionWorkflow(container).run({ input: { id: input.id } })

        const afterCancel = await readRenewalState(container, failed)

        expect(afterCancel.cycle).toEqual(before.cycle)
        expect(afterCancel.attempts).toEqual(before.attempts)
        expect(afterCancel.failedLogs).toHaveLength(0)
      })

      it("answers a customer's cancellation with a readable conflict while a renewal holds the lock, writing nothing", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, { reference: "SUB-AWL-STORE-LOCKED" })
        const headers = await createStoreCustomerHeaders(container, seeded.subscription.customer_id)
        const before = await readRenewalState(container, seeded)

        const refusal = await whileRenewalLockHeld(container, seeded.subscription.id, () =>
          api
            .post(
              `/store/customers/me/subscriptions/${seeded.subscription.id}/cancellation`,
              { reason: "too expensive" },
              { headers }
            )
            .catch((error: { response?: unknown }) => error.response)
        )

        expect(refusal).toMatchObject({
          status: 409,
          data: { type: "conflict", message: expect.stringMatching(/already being updated/) },
        })
        expect(await readRenewalState(container, seeded)).toEqual(before)
      })

      describe("when a write inside the cancellation fails", () => {
        const RENEWAL_LOG_FAILURE = { message: "the renewal log could not be written" }
        const CASE_WRITE_FAILURE = { message: "the cancellation case could not be written" }

        function failRenewalLogOnce() {
          const activityLog = getContainer().resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)
          const create = activityLog.createSubscriptionLogs.bind(activityLog)
          let failed = false

          jest.spyOn(activityLog, "createSubscriptionLogs").mockImplementation(((data: { event_type?: string }) => {
            if (!failed && data?.event_type === ActivityLogEventType.RENEWAL_FAILED) {
              failed = true

              return Promise.reject(new Error(RENEWAL_LOG_FAILURE.message))
            }

            return create(data as never)
          }) as never)

          return RENEWAL_LOG_FAILURE
        }

        function failCaseFinalizeOnce() {
          const cancellationModule = getContainer().resolve<CancellationModuleService>(CANCELLATION_MODULE)
          const update = cancellationModule.updateCancellationCases.bind(cancellationModule)
          let failed = false

          jest.spyOn(cancellationModule, "updateCancellationCases").mockImplementation(((data: { status?: string }) => {
            if (!failed && data?.status === CancellationCaseStatus.CANCELED) {
              failed = true

              return Promise.reject(new Error(CASE_WRITE_FAILURE.message))
            }

            return update(data as never)
          }) as never)

          return CASE_WRITE_FAILURE
        }

        const cancelBy = {
          admin: (input: CancellationInput) =>
            cancelSubscriptionWorkflow(getContainer()).run({ input: { id: input.id, reason: input.reason } }),
          finalize: (input: CancellationInput) =>
            finalizeCancellationWorkflow(getContainer()).run({
              input: { cancellation_case_id: input.cancellation_case_id },
            }),
          customer: (input: CancellationInput) =>
            cancelSubscriptionByCustomerWorkflow(getContainer()).run({
              input: { subscription_id: input.subscription_id, reason: input.reason },
            }),
        }

        async function cancellationLogs(subscriptionId: string) {
          const activityLog = getContainer().resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)

          return await activityLog.listSubscriptionLogs({
            subscription_id: subscriptionId,
            event_type: [
              ActivityLogEventType.SUBSCRIPTION_CANCELED,
              ActivityLogEventType.CANCELLATION_CASE_STARTED,
              ActivityLogEventType.CANCELLATION_FINALIZED,
            ],
          })
        }

        it.each([
          { flow: "admin" as const, fails: "the ended cycle's renewal log", inject: failRenewalLogOnce },
          { flow: "finalize" as const, fails: "the ended cycle's renewal log", inject: failRenewalLogOnce },
          { flow: "finalize" as const, fails: "the cancellation case", inject: failCaseFinalizeOnce },
          { flow: "customer" as const, fails: "the ended cycle's renewal log", inject: failRenewalLogOnce },
          { flow: "customer" as const, fails: "the cancellation case", inject: failCaseFinalizeOnce },
        ])(
          "leaves nothing changed when the $flow cancellation fails writing $fails, and a second attempt cancels",
          async ({ flow, fails, inject }) => {
            const container = getContainer()
            const seeded = await seedAwaitingRenewal(container, {
              reference: `SUB-AWL-INSIDE-${flow}-${fails.length}`,
            })
            const input = await cancellationInputFor(seeded)
            const before = await readRenewalState(container, seeded)
            const failure = inject()

            await expect(cancelBy[flow](input)).rejects.toMatchObject(failure)

            const after = await readRenewalState(container, seeded)

            expect(after.subscription).toEqual({ ...before.subscription, updated_at: expect.any(Date) })
            expect(after.cycle).toEqual({ ...before.cycle, updated_at: expect.any(Date) })
            expect(after.attempts).toEqual([{ ...before.attempts[0], updated_at: expect.any(Date) }])
            expect(after.failedLogs).toHaveLength(0)
            expect(await cancellationLogs(seeded.subscription.id)).toEqual([])

            await cancelBy[flow](input)

            const cancelled = await readRenewalState(container, seeded)

            expect(cancelled.subscription.status).toEqual(SubscriptionStatus.CANCELLED)
            expect(cancelled.cycle.status).toEqual(RenewalCycleStatus.FAILED)
            expect(cancelled.failedLogs).toHaveLength(1)
          }
        )
      })

      it.each([
        { name: "admin cancellation", nested: cancelAsStep },
        { name: "finalised cancellation", nested: finalizeAsStep },
        { name: "customer cancellation", nested: customerCancelAsStep },
      ])(
        "takes the renewal lock when the $name runs as a step of another workflow, writing nothing while a renewal holds it",
        async ({ name, nested }) => {
          const container = getContainer()
          const seeded = await seedAwaitingRenewal(container, { reference: `SUB-AWL-NESTED-${name}` })
          const input = await cancellationInputFor(seeded)
          const before = await readRenewalState(container, seeded)

          const refusal = await whileRenewalLockHeld(container, input.id, () =>
            nested(container).run({ input }).catch((error: unknown) => error)
          )

          expect(refusal).toMatchObject({
            message: `Failed to acquire lock for key "${renewalSubscriptionLockKey(input.id)}"`,
          })
          expect(await readRenewalState(container, seeded)).toEqual(before)
        }
      )
    })

    describe("the awaiting-payment sweep after a cancellation", () => {
      it("ends an awaiting cycle a failed cancellation left on a cancelled subscription, instead of reporting it", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, {
          reference: "SUB-AWL-SWEEP-CANCELLED",
          subscription_status: SubscriptionStatus.CANCELLED,
        })
        const entries = watchLogs(container)

        const result = await reconcileAwaitingRenewalCycles(container)
        const state = await readRenewalState(container, seeded)

        expect(result).toMatchObject({ ended_cancelled: 1, order_unpaid: 0, subscription_terminal: 0, failed: 0 })
        expect(state.cycle).toMatchObject({
          status: RenewalCycleStatus.FAILED,
          last_error: expect.stringMatching(/cancel/i),
        })
        expect(state.attempts).toEqual([
          expect.objectContaining({ id: seeded.attempt.id, status: RenewalAttemptStatus.PROCESSING }),
        ])
        expect(state.failedLogs).toEqual([expect.objectContaining({ actor_type: ActivityLogActorType.SYSTEM })])
        expect(state.cases).toHaveLength(0)
        expect(entries({ event: AWAITING_PAYMENT_OVERDUE_EVENT })).toHaveLength(0)
      })

      it("fails a charge left in flight on a closed cycle once it is past the minimum age with no signal, leaves a younger one alone, and still reports a capture that arrives after that once", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, { reference: "SUB-AWL-SWEEP-STALE" })

        await cancelSubscriptionWorkflow(container).run({ input: { id: seeded.subscription.id } })

        const submittedAt = new Date(seeded.attempt.started_at).getTime()
        const entries = watchLogs(container)
        const sweep = (offsetMs: number) =>
          atTime(submittedAt + offsetMs, () => reconcileAwaitingRenewalCycles(getContainer()))

        expect(await sweep((DEFAULT_AWAITING_PAYMENT_RESOLVE_MIN_HOURS - 1) * HOUR_MS)).toMatchObject({
          stale_attempts_closed: 0,
          late_captures: 0,
        })
        expect((await readRenewalState(container, seeded)).attempts).toEqual([
          expect.objectContaining({ status: RenewalAttemptStatus.PROCESSING }),
        ])

        expect(await sweep((DEFAULT_AWAITING_PAYMENT_RESOLVE_MIN_HOURS + 1) * HOUR_MS)).toMatchObject({
          stale_attempts_closed: 1,
        })
        expect(await sweep((DEFAULT_AWAITING_PAYMENT_RESOLVE_MIN_HOURS + 2) * HOUR_MS)).toMatchObject({
          stale_attempts_closed: 0,
        })

        expect((await readRenewalState(container, seeded)).attempts).toEqual([
          expect.objectContaining({
            status: RenewalAttemptStatus.FAILED,
            error_code: NO_PAYMENT_SIGNAL_ERROR_CODE,
          }),
        ])
        expect(entries({ event: "renewal.stale_attempt_closed" })).toEqual([
          expect.objectContaining({ renewal_cycle_id: seeded.cycle.id, alertable: false }),
        ])
        expect(emitted(SubscriptionEvents.LATE_PAYMENT_CAPTURED)).toHaveLength(0)

        const payment = await captureOnOrder(container, seeded.order.id, seeded.session.id)

        await deliverCapture(container, payment.id)
        await deliverCapture(container, payment.id)

        expect((await readRenewalState(container, seeded)).attempts).toEqual([
          expect.objectContaining({
            status: RenewalAttemptStatus.SUCCEEDED,
            error_code: CAPTURED_AFTER_CLOSE_ERROR_CODE,
          }),
        ])
        expect(emitted(SubscriptionEvents.LATE_PAYMENT_CAPTURED).map((message) => message.data)).toEqual([
          expect.objectContaining({
            payment_id: payment.id,
            reason: LatePaymentCapturedReason.SUBSCRIPTION_TERMINAL,
          }),
        ])
      })

      it("delivers again the lost capture of a charge left in flight on a closed cycle, reporting it once for a refund", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, { reference: "SUB-AWL-SWEEP-CAPTURED" })

        await cancelSubscriptionWorkflow(container).run({ input: { id: seeded.subscription.id } })

        const payment = await captureOnOrder(container, seeded.order.id, seeded.session.id)

        expect(await reconcileAwaitingRenewalCycles(container)).toMatchObject({ late_captures: 1 })
        expect(await reconcileAwaitingRenewalCycles(container)).toMatchObject({ late_captures: 0 })

        expect((await readRenewalState(container, seeded)).attempts).toEqual([
          expect.objectContaining({
            status: RenewalAttemptStatus.SUCCEEDED,
            error_code: CAPTURED_AFTER_CLOSE_ERROR_CODE,
          }),
        ])
        expect(emitted(SubscriptionEvents.LATE_PAYMENT_CAPTURED).map((message) => message.data)).toEqual([
          expect.objectContaining({
            payment_id: payment.id,
            renewal_cycle_id: seeded.cycle.id,
            reason: LatePaymentCapturedReason.SUBSCRIPTION_TERMINAL,
          }),
        ])
      })
    })

    describe("awaiting cycles older than the alert limit", () => {
      it("raises one alertable entry for a cycle past the limit read from the environment however many runs see it, none under the limit, and charges nothing", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, { reference: "SUB-AWL-OVERDUE" })
        const entries = watchLogs(container)
        const alerts = () =>
          entries({ event: AWAITING_PAYMENT_OVERDUE_EVENT }).filter((entry) => entry.alertable === true)
        const raisedOnce = [expect.objectContaining({ renewal_cycle_id: seeded.cycle.id })]

        process.env[AWAITING_PAYMENT_ALERT_HOURS_ENV] = "2"

        await sweepAt(HOUR_MS)
        expect(alerts()).toHaveLength(0)
        await sweepAt(3 * HOUR_MS)
        expect(alerts()).toEqual(raisedOnce)
        await sweepAt(4 * HOUR_MS)
        expect(alerts()).toEqual(raisedOnce)

        const state = await readRenewalState(container, seeded)

        expect(state.cycle.status).toEqual(RenewalCycleStatus.AWAITING_PAYMENT)
        expect(state.attempts).toEqual([expect.objectContaining({ status: RenewalAttemptStatus.PROCESSING })])
        expect(state.cases).toHaveLength(0)
      })
    })

    describe("POST /admin/renewals/:id/resolve-awaiting-payment", () => {
      const route = (cycleId: string) => `/admin/renewals/${cycleId}/resolve-awaiting-payment`
      const notAwaiting = {
        status: 409,
        data: { type: "conflict", message: expect.stringMatching(/isn't awaiting its payment/) },
      }

      async function resolveTwice(cycleId: string, body: { reason?: string } = {}) {
        const headers = await createAdminAuthHeaders(getContainer())
        const results = await Promise.allSettled([
          api.post(route(cycleId), body, { headers }),
          api.post(route(cycleId), body, { headers }),
        ])

        return results
          .map((result) => (result.status === "fulfilled" ? result.value : result.reason.response))
          .sort((first, second) => first.status - second.status)
      }

      it("rejects an unauthenticated request, an invalid body and a cycle that is not awaiting its payment, and answers a conflict that the payment may still arrive for an unpaid cycle under the minimum age, writing nothing", async () => {
        const container = getContainer()
        const headers = await createAdminAuthHeaders(container)
        const seeded = await seedAwaitingRenewal(container, { reference: "SUB-AWL-RESOLVE-YOUNG" })
        const scheduled = await seedAwaitingRenewal(container, {
          reference: "SUB-AWL-RESOLVE-SCHEDULED",
          cycle_status: RenewalCycleStatus.SCHEDULED,
        })
        const url = route(seeded.cycle.id)
        const before = await readRenewalState(container, seeded)
        const scheduledBefore = await readRenewalState(container, scheduled)

        await expect(api.post(route(scheduled.cycle.id), {}, { headers })).rejects.toMatchObject({
          response: notAwaiting,
        })
        expect(await readRenewalState(container, scheduled)).toEqual(scheduledBefore)

        await expect(api.post(url, {})).rejects.toMatchObject({ response: { status: 401 } })
        await expect(api.post(url, { reason: "" }, { headers })).rejects.toMatchObject({
          response: { status: 400 },
        })
        await expect(api.post(url, {}, { headers })).rejects.toMatchObject({
          response: {
            status: 409,
            data: { type: "conflict", message: expect.stringMatching(/payment may still arrive/) },
          },
        })

        expect(await readRenewalState(container, seeded)).toEqual(before)
        expect(emitted(DunningEvents.STARTED)).toHaveLength(0)
      })

      it("shows an admin when an awaiting charge was submitted and after when it can be resolved as failed, and nothing for a cycle without a charge in flight", async () => {
        const container = getContainer()
        const headers = await createAdminAuthHeaders(container)
        const submittedAt = new Date(Date.now() - 5 * HOUR_MS)
        const awaiting = await seedAwaitingRenewal(container, {
          reference: "SUB-AWL-DETAIL-AWAITING",
          submitted_at: submittedAt,
        })
        const processing = await seedAwaitingRenewal(container, {
          reference: "SUB-AWL-DETAIL-PROCESSING",
          cycle_status: RenewalCycleStatus.PROCESSING,
          submitted_at: submittedAt,
        })
        const scheduled = await seedAwaitingRenewal(container, {
          reference: "SUB-AWL-DETAIL-SCHEDULED",
          cycle_status: RenewalCycleStatus.SCHEDULED,
        })
        const detail = async (cycleId: string) =>
          (await api.get(`/admin/renewals/${cycleId}`, { headers })).data.renewal
        const awaitingPayment = (minHours: number) => ({
          submitted_at: submittedAt.toISOString(),
          can_fail_after: new Date(submittedAt.getTime() + minHours * HOUR_MS).toISOString(),
        })

        process.env[AWAITING_PAYMENT_ALERT_HOURS_ENV] = "2"

        expect((await detail(awaiting.cycle.id)).awaiting_payment).toEqual(
          awaitingPayment(DEFAULT_AWAITING_PAYMENT_RESOLVE_MIN_HOURS)
        )
        expect((await detail(processing.cycle.id)).awaiting_payment).toEqual(
          awaitingPayment(DEFAULT_AWAITING_PAYMENT_RESOLVE_MIN_HOURS)
        )
        expect((await detail(scheduled.cycle.id)).awaiting_payment).toBeNull()

        process.env[AWAITING_PAYMENT_RESOLVE_MIN_HOURS_ENV] = "4"

        expect((await detail(awaiting.cycle.id)).awaiting_payment).toEqual(awaitingPayment(4))

        const resolved = await api.post(route(awaiting.cycle.id), {}, { headers })

        expect(resolved.data).toMatchObject({
          resolution: "failed",
          renewal: { id: awaiting.cycle.id, awaiting_payment: null },
        })
      })

      it("measures the age an unpaid charge needs before it can be resolved as failed by its own setting, not by the alert hours", async () => {
        const container = getContainer()
        const headers = await createAdminAuthHeaders(container)
        const seeded = await seedAwaitingRenewal(container, {
          reference: "SUB-AWL-RESOLVE-MIN-AGE",
          submitted_at: new Date(Date.now() - 3 * HOUR_MS),
        })
        const before = await readRenewalState(container, seeded)

        process.env[AWAITING_PAYMENT_ALERT_HOURS_ENV] = "2"

        await expect(api.post(route(seeded.cycle.id), {}, { headers })).rejects.toMatchObject({
          response: {
            status: 409,
            data: {
              type: "conflict",
              message: expect.stringContaining(
                `payment may still arrive; it can be resolved as failed once it has waited for more than ${DEFAULT_AWAITING_PAYMENT_RESOLVE_MIN_HOURS} hours`
              ),
            },
          },
        })
        expect(await readRenewalState(container, seeded)).toEqual(before)

        process.env[AWAITING_PAYMENT_RESOLVE_MIN_HOURS_ENV] = "2"

        const resolved = await api.post(route(seeded.cycle.id), {}, { headers })

        expect(resolved.data).toMatchObject({
          resolution: "failed",
          renewal: { status: RenewalCycleStatus.FAILED },
        })
        expect((await readRenewalState(container, seeded)).cases).toEqual([
          expect.objectContaining({ renewal_cycle_id: seeded.cycle.id }),
        ])
      })

      it("settles once, as a capture would, when two resolves of a paid order run at the same time", async () => {
        const seeded = await seedAwaitingRenewal(getContainer(), { reference: "SUB-AWL-RESOLVE-PAID" })

        await captureOnOrder(getContainer(), seeded.order.id, seeded.session.id)

        const [won, lost] = await resolveTwice(seeded.cycle.id)
        const state = await readRenewalState(getContainer(), seeded)

        expect(won).toMatchObject({
          status: 200,
          data: {
            resolution: "settled",
            renewal: { id: seeded.cycle.id, status: RenewalCycleStatus.SUCCEEDED },
          },
        })
        expect(lost).toMatchObject(notAwaiting)
        expect(state.cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(state.attempts).toEqual([
          expect.objectContaining({ id: seeded.attempt.id, status: RenewalAttemptStatus.SUCCEEDED }),
        ])
        expect(state.subscription.next_renewal_at).toEqual(
          DateTime.fromJSDate(seeded.scheduledFor, { zone: "utc" }).plus({ months: 1 }).toJSDate()
        )
        expect(state.cycles.filter(({ status }) => status === RenewalCycleStatus.SCHEDULED)).toHaveLength(1)
        expect(state.succeededLogs).toHaveLength(1)
        expect(state.cases).toHaveLength(0)
      })

      it.each([
        { name: "cycle awaiting its payment", cycle_status: RenewalCycleStatus.AWAITING_PAYMENT },
        {
          name: "cycle left processing by a run that never recorded its session",
          cycle_status: RenewalCycleStatus.PROCESSING,
        },
      ])(
        "fails the cycle and opens one dunning case when two resolves of an overdue unpaid $name run at the same time",
        async ({ cycle_status }) => {
          const container = getContainer()
          const seeded = await seedAwaitingRenewal(container, {
            reference: `SUB-AWL-RESOLVE-UNPAID-${cycle_status}`,
            cycle_status,
            submitted_at: new Date(Date.now() - (DEFAULT_AWAITING_PAYMENT_RESOLVE_MIN_HOURS + 1) * HOUR_MS),
          })

          if (cycle_status === RenewalCycleStatus.PROCESSING) {
            await container
              .resolve<RenewalModuleService>(RENEWAL_MODULE)
              .updateRenewalAttempts({ id: seeded.attempt.id, payment_reference: null })
          }

          const [won, lost] = await resolveTwice(seeded.cycle.id, { reason: "bank confirmed no transfer" })
          const state = await readRenewalState(container, seeded)

          expect(won).toMatchObject({
            status: 200,
            data: { resolution: "failed", renewal: { status: RenewalCycleStatus.FAILED } },
          })
          expect(lost).toMatchObject(notAwaiting)
          expect(state.cycle).toMatchObject({
            status: RenewalCycleStatus.FAILED,
            last_error: expect.stringContaining("bank confirmed no transfer"),
          })
          expect(state.attempts).toEqual([
            expect.objectContaining({ id: seeded.attempt.id, status: RenewalAttemptStatus.FAILED }),
          ])
          expect(state.subscription.status).toEqual(SubscriptionStatus.PAST_DUE)
          expect(state.cases).toEqual([
            expect.objectContaining({
              renewal_cycle_id: seeded.cycle.id,
              renewal_order_id: seeded.order.id,
              status: DunningCaseStatus.RETRY_SCHEDULED,
            }),
          ])
          expect(state.failedLogs).toHaveLength(1)
          expect(state.succeededLogs).toHaveLength(0)
          expect(emitted(DunningEvents.STARTED)).toHaveLength(1)
        }
      )
    })

    describe("failed renewal cycles owned by dunning", () => {
      it("counts a run that parks as awaiting and a failed cycle owned by dunning as blocked in the scheduler job, neither as a success nor as a failure", async () => {
        const container = getContainer()
        const dueAt = new Date(Date.now() - HOUR_MS)
        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-AWL-JOB-PARK",
          next_renewal_at: dueAt,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          scheduled_for: dueAt,
        })
        const owned = await seedFailedCycle("SUB-AWL-JOB-BLOCK", DunningCaseStatus.RETRY_SCHEDULED)
        const ownedBefore = await readRenewalState(container, owned)

        stubRenewalCharge(container, { subscription, order_id: "ord_awl_job_park" })
        answerAuthorizationWithNull(container)
        const entries = watchLogs(container)

        await processRenewalCyclesJob(container)

        const cycleEntries = (cycleId: string) =>
          entries({ event: "renewal.job.cycle" }).filter((entry) => entry.renewal_cycle_id === cycleId)

        expect((await readRenewalState(container, { subscription, cycle })).cycle.status).toEqual(
          RenewalCycleStatus.AWAITING_PAYMENT
        )
        expect(cycleEntries(cycle.id)).toEqual([
          expect.objectContaining({ outcome: "awaiting_payment", success_count: 0, failure_count: 0 }),
        ])
        expect(cycleEntries(owned.cycle.id)).toEqual([
          expect.objectContaining({ outcome: "blocked", alertable: false }),
        ])
        expect(entries({ event: "renewal.job" }).filter((entry) => entry.outcome === "completed")).toEqual([
          expect.objectContaining({ success_count: 0, failure_count: 0, blocked_count: 1, awaiting_count: 1 }),
        ])
        expect(await readRenewalState(container, owned)).toEqual(ownedBefore)
      })

      it("refuses scheduled and forced runs of a failed cycle while a dunning case of any active status owns it", async () => {
        const container = getContainer()
        const entries = watchLogs(container)

        for (const status of [
          DunningCaseStatus.OPEN,
          DunningCaseStatus.RETRY_SCHEDULED,
          DunningCaseStatus.RETRYING,
          DunningCaseStatus.AWAITING_PAYMENT,
          DunningCaseStatus.AWAITING_MANUAL_RESOLUTION,
        ]) {
          const owned = await seedFailedCycle(`SUB-AWL-OWNED-${status}`, status)
          const before = await readRenewalState(container, owned)
          const refusal = {
            type: MedusaError.Types.CONFLICT,
            message: renewalErrors.dunningOwnsCycle(owned.cycle.id).message,
          }

          await expect(
            processRenewalCycleWorkflow(container).run({
              input: { renewal_cycle_id: owned.cycle.id, trigger_type: "scheduler" },
            })
          ).rejects.toMatchObject(refusal)
          await expect(
            forceRenewalCycleWorkflow(container).run({
              input: { renewal_cycle_id: owned.cycle.id, triggered_by: "admin_dunning" },
            })
          ).rejects.toMatchObject(refusal)

          expect(await readRenewalState(container, owned)).toEqual(before)
          expect(
            entries({ event: "renewal.force" }).filter(
              (entry) => entry.renewal_cycle_id === owned.cycle.id && entry.outcome !== "started"
            )
          ).toEqual([
            expect.objectContaining({ outcome: "blocked", failure_kind: "dunning_owns_cycle", alertable: false }),
          ])
        }

        expect(mockCreateOrderRun).not.toHaveBeenCalled()
        expect(mockCreatePaymentSessionsRun).not.toHaveBeenCalled()
      })

      it("re-runs a failed cycle whose dunning case is closed", async () => {
        const container = getContainer()

        for (const status of [DunningCaseStatus.RECOVERED, DunningCaseStatus.UNRECOVERED]) {
          jest.restoreAllMocks()

          const closed = await seedFailedCycle(`SUB-AWL-CLOSED-${status}`, status)

          stubRenewalCharge(container, {
            subscription: closed.subscription,
            order_id: `ord_awl_closed_${status}`,
          })

          await processRenewalCycleWorkflow(container).run({
            input: { renewal_cycle_id: closed.cycle.id, trigger_type: "scheduler" },
          })

          const state = await readRenewalState(container, closed)

          expect(state.cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
          expect(state.attempts).toHaveLength(2)
        }
      })
    })
  },
})
