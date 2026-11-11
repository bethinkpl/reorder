import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import type {
  ICustomerModuleService,
  IOrderModuleService,
  IPaymentModuleService,
} from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
  PaymentEvents,
} from "@medusajs/framework/utils"
import { DateTime } from "luxon"
import { FrequencyInterval } from "../../src/common/types/frequency-interval"
import { reconcileAwaitingRenewalCycles } from "../../src/jobs/reconcile-awaiting-renewal-cycles"
import { ACTIVITY_LOG_MODULE } from "../../src/modules/activity-log"
import type ActivityLogModuleService from "../../src/modules/activity-log/service"
import { ActivityLogEventType } from "../../src/modules/activity-log/types"
import { DUNNING_MODULE } from "../../src/modules/dunning"
import type DunningModuleService from "../../src/modules/dunning/service"
import { DunningCaseStatus } from "../../src/modules/dunning/types"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import {
  type RenewalAppliedPendingUpdateData,
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../src/modules/renewal/types"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import {
  type SubscriptionPaymentContext,
  type SubscriptionSourceSnapshot,
  SubscriptionStatus,
} from "../../src/modules/subscription/types"
import activateSubscriptionOnPaymentCapturedHandler from "../../src/subscribers/activate-subscription-on-payment-captured"
import { loadOrderAmounts } from "../../src/workflows/steps/run-dunning-retry"
import { recordOrderCaptureTransactions } from "../../src/workflows/utils/record-order-capture-transactions"
import {
  type RenewalSettlementAudit,
  settleRenewalCycleSucceeded,
} from "../../src/workflows/utils/settle-renewal-cycle-succeeded"
import { createDunningCaseSeed } from "../helpers/dunning-fixtures"
import {
  SYSTEM_PAYMENT_PROVIDER_ID,
  authorizeAndCapturePaymentSession,
  createPaymentSessionFixture,
} from "../helpers/payment-fixtures"
import {
  createRenewalAttemptSeed,
  createRenewalCycleSeed,
  createSubscriptionSeed,
} from "../helpers/renewal-fixtures"

jest.mock("../../src/workflows/utils/settle-renewal-cycle-succeeded", () => {
  const actual = jest.requireActual(
    "../../src/workflows/utils/settle-renewal-cycle-succeeded"
  )

  return {
    ...actual,
    settleRenewalCycleSucceeded: jest.fn(actual.settleRenewalCycleSucceeded),
  }
})

const actualSettleRenewalCycleSucceeded = jest.requireActual<
  typeof import("../../src/workflows/utils/settle-renewal-cycle-succeeded")
>("../../src/workflows/utils/settle-renewal-cycle-succeeded").settleRenewalCycleSucceeded
const settleRenewalCycleSucceededMock = jest.mocked(settleRenewalCycleSucceeded)

type StoredSettlementInputs = {
  attempt_id: string
  audit: RenewalSettlementAudit
  source_snapshot: SubscriptionSourceSnapshot | null
}

type AwaitingCycleSeedInput = {
  reference: string
  scheduled_for: Date
  next_renewal_at?: Date
  applied_pending_update_data?: RenewalAppliedPendingUpdateData
  source_snapshot?: SubscriptionSourceSnapshot
  customer_id?: string
  payment_context?: SubscriptionPaymentContext
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const ORDER_TOTAL = 100

function oneMonthAfter(date: Date) {
  return DateTime.fromJSDate(date, { zone: "utc" }).plus({ months: 1 }).toJSDate()
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ getContainer }) => {
    async function deliverCapture(paymentId: string) {
      await activateSubscriptionOnPaymentCapturedHandler({
        event: { name: PaymentEvents.CAPTURED, data: { id: paymentId } },
        container: getContainer(),
        pluginOptions: {},
      })
    }

    async function seedAwaitingCycle(input: AwaitingCycleSeedInput) {
      const container = getContainer()
      const orderModule = container.resolve<IOrderModuleService>(Modules.ORDER)
      const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
      const link = container.resolve(ContainerRegistrationKeys.LINK)

      const subscription = await createSubscriptionSeed(container, {
        reference: input.reference,
        status: SubscriptionStatus.ACTIVE,
        cart_id: `cart_${input.reference}`,
        next_renewal_at: input.next_renewal_at ?? input.scheduled_for,
        customer_id: input.customer_id,
        payment_context: input.payment_context,
      })
      const order = await orderModule.createOrders({
        currency_code: "pln",
        email: "customer@example.com",
        customer_id: subscription.customer_id,
        items: [
          { title: "Subscription Product", quantity: 1, unit_price: ORDER_TOTAL },
        ],
      })
      await link.create({
        [SUBSCRIPTION_MODULE]: { subscription_id: subscription.id },
        [Modules.ORDER]: { order_id: order.id },
      })

      const cycle = await createRenewalCycleSeed(container, {
        subscription_id: subscription.id,
        scheduled_for: input.scheduled_for,
        status: RenewalCycleStatus.AWAITING_PAYMENT,
        generated_order_id: order.id,
        applied_pending_update_data: input.applied_pending_update_data ?? null,
        attempt_count: 1,
      })
      const { collection, session } = await createPaymentSessionFixture(container, {
        amount: ORDER_TOTAL,
        context: { renewal_cycle_id: cycle.id },
      })
      await link.create({
        [Modules.ORDER]: { order_id: order.id },
        [Modules.PAYMENT]: { payment_collection_id: collection.id },
      })

      const attempt = await createRenewalAttemptSeed(container, {
        renewal_cycle_id: cycle.id,
        attempt_no: 1,
        status: RenewalAttemptStatus.PROCESSING,
        payment_reference: session.id,
        order_id: order.id,
      })
      const settlementInputs: StoredSettlementInputs = {
        attempt_id: attempt.id,
        audit: {
          correlation_id: `renewal-scheduler-${input.reference}`,
          trigger_type: "scheduler",
          triggered_by: null,
          attempt_no: 1,
          operation_started_at: input.scheduled_for.getTime(),
          scheduled_for: input.scheduled_for.toISOString(),
          previous_state: {
            status: RenewalCycleStatus.SCHEDULED,
            attempt_count: 0,
            processed_at: null,
            generated_order_id: null,
            last_error: null,
          },
        },
        source_snapshot: input.source_snapshot ?? null,
      }
      await renewalModule.updateRenewalCycles({
        id: cycle.id,
        settlement_inputs: settlementInputs,
      })

      return { subscription, order, cycle, attempt, session, settlementInputs }
    }

    async function seedSavedCardHolder(reference: string) {
      const container = getContainer()
      const customerModule =
        container.resolve<ICustomerModuleService>(Modules.CUSTOMER)
      const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
      const link = container.resolve(ContainerRegistrationKeys.LINK)
      const email = `${reference.toLowerCase()}@example.com`

      const customer = await customerModule.createCustomers({ email })
      const accountHolder = await paymentModule.createAccountHolder({
        provider_id: SYSTEM_PAYMENT_PROVIDER_ID,
        context: { customer: { id: customer.id, email } },
      })
      await link.create({
        [Modules.CUSTOMER]: { customer_id: customer.id },
        [Modules.PAYMENT]: { account_holder_id: accountHolder.id },
      })

      const paymentContext: SubscriptionPaymentContext = {
        payment_provider_id: SYSTEM_PAYMENT_PROVIDER_ID,
        account_holder_id: accountHolder.id,
        payment_method_id: "pm_old",
      }

      return { customer_id: customer.id, payment_context: paymentContext }
    }

    async function captureInFull(sessionId: string, orderId: string) {
      const container = getContainer()
      const payment = await authorizeAndCapturePaymentSession(container, sessionId)

      await recordOrderCaptureTransactions(container, orderId, payment.id)

      return payment
    }

    async function readRenewalState(subscriptionId: string, cycleId: string) {
      const container = getContainer()
      const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
      const subscriptionModule =
        container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
      const activityLogModule =
        container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)

      const cycles = await renewalModule.listRenewalCycles({
        subscription_id: subscriptionId,
      })
      const attempts = await renewalModule.listRenewalAttempts({
        renewal_cycle_id: cycleId,
      })
      const subscription = await subscriptionModule.retrieveSubscription(
        subscriptionId
      )
      const renewalSucceededLogs = await activityLogModule.listSubscriptionLogs({
        subscription_id: subscriptionId,
        event_type: ActivityLogEventType.RENEWAL_SUCCEEDED,
      })

      return {
        cycle: cycles.find((cycle) => cycle.id === cycleId),
        scheduled: cycles.filter(
          (cycle) => cycle.status === RenewalCycleStatus.SCHEDULED
        ),
        attempts,
        subscription,
        renewalSucceededLogs,
      }
    }

    afterEach(() => {
      jest.restoreAllMocks()
      settleRenewalCycleSucceededMock.mockImplementation(
        actualSettleRenewalCycleSucceeded
      )
    })

    describe("payment.captured for a renewal cycle awaiting payment", () => {
      it("settles the cycle with the inputs stored when it parked", async () => {
        const scheduledFor = new Date(Date.now() - HOUR_MS)
        const seeded = await seedAwaitingCycle({
          reference: "SUB-AWAIT-SETTLE-001",
          scheduled_for: scheduledFor,
        })
        const payment = await captureInFull(seeded.session.id, seeded.order.id)

        await deliverCapture(payment.id)

        const state = await readRenewalState(seeded.subscription.id, seeded.cycle.id)

        expect(state.cycle).toMatchObject({
          status: RenewalCycleStatus.SUCCEEDED,
          generated_order_id: seeded.order.id,
        })
        expect(state.attempts).toEqual([
          expect.objectContaining({
            id: seeded.attempt.id,
            status: RenewalAttemptStatus.SUCCEEDED,
            order_id: seeded.order.id,
          }),
        ])
        expect(state.subscription.next_renewal_at).toEqual(
          oneMonthAfter(scheduledFor)
        )
        expect(state.scheduled).toHaveLength(1)
        expect(state.scheduled[0].scheduled_for).toEqual(
          oneMonthAfter(scheduledFor)
        )
        expect(state.renewalSucceededLogs).toHaveLength(1)
        expect(state.renewalSucceededLogs[0].metadata).toMatchObject({
          order_id: seeded.order.id,
          correlation_id: seeded.settlementInputs.audit.correlation_id,
        })
      })

      it("bills the next period from the cycle's due date when the capture arrives three days late", async () => {
        const scheduledFor = new Date(Date.now() - 3 * DAY_MS)
        const seeded = await seedAwaitingCycle({
          reference: "SUB-AWAIT-LATE-001",
          scheduled_for: scheduledFor,
        })
        const payment = await captureInFull(seeded.session.id, seeded.order.id)

        await deliverCapture(payment.id)

        const state = await readRenewalState(seeded.subscription.id, seeded.cycle.id)

        expect(state.cycle?.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(state.subscription.next_renewal_at).toEqual(
          oneMonthAfter(scheduledFor)
        )
      })

      it("settles once when the same capture is delivered twice at the same time", async () => {
        const seeded = await seedAwaitingCycle({
          reference: "SUB-AWAIT-TWICE-001",
          scheduled_for: new Date(Date.now() - HOUR_MS),
        })
        const payment = await captureInFull(seeded.session.id, seeded.order.id)

        await Promise.all([deliverCapture(payment.id), deliverCapture(payment.id)])

        const state = await readRenewalState(seeded.subscription.id, seeded.cycle.id)

        expect(state.cycle?.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(state.attempts).toHaveLength(1)
        expect(state.renewalSucceededLogs).toHaveLength(1)
        expect(state.scheduled).toHaveLength(1)
      })

      it("applies the plan change's source snapshot the cycle stored", async () => {
        const premiumSnapshot: SubscriptionSourceSnapshot = {
          product_id: "prod_await_plan_change",
          variant_id: "variant_await_premium",
          title: "Subscription Product - Premium",
          quantity: 1,
          unit_price: 4999,
          subtitle: null,
          sku: "SUB-SKU-PREMIUM",
          is_discountable: true,
          is_tax_inclusive: false,
          requires_shipping: true,
          tax_lines: [],
          adjustments: [],
        }
        const seeded = await seedAwaitingCycle({
          reference: "SUB-AWAIT-PLAN-001",
          scheduled_for: new Date(Date.now() - HOUR_MS),
          applied_pending_update_data: {
            variant_id: "variant_await_premium",
            variant_title: "Premium",
            sku: "SUB-SKU-PREMIUM",
            frequency_interval: FrequencyInterval.MONTH,
            frequency_value: 1,
            effective_at: null,
          },
          source_snapshot: premiumSnapshot,
        })
        const payment = await captureInFull(seeded.session.id, seeded.order.id)

        await deliverCapture(payment.id)

        const state = await readRenewalState(seeded.subscription.id, seeded.cycle.id)

        expect(state.cycle?.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(state.subscription).toMatchObject({
          variant_id: "variant_await_premium",
          source_snapshot: premiumSnapshot,
        })
      })

      it("leaves the cycle awaiting until the order is paid up", async () => {
        const container = getContainer()
        const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
        const scheduledFor = new Date(Date.now() - HOUR_MS)
        const seeded = await seedAwaitingCycle({
          reference: "SUB-AWAIT-PARTIAL-001",
          scheduled_for: scheduledFor,
        })
        const payment = await paymentModule.authorizePaymentSession(
          seeded.session.id,
          {}
        )

        await paymentModule.capturePayment({ payment_id: payment.id, amount: 40 })
        await recordOrderCaptureTransactions(container, seeded.order.id, payment.id)
        expect((await loadOrderAmounts(container, seeded.order.id)).pending).toEqual(60)

        await deliverCapture(payment.id)

        const partlyPaid = await readRenewalState(
          seeded.subscription.id,
          seeded.cycle.id
        )

        expect(partlyPaid.cycle?.status).toEqual(RenewalCycleStatus.AWAITING_PAYMENT)
        expect(partlyPaid.attempts).toEqual([
          expect.objectContaining({ status: RenewalAttemptStatus.PROCESSING }),
        ])
        expect(partlyPaid.subscription.next_renewal_at).toEqual(scheduledFor)
        expect(partlyPaid.renewalSucceededLogs).toHaveLength(0)

        await paymentModule.capturePayment({ payment_id: payment.id, amount: 60 })
        await recordOrderCaptureTransactions(container, seeded.order.id, payment.id)
        expect((await loadOrderAmounts(container, seeded.order.id)).pending).toEqual(0)

        await deliverCapture(payment.id)

        const paidUp = await readRenewalState(seeded.subscription.id, seeded.cycle.id)

        expect(paidUp.cycle?.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(paidUp.subscription.next_renewal_at).toEqual(
          oneMonthAfter(scheduledFor)
        )
      })

      it("closes the cycle without moving any date once billing has moved past it", async () => {
        const scheduledFor = new Date(Date.now() - HOUR_MS)
        const movedTo = oneMonthAfter(scheduledFor)
        const seeded = await seedAwaitingCycle({
          reference: "SUB-AWAIT-MOVED-001",
          scheduled_for: scheduledFor,
          next_renewal_at: movedTo,
        })
        const payment = await captureInFull(seeded.session.id, seeded.order.id)

        await deliverCapture(payment.id)

        const state = await readRenewalState(seeded.subscription.id, seeded.cycle.id)

        expect(state.cycle?.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(state.subscription.next_renewal_at).toEqual(movedTo)
        expect(state.subscription.last_renewal_at).toBeNull()
      })
    })

    describe("settling next to the other effects of a capture", () => {
      it("settles when refreshing the payment context fails", async () => {
        const container = getContainer()
        const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
        const holder = await seedSavedCardHolder("SUB-AWAIT-REFRESH-001")
        const seeded = await seedAwaitingCycle({
          reference: "SUB-AWAIT-REFRESH-001",
          scheduled_for: new Date(Date.now() - HOUR_MS),
          ...holder,
        })
        const payment = await captureInFull(seeded.session.id, seeded.order.id)

        jest
          .spyOn(paymentModule, "listPaymentMethods")
          .mockRejectedValue(new Error("payment provider unavailable"))

        await deliverCapture(payment.id).catch(() => undefined)

        const state = await readRenewalState(seeded.subscription.id, seeded.cycle.id)

        expect(state.cycle?.status).toEqual(RenewalCycleStatus.SUCCEEDED)
      })

      it("settles when dunning recovery fails", async () => {
        const container = getContainer()
        const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
        const seeded = await seedAwaitingCycle({
          reference: "SUB-AWAIT-DUNNING-001",
          scheduled_for: new Date(Date.now() - HOUR_MS),
        })
        const payment = await captureInFull(seeded.session.id, seeded.order.id)
        const listDunningCases = dunningModule.listDunningCases.bind(dunningModule)

        jest
          .spyOn(dunningModule, "listDunningCases")
          .mockImplementation(async (filters, config) => {
            if (filters && "renewal_order_id" in filters) {
              throw new Error("dunning store unavailable")
            }

            return await listDunningCases(filters, config)
          })

        await deliverCapture(payment.id).catch(() => undefined)

        const state = await readRenewalState(seeded.subscription.id, seeded.cycle.id)

        expect(state.cycle?.status).toEqual(RenewalCycleStatus.SUCCEEDED)
      })

      it("still refreshes the payment context and recovers dunning when the settlement fails", async () => {
        const container = getContainer()
        const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
        const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const holder = await seedSavedCardHolder("SUB-AWAIT-SETTLE-FAIL-001")
        const seeded = await seedAwaitingCycle({
          reference: "SUB-AWAIT-SETTLE-FAIL-001",
          scheduled_for: new Date(Date.now() - HOUR_MS),
          ...holder,
        })
        const dunningCase = await createDunningCaseSeed(container, {
          subscription_id: seeded.subscription.id,
          renewal_cycle_id: seeded.cycle.id,
          renewal_order_id: seeded.order.id,
          status: DunningCaseStatus.RETRY_SCHEDULED,
        })
        const payment = await captureInFull(seeded.session.id, seeded.order.id)

        jest.spyOn(paymentModule, "listPaymentMethods").mockResolvedValue([
          { id: "pm_new", provider_id: SYSTEM_PAYMENT_PROVIDER_ID, data: { created: 2 } },
        ])
        settleRenewalCycleSucceededMock.mockImplementation(async (scope, input) => {
          if (input.source === "renewal") {
            throw new Error("renewal settlement failed")
          }

          return await actualSettleRenewalCycleSucceeded(scope, input)
        })

        await deliverCapture(payment.id).catch(() => undefined)

        const subscription = await subscriptionModule.retrieveSubscription(
          seeded.subscription.id
        )
        const recoveredCase = await dunningModule.retrieveDunningCase(dunningCase.id)

        expect(subscription.payment_context?.payment_method_id).toEqual("pm_new")
        expect(recoveredCase.status).toEqual(DunningCaseStatus.RECOVERED)
      })
    })

    describe("awaiting cycles whose capture event never arrived", () => {
      it("settles a paid one on the sweep and leaves an unpaid one awaiting", async () => {
        const scheduledFor = new Date(Date.now() - HOUR_MS)
        const paid = await seedAwaitingCycle({
          reference: "SUB-AWAIT-SWEEP-PAID",
          scheduled_for: scheduledFor,
        })
        const unpaid = await seedAwaitingCycle({
          reference: "SUB-AWAIT-SWEEP-UNPAID",
          scheduled_for: scheduledFor,
        })
        await captureInFull(paid.session.id, paid.order.id)

        await reconcileAwaitingRenewalCycles(getContainer())

        const paidState = await readRenewalState(paid.subscription.id, paid.cycle.id)
        const unpaidState = await readRenewalState(
          unpaid.subscription.id,
          unpaid.cycle.id
        )

        expect(paidState.cycle?.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(paidState.attempts).toEqual([
          expect.objectContaining({
            id: paid.attempt.id,
            status: RenewalAttemptStatus.SUCCEEDED,
          }),
        ])
        expect(paidState.subscription.next_renewal_at).toEqual(
          oneMonthAfter(scheduledFor)
        )
        expect(paidState.scheduled).toHaveLength(1)
        expect(unpaidState.cycle?.status).toEqual(RenewalCycleStatus.AWAITING_PAYMENT)
        expect(unpaidState.attempts).toEqual([
          expect.objectContaining({ status: RenewalAttemptStatus.PROCESSING }),
        ])
        expect(unpaidState.subscription.next_renewal_at).toEqual(scheduledFor)
      })
    })

    describe("payment.captured for a pending_payment subscription", () => {
      it("activates the subscription and schedules its first renewal", async () => {
        const container = getContainer()
        const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const link = container.resolve(ContainerRegistrationKeys.LINK)
        const cartId = "cart_SUB-PENDING-ACTIVATE-001"
        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-PENDING-ACTIVATE-001",
          status: SubscriptionStatus.PENDING_PAYMENT,
          cart_id: cartId,
        })
        const { collection, session } = await createPaymentSessionFixture(container)
        await link.create({
          [Modules.CART]: { cart_id: cartId },
          [Modules.PAYMENT]: { payment_collection_id: collection.id },
        })
        const payment = await authorizeAndCapturePaymentSession(container, session.id)

        await deliverCapture(payment.id)

        const activated = await subscriptionModule.retrieveSubscription(subscription.id)
        const cycles = await renewalModule.listRenewalCycles({
          subscription_id: subscription.id,
        })

        expect(activated.status).toEqual(SubscriptionStatus.ACTIVE)
        expect(cycles).toEqual([
          expect.objectContaining({
            status: RenewalCycleStatus.SCHEDULED,
            scheduled_for: subscription.next_renewal_at,
          }),
        ])
      })
    })
  },
})

jest.setTimeout(120 * 1000)
