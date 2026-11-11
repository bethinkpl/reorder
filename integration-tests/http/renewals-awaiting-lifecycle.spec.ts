import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import type {
  IEventBusModuleService,
  IPaymentModuleService,
  MedusaContainer,
} from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
  PaymentActions,
  PaymentEvents,
} from "@medusajs/framework/utils"
import {
  createStep,
  createWorkflow,
  type StepFunction,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { DateTime } from "luxon"
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
import {
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../src/modules/renewal/types"
import {
  AWAITING_PAYMENT_ALERT_HOURS_ENV,
  AWAITING_PAYMENT_OVERDUE_EVENT,
} from "../../src/modules/renewal/utils/awaiting-payment-age"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import activateSubscriptionOnPaymentCapturedHandler from "../../src/subscribers/activate-subscription-on-payment-captured"
import { cancelPendingSubscriptionOnPaymentFailure } from "../../src/subscribers/cancel-pending-subscription-on-payment-failure"
import {
  cancelSubscriptionWorkflow,
  finalizeCancellationWorkflow,
} from "../../src/workflows"
import { cancelSubscriptionStep } from "../../src/workflows/steps/cancel-subscription"
import { finalizeCancellationStep } from "../../src/workflows/steps/finalize-cancellation"
import { recordOrderCaptureTransactions } from "../../src/workflows/utils/record-order-capture-transactions"
import {
  type SeededAwaitingRenewal,
  seedAwaitingRenewal,
} from "../helpers/awaiting-renewal-fixtures"
import { createCancellationCaseSeed } from "../helpers/cancellation-fixtures"
import { authorizeAndCapturePaymentSession } from "../helpers/payment-fixtures"
import {
  createAdminAuthHeaders,
  createRenewalAttemptSeed,
  createRenewalCycleSeed,
  createSubscriptionSeed,
} from "../helpers/renewal-fixtures"

jest.setTimeout(120 * 1000)

const HOUR_MS = 60 * 60 * 1000
const LATER_STEP_FAILURE = "a later step failed after the cancellation"

const webhookEvent = {
  provider: "pp_test_provider",
  payload: { data: {}, rawData: Buffer.from("{}"), headers: {} },
}

type LogLine = { event?: string, alertable?: boolean, renewal_cycle_id?: string }

let cycleStatusWhenLaterStepRan: RenewalCycleStatus | null = null

const failingStep = createStep(
  "awaiting-lifecycle-failing-step",
  async function (input: { renewal_cycle_id: string }, { container }) {
    const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)

    cycleStatusWhenLaterStepRan = (
      await renewalModule.retrieveRenewalCycle(input.renewal_cycle_id)
    ).status

    throw new Error(LATER_STEP_FAILURE)
  }
)

function failingAfter<TStepInput>(
  workflowId: string,
  step: StepFunction<TStepInput, unknown>
) {
  return createWorkflow(workflowId, function (input: {
    step: TStepInput
    renewal_cycle_id: string
  }) {
    step(input.step)
    failingStep({ renewal_cycle_id: input.renewal_cycle_id })

    return new WorkflowResponse(undefined)
  })
}

const cancelThenFail = failingAfter(
  "awaiting-lifecycle-cancel-then-fail",
  cancelSubscriptionStep
)
const finalizeThenFail = failingAfter(
  "awaiting-lifecycle-finalize-then-fail",
  finalizeCancellationStep
)

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ api, getContainer }) => {
    let emit: jest.SpyInstance
    let decoder: jest.SpyInstance

    beforeEach(() => {
      const container = getContainer()

      emit = jest.spyOn(
        container.resolve<IEventBusModuleService>(Modules.EVENT_BUS),
        "emit"
      )
      decoder = jest.spyOn(
        container.resolve<IPaymentModuleService>(Modules.PAYMENT),
        "getWebhookActionAndData"
      )
    })

    afterEach(() => {
      jest.restoreAllMocks()
      delete process.env[AWAITING_PAYMENT_ALERT_HOURS_ENV]
    })

    function dunningStartedEmissions() {
      return emit.mock.calls.filter(
        ([message]) => message?.name === DunningEvents.STARTED
      )
    }

    async function captureInFull(seeded: SeededAwaitingRenewal) {
      const container = getContainer()
      const payment = await authorizeAndCapturePaymentSession(
        container,
        seeded.session.id
      )

      await recordOrderCaptureTransactions(container, seeded.order.id, payment.id)

      return payment
    }

    async function deliverCapture(paymentId: string) {
      await activateSubscriptionOnPaymentCapturedHandler({
        event: { name: PaymentEvents.CAPTURED, data: { id: paymentId } },
        container: getContainer(),
        pluginOptions: {},
      })
    }

    async function deliverFailure(sessionId: string) {
      decoder.mockResolvedValue({
        action: PaymentActions.FAILED,
        data: { session_id: sessionId, amount: 100, reason: "declined" },
      })

      await cancelPendingSubscriptionOnPaymentFailure(
        getContainer(),
        webhookEvent
      )
    }

    async function readState(seeded: SeededAwaitingRenewal) {
      const container = getContainer()
      const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
      const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
      const subscriptionModule =
        container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
      const activityLogModule =
        container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)
      const logsOf = async (eventType: ActivityLogEventType) =>
        await activityLogModule.listSubscriptionLogs({
          subscription_id: seeded.subscription.id,
          event_type: eventType,
        })

      return {
        cycle: await renewalModule.retrieveRenewalCycle(seeded.cycle.id),
        cycles: await renewalModule.listRenewalCycles({
          subscription_id: seeded.subscription.id,
        }),
        attempts: await renewalModule.listRenewalAttempts({
          renewal_cycle_id: seeded.cycle.id,
        }),
        subscription: await subscriptionModule.retrieveSubscription(
          seeded.subscription.id
        ),
        cases: await dunningModule.listDunningCases({
          subscription_id: seeded.subscription.id,
        } as never),
        failedLogs: await logsOf(ActivityLogEventType.RENEWAL_FAILED),
        succeededLogs: await logsOf(ActivityLogEventType.RENEWAL_SUCCEEDED),
      }
    }

    function watchLogger(container: MedusaContainer) {
      const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

      return (["info", "warn", "error"] as const).map((level) =>
        jest.spyOn(logger, level)
      )
    }

    function overdueAlerts(spies: jest.SpyInstance[]) {
      return spies
        .flatMap((spy) => spy.mock.calls)
        .map(([line]): LogLine => {
          try {
            return JSON.parse(String(line))
          } catch {
            return {}
          }
        })
        .filter(
          (line) =>
            line.event === AWAITING_PAYMENT_OVERDUE_EVENT &&
            line.alertable === true
        )
    }

    async function sweepAt(offsetMs: number) {
      const realNow = Date.now()
      const clock = jest.spyOn(Date, "now").mockReturnValue(realNow + offsetMs)

      try {
        await reconcileAwaitingRenewalCycles(getContainer())
      } finally {
        clock.mockRestore()
      }
    }

    describe("cancelling a subscription whose renewal awaits payment", () => {
      it("ends the cycle and attempt without dunning, and ignores a capture or failure that arrives afterwards", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, {
          reference: "SUB-AWL-CANCEL-001",
        })

        await cancelSubscriptionWorkflow(container).run({
          input: { id: seeded.subscription.id, reason: "customer left" },
        })

        const cancelled = await readState(seeded)

        expect(cancelled.subscription.status).toEqual(SubscriptionStatus.CANCELLED)
        expect(cancelled.cycle.status).toEqual(RenewalCycleStatus.FAILED)
        expect(cancelled.cycle.last_error).toMatch(/cancel/i)
        expect(cancelled.cycle.generated_order_id).toEqual(seeded.order.id)
        expect(cancelled.attempts).toEqual([
          expect.objectContaining({
            id: seeded.attempt.id,
            status: RenewalAttemptStatus.FAILED,
          }),
        ])
        expect(cancelled.attempts[0].finished_at).toBeTruthy()
        expect(cancelled.failedLogs).toHaveLength(1)
        expect(cancelled.cases).toHaveLength(0)
        expect(dunningStartedEmissions()).toHaveLength(0)

        const payment = await captureInFull(seeded)
        await deliverCapture(payment.id)

        const afterCapture = await readState(seeded)

        expect(afterCapture.cycle.status).toEqual(RenewalCycleStatus.FAILED)
        expect(afterCapture.subscription.next_renewal_at).toBeNull()
        expect(afterCapture.succeededLogs).toHaveLength(0)
        expect(afterCapture.cycles).toEqual(cancelled.cycles)

        await deliverFailure(seeded.session.id)

        const afterFailure = await readState(seeded)

        expect(afterFailure.cycle).toEqual(afterCapture.cycle)
        expect(afterFailure.attempts).toEqual(afterCapture.attempts)
        expect(afterFailure.cases).toHaveLength(0)
        expect(afterFailure.failedLogs).toHaveLength(1)
        expect(dunningStartedEmissions()).toHaveLength(0)
      })

      it("ends the cycle and attempt without dunning when the cancellation is finalised", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, {
          reference: "SUB-AWL-FINALIZE-001",
        })
        const cancellationCase = await createCancellationCaseSeed(container, {
          subscription_id: seeded.subscription.id,
          reason: "customer left",
        })

        await finalizeCancellationWorkflow(container).run({
          input: { cancellation_case_id: cancellationCase.id },
        })

        const state = await readState(seeded)

        expect(state.subscription.status).toEqual(SubscriptionStatus.CANCELLED)
        expect(state.cycle.status).toEqual(RenewalCycleStatus.FAILED)
        expect(state.cycle.last_error).toMatch(/cancel/i)
        expect(state.attempts).toEqual([
          expect.objectContaining({
            id: seeded.attempt.id,
            status: RenewalAttemptStatus.FAILED,
          }),
        ])
        expect(state.failedLogs).toHaveLength(1)
        expect(state.cases).toHaveLength(0)
        expect(dunningStartedEmissions()).toHaveLength(0)
      })

      it.each([
        { name: "cancel-subscription", workflow: cancelThenFail },
        { name: "finalize-cancellation", workflow: finalizeThenFail },
      ])(
        "the $name step restores the awaiting cycle and attempt when a later step fails",
        async ({ name, workflow }) => {
          const container = getContainer()
          const seeded = await seedAwaitingRenewal(container, {
            reference: `SUB-AWL-ROLLBACK-${name}`,
          })
          const cancellationCase = await createCancellationCaseSeed(container, {
            subscription_id: seeded.subscription.id,
            reason: "customer left",
          })
          const before = await readState(seeded)

          cycleStatusWhenLaterStepRan = null

          await expect(
            workflow(container).run({
              input: {
                step:
                  name === "cancel-subscription"
                    ? { id: seeded.subscription.id }
                    : { cancellation_case_id: cancellationCase.id },
                renewal_cycle_id: seeded.cycle.id,
              } as never,
            })
          ).rejects.toMatchObject({ message: LATER_STEP_FAILURE })

          const after = await readState(seeded)

          expect(cycleStatusWhenLaterStepRan).toEqual(RenewalCycleStatus.FAILED)
          expect(after.subscription.status).toEqual(SubscriptionStatus.ACTIVE)
          expect(after.cycle.status).toEqual(RenewalCycleStatus.AWAITING_PAYMENT)
          expect(after.cycle.last_error).toEqual(before.cycle.last_error)
          expect(after.cycle.processed_at).toEqual(before.cycle.processed_at)
          expect(after.cycle.settlement_inputs).toEqual(
            before.cycle.settlement_inputs
          )
          expect(after.attempts).toEqual([
            expect.objectContaining({
              id: seeded.attempt.id,
              status: RenewalAttemptStatus.PROCESSING,
              finished_at: null,
              error_code: null,
              error_message: null,
            }),
          ])
          expect(after.cases).toHaveLength(0)
        }
      )

      it.each([
        { name: "cancel-subscription", workflow: cancelThenFail },
        { name: "finalize-cancellation", workflow: finalizeThenFail },
      ])(
        "the $name step leaves an earlier failed cycle as it was, on success and on rollback",
        async ({ name, workflow }) => {
          const container = getContainer()
          const renewalModule =
            container.resolve<RenewalModuleService>(RENEWAL_MODULE)
          const subscription = await createSubscriptionSeed(container, {
            reference: `SUB-AWL-NOOP-${name}`,
            status: SubscriptionStatus.ACTIVE,
          })
          const cycle = await createRenewalCycleSeed(container, {
            subscription_id: subscription.id,
            status: RenewalCycleStatus.FAILED,
            last_error: "card declined",
            attempt_count: 1,
          })
          const attempt = await createRenewalAttemptSeed(container, {
            renewal_cycle_id: cycle.id,
            attempt_no: 1,
            status: RenewalAttemptStatus.FAILED,
            finished_at: new Date(),
            error_code: "card_declined",
            error_message: "card declined",
          })
          const cancellationCase = await createCancellationCaseSeed(container, {
            subscription_id: subscription.id,
            reason: "customer left",
          })
          const seeded = { subscription, cycle, attempt } as SeededAwaitingRenewal
          const before = await readState(seeded)

          await expect(
            workflow(container).run({
              input: {
                step:
                  name === "cancel-subscription"
                    ? { id: subscription.id }
                    : { cancellation_case_id: cancellationCase.id },
                renewal_cycle_id: cycle.id,
              } as never,
            })
          ).rejects.toMatchObject({ message: LATER_STEP_FAILURE })

          const afterRollback = await readState(seeded)

          expect(afterRollback.cycle).toEqual(before.cycle)
          expect(afterRollback.attempts).toEqual(before.attempts)

          await cancelSubscriptionWorkflow(container).run({
            input: { id: subscription.id },
          })

          const afterCancel = await readState(seeded)

          expect(afterCancel.cycle).toEqual(before.cycle)
          expect(afterCancel.attempts).toEqual(before.attempts)
          expect(afterCancel.failedLogs).toHaveLength(0)
          expect(
            await renewalModule.listRenewalCycles({ subscription_id: subscription.id })
          ).toEqual(expect.arrayContaining([expect.objectContaining({ id: cycle.id })]))
        }
      )
    })

    describe("awaiting cycles older than the alert limit", () => {
      it("raises one alertable entry per run for an overdue cycle, none for a cancelled one, and charges nothing", async () => {
        const container = getContainer()
        const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const overdue = await seedAwaitingRenewal(container, {
          reference: "SUB-AWL-OVERDUE-001",
        })
        const cancelled = await seedAwaitingRenewal(container, {
          reference: "SUB-AWL-OVERDUE-002",
        })

        await cancelSubscriptionWorkflow(container).run({
          input: { id: cancelled.subscription.id },
        })

        const spies = watchLogger(container)

        await sweepAt(96 * HOUR_MS + HOUR_MS)

        let alerts = overdueAlerts(spies)

        expect(alerts).toHaveLength(1)
        expect(alerts[0].renewal_cycle_id).toEqual(overdue.cycle.id)

        await sweepAt(96 * HOUR_MS + HOUR_MS)

        alerts = overdueAlerts(spies)

        expect(alerts).toHaveLength(2)
        expect(alerts.map((alert) => alert.renewal_cycle_id)).toEqual([
          overdue.cycle.id,
          overdue.cycle.id,
        ])

        const overdueState = await readState(overdue)
        const cancelledState = await readState(cancelled)

        expect(overdueState.cycle.status).toEqual(RenewalCycleStatus.AWAITING_PAYMENT)
        expect(overdueState.attempts).toHaveLength(1)
        expect(overdueState.attempts[0].status).toEqual(RenewalAttemptStatus.PROCESSING)
        expect(overdueState.cases).toHaveLength(0)
        expect(cancelledState.cycle.status).toEqual(RenewalCycleStatus.FAILED)
        expect(
          await renewalModule.listRenewalAttempts({
            renewal_cycle_id: cancelled.cycle.id,
          })
        ).toHaveLength(1)
      })

      it("raises none for a cycle under the limit", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, {
          reference: "SUB-AWL-YOUNG-001",
        })
        const spies = watchLogger(container)

        await sweepAt(95 * HOUR_MS)

        expect(overdueAlerts(spies)).toHaveLength(0)
        expect((await readState(seeded)).cycle.status).toEqual(
          RenewalCycleStatus.AWAITING_PAYMENT
        )
      })

      it("reads the limit from the environment", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, {
          reference: "SUB-AWL-LIMIT-001",
        })
        const spies = watchLogger(container)

        process.env[AWAITING_PAYMENT_ALERT_HOURS_ENV] = "2"

        await sweepAt(HOUR_MS)
        expect(overdueAlerts(spies)).toHaveLength(0)

        await sweepAt(3 * HOUR_MS)

        const alerts = overdueAlerts(spies)

        expect(alerts).toHaveLength(1)
        expect(alerts[0].renewal_cycle_id).toEqual(seeded.cycle.id)
      })
    })

    describe("POST /admin/renewals/:id/resolve-awaiting-payment", () => {
      const route = (cycleId: string) =>
        `/admin/renewals/${cycleId}/resolve-awaiting-payment`

      it("settles the cycle as a capture would when the order owes nothing", async () => {
        const container = getContainer()
        const headers = await createAdminAuthHeaders(container)
        const seeded = await seedAwaitingRenewal(container, {
          reference: "SUB-AWL-RESOLVE-PAID",
        })

        await captureInFull(seeded)

        const response = await api.post(route(seeded.cycle.id), {}, { headers })

        expect(response.status).toEqual(200)
        expect(response.data.renewal.id).toEqual(seeded.cycle.id)
        expect(response.data.renewal.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(response.data.resolution).toEqual("settled")

        const state = await readState(seeded)
        const expectedNext = DateTime.fromJSDate(seeded.scheduledFor, { zone: "utc" })
          .plus({ months: 1 })
          .toJSDate()

        expect(state.cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(state.attempts).toEqual([
          expect.objectContaining({
            id: seeded.attempt.id,
            status: RenewalAttemptStatus.SUCCEEDED,
          }),
        ])
        expect(state.subscription.next_renewal_at).toEqual(expectedNext)
        expect(
          state.cycles.filter((cycle) => cycle.status === RenewalCycleStatus.SCHEDULED)
        ).toHaveLength(1)
        expect(state.succeededLogs).toHaveLength(1)
        expect(state.cases).toHaveLength(0)
      })

      it("fails the cycle and opens dunning when the order is still unpaid", async () => {
        const container = getContainer()
        const headers = await createAdminAuthHeaders(container)
        const seeded = await seedAwaitingRenewal(container, {
          reference: "SUB-AWL-RESOLVE-UNPAID",
        })

        const response = await api.post(route(seeded.cycle.id), {}, { headers })

        expect(response.status).toEqual(200)
        expect(response.data.renewal.status).toEqual(RenewalCycleStatus.FAILED)
        expect(response.data.resolution).toEqual("failed")

        const state = await readState(seeded)

        expect(state.cycle.status).toEqual(RenewalCycleStatus.FAILED)
        expect(state.cycle.last_error).toBeTruthy()
        expect(state.attempts).toEqual([
          expect.objectContaining({
            id: seeded.attempt.id,
            status: RenewalAttemptStatus.FAILED,
          }),
        ])
        expect(state.subscription.status).toEqual(SubscriptionStatus.PAST_DUE)
        expect(state.cases).toHaveLength(1)
        expect(state.cases[0]).toMatchObject({
          renewal_cycle_id: seeded.cycle.id,
          renewal_order_id: seeded.order.id,
          status: DunningCaseStatus.RETRY_SCHEDULED,
        })
        expect(state.failedLogs).toHaveLength(1)
        expect(state.succeededLogs).toHaveLength(0)
        expect(dunningStartedEmissions()).toHaveLength(1)
      })

      it("answers a conflict and writes nothing for a cycle that is not awaiting payment", async () => {
        const container = getContainer()
        const headers = await createAdminAuthHeaders(container)

        for (const cycleStatus of [
          RenewalCycleStatus.SCHEDULED,
          RenewalCycleStatus.PROCESSING,
          RenewalCycleStatus.FAILED,
          RenewalCycleStatus.SUCCEEDED,
        ]) {
          const seeded = await seedAwaitingRenewal(container, {
            reference: `SUB-AWL-RESOLVE-${cycleStatus}`,
            cycle_status: cycleStatus,
          })
          const before = await readState(seeded)

          const error = await api
            .post(route(seeded.cycle.id), {}, { headers })
            .catch((caught: { response?: { status?: number, data?: { type?: string } } }) => caught)

          expect(error.response?.status).toEqual(409)
          expect(error.response?.data?.type).toEqual("conflict")

          const after = await readState(seeded)

          expect(after.cycle).toEqual(before.cycle)
          expect(after.attempts).toEqual(before.attempts)
          expect(after.subscription).toEqual(before.subscription)
          expect(after.cases).toHaveLength(0)
          expect(after.failedLogs).toHaveLength(0)
          expect(after.succeededLogs).toHaveLength(0)
        }

        expect(dunningStartedEmissions()).toHaveLength(0)
      })

      it("rejects an unauthenticated request", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, {
          reference: "SUB-AWL-RESOLVE-NOAUTH",
        })

        await expect(
          api.post(route(seeded.cycle.id), {})
        ).rejects.toMatchObject({ response: { status: 401 } })

        expect((await readState(seeded)).cycle.status).toEqual(
          RenewalCycleStatus.AWAITING_PAYMENT
        )
      })

      it("settles once when two resolves of a paid order run at the same time", async () => {
        const container = getContainer()
        const headers = await createAdminAuthHeaders(container)
        const seeded = await seedAwaitingRenewal(container, {
          reference: "SUB-AWL-RESOLVE-PAID-TWICE",
        })

        await captureInFull(seeded)

        const results = await Promise.allSettled([
          api.post(route(seeded.cycle.id), {}, { headers }),
          api.post(route(seeded.cycle.id), {}, { headers }),
        ])
        const statuses = results
          .map((result) =>
            result.status === "fulfilled"
              ? result.value.status
              : result.reason.response?.status
          )
          .sort()
        const state = await readState(seeded)

        expect(statuses).toEqual([200, 409])
        expect(state.cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(state.succeededLogs).toHaveLength(1)
        expect(
          state.cycles.filter((cycle) => cycle.status === RenewalCycleStatus.SCHEDULED)
        ).toHaveLength(1)
        expect(state.cases).toHaveLength(0)
      })

      it("opens one dunning case when two resolves of an unpaid order run at the same time", async () => {
        const container = getContainer()
        const headers = await createAdminAuthHeaders(container)
        const seeded = await seedAwaitingRenewal(container, {
          reference: "SUB-AWL-RESOLVE-UNPAID-TWICE",
        })

        const results = await Promise.allSettled([
          api.post(route(seeded.cycle.id), {}, { headers }),
          api.post(route(seeded.cycle.id), {}, { headers }),
        ])
        const statuses = results
          .map((result) =>
            result.status === "fulfilled"
              ? result.value.status
              : result.reason.response?.status
          )
          .sort()
        const state = await readState(seeded)

        expect(statuses).toEqual([200, 409])
        expect(state.cycle.status).toEqual(RenewalCycleStatus.FAILED)
        expect(state.cases).toHaveLength(1)
        expect(state.failedLogs).toHaveLength(1)
        expect(dunningStartedEmissions()).toHaveLength(1)
      })
    })
  },
})
