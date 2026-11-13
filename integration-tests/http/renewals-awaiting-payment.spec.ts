import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
  PaymentActions,
} from "@medusajs/framework/utils"
import { FrequencyInterval } from "../../src/common/types/frequency-interval"
import { reconcileAwaitingRenewalCycles } from "../../src/jobs/reconcile-awaiting-renewal-cycles"
import { ACTIVITY_LOG_MODULE } from "../../src/modules/activity-log"
import type ActivityLogModuleService from "../../src/modules/activity-log/service"
import { ActivityLogEventType } from "../../src/modules/activity-log/types"
import { DUNNING_MODULE } from "../../src/modules/dunning"
import { DunningEvents } from "../../src/modules/dunning/events"
import type DunningModuleService from "../../src/modules/dunning/service"
import { DunningCaseStatus } from "../../src/modules/dunning/types"
import { PlanOfferScope } from "../../src/modules/plan-offer/types"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import { RenewalAttemptStatus, RenewalCycleStatus } from "../../src/modules/renewal/types"
import { renewalErrors } from "../../src/modules/renewal/utils/errors"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { type SubscriptionSourceSnapshot, SubscriptionStatus } from "../../src/modules/subscription/types"
import { forceRenewalCycleWorkflow, processRenewalCycleWorkflow } from "../../src/workflows"
import { loadOrderAmounts } from "../../src/workflows/steps/run-dunning-retry"
import { recordOrderCaptureTransactions } from "../../src/workflows/utils/record-order-capture-transactions"
import {
  type SeededAwaitingRenewal,
  failRenewalLockReleaseOnce,
  oneMonthAfter,
  readRenewalState,
  renewalLockKey,
  seedAwaitingRenewal,
} from "../helpers/awaiting-renewal-fixtures"
import { createDunningCaseSeed } from "../helpers/dunning-fixtures"
import {
  SYSTEM_PAYMENT_PROVIDER_ID,
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
  createRenewalAttemptSeed,
  createRenewalCycleSeed,
  createSubscriptionSeed,
} from "../helpers/renewal-fixtures"
import { watchEvents, watchLogs } from "../helpers/spy-fixtures"

const mockCreateOrderRun = jest.fn()
const mockCreateOrUpdateOrderPaymentCollectionRun = jest.fn()
const mockCreatePaymentSessionsRun = jest.fn()

jest.mock("@medusajs/medusa/core-flows", () => ({
  ...jest.requireActual("@medusajs/medusa/core-flows"),
  createOrderWorkflow: () => ({ run: mockCreateOrderRun }),
  createOrUpdateOrderPaymentCollectionWorkflow: () => ({
    run: mockCreateOrUpdateOrderPaymentCollectionRun,
  }),
  createPaymentSessionsWorkflow: () => ({ run: mockCreatePaymentSessionsRun }),
}))

const stubRenewalCharge = createRenewalChargeStub({
  createOrderRun: mockCreateOrderRun,
  createOrUpdateOrderPaymentCollectionRun: mockCreateOrUpdateOrderPaymentCollectionRun,
  createPaymentSessionsRun: mockCreatePaymentSessionsRun,
})

const DAY_MS = 24 * 60 * 60 * 1000
const FIRST_RETRY_MS = 1440 * 60 * 1000
const PLAN_PRODUCT_ID = "prod_awaiting_plan"

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

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: { JWT_SECRET: "supersecret", COOKIE_SECRET: "supersecret" },
  testSuite: ({ getContainer }) => {
    const renewals = () => getContainer().resolve<RenewalModuleService>(RENEWAL_MODULE)
    const subscriptions = () => getContainer().resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
    const dunning = () => getContainer().resolve<DunningModuleService>(DUNNING_MODULE)
    const activityLog = () => getContainer().resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)
    const payments = () => getContainer().resolve(Modules.PAYMENT)

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

    beforeEach(() => {
      jest.restoreAllMocks()
      jest.clearAllMocks()
    })

    describe("a renewal run whose charge is confirmed later", () => {
      it("parks the cycle when authorisation answers null, keeping the order, the settlement inputs and the subscription's dates", async () => {
        const locking = getContainer().resolve(Modules.LOCKING)
        const dueAt = new Date("2026-05-10T10:00:00.000Z")
        const orderId = "ord_awaiting_parked"
        const seeded = await seedDueRenewal({ dueAt, orderId })
        answerAuthorizationWithNull(getContainer())
        const logEntries = watchLogs(getContainer())

        await runRenewal(getContainer(), seeded.cycle.id, "corr-awaiting-park")

        const state = await readRenewalState(getContainer(), seeded)

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
          logEntries({ event: "renewal.execution" })
            .filter((entry) => entry.renewal_cycle_id === seeded.cycle.id)
            .map((entry) => entry.outcome)
        ).toEqual(["started", "awaiting_payment"])
        await expect(
          locking.acquire(renewalLockKey(seeded.subscription.id), { ownerId: "lock-probe", expire: 5 })
        ).resolves.toBeUndefined()
        await locking.release(renewalLockKey(seeded.subscription.id), { ownerId: "lock-probe" })
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
        await subscriptions().updateSubscriptions({
          id: seeded.subscription.id,
          pending_update_data: {
            variant_id: newVariantId,
            variant_title: "New Variant",
            sku: "NEW-SKU",
            frequency_interval: FrequencyInterval.MONTH,
            frequency_value: 1,
            effective_at: null,
            requested_at: new Date().toISOString(),
            requested_by: null,
          },
        })
        answerAuthorizationWithNull(getContainer())

        await runRenewal(getContainer(), seeded.cycle.id)

        const state = await readRenewalState(getContainer(), seeded)

        expect(state.cycle).toMatchObject({
          status: RenewalCycleStatus.AWAITING_PAYMENT,
          settlement_inputs: {
            source_snapshot: { product_id, variant_id, title, quantity, unit_price, sku },
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

        await runRenewal(getContainer(), seeded.cycle.id)

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

        await runRenewal(getContainer(), seeded.cycle.id)

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

      it("leaves the cycle awaiting until the order is paid up", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, { reference: "SUB-AWAIT-PARTIAL" })
        const payment = await payments().authorizePaymentSession(seeded.session.id, {})

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

      it("closes the cycle without moving any date once billing has moved past it", async () => {
        const seeded = await seedAwaitingRenewal(getContainer(), { reference: "SUB-AWAIT-MOVED" })
        const movedTo = oneMonthAfter(seeded.scheduledFor)
        await subscriptions().updateSubscriptions({
          id: seeded.subscription.id,
          next_renewal_at: movedTo,
        })
        const payment = await captureOnOrder(getContainer(), seeded.order.id, seeded.session.id)

        await deliverCapture(getContainer(), payment.id)

        const state = await readRenewalState(getContainer(), seeded)

        expect(state.cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(state.subscription.next_renewal_at).toEqual(movedTo)
        expect(state.subscription.last_renewal_at).toBeNull()
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
        expect(logEntries({ event: "dunning_recovery_from_capture_failed" })).toEqual(
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

        expect(logEntries({ event: "renewal_settlement_from_capture_failed" })).toEqual(
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

      it("ignores a failure for a session whose cycle already succeeded, leaving the subscription's processing cycle alone", async () => {
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

        expect(after).toEqual(before)
        expect(after[1].cycle.status).toEqual(RenewalCycleStatus.PROCESSING)
        expect(after[0].subscription.status).toEqual(SubscriptionStatus.ACTIVE)
        expect(after[0].cases).toHaveLength(0)
        expect(emitted(DunningEvents.STARTED)).toHaveLength(0)
      })
    })
  },
})

jest.setTimeout(120 * 1000)
