import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import type { IPaymentModuleService } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
  PaymentActions,
} from "@medusajs/framework/utils"
import { createStep, createWorkflow, type WorkflowData, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { DateTime } from "luxon"
import { FrequencyInterval } from "../../src/common/types/frequency-interval"
import { PaymentAttemptErrorCode } from "../../src/common/types/payment-attempt-error-code"
import processRenewalCyclesJob from "../../src/jobs/process-renewal-cycles"
import { reconcileAwaitingRenewalCycles } from "../../src/jobs/reconcile-awaiting-renewal-cycles"
import { ACTIVITY_LOG_MODULE } from "../../src/modules/activity-log"
import type ActivityLogModuleService from "../../src/modules/activity-log/service"
import { ActivityLogActorType, ActivityLogEventType } from "../../src/modules/activity-log/types"
import { CANCELLATION_MODULE } from "../../src/modules/cancellation"
import type CancellationModuleService from "../../src/modules/cancellation/service"
import {
  CancellationCaseStatus,
  RetentionOfferType,
} from "../../src/modules/cancellation/types"
import { DUNNING_MODULE } from "../../src/modules/dunning"
import { DunningEvents } from "../../src/modules/dunning/events"
import type DunningModuleService from "../../src/modules/dunning/service"
import { DunningAttemptStatus, DunningCaseStatus } from "../../src/modules/dunning/types"
import { dunningCaseLockKey } from "../../src/modules/dunning/utils/lock-key"
import { PlanOfferScope } from "../../src/modules/plan-offer/types"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import { RenewalAttemptStatus, RenewalCycleStatus } from "../../src/modules/renewal/types"
import {
  AWAITING_PAYMENT_ALERT_HOURS_ENV,
  AWAITING_PAYMENT_RESOLVE_MIN_HOURS_ENV,
  DEFAULT_AWAITING_PAYMENT_RESOLVE_MIN_HOURS,
} from "../../src/modules/renewal/utils/awaiting-payment-age"
import { renewalErrors } from "../../src/modules/renewal/utils/errors"
import { renewalSubscriptionLockKey } from "../../src/modules/renewal/utils/lock-key"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import {
  LatePaymentCapturedReason,
  SubscriptionEvents,
} from "../../src/modules/subscription/events"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { type SubscriptionSourceSnapshot, SubscriptionStatus } from "../../src/modules/subscription/types"
import {
  cancelSubscriptionByCustomerWorkflow,
  cancelSubscriptionWorkflow,
  ensureNextRenewalCycleWorkflow,
  finalizeCancellationWorkflow,
  forceRenewalCycleWorkflow,
  processRenewalCycleWorkflow,
  RenewalRunOutcome,
  scheduleSubscriptionPlanChangeWorkflow,
  skipNextDeliveryWorkflow,
} from "../../src/workflows"
import { loadOrderAmounts } from "../../src/workflows/steps/run-dunning-retry"
import { recordOrderCaptureTransactions } from "../../src/workflows/utils/record-order-capture-transactions"
import { seedDunningCase } from "../helpers/awaiting-dunning-fixtures"
import {
  AWAITING_ORDER_TOTAL,
  type RenewalRefs,
  type SeededAwaitingRenewal,
  failRenewalLockReleaseOnce,
  oneMonthAfter,
  readRenewalState,
  seedAwaitingRenewal,
  whileRenewalLockHeld,
} from "../helpers/awaiting-renewal-fixtures"
import { createCancellationCaseSeed } from "../helpers/cancellation-fixtures"
import { chargeMocks } from "../helpers/core-flow-mocks"
import { createDunningCaseSeed } from "../helpers/dunning-fixtures"
import {
  SYSTEM_PAYMENT_PROVIDER_ID,
  authorizePaymentSessionOrThrow,
  captureOnOrder,
  createPaymentSessionFixture,
  deliverCapture,
  deliverFailure,
} from "../helpers/payment-fixtures"
import { createPlanOfferSeed } from "../helpers/plan-offer-fixtures"
import {
  answerAuthorizationWithNull,
  createRenewalChargeStub,
  runRenewal,
} from "../helpers/renewal-charge-fixtures"
import {
  createAdminAuthHeaders,
  createProductWithVariant,
  createRenewalAttemptSeed,
  createRenewalCycleSeed,
  createSubscriptionSeed,
} from "../helpers/renewal-fixtures"
import {
  atTime,
  expectCapturedAfterClose,
  expectLockFree,
  failOnce,
  watchEvents,
  watchLogs,
  whileLockHeld,
} from "../helpers/spy-fixtures"
import { createStoreCustomerHeaders } from "../helpers/subscription-fixtures"
import { RenewalLogEvents } from "../../src/modules/renewal/utils/observability"
import { SubscriptionLogEvents } from "../../src/modules/subscription/utils/observability"

jest.mock("@medusajs/medusa/core-flows", () => require("../helpers/core-flow-mocks").coreFlowsMock())

const stubRenewalCharge = createRenewalChargeStub(chargeMocks)

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const FIRST_RETRY_MS = 1440 * 60 * 1000
const PLAN_PRODUCT_ID = "prod_awaiting_plan"
const LATER_STEP_FAILURE = { message: "a later step failed after the cancellation" }

const only = (fields: Record<string, unknown>) => [expect.objectContaining(fields)]

function sourceSnapshot(variantId: string, title: string, unitPrice: number, sku: string) {
  const snapshot: SubscriptionSourceSnapshot = {
    product_id: PLAN_PRODUCT_ID,
    variant_id: variantId,
    title,
    subtitle: null,
    quantity: 1,
    unit_price: unitPrice,
    sku,
    is_discountable: true,
    is_tax_inclusive: false,
    requires_shipping: true,
    tax_lines: [],
    adjustments: [],
  }

  return snapshot
}

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

type RequestOptions = { headers: Record<string, string> }

const storeRefusal = {
  status: 409,
  data: {
    type: "conflict",
    code: "renewal_payment_in_progress",
    message: "A payment for this subscription is being processed. Please try again once it has completed.",
  },
}

function adminRefusal(action: string, charge: RegExp) {
  return {
    status: 409,
    data: {
      type: "conflict",
      message: expect.stringMatching(new RegExp(`can't ${action} while ${charge.source}`)),
    },
  }
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: { JWT_SECRET: "supersecret", COOKIE_SECRET: "supersecret" },
  testSuite: ({ api, getContainer }) => {
    const renewals = () => getContainer().resolve<RenewalModuleService>(RENEWAL_MODULE)
    const subscriptions = () => getContainer().resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
    const dunning = () => getContainer().resolve<DunningModuleService>(DUNNING_MODULE)
    const activityLog = () => getContainer().resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)
    const payments = () => getContainer().resolve(Modules.PAYMENT)
    const cancellations = () => getContainer().resolve<CancellationModuleService>(CANCELLATION_MODULE)

    let emitted: ReturnType<typeof watchEvents>

    beforeEach(() => {
      jest.restoreAllMocks()
      jest.clearAllMocks()
      emitted = watchEvents(getContainer())
    })

    afterEach(() => {
      jest.restoreAllMocks()
      jest.clearAllMocks()
      delete process.env[AWAITING_PAYMENT_ALERT_HOURS_ENV]
      delete process.env[AWAITING_PAYMENT_RESOLVE_MIN_HOURS_ENV]
    })

    async function seedDueRenewal(input: {
      dueAt: Date
      orderId: string
      subscription?: Parameters<typeof createSubscriptionSeed>[1]
      orderItem?: SubscriptionSourceSnapshot
    }) {
      const container = getContainer()
      const subscription = await createSubscriptionSeed(container, {
        next_renewal_at: input.dueAt,
        ...input.subscription,
      })
      const cycle = await createRenewalCycleSeed(container, {
        subscription_id: subscription.id,
        scheduled_for: input.dueAt,
      })
      const { sessionIds } = stubRenewalCharge(container, {
        subscription,
        order_id: input.orderId,
        order_item: input.orderItem,
      })

      return { subscription, cycle, sessionIds }
    }

    async function seedAwaitingWithSavedCard(reference: string) {
      const container = getContainer()
      const email = `${reference.toLowerCase()}@example.com`
      const customer = await container.resolve(Modules.CUSTOMER).createCustomers({ email })
      const accountHolder = await payments().createAccountHolder({
        provider_id: SYSTEM_PAYMENT_PROVIDER_ID,
        context: { customer: { id: customer.id, email } },
      })
      await container.resolve(ContainerRegistrationKeys.LINK).create({
        [Modules.CUSTOMER]: { customer_id: customer.id },
        [Modules.PAYMENT]: { account_holder_id: accountHolder.id },
      })
      const seeded = await seedAwaitingRenewal(container, { reference })
      await subscriptions().updateSubscriptions({
        id: seeded.subscription.id,
        customer_id: customer.id,
        payment_context: {
          payment_provider_id: SYSTEM_PAYMENT_PROVIDER_ID,
          account_holder_id: accountHolder.id,
          payment_method_id: "pm_old",
        },
      })

      return seeded
    }

    async function useSessionNamingAttempt(seeded: SeededAwaitingRenewal) {
      const { session } = await createPaymentSessionFixture(getContainer(), {
        context: { renewal_cycle_id: seeded.cycle.id, renewal_attempt_id: seeded.attempt.id },
      })
      await renewals().updateRenewalAttempts({ id: seeded.attempt.id, payment_reference: session.id })

      return session.id
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

    async function refusalOf(request: Promise<unknown>) {
      return ((await request.catch((error: { response?: unknown }) => error)) as { response?: unknown })
        .response
    }

    async function asAdmin(): Promise<RequestOptions> {
      return { headers: await createAdminAuthHeaders(getContainer()) }
    }

    async function asCustomer(subscriptionId: string): Promise<RequestOptions> {
      const { customer_id } = await subscriptions().retrieveSubscription(subscriptionId)

      return { headers: await createStoreCustomerHeaders(getContainer(), customer_id) }
    }

    const adminUrl = (id: string, action: string) => `/admin/subscriptions/${id}/${action}`
    const storeUrl = (id: string, action: string) => `/store/customers/me/subscriptions/${id}/${action}`

    describe("a renewal run whose charge is confirmed later", () => {
      it("parks the cycle when authorisation answers null, keeping the order, the settlement inputs and the subscription's dates", async () => {
        const dueAt = new Date("2026-05-10T10:00:00.000Z")
        const orderId = "ord_awaiting_parked"
        const seeded = await seedDueRenewal({ dueAt, orderId })
        answerAuthorizationWithNull(getContainer())
        const logEntries = watchLogs(getContainer())

        const result = await runRenewal(getContainer(), seeded.cycle.id, "corr-awaiting-park")

        const state = await readRenewalState(getContainer(), seeded)

        expect(result).toMatchObject({
          outcome: RenewalRunOutcome.AWAITING_PAYMENT,
          renewal_cycle: { id: seeded.cycle.id, status: RenewalCycleStatus.AWAITING_PAYMENT },
        })

        expect(seeded.sessionIds).toHaveLength(1)
        expect(state.cycle).toMatchObject({
          status: RenewalCycleStatus.AWAITING_PAYMENT,
          generated_order_id: orderId,
          attempt_count: 1,
        })
        expect(state.attempts).toEqual(
          only({ status: RenewalAttemptStatus.PROCESSING, payment_reference: seeded.sessionIds[0] })
        )
        expect(state.cycle.settlement_inputs).toEqual({
          attempt_id: state.attempts[0].id,
          audit: {
            correlation_id: "corr-awaiting-park",
            trigger_type: "scheduler",
            triggered_by: null,
            attempt_no: 1,
            operation_started_at: expect.any(Number),
            scheduled_for: dueAt.toISOString(),
            previous_state: {
              status: RenewalCycleStatus.SCHEDULED,
              attempt_count: 0,
              processed_at: null,
              generated_order_id: null,
              last_error: null,
            },
          },
          source_snapshot: null,
          consumed_skip_next_cycle: false,
        })
        expect(state.otherCycles).toHaveLength(0)
        expect(state.subscription).toMatchObject({
          status: SubscriptionStatus.ACTIVE,
          next_renewal_at: dueAt,
          last_renewal_at: null,
        })
        expect(state.succeededLogs).toHaveLength(0)
        expect(state.failedLogs).toHaveLength(0)
        expect(state.cases).toHaveLength(0)
        expect(
          logEntries({ event: RenewalLogEvents.EXECUTION })
            .filter((entry) => entry.renewal_cycle_id === seeded.cycle.id)
            .map((entry) => entry.outcome)
        ).toEqual(["started", "awaiting_payment"])
        await expectLockFree(getContainer(), renewalSubscriptionLockKey(seeded.subscription.id))
      })

      it("parks a plan-change cycle with the new variant's snapshot and leaves the plan change unapplied", async () => {
        const oldVariantId = "variant_awaiting_old"
        const newVariantId = "variant_awaiting_new"
        const newSnapshot = sourceSnapshot(newVariantId, "New Variant", 7500, "NEW-SKU")
        const { product_id, variant_id, title, quantity, unit_price, sku } = newSnapshot

        await createPlanOfferSeed(getContainer(), {
          name: "Awaiting plan change offer",
          scope: PlanOfferScope.VARIANT,
          product_id: PLAN_PRODUCT_ID,
          variant_id: newVariantId,
          is_enabled: true,
          allowed_frequencies: [{ interval: FrequencyInterval.MONTH, value: 1 }],
        })
        const seeded = await seedDueRenewal({
          dueAt: new Date("2026-05-11T10:00:00.000Z"),
          orderId: "ord_awaiting_plan",
          orderItem: newSnapshot,
          subscription: {
            product_id: PLAN_PRODUCT_ID,
            variant_id: oldVariantId,
            source_snapshot: sourceSnapshot(oldVariantId, "Old Variant", 5000, "OLD-SKU"),
          },
        })
        const requestedAt = new Date().toISOString()
        await subscriptions().updateSubscriptions({
          id: seeded.subscription.id,
          pending_update_data: {
            variant_id: newVariantId,
            variant_title: "New Variant",
            sku: "NEW-SKU",
            frequency_interval: FrequencyInterval.MONTH,
            frequency_value: 1,
            effective_at: null,
            requested_at: requestedAt,
            requested_by: null,
          },
        })
        answerAuthorizationWithNull(getContainer())

        await runRenewal(getContainer(), seeded.cycle.id)

        const state = await readRenewalState(getContainer(), seeded)

        expect(state.cycle).toMatchObject({
          status: RenewalCycleStatus.AWAITING_PAYMENT,
          applied_pending_update_data: { variant_id: newVariantId, requested_at: requestedAt },
          settlement_inputs: {
            source_snapshot: { product_id, variant_id, title, quantity, unit_price, sku },
            consumed_skip_next_cycle: false,
          },
        })
        expect(state.subscription).toMatchObject({
          variant_id: oldVariantId,
          source_snapshot: { variant_id: oldVariantId, unit_price: 5000 },
          pending_update_data: { variant_id: newVariantId },
        })
      })

      it("refuses forced and manual runs of a cycle awaiting its payment, writes nothing, and keeps it off the scheduler's due list", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, { reference: "SUB-AWAITING-REFUSE" })
        const scheduled = await createRenewalCycleSeed(container, {
          subscription_id: "sub_due_scheduled",
          scheduled_for: seeded.scheduledFor,
        })
        const input = { renewal_cycle_id: seeded.cycle.id, triggered_by: "admin_awaiting" }
        const refusal = {
          type: MedusaError.Types.CONFLICT,
          message: renewalErrors.awaitingPayment(seeded.cycle.id).message,
        }

        await expect(forceRenewalCycleWorkflow(container).run({ input })).rejects.toMatchObject(refusal)
        await expect(
          processRenewalCycleWorkflow(container).run({ input: { ...input, trigger_type: "manual" } })
        ).rejects.toMatchObject(refusal)

        const state = await readRenewalState(getContainer(), seeded)
        const forceEntries = await activityLog().listSubscriptionLogs({
          subscription_id: seeded.subscription.id,
          event_type: ActivityLogEventType.RENEWAL_FORCE_REQUESTED,
        })
        const due = await renewals().listDueRenewalCyclesForWindow({
          dueBefore: new Date(Date.now() + DAY_MS),
          cursor: "",
          limit: 100,
        })
        const dueIds = due.map((record) => record.id)

        expect(state.cycle).toMatchObject({
          status: RenewalCycleStatus.AWAITING_PAYMENT,
          attempt_count: 1,
        })
        expect(state.attempts).toEqual(only({ status: RenewalAttemptStatus.PROCESSING }))
        expect(forceEntries).toHaveLength(0)
        expect(dueIds).toContain(scheduled.id)
        expect(dueIds).not.toContain(seeded.cycle.id)
      })

      it("keeps a parked cycle awaiting its payment when a later step of the run fails", async () => {
        const orderId = "ord_awaiting_late_failure"
        const seeded = await seedDueRenewal({ dueAt: new Date("2026-05-15T10:00:00.000Z"), orderId })
        answerAuthorizationWithNull(getContainer())
        failRenewalLockReleaseOnce(getContainer(), seeded.subscription.id, "lock store unavailable")

        await expect(runRenewal(getContainer(), seeded.cycle.id)).rejects.toMatchObject({
          message: expect.stringContaining("lock store unavailable"),
        })

        const state = await readRenewalState(getContainer(), seeded)

        expect(state.attempts).toEqual(
          only({ status: RenewalAttemptStatus.PROCESSING, payment_reference: seeded.sessionIds[0] })
        )
        expect(state.cycle).toMatchObject({
          status: RenewalCycleStatus.AWAITING_PAYMENT,
          generated_order_id: orderId,
          settlement_inputs: { attempt_id: state.attempts[0].id },
        })
        expect(state.failedLogs).toHaveLength(0)
        expect(state.cases).toHaveLength(0)
      })

      it("leaves a cycle settled as succeeded while the run waited on authorisation, closing its attempt as succeeded", async () => {
        const orderId = "ord_settled_during_run"
        const seeded = await seedDueRenewal({ dueAt: new Date("2026-05-17T10:00:00.000Z"), orderId })

        jest.spyOn(payments(), "authorizePaymentSession").mockImplementation(async () => {
          await renewals().updateRenewalCycles({
            id: seeded.cycle.id,
            status: RenewalCycleStatus.SUCCEEDED,
          })

          return null as never
        })

        expect(await runRenewal(getContainer(), seeded.cycle.id)).toMatchObject({
          outcome: RenewalRunOutcome.SUCCEEDED,
        })

        const state = await readRenewalState(getContainer(), seeded)

        expect(state.cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(state.attempts).toEqual(
          only({
            status: RenewalAttemptStatus.SUCCEEDED,
            payment_reference: seeded.sessionIds[0],
            order_id: orderId,
            finished_at: expect.anything(),
          })
        )
        expect(state.succeededLogs).toHaveLength(0)
      })

      it("settles the cycle in the same run when authorisation returns a payment", async () => {
        const dueAt = new Date("2026-05-16T10:00:00.000Z")
        const orderId = "ord_sync_settled"
        const seeded = await seedDueRenewal({ dueAt, orderId })

        expect(await runRenewal(getContainer(), seeded.cycle.id)).toMatchObject({
          outcome: RenewalRunOutcome.SUCCEEDED,
          renewal_cycle: { id: seeded.cycle.id, status: RenewalCycleStatus.SUCCEEDED },
        })

        const state = await readRenewalState(getContainer(), seeded)

        expect(state.cycle).toMatchObject({
          status: RenewalCycleStatus.SUCCEEDED,
          generated_order_id: orderId,
        })
        expect(state.attempts).toEqual(only({ status: RenewalAttemptStatus.SUCCEEDED }))
        expect(
          await payments().listPayments({ payment_session_id: seeded.sessionIds[0] })
        ).toEqual(only({ captured_at: expect.anything() }))
        expect(new Date(state.subscription.next_renewal_at!).getTime()).toBeGreaterThan(dueAt.getTime())
        expect(state.subscription.last_renewal_at).toBeTruthy()
        expect(state.succeededLogs).toHaveLength(1)
        expect(state.otherCycles).toEqual(only({ status: RenewalCycleStatus.SCHEDULED }))
      })
    })

    describe("payment.captured for a renewal cycle awaiting payment", () => {
      it.each([
        { name: "once", deliveries: 1 },
        { name: "twice at the same time", deliveries: 2 },
      ])("settles once, from the cycle's due date and with the stored inputs, when the capture is delivered $name", async ({ deliveries }) => {
        const reference = `SUB-AWAIT-SETTLE-${deliveries}`
        const scheduledFor = new Date(Date.now() - 3 * DAY_MS)
        const seeded = await seedAwaitingRenewal(getContainer(), {
          reference,
          scheduled_for: scheduledFor,
        })
        const payment = await captureOnOrder(getContainer(), seeded.order.id, seeded.session.id)

        await Promise.all(Array.from({ length: deliveries }, () => deliverCapture(getContainer(), payment.id)))

        const state = await readRenewalState(getContainer(), seeded)

        expect(state.cycle).toMatchObject({
          status: RenewalCycleStatus.SUCCEEDED,
          generated_order_id: seeded.order.id,
        })
        expect(state.attempts).toEqual(
          only({
            id: seeded.attempt.id,
            status: RenewalAttemptStatus.SUCCEEDED,
            order_id: seeded.order.id,
          })
        )
        expect(state.subscription.next_renewal_at).toEqual(oneMonthAfter(scheduledFor))
        expect(state.otherCycles).toEqual(
          only({ status: RenewalCycleStatus.SCHEDULED, scheduled_for: oneMonthAfter(scheduledFor) })
        )
        expect(state.succeededLogs).toEqual(
          only({
            metadata: expect.objectContaining({
              order_id: seeded.order.id,
              correlation_id: `renewal-scheduler-${reference}`,
            }),
          })
        )
      })

      describe("a plan change and a skip the customer requested while the charge was pending", () => {
        async function seedAwaitingPlanChange(reference: string) {
          const container = getContainer()
          const { product, variant } = await createProductWithVariant(container)

          await createPlanOfferSeed(container, {
            name: `Awaiting newer requests ${reference}`,
            scope: PlanOfferScope.VARIANT,
            product_id: product.id,
            variant_id: variant.id,
            is_enabled: true,
            allowed_frequencies: [
              { interval: FrequencyInterval.MONTH, value: 3 },
              { interval: FrequencyInterval.MONTH, value: 6 },
            ],
          })
          const seeded = await seedAwaitingRenewal(container, { reference })
          const applied = {
            variant_id: variant.id,
            variant_title: variant.title,
            sku: variant.sku ?? null,
            frequency_interval: FrequencyInterval.MONTH,
            frequency_value: 3,
            effective_at: null,
            requested_at: new Date(Date.now() - DAY_MS).toISOString(),
          }

          await subscriptions().updateSubscriptions({
            id: seeded.subscription.id,
            product_id: product.id,
            variant_id: variant.id,
            pending_update_data: { ...applied, requested_by: null },
          })
          await renewals().updateRenewalCycles({
            id: seeded.cycle.id,
            applied_pending_update_data: applied,
          })

          return { seeded, variant }
        }

        async function requestWhileAwaiting(subscriptionId: string) {
          await scheduleSubscriptionPlanChangeWorkflow(getContainer()).run({
            input: {
              id: subscriptionId,
              variant_id: (await subscriptions().retrieveSubscription(subscriptionId)).variant_id,
              frequency_interval: FrequencyInterval.MONTH,
              frequency_value: 6,
            },
          })
          await skipNextDeliveryWorkflow(getContainer()).run({ input: { id: subscriptionId } })

          return (await subscriptions().retrieveSubscription(subscriptionId)).pending_update_data
        }

        async function settleOnCapture(seeded: SeededAwaitingRenewal) {
          const payment = await captureOnOrder(getContainer(), seeded.order.id, seeded.session.id)

          await deliverCapture(getContainer(), payment.id)

          return await readRenewalState(getContainer(), seeded)
        }

        it("applies the cycle's own plan change and keeps the newer change and the skip for the next cycle", async () => {
          const { seeded, variant } = await seedAwaitingPlanChange("SUB-AWAIT-NEWER-REQUESTS")
          const newerChange = await requestWhileAwaiting(seeded.subscription.id)

          const state = await settleOnCapture(seeded)

          expect(newerChange).toMatchObject({ frequency_value: 6 })
          expect(state.cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
          expect(state.subscription).toMatchObject({
            variant_id: variant.id,
            frequency_interval: FrequencyInterval.MONTH,
            frequency_value: 3,
            skip_next_cycle: true,
            pending_update_data: newerChange,
          })
        })

        it("clears the change the cycle applied and resets a skip when its inputs predate the skip record", async () => {
          const { seeded } = await seedAwaitingPlanChange("SUB-AWAIT-LEGACY-INPUTS")
          const { consumed_skip_next_cycle: _recorded, ...legacyInputs } = (
            await renewals().retrieveRenewalCycle(seeded.cycle.id)
          ).settlement_inputs as Record<string, unknown>

          // An update merges into the stored JSON, so clear it before writing it back without the record.
          await renewals().updateRenewalCycles({ id: seeded.cycle.id, settlement_inputs: null })
          await renewals().updateRenewalCycles({ id: seeded.cycle.id, settlement_inputs: legacyInputs })
          await skipNextDeliveryWorkflow(getContainer()).run({ input: { id: seeded.subscription.id } })

          const state = await settleOnCapture(seeded)

          expect(state.cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
          expect(state.subscription).toMatchObject({
            frequency_value: 3,
            skip_next_cycle: false,
            pending_update_data: null,
          })
        })
      })

      it("leaves the cycle awaiting until the order is paid up", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, { reference: "SUB-AWAIT-PARTIAL" })
        const payment = await authorizePaymentSessionOrThrow(container, seeded.session.id)

        await payments().capturePayment({ payment_id: payment.id, amount: 40 })
        await recordOrderCaptureTransactions(container, seeded.order.id, payment.id)
        expect((await loadOrderAmounts(container, seeded.order.id)).pending).toEqual(60)

        await deliverCapture(getContainer(), payment.id)

        const partlyPaid = await readRenewalState(getContainer(), seeded)

        expect(partlyPaid.cycle.status).toEqual(RenewalCycleStatus.AWAITING_PAYMENT)
        expect(partlyPaid.attempts).toEqual(only({ status: RenewalAttemptStatus.PROCESSING }))
        expect(partlyPaid.subscription.next_renewal_at).toEqual(seeded.scheduledFor)
        expect(partlyPaid.succeededLogs).toHaveLength(0)

        await payments().capturePayment({ payment_id: payment.id, amount: 60 })
        await recordOrderCaptureTransactions(container, seeded.order.id, payment.id)
        expect((await loadOrderAmounts(container, seeded.order.id)).pending).toEqual(0)

        await deliverCapture(getContainer(), payment.id)

        const paidUp = await readRenewalState(getContainer(), seeded)

        expect(paidUp.cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(paidUp.subscription.next_renewal_at).toEqual(oneMonthAfter(seeded.scheduledFor))
      })

      it("schedules the next renewal of a settlement that moved the dates but could not close its cycle, once the sweep closes that cycle as superseded without moving a date again", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, { reference: "SUB-AWAIT-HALF-SETTLED" })

        failOnce(
          renewals(),
          "updateRenewalCycles",
          (data) => data.status === RenewalCycleStatus.SUCCEEDED,
          "the cycle could not be written"
        )

        const payment = await captureOnOrder(container, seeded.order.id, seeded.session.id)

        await deliverCapture(container, payment.id)

        const halfSettled = await readRenewalState(container, seeded)

        await reconcileAwaitingRenewalCycles(container)

        const state = await readRenewalState(container, seeded)
        const nextRenewalAt = oneMonthAfter(seeded.scheduledFor)

        expect(halfSettled.cycle.status).toEqual(RenewalCycleStatus.AWAITING_PAYMENT)
        expect(halfSettled.subscription.next_renewal_at).toEqual(nextRenewalAt)
        expect(state.cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(state.subscription.next_renewal_at).toEqual(nextRenewalAt)
        expect(state.subscription.last_renewal_at).toEqual(halfSettled.subscription.last_renewal_at)
        expect(state.otherCycles).toEqual([
          expect.objectContaining({ status: RenewalCycleStatus.SCHEDULED, scheduled_for: nextRenewalAt }),
        ])
      })

      it("settles when refreshing the payment context fails", async () => {
        const seeded = await seedAwaitingWithSavedCard("SUB-AWAIT-REFRESH-FAILS")
        const payment = await captureOnOrder(getContainer(), seeded.order.id, seeded.session.id)

        jest
          .spyOn(payments(), "listPaymentMethods")
          .mockRejectedValue(new Error("payment provider unavailable"))

        await expect(deliverCapture(getContainer(), payment.id)).rejects.toThrow(
          "payment provider unavailable"
        )

        expect((await readRenewalState(getContainer(), seeded)).cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
      })

      it("settles and raises an alertable entry, without failing the delivery, when the dunning lookup fails", async () => {
        const seeded = await seedAwaitingWithSavedCard("SUB-AWAIT-DUNNING-LOOKUP-FAILS")
        const payment = await captureOnOrder(getContainer(), seeded.order.id, seeded.session.id)
        const dunningModule = dunning()
        const list = dunningModule.listDunningCases.bind(dunningModule)

        jest.spyOn(dunningModule, "listDunningCases").mockImplementation(async (filters, config) => {
          if (filters && "renewal_order_id" in filters) {
            throw new Error("dunning store unavailable")
          }

          return await list(filters, config)
        })
        const logEntries = watchLogs(getContainer())

        await expect(deliverCapture(getContainer(), payment.id)).resolves.toBeUndefined()

        expect((await readRenewalState(getContainer(), seeded)).cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(logEntries({ event: SubscriptionLogEvents.DUNNING_RECOVERY_FROM_CAPTURE_FAILED })).toEqual(
          only({
            subscription_id: seeded.subscription.id,
            order_id: seeded.order.id,
            dunning_case_id: null,
            payment_id: payment.id,
            alertable: true,
          })
        )
      })

      it("still refreshes the payment context and recovers dunning when the settlement fails", async () => {
        const seeded = await seedAwaitingWithSavedCard("SUB-AWAIT-SETTLE-FAIL")
        const dunningCase = await createDunningCaseSeed(getContainer(), {
          subscription_id: seeded.subscription.id,
          renewal_cycle_id: seeded.cycle.id,
          renewal_order_id: seeded.order.id,
          status: DunningCaseStatus.RETRY_SCHEDULED,
        })
        const payment = await captureOnOrder(getContainer(), seeded.order.id, seeded.session.id)

        jest.spyOn(payments(), "listPaymentMethods").mockResolvedValue([
          { id: "pm_new", provider_id: SYSTEM_PAYMENT_PROVIDER_ID, data: { created: 2 } },
        ])
        jest
          .spyOn(subscriptions(), "retrieveSubscription")
          .mockRejectedValueOnce(new Error("renewal settlement failed"))
        const logEntries = watchLogs(getContainer())

        await deliverCapture(getContainer(), payment.id)

        const state = await readRenewalState(getContainer(), seeded)

        expect(logEntries({ event: SubscriptionLogEvents.RENEWAL_SETTLEMENT_FROM_CAPTURE_FAILED })).toEqual(
          only({
            renewal_cycle_id: seeded.cycle.id,
            subscription_id: seeded.subscription.id,
            payment_id: payment.id,
          })
        )
        expect(state.subscription.payment_context?.payment_method_id).toEqual("pm_new")
        expect((await dunning().retrieveDunningCase(dunningCase.id)).status).toEqual(
          DunningCaseStatus.RECOVERED
        )
      })

      it("settles a paid cycle on the sweep and leaves an unpaid one awaiting", async () => {
        const container = getContainer()
        const paid = await seedAwaitingRenewal(container, { reference: "SUB-AWAIT-SWEEP-PAID" })
        const unpaid = await seedAwaitingRenewal(container, { reference: "SUB-AWAIT-SWEEP-UNPAID" })
        await captureOnOrder(container, paid.order.id, paid.session.id)

        await reconcileAwaitingRenewalCycles(container)

        const paidState = await readRenewalState(container, paid)
        const unpaidState = await readRenewalState(container, unpaid)

        expect(paidState.cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(paidState.attempts).toEqual(
          only({ id: paid.attempt.id, status: RenewalAttemptStatus.SUCCEEDED })
        )
        expect(paidState.subscription.next_renewal_at).toEqual(oneMonthAfter(paid.scheduledFor))
        expect(paidState.otherCycles).toEqual(only({ status: RenewalCycleStatus.SCHEDULED }))
        expect(unpaidState.cycle.status).toEqual(RenewalCycleStatus.AWAITING_PAYMENT)
        expect(unpaidState.attempts).toEqual(only({ status: RenewalAttemptStatus.PROCESSING }))
        expect(unpaidState.subscription.next_renewal_at).toEqual(unpaid.scheduledFor)
      })
    })

    describe("a failed or canceled payment for a renewal cycle awaiting payment", () => {
      it.each([
        { action: PaymentActions.FAILED, reason: "declined", namesAttempt: true },
        { action: PaymentActions.CANCELED, reason: undefined, namesAttempt: false },
      ])("fails the cycle and opens dunning once on '$action' with reason $reason (session names its attempt: $namesAttempt), and changes nothing when delivered again", async ({ action, reason, namesAttempt }) => {
        const seeded = await seedAwaitingRenewal(getContainer(), { reference: `SUB-FAIL-${action}` })
        const sessionId = namesAttempt ? await useSessionNamingAttempt(seeded) : seeded.session.id
        const errorCode = reason ?? action
        const emitted = watchEvents(getContainer())

        const before = Date.now()
        await deliverFailure(getContainer(), sessionId, { action, reason })
        const after = Date.now()

        const state = await readRenewalState(getContainer(), seeded)

        expect(state.cycle).toMatchObject({
          status: RenewalCycleStatus.FAILED,
          generated_order_id: seeded.order.id,
          last_error: expect.stringContaining(action),
        })
        expect(state.attempts).toEqual(
          only({
            id: seeded.attempt.id,
            status: RenewalAttemptStatus.FAILED,
            error_code: errorCode,
            payment_reference: sessionId,
            finished_at: expect.anything(),
          })
        )
        expect(state.subscription.status).toEqual(SubscriptionStatus.PAST_DUE)
        expect(state.cases).toEqual(
          only({
            renewal_cycle_id: seeded.cycle.id,
            renewal_order_id: seeded.order.id,
            status: DunningCaseStatus.RETRY_SCHEDULED,
            last_payment_error_code: errorCode,
          })
        )

        const nextRetryAt = new Date(state.cases[0].next_retry_at!).getTime()

        expect(nextRetryAt).toBeGreaterThanOrEqual(before + FIRST_RETRY_MS)
        expect(nextRetryAt).toBeLessThanOrEqual(after + FIRST_RETRY_MS)
        expect(emitted(DunningEvents.STARTED).map((message) => message.data)).toEqual(
          only({
            subscription_id: seeded.subscription.id,
            dunning_case_id: state.cases[0].id,
            renewal_cycle_id: seeded.cycle.id,
          })
        )
        expect(state.failedLogs).toHaveLength(1)

        await deliverFailure(getContainer(), sessionId, { action, reason })

        const replayed = await readRenewalState(getContainer(), seeded)

        expect(replayed.cycle).toEqual(state.cycle)
        expect(replayed.attempts).toEqual(state.attempts)
        expect(replayed.cases).toEqual(state.cases)
        expect(replayed.subscription.status).toEqual(SubscriptionStatus.PAST_DUE)
        expect(replayed.failedLogs).toHaveLength(1)
        expect(emitted(DunningEvents.STARTED)).toHaveLength(1)
      })

      it("leaves a cycle whose order was paid another way meanwhile for the sweep to settle, failing nothing and opening no dunning", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, { reference: "SUB-FAIL-PAID-ELSEWHERE" })
        const customer = await createPaymentSessionFixture(container, { amount: AWAITING_ORDER_TOTAL })

        await captureOnOrder(container, seeded.order.id, customer.session.id, { linkCollection: true })

        const before = await readRenewalState(container, seeded)
        const emitted = watchEvents(container)

        await deliverFailure(container, seeded.session.id, { reason: "declined" })

        expect(await readRenewalState(container, seeded)).toEqual(before)
        expect(emitted(DunningEvents.STARTED)).toHaveLength(0)

        await reconcileAwaitingRenewalCycles(container)

        const settled = await readRenewalState(container, seeded)

        expect(settled.cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(settled.cases).toHaveLength(0)
        expect(settled.subscription.status).toEqual(SubscriptionStatus.ACTIVE)
      })

      it("fails the cycle but opens no dunning case when the subscription is paused", async () => {
        const seeded = await seedAwaitingRenewal(getContainer(), {
          reference: "SUB-FAIL-PAUSED",
          subscription_status: SubscriptionStatus.PAUSED,
        })
        const emitted = watchEvents(getContainer())

        await deliverFailure(getContainer(), seeded.session.id, {
          action: PaymentActions.FAILED,
          reason: "declined",
        })

        const state = await readRenewalState(getContainer(), seeded)

        expect(state.cycle).toMatchObject({
          status: RenewalCycleStatus.FAILED,
          generated_order_id: seeded.order.id,
        })
        expect(state.attempts).toEqual(
          only({ status: RenewalAttemptStatus.FAILED, error_code: "declined" })
        )
        expect(state.subscription.status).toEqual(SubscriptionStatus.PAUSED)
        expect(state.cases).toHaveLength(0)
        expect(emitted(DunningEvents.STARTED)).toHaveLength(0)
      })

      it("only closes the in-flight attempt of a cycle that already succeeded when its session fails, leaving the subscription's processing cycle alone", async () => {
        const container = getContainer()
        const settled = await seedAwaitingRenewal(container, {
          reference: "SUB-FAIL-STALE",
          cycle_status: RenewalCycleStatus.SUCCEEDED,
        })
        const current = {
          subscription: settled.subscription,
          cycle: await createRenewalCycleSeed(container, {
            subscription_id: settled.subscription.id,
            status: RenewalCycleStatus.PROCESSING,
            attempt_count: 1,
          }),
        }
        await createRenewalAttemptSeed(container, {
          renewal_cycle_id: current.cycle.id,
          status: RenewalAttemptStatus.PROCESSING,
        })
        const emitted = watchEvents(getContainer())
        const before = [await readRenewalState(container, settled), await readRenewalState(container, current)]

        await deliverFailure(container, settled.session.id, {
          action: PaymentActions.FAILED,
          reason: "declined",
        })

        const after = [await readRenewalState(container, settled), await readRenewalState(container, current)]

        expect(after).toEqual([
          {
            ...before[0],
            attempts: [
              {
                ...before[0].attempts[0],
                status: RenewalAttemptStatus.FAILED,
                error_code: "declined",
                error_message: expect.stringMatching(/after the renewal had closed/),
                finished_at: expect.any(Date),
                updated_at: expect.any(Date),
              },
            ],
          },
          before[1],
        ])
        expect(after[1].cycle.status).toEqual(RenewalCycleStatus.PROCESSING)
        expect(after[0].subscription.status).toEqual(SubscriptionStatus.ACTIVE)
        expect(after[0].cases).toHaveLength(0)
        expect(emitted(DunningEvents.STARTED)).toHaveLength(0)
      })
    })

    it("leaves the approval fields of an awaiting cycle as they are when the next cycle is ensured", async () => {
      const container = getContainer()
      const seeded = await seedAwaitingRenewal(container, {
        reference: "SUB-AWAITING-WITH-PENDING-CHANGE",
      })

      await subscriptions().updateSubscriptions({
        id: seeded.subscription.id,
        pending_update_data: {
          variant_id: "variant_pending_change",
          variant_title: "Pending Variant",
          sku: "PENDING-SKU",
          frequency_interval: FrequencyInterval.MONTH,
          frequency_value: 1,
          effective_at: null,
          requested_at: new Date().toISOString(),
          requested_by: null,
        },
      })
      await ensureNextRenewalCycleWorkflow(container).run({
        input: { subscription_id: seeded.subscription.id },
      })

      expect(await renewals().retrieveRenewalCycle(seeded.cycle.id)).toMatchObject({
        status: RenewalCycleStatus.AWAITING_PAYMENT,
        approval_required: false,
        approval_status: null,
      })
    })

    describe("cancelling a subscription whose renewal awaits payment", () => {
      it("refuses an admin cancellation with a conflict and writes nothing while a renewal holds the lock, then ends the cycle without dunning, keeps its charge in flight, and reports a capture that arrives afterwards once for a refund", async () => {
        const container = getContainer()
        const headers = await createAdminAuthHeaders(container)
        const seeded = await seedAwaitingRenewal(container, { reference: "SUB-AWL-CANCEL" })
        const input = await cancellationInputFor(seeded)
        const cancel = () =>
          api.post(`/admin/subscriptions/${input.id}/cancel`, { reason: input.reason }, { headers })
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
              error_code: PaymentAttemptErrorCode.CAPTURED_AFTER_CLOSE,
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

      describe("when a write inside the cancellation fails", () => {
        const RENEWAL_LOG_FAILURE = { message: "the renewal log could not be written" }
        const CASE_WRITE_FAILURE = { message: "the cancellation case could not be written" }

        const failRenewalLogOnce = () =>
          failOnce(
            getContainer().resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE),
            "createSubscriptionLogs",
            (data) => data.event_type === ActivityLogEventType.RENEWAL_FAILED,
            RENEWAL_LOG_FAILURE.message
          )

        const failCaseFinalizeOnce = () =>
          failOnce(
            getContainer().resolve<CancellationModuleService>(CANCELLATION_MODULE),
            "updateCancellationCases",
            (data) => data.status === CancellationCaseStatus.CANCELED,
            CASE_WRITE_FAILURE.message
          )

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
      it.each([
        { status: SubscriptionStatus.CANCELLED, paid: false },
        { status: SubscriptionStatus.PAYMENT_FAILED, paid: false },
        { status: SubscriptionStatus.PAYMENT_FAILED, paid: true },
      ])(
        "ends an awaiting cycle left on a $status subscription instead of reporting it, and reports a capture on its order (paid: $paid) once for a refund",
        async ({ status, paid }) => {
          const container = getContainer()
          const seeded = await seedAwaitingRenewal(container, {
            reference: `SUB-AWL-SWEEP-${status}-${paid}`,
            subscription_status: status,
          })
          const payment = paid ? await captureOnOrder(container, seeded.order.id, seeded.session.id) : null
          const entries = watchLogs(container)

          const result = await reconcileAwaitingRenewalCycles(container)
          const state = await readRenewalState(container, seeded)

          expect(result).toMatchObject({
            ended_cancelled: 1,
            order_unpaid: 0,
            subscription_terminal: 0,
            late_captures: paid ? 1 : 0,
            failed: 0,
          })
          expect(state.cycle).toMatchObject({
            status: RenewalCycleStatus.FAILED,
            last_error: expect.stringMatching(/cancel/i),
          })
          expect(state.attempts).toEqual([
            expect.objectContaining({
              id: seeded.attempt.id,
              ...(paid
                ? { status: RenewalAttemptStatus.SUCCEEDED, error_code: PaymentAttemptErrorCode.CAPTURED_AFTER_CLOSE }
                : { status: RenewalAttemptStatus.PROCESSING }),
            }),
          ])
          expect(state.failedLogs).toEqual([expect.objectContaining({ actor_type: ActivityLogActorType.SYSTEM })])
          expect(state.cases).toHaveLength(0)
          expect(entries({ event: RenewalLogEvents.AWAITING_PAYMENT_OVERDUE })).toHaveLength(0)

          expect(await reconcileAwaitingRenewalCycles(container)).toMatchObject({ ended_cancelled: 0, late_captures: 0 })
          expect(emitted(SubscriptionEvents.LATE_PAYMENT_CAPTURED).map((message) => message.data)).toEqual(
            payment
              ? [
                  expect.objectContaining({
                    payment_id: payment.id,
                    renewal_cycle_id: seeded.cycle.id,
                    reason: LatePaymentCapturedReason.SUBSCRIPTION_TERMINAL,
                    refund_amount: AWAITING_ORDER_TOTAL,
                  }),
                ]
              : []
          )
        }
      )

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
            error_code: PaymentAttemptErrorCode.NO_PAYMENT_SIGNAL,
          }),
        ])
        expect(entries({ event: RenewalLogEvents.STALE_ATTEMPT_CLOSED })).toEqual([
          expect.objectContaining({ renewal_cycle_id: seeded.cycle.id, alertable: false }),
        ])
        expect(emitted(SubscriptionEvents.LATE_PAYMENT_CAPTURED)).toHaveLength(0)

        const payment = await captureOnOrder(container, seeded.order.id, seeded.session.id)

        await deliverCapture(container, payment.id)
        await deliverCapture(container, payment.id)

        expectCapturedAfterClose(
          (await readRenewalState(container, seeded)).attempts,
          emitted(SubscriptionEvents.LATE_PAYMENT_CAPTURED),
          {
            attempt: {},
            event: { payment_id: payment.id, reason: LatePaymentCapturedReason.SUBSCRIPTION_TERMINAL },
          }
        )
      })

      it("delivers again the lost capture of a charge left in flight on a closed cycle, reporting it once for a refund", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, { reference: "SUB-AWL-SWEEP-CAPTURED" })

        await cancelSubscriptionWorkflow(container).run({ input: { id: seeded.subscription.id } })

        const payment = await captureOnOrder(container, seeded.order.id, seeded.session.id)

        expect(await reconcileAwaitingRenewalCycles(container)).toMatchObject({ late_captures: 1 })
        expect(await reconcileAwaitingRenewalCycles(container)).toMatchObject({ late_captures: 0 })

        expectCapturedAfterClose(
          (await readRenewalState(container, seeded)).attempts,
          emitted(SubscriptionEvents.LATE_PAYMENT_CAPTURED),
          {
            attempt: {},
            event: {
              payment_id: payment.id,
              renewal_cycle_id: seeded.cycle.id,
              reason: LatePaymentCapturedReason.SUBSCRIPTION_TERMINAL,
            },
          }
        )
      })
    })

    describe("an awaiting charge whose payment session is gone", () => {
      it("raises an alertable entry on each sweep while nothing was captured on it, and changes nothing", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, { reference: "SUB-AWL-SESSION-GONE" })
        const entries = watchLogs(container)
        const missing = () => entries({ event: RenewalLogEvents.AWAITING_PAYMENT_SESSION_MISSING })

        expect(await reconcileAwaitingRenewalCycles(container)).toMatchObject({ session_missing: 0 })
        expect(missing()).toHaveLength(0)

        await container.resolve<IPaymentModuleService>(Modules.PAYMENT).deletePaymentSession(seeded.session.id)

        const before = await readRenewalState(container, seeded)

        expect(await reconcileAwaitingRenewalCycles(container)).toMatchObject({ order_unpaid: 1, session_missing: 1 })
        expect(missing()).toEqual([
          expect.objectContaining({
            renewal_cycle_id: seeded.cycle.id,
            alertable: true,
            metadata: expect.objectContaining({ payment_session_id: seeded.session.id }),
          }),
        ])
        expect(await readRenewalState(container, seeded)).toEqual(before)
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

      it("shows an admin when an awaiting charge was submitted and after when it can be resolved as failed by its own setting, not by the alert hours, and nothing for a cycle without a charge in flight, then fails it keeping the admin's reason off the storefront", async () => {
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
        const before = await readRenewalState(container, awaiting)
        const note = "card flagged by fraud team, ticket OPS-1234"
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

        await expect(api.post(route(awaiting.cycle.id), {}, { headers })).rejects.toMatchObject({
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
        expect(await readRenewalState(container, awaiting)).toEqual(before)

        process.env[AWAITING_PAYMENT_RESOLVE_MIN_HOURS_ENV] = "4"

        expect((await detail(awaiting.cycle.id)).awaiting_payment).toEqual(awaitingPayment(4))

        const resolved = await api.post(route(awaiting.cycle.id), { reason: note }, { headers })

        expect(resolved.data).toMatchObject({
          resolution: "failed",
          renewal: { id: awaiting.cycle.id, status: RenewalCycleStatus.FAILED, awaiting_payment: null },
        })

        const store = { headers: await createStoreCustomerHeaders(container, awaiting.subscription.customer_id) }
        const { subscription } = (
          await api.get(`/store/customers/me/subscriptions/${awaiting.subscription.id}`, store)
        ).data
        const { attempts, cases } = await readRenewalState(container, awaiting)

        expect(cases).toEqual([expect.objectContaining({ renewal_cycle_id: awaiting.cycle.id })])
        expect(subscription.payment_recovery.last_error_message).toEqual("Renewal payment never arrived")
        expect(JSON.stringify(subscription)).not.toContain(note)
        expect(attempts[0].metadata).toMatchObject({ admin_resolution: { reason: note } })
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
            last_error: "Renewal payment never arrived",
          })
          expect(state.attempts).toEqual([
            expect.objectContaining({
              id: seeded.attempt.id,
              status: RenewalAttemptStatus.FAILED,
              metadata: expect.objectContaining({
                admin_resolution: expect.objectContaining({ reason: "bank confirmed no transfer" }),
              }),
            }),
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
          entries({ event: RenewalLogEvents.JOB_CYCLE }).filter((entry) => entry.renewal_cycle_id === cycleId)

        expect((await readRenewalState(container, { subscription, cycle })).cycle.status).toEqual(
          RenewalCycleStatus.AWAITING_PAYMENT
        )
        expect(cycleEntries(cycle.id)).toEqual([
          expect.objectContaining({ outcome: "awaiting_payment", success_count: 0, failure_count: 0 }),
        ])
        expect(cycleEntries(owned.cycle.id)).toEqual([
          expect.objectContaining({ outcome: "blocked", alertable: false }),
        ])
        expect(entries({ event: RenewalLogEvents.JOB }).filter((entry) => entry.outcome === "completed")).toEqual([
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
            entries({ event: RenewalLogEvents.FORCE }).filter(
              (entry) => entry.renewal_cycle_id === owned.cycle.id && entry.outcome !== "started"
            )
          ).toEqual([
            expect.objectContaining({ outcome: "blocked", failure_kind: "dunning_owns_cycle", alertable: false }),
          ])
        }

        expect(chargeMocks.createOrderRun).not.toHaveBeenCalled()
        expect(chargeMocks.createPaymentSessionsRun).not.toHaveBeenCalled()
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

    describe("pausing while a renewal charge awaits the provider's answer", () => {
      it.each([
        {
          name: "a renewal is awaiting its payment",
          outcome: "was captured",
          cycleAfter: RenewalCycleStatus.SUCCEEDED,
          seed: async (reference: string) => {
            const seeded = await seedAwaitingRenewal(getContainer(), { reference })

            return {
              seeded,
              sessionId: seeded.session.id,
              charge: new RegExp(`renewal '${seeded.cycle.id}' is awaiting its payment`),
            }
          },
        },
        {
          name: "a renewal left processing after submitting its charge",
          outcome: "failed",
          cycleAfter: RenewalCycleStatus.FAILED,
          seed: async (reference: string) => {
            const seeded = await seedAwaitingRenewal(getContainer(), {
              reference,
              cycle_status: RenewalCycleStatus.PROCESSING,
            })

            return { seeded, sessionId: seeded.session.id, charge: /renewal '.+' has a charge in progress/ }
          },
        },
        ...[DunningCaseStatus.RETRYING, DunningCaseStatus.AWAITING_PAYMENT].map((status) => ({
          name: `a dunning case is ${status}`,
          outcome: "failed",
          cycleAfter: RenewalCycleStatus.FAILED,
          seed: async (reference: string) => {
            const seeded = await seedDunningCase(getContainer(), reference, { status })

            return {
              seeded,
              sessionId: seeded.attempts[0].session.id,
              charge: /dunning case '.+' has a retry charge in progress/,
            }
          },
        })),
      ])("refuses a pause while $name, and pauses once the charge $outcome", async ({ name, outcome, cycleAfter, seed }) => {
        const container = getContainer()
        const { seeded, sessionId, charge } = await seed(`SUB-AWP-PAUSE-${name}`)
        const id = seeded.subscription.id
        const admin = await asAdmin()
        const before = await readRenewalState(container, seeded)

        expect(await refusalOf(api.post(adminUrl(id, "pause"), {}, admin))).toMatchObject(
          adminRefusal("be paused", charge)
        )
        expect(await refusalOf(api.post(storeUrl(id, "pause"), {}, await asCustomer(id)))).toMatchObject(
          storeRefusal
        )
        expect(await readRenewalState(container, seeded)).toEqual(before)
        expect((await subscriptions().retrieveSubscription(id)).status).not.toEqual(SubscriptionStatus.PAUSED)
        await expectLockFree(container, renewalSubscriptionLockKey(id))

        if (outcome === "failed") {
          await deliverFailure(container, sessionId, { reason: "declined" })
        } else {
          const payment = await captureOnOrder(container, seeded.order.id, sessionId)
          await deliverCapture(container, payment.id)
        }

        const response = await api.post(adminUrl(id, "pause"), {}, admin)
        const paused = await readRenewalState(container, seeded)

        expect(response.status).toEqual(200)
        expect(paused.cycle.status).toEqual(cycleAfter)
        expect(paused.subscription).toMatchObject({
          status: SubscriptionStatus.PAUSED,
          next_renewal_at: expect.any(Date),
        })
        await expectLockFree(container, renewalSubscriptionLockKey(id))
      })

      it("answers a conflict and writes nothing while a renewal run holds the lock", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, {
          reference: "SUB-AWP-LOCKED",
          cycle_status: RenewalCycleStatus.SUCCEEDED,
        })
        const id = seeded.subscription.id
        const admin = await asAdmin()
        const customer = await asCustomer(id)
        const before = await readRenewalState(container, seeded)

        const [adminAnswer, storeAnswer] = await whileRenewalLockHeld(container, id, async () => [
          await refusalOf(api.post(adminUrl(id, "pause"), {}, admin)),
          await refusalOf(api.post(storeUrl(id, "pause"), {}, customer)),
        ])

        expect(adminAnswer).toMatchObject({
          status: 409,
          data: { type: "conflict", message: expect.stringContaining("is being updated by a renewal") },
        })
        expect(storeAnswer).toMatchObject({
          status: 409,
          data: {
            type: "conflict",
            message: "This subscription is already being updated. Please try again in a moment.",
          },
        })
        expect(await readRenewalState(container, seeded)).toEqual(before)
        await expectLockFree(container, renewalSubscriptionLockKey(id))
      })
    })

    describe("resuming while a renewal charge awaits the provider's answer", () => {
      it("refuses an admin resume with and without a resume date and a customer resume, creating no cycle, and resumes once the charge failed", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, {
          reference: "SUB-AWP-RESUME",
          subscription_status: SubscriptionStatus.PAUSED,
        })
        const id = seeded.subscription.id
        const admin = await asAdmin()
        const resumeAt = new Date(Date.now() + 7 * DAY_MS).toISOString()
        const charge = new RegExp(`renewal '${seeded.cycle.id}' is awaiting its payment`)
        const before = await readRenewalState(container, seeded)

        for (const body of [{}, { resume_at: resumeAt }]) {
          expect(await refusalOf(api.post(adminUrl(id, "resume"), body, admin))).toMatchObject(
            adminRefusal("be resumed", charge)
          )
        }
        expect(
          await refusalOf(api.post(storeUrl(id, "resume"), { resume_at: resumeAt }, await asCustomer(id)))
        ).toMatchObject(storeRefusal)
        expect(await readRenewalState(container, seeded)).toEqual(before)
        await expectLockFree(container, renewalSubscriptionLockKey(id))

        await deliverFailure(container, seeded.session.id, { reason: "declined" })

        const response = await api.post(adminUrl(id, "resume"), { resume_at: resumeAt }, admin)
        const resumed = await readRenewalState(container, seeded)

        expect(response.status).toEqual(200)
        expect(resumed.cycle.status).toEqual(RenewalCycleStatus.FAILED)
        expect(resumed.subscription).toMatchObject({
          status: SubscriptionStatus.ACTIVE,
          next_renewal_at: new Date(resumeAt),
        })
        expect(resumed.otherCycles).toEqual([
          expect.objectContaining({ status: RenewalCycleStatus.SCHEDULED, scheduled_for: new Date(resumeAt) }),
        ])
      })
    })

    describe("pausing or resuming while a dunning retry run holds its case", () => {
      it("refuses a pause, a pause offer and a resume with a conflict, writing nothing, until the run releases the case", async () => {
        const seeded = await seedDunningCase(getContainer(), "SUB-AWP-DUNNING-LOCK", {
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempts: [DunningAttemptStatus.FAILED],
        })
        const id = seeded.subscription.id
        const caseId = seeded.dunningCase.id
        const admin = await asAdmin()
        const customer = await asCustomer(id)
        const cancellationCase = await createCancellationCaseSeed(getContainer(), {
          subscription_id: id,
          status: CancellationCaseStatus.EVALUATING_RETENTION,
        })
        const pauseOffer = {
          offer_type: RetentionOfferType.PAUSE_OFFER,
          offer_payload: { pause_offer: { pause_cycles: 1, resume_at: null, note: null } },
        }
        const before = await subscriptions().retrieveSubscription(id)
        const busy = expect.objectContaining({ status: 409 })

        const refusals = await whileLockHeld(getContainer(), dunningCaseLockKey(caseId), async () => [
          await refusalOf(api.post(adminUrl(id, "pause"), {}, admin)),
          await refusalOf(api.post(storeUrl(id, "pause"), {}, customer)),
          await refusalOf(api.post(`/admin/cancellations/${cancellationCase.id}/apply-offer`, pauseOffer, admin)),
        ])

        expect(refusals).toEqual([busy, busy, busy])
        expect(refusals[1]).toMatchObject({
          data: { message: "This subscription is already being updated. Please try again in a moment." },
        })
        expect(await subscriptions().retrieveSubscription(id)).toEqual(before)
        expect(
          await cancellations().listRetentionOfferEvents({ cancellation_case_id: cancellationCase.id })
        ).toHaveLength(0)
        await expectLockFree(getContainer(), renewalSubscriptionLockKey(id))

        expect((await api.post(adminUrl(id, "pause"), {}, admin)).status).toEqual(200)
        await expectLockFree(getContainer(), dunningCaseLockKey(caseId))

        const resumeRefusal = await whileLockHeld(getContainer(), dunningCaseLockKey(caseId), () =>
          refusalOf(api.post(adminUrl(id, "resume"), {}, admin))
        )

        expect(resumeRefusal).toMatchObject({ status: 409 })
        expect((await subscriptions().retrieveSubscription(id)).status).toEqual(SubscriptionStatus.PAUSED)

        expect((await api.post(adminUrl(id, "resume"), {}, admin)).status).toEqual(200)
        await expectLockFree(getContainer(), dunningCaseLockKey(caseId))
        await expectLockFree(getContainer(), renewalSubscriptionLockKey(id))
      })

      it("applies a pause offer on a subscription with an active dunning case and lets go of that case's lock", async () => {
        const seeded = await seedDunningCase(getContainer(), "SUB-AWP-DUNNING-OFFER", {
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempts: [DunningAttemptStatus.FAILED],
        })
        const cancellationCase = await createCancellationCaseSeed(getContainer(), {
          subscription_id: seeded.subscription.id,
          status: CancellationCaseStatus.EVALUATING_RETENTION,
        })

        const response = await api.post(
          `/admin/cancellations/${cancellationCase.id}/apply-offer`,
          {
            offer_type: RetentionOfferType.PAUSE_OFFER,
            offer_payload: { pause_offer: { pause_cycles: 1, resume_at: null, note: null } },
          },
          await asAdmin()
        )

        expect(response.status).toEqual(200)
        expect((await subscriptions().retrieveSubscription(seeded.subscription.id)).status).toEqual(
          SubscriptionStatus.PAUSED
        )
        await expectLockFree(getContainer(), dunningCaseLockKey(seeded.dunningCase.id))
        await expectLockFree(getContainer(), renewalSubscriptionLockKey(seeded.subscription.id))
      })
    })

    describe("accepting a retention offer while a renewal charge awaits the provider's answer", () => {
      const applyOffer = (caseId: string, body: Record<string, unknown>, options: RequestOptions) =>
        api.post(`/admin/cancellations/${caseId}/apply-offer`, body, options)
      const pauseOffer = {
        offer_type: RetentionOfferType.PAUSE_OFFER,
        offer_payload: { pause_offer: { pause_cycles: 1, resume_at: null, note: null } },
      }
      const bonusOffer = {
        offer_type: RetentionOfferType.BONUS_OFFER,
        offer_payload: {
          bonus_offer: { bonus_type: "gift", value: null, label: "Mug", duration_cycles: null, note: null },
        },
      }

      async function seedCaseOnAwaitingRenewal(reference: string) {
        const seeded = await seedAwaitingRenewal(getContainer(), { reference })
        const cancellationCase = await createCancellationCaseSeed(getContainer(), {
          subscription_id: seeded.subscription.id,
          status: CancellationCaseStatus.EVALUATING_RETENTION,
        })

        return { seeded, cancellationCase }
      }

      it("refuses a pause offer without recording it, then applies it once the capture settled the renewal", async () => {
        const container = getContainer()
        const admin = await asAdmin()
        const { seeded, cancellationCase } = await seedCaseOnAwaitingRenewal("SUB-AWP-OFFER-PAUSE")
        const caseBefore = await cancellations().retrieveCancellationCase(cancellationCase.id)
        const renewalBefore = await readRenewalState(container, seeded)

        expect(await refusalOf(applyOffer(cancellationCase.id, pauseOffer, admin))).toMatchObject(
          adminRefusal("be paused", new RegExp(`renewal '${seeded.cycle.id}' is awaiting its payment`))
        )
        expect(await cancellations().retrieveCancellationCase(cancellationCase.id)).toEqual(caseBefore)
        expect(
          await cancellations().listRetentionOfferEvents({ cancellation_case_id: cancellationCase.id })
        ).toHaveLength(0)
        expect(await readRenewalState(container, seeded)).toEqual(renewalBefore)
        await expectLockFree(getContainer(), renewalSubscriptionLockKey(seeded.subscription.id))

        const payment = await captureOnOrder(container, seeded.order.id, seeded.session.id)
        await deliverCapture(container, payment.id)

        const response = await applyOffer(cancellationCase.id, pauseOffer, admin)

        expect(response.status).toEqual(200)
        expect(await cancellations().retrieveCancellationCase(cancellationCase.id)).toMatchObject({
          status: CancellationCaseStatus.PAUSED,
        })
        expect((await subscriptions().retrieveSubscription(seeded.subscription.id)).status).toEqual(
          SubscriptionStatus.PAUSED
        )
      })

      it("applies an offer that does not pause the subscription", async () => {
        const admin = await asAdmin()
        const { seeded, cancellationCase } = await seedCaseOnAwaitingRenewal("SUB-AWP-OFFER-BONUS")

        const response = await applyOffer(cancellationCase.id, bonusOffer, admin)

        expect(response.status).toEqual(200)
        expect(await cancellations().retrieveCancellationCase(cancellationCase.id)).toMatchObject({
          status: CancellationCaseStatus.RETAINED,
        })
        expect((await readRenewalState(getContainer(), seeded)).cycle.status).toEqual(
          RenewalCycleStatus.AWAITING_PAYMENT
        )
        await expectLockFree(getContainer(), renewalSubscriptionLockKey(seeded.subscription.id))
      })
    })
  },
})

jest.setTimeout(120 * 1000)
