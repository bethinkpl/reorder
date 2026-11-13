import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import type { IEventBusModuleService, MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError, Modules, PaymentEvents } from "@medusajs/framework/utils"
import { createStep, createWorkflow, type StepFunction, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { DateTime } from "luxon"
import processRenewalCyclesJob from "../../src/jobs/process-renewal-cycles"
import { reconcileAwaitingRenewalCycles } from "../../src/jobs/reconcile-awaiting-renewal-cycles"
import { ACTIVITY_LOG_MODULE } from "../../src/modules/activity-log"
import type ActivityLogModuleService from "../../src/modules/activity-log/service"
import { ActivityLogEventType } from "../../src/modules/activity-log/types"
import { DUNNING_MODULE } from "../../src/modules/dunning"
import { DunningEvents } from "../../src/modules/dunning/events"
import type DunningModuleService from "../../src/modules/dunning/service"
import { DunningCaseStatus } from "../../src/modules/dunning/types"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import { RenewalAttemptStatus, RenewalCycleStatus } from "../../src/modules/renewal/types"
import {
  AWAITING_PAYMENT_ALERT_HOURS_ENV,
  AWAITING_PAYMENT_OVERDUE_EVENT,
  DEFAULT_AWAITING_PAYMENT_ALERT_HOURS,
} from "../../src/modules/renewal/utils/awaiting-payment-age"
import { renewalErrors } from "../../src/modules/renewal/utils/errors"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import activateSubscriptionOnPaymentCapturedHandler from "../../src/subscribers/activate-subscription-on-payment-captured"
import {
  cancelSubscriptionByCustomerWorkflow,
  cancelSubscriptionWorkflow,
  finalizeCancellationWorkflow,
  forceRenewalCycleWorkflow,
  processRenewalCycleWorkflow,
} from "../../src/workflows"
import { cancelSubscriptionStep } from "../../src/workflows/steps/cancel-subscription"
import { finalizeCancellationStep } from "../../src/workflows/steps/finalize-cancellation"
import { recordOrderCaptureTransactions } from "../../src/workflows/utils/record-order-capture-transactions"
import { type SeededAwaitingRenewal, seedAwaitingRenewal } from "../helpers/awaiting-renewal-fixtures"
import { createCancellationCaseSeed } from "../helpers/cancellation-fixtures"
import { createDunningCaseSeed } from "../helpers/dunning-fixtures"
import { authorizeAndCapturePaymentSession } from "../helpers/payment-fixtures"
import { answerAuthorizationWithNull, createRenewalChargeStub } from "../helpers/renewal-charge-fixtures"
import {
  createAdminAuthHeaders,
  createRenewalAttemptSeed,
  createRenewalCycleSeed,
  createSubscriptionSeed,
} from "../helpers/renewal-fixtures"

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

type LogEntry = Record<string, unknown>
type CycleRef = { subscription: { id: string }, cycle: { id: string } }
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

function failingAfter(name: string, step: StepFunction<CancellationInput, unknown>) {
  return createWorkflow(`awaiting-lifecycle-${name}-then-fail`, function (input: CancellationInput) {
    step(input)
    failingStep(input)

    return new WorkflowResponse(undefined)
  })
}

const STEPS_THEN_FAIL = [
  { name: "cancel-subscription", workflow: failingAfter("cancel", cancelSubscriptionStep) },
  { name: "finalize-cancellation", workflow: failingAfter("finalize", finalizeCancellationStep) },
]

function asStep(name: string, run: (input: CancellationInput) => unknown) {
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
    let emit: jest.SpyInstance

    beforeEach(() => {
      emit = jest.spyOn(getContainer().resolve<IEventBusModuleService>(Modules.EVENT_BUS), "emit")
    })

    afterEach(() => {
      jest.restoreAllMocks()
      jest.clearAllMocks()
      delete process.env[AWAITING_PAYMENT_ALERT_HOURS_ENV]
    })

    function dunningStartedEmissions() {
      return emit.mock.calls.filter(([message]) => message?.name === DunningEvents.STARTED)
    }

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

    async function cancellationInputFor({ subscription, cycle }: CycleRef): Promise<CancellationInput> {
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

    async function captureInFull(seeded: SeededAwaitingRenewal) {
      const payment = await authorizeAndCapturePaymentSession(getContainer(), seeded.session.id)

      await recordOrderCaptureTransactions(getContainer(), seeded.order.id, payment.id)

      return payment
    }

    async function deliverCapture(paymentId: string) {
      await activateSubscriptionOnPaymentCapturedHandler({
        event: { name: PaymentEvents.CAPTURED, data: { id: paymentId } },
        container: getContainer(),
        pluginOptions: {},
      })
    }

    async function readState({ subscription, cycle }: CycleRef) {
      const container = getContainer()
      const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
      const logsOf = (event_type: ActivityLogEventType) =>
        container
          .resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)
          .listSubscriptionLogs({ subscription_id: subscription.id, event_type })

      return {
        cycle: await renewalModule.retrieveRenewalCycle(cycle.id),
        cycles: await renewalModule.listRenewalCycles({ subscription_id: subscription.id }),
        attempts: await renewalModule.listRenewalAttempts({ renewal_cycle_id: cycle.id }),
        subscription: await container
          .resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
          .retrieveSubscription(subscription.id),
        cases: await container
          .resolve<DunningModuleService>(DUNNING_MODULE)
          .listDunningCases({ subscription_id: subscription.id }),
        failedLogs: await logsOf(ActivityLogEventType.RENEWAL_FAILED),
        succeededLogs: await logsOf(ActivityLogEventType.RENEWAL_SUCCEEDED),
        forceLogs: await logsOf(ActivityLogEventType.RENEWAL_FORCE_REQUESTED),
      }
    }

    function watchLogger(container: MedusaContainer) {
      const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
      const spies = (["info", "warn", "error"] as const).map((level) => jest.spyOn(logger, level))

      return function entries(event: string): LogEntry[] {
        return spies
          .flatMap((spy) => spy.mock.calls)
          .flatMap(([line]) => {
            try {
              const entry: LogEntry = JSON.parse(String(line))

              return entry?.event === event ? [entry] : []
            } catch {
              return []
            }
          })
      }
    }

    async function sweepAt(offsetMs: number) {
      const clock = jest.spyOn(Date, "now").mockReturnValue(Date.now() + offsetMs)

      try {
        await reconcileAwaitingRenewalCycles(getContainer())
      } finally {
        clock.mockRestore()
      }
    }

    async function whileRenewalLockHeld<T>(subscriptionId: string, run: () => Promise<T>) {
      const locking = getContainer().resolve(Modules.LOCKING)
      const key = `renewal:subscription:${subscriptionId}`
      const ownerId = `renewal-run-on-${subscriptionId}`

      await locking.acquire(key, { ownerId, expire: 60 })

      try {
        return await run()
      } finally {
        await locking.release(key, { ownerId })
      }
    }

    describe("cancelling a subscription whose renewal awaits payment", () => {
      it.each([
        { name: "cancellation", finalize: false },
        { name: "finalised cancellation", finalize: true },
      ])(
        "refuses an admin $name with a conflict and writes nothing while a renewal holds the lock, then ends the cycle and attempt without dunning and ignores a capture that arrives afterwards",
        async ({ finalize }) => {
          const container = getContainer()
          const headers = await createAdminAuthHeaders(container)
          const seeded = await seedAwaitingRenewal(container, { reference: `SUB-AWL-CANCEL-${finalize}` })
          const input = await cancellationInputFor(seeded)
          const cancel = () =>
            finalize
              ? api.post(`/admin/cancellations/${input.cancellation_case_id}/finalize`, {}, { headers })
              : api.post(`/admin/subscriptions/${input.id}/cancel`, { reason: input.reason }, { headers })
          const before = await readState(seeded)

          const refusal = await whileRenewalLockHeld(input.id, () => cancel().catch((error: unknown) => error))

          expect(refusal.response).toMatchObject({ status: 409, data: { type: "conflict" } })
          expect(await readState(seeded)).toEqual(before)

          const response = await cancel()
          const cancelled = await readState(seeded)

          expect(response.status).toEqual(200)
          expect(cancelled).toMatchObject({
            subscription: { status: SubscriptionStatus.CANCELLED, next_renewal_at: null },
            cycle: {
              status: RenewalCycleStatus.FAILED,
              last_error: expect.stringMatching(/cancel/i),
              generated_order_id: seeded.order.id,
            },
            attempts: [
              { id: seeded.attempt.id, status: RenewalAttemptStatus.FAILED, finished_at: expect.any(Date) },
            ],
          })
          expect(cancelled.failedLogs).toHaveLength(1)
          expect(cancelled.succeededLogs).toHaveLength(0)
          expect(cancelled.cases).toHaveLength(0)

          const payment = await captureInFull(seeded)
          await deliverCapture(payment.id)

          expect(await readState(seeded)).toEqual(cancelled)
          expect(dunningStartedEmissions()).toHaveLength(0)
        }
      )

      it.each(STEPS_THEN_FAIL)(
        "the $name step restores the awaiting cycle and attempt when a later step fails",
        async ({ name, workflow }) => {
          const container = getContainer()
          const seeded = await seedAwaitingRenewal(container, { reference: `SUB-AWL-ROLLBACK-${name}` })
          const input = await cancellationInputFor(seeded)
          const before = await readState(seeded)

          cycleStatusWhenLaterStepRan = null

          await expect(workflow(container).run({ input })).rejects.toMatchObject(LATER_STEP_FAILURE)

          const after = await readState(seeded)

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
        const before = await readState(failed)

        for (const { workflow } of STEPS_THEN_FAIL) {
          await expect(workflow(container).run({ input })).rejects.toMatchObject(LATER_STEP_FAILURE)

          const afterRollback = await readState(failed)

          expect(afterRollback.cycle).toEqual(before.cycle)
          expect(afterRollback.attempts).toEqual(before.attempts)
        }

        await cancelSubscriptionWorkflow(container).run({ input: { id: input.id } })

        const afterCancel = await readState(failed)

        expect(afterCancel.cycle).toEqual(before.cycle)
        expect(afterCancel.attempts).toEqual(before.attempts)
        expect(afterCancel.failedLogs).toHaveLength(0)
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
          const before = await readState(seeded)

          const refusal = await whileRenewalLockHeld(input.id, () =>
            nested(container).run({ input }).catch((error: unknown) => error)
          )

          expect(refusal).toMatchObject({
            message: `Failed to acquire lock for key "renewal:subscription:${input.id}"`,
          })
          expect(await readState(seeded)).toEqual(before)
        }
      )
    })

    describe("awaiting cycles older than the alert limit", () => {
      it("raises one alertable entry for a cycle past the limit read from the environment however many runs see it, none under the limit, and charges nothing", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, { reference: "SUB-AWL-OVERDUE" })
        const entries = watchLogger(container)
        const alerts = () =>
          entries(AWAITING_PAYMENT_OVERDUE_EVENT).filter((entry) => entry.alertable === true)
        const raisedOnce = [expect.objectContaining({ renewal_cycle_id: seeded.cycle.id })]

        process.env[AWAITING_PAYMENT_ALERT_HOURS_ENV] = "2"

        await sweepAt(HOUR_MS)
        expect(alerts()).toHaveLength(0)
        await sweepAt(3 * HOUR_MS)
        expect(alerts()).toEqual(raisedOnce)
        await sweepAt(4 * HOUR_MS)
        expect(alerts()).toEqual(raisedOnce)

        const state = await readState(seeded)

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

      it("rejects an unauthenticated request and an invalid body, and answers a conflict that the payment may still arrive for an unpaid cycle under the alert limit, writing nothing", async () => {
        const container = getContainer()
        const headers = await createAdminAuthHeaders(container)
        const seeded = await seedAwaitingRenewal(container, { reference: "SUB-AWL-RESOLVE-YOUNG" })
        const url = route(seeded.cycle.id)
        const before = await readState(seeded)

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

        expect(await readState(seeded)).toEqual(before)
        expect(dunningStartedEmissions()).toHaveLength(0)
      })

      it("settles once, as a capture would, when two resolves of a paid order run at the same time", async () => {
        const seeded = await seedAwaitingRenewal(getContainer(), { reference: "SUB-AWL-RESOLVE-PAID" })

        await captureInFull(seeded)

        const [won, lost] = await resolveTwice(seeded.cycle.id)
        const state = await readState(seeded)

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
            submitted_at: new Date(Date.now() - (DEFAULT_AWAITING_PAYMENT_ALERT_HOURS + 1) * HOUR_MS),
          })

          if (cycle_status === RenewalCycleStatus.PROCESSING) {
            await container
              .resolve<RenewalModuleService>(RENEWAL_MODULE)
              .updateRenewalAttempts({ id: seeded.attempt.id, payment_reference: null })
          }

          const [won, lost] = await resolveTwice(seeded.cycle.id, { reason: "bank confirmed no transfer" })
          const state = await readState(seeded)

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
          expect(dunningStartedEmissions()).toHaveLength(1)
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
        const ownedBefore = await readState(owned)

        stubRenewalCharge(container, { subscription, order_id: "ord_awl_job_park" })
        answerAuthorizationWithNull(container)
        const entries = watchLogger(container)

        await processRenewalCyclesJob(container)

        const cycleEntries = (cycleId: string) =>
          entries("renewal.job.cycle").filter((entry) => entry.renewal_cycle_id === cycleId)

        expect((await readState({ subscription, cycle })).cycle.status).toEqual(
          RenewalCycleStatus.AWAITING_PAYMENT
        )
        expect(cycleEntries(cycle.id)).toEqual([
          expect.objectContaining({ outcome: "awaiting_payment", success_count: 0, failure_count: 0 }),
        ])
        expect(cycleEntries(owned.cycle.id)).toEqual([
          expect.objectContaining({ outcome: "blocked", alertable: false }),
        ])
        expect(entries("renewal.job").filter((entry) => entry.outcome === "completed")).toEqual([
          expect.objectContaining({ success_count: 0, failure_count: 0, blocked_count: 1, awaiting_count: 1 }),
        ])
        expect(await readState(owned)).toEqual(ownedBefore)
      })

      it("refuses scheduled and forced runs of a failed cycle while a dunning case of any active status owns it", async () => {
        const container = getContainer()
        const entries = watchLogger(container)

        for (const status of [
          DunningCaseStatus.OPEN,
          DunningCaseStatus.RETRY_SCHEDULED,
          DunningCaseStatus.RETRYING,
          DunningCaseStatus.AWAITING_PAYMENT,
          DunningCaseStatus.AWAITING_MANUAL_RESOLUTION,
        ]) {
          const owned = await seedFailedCycle(`SUB-AWL-OWNED-${status}`, status)
          const before = await readState(owned)
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

          expect(await readState(owned)).toEqual(before)
          expect(
            entries("renewal.force").filter(
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

          const state = await readState(closed)

          expect(state.cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
          expect(state.attempts).toHaveLength(2)
        }
      })
    })
  },
})
