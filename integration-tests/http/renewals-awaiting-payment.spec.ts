import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import type {
  IPaymentModuleService,
  Logger,
  MedusaContainer,
} from "@medusajs/framework/types"
import { MedusaError, Modules } from "@medusajs/framework/utils"
import { ACTIVITY_LOG_MODULE } from "../../src/modules/activity-log"
import type ActivityLogModuleService from "../../src/modules/activity-log/service"
import { ActivityLogEventType } from "../../src/modules/activity-log/types"
import { DUNNING_MODULE } from "../../src/modules/dunning"
import type DunningModuleService from "../../src/modules/dunning/service"
import { PlanOfferScope } from "../../src/modules/plan-offer/types"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import {
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../src/modules/renewal/types"
import { renewalErrors } from "../../src/modules/renewal/utils/errors"
import {
  classifyRenewalFailure,
  isAlertableRenewalFailure,
} from "../../src/modules/renewal/utils/observability"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import {
  type SubscriptionSourceSnapshot,
  SubscriptionStatus,
} from "../../src/modules/subscription/types"
import { isBlockedRenewalOutcome } from "../../src/jobs/process-renewal-cycles"
import {
  forceRenewalCycleWorkflow,
  processRenewalCycleWorkflow,
} from "../../src/workflows"
import { FrequencyInterval } from "../../src/common/types/frequency-interval"
import { createPlanOfferSeed } from "../helpers/plan-offer-fixtures"
import {
  answerAuthorizationWithNull,
  createRenewalChargeStub,
} from "../helpers/renewal-charge-fixtures"
import {
  createRenewalAttemptSeed,
  createRenewalCycleSeed,
  createSubscriptionSeed,
} from "../helpers/renewal-fixtures"

const mockCreateOrderRun = jest.fn()
const mockCreateOrUpdateOrderPaymentCollectionRun = jest.fn()
const mockCreatePaymentSessionsRun = jest.fn()

jest.mock("@medusajs/medusa/core-flows", () => {
  const actual = jest.requireActual("@medusajs/medusa/core-flows")

  return {
    ...actual,
    createOrderWorkflow: () => ({
      run: mockCreateOrderRun,
    }),
    createOrUpdateOrderPaymentCollectionWorkflow: () => ({
      run: mockCreateOrUpdateOrderPaymentCollectionRun,
    }),
    createPaymentSessionsWorkflow: () => ({
      run: mockCreatePaymentSessionsRun,
    }),
  }
})

const stubRenewalCharge = createRenewalChargeStub({
  createOrderRun: mockCreateOrderRun,
  createOrUpdateOrderPaymentCollectionRun:
    mockCreateOrUpdateOrderPaymentCollectionRun,
  createPaymentSessionsRun: mockCreatePaymentSessionsRun,
})

function spyOnRenewalLog(container: MedusaContainer) {
  const logger = container.resolve<Logger>("logger")
  const spies = [
    jest.spyOn(logger, "info"),
    jest.spyOn(logger, "warn"),
    jest.spyOn(logger, "error"),
  ]

  return function executionOutcomes(renewalCycleId: string) {
    return spies
      .flatMap((spy) => spy.mock.calls.map(([line]) => String(line)))
      .flatMap((line) => {
        try {
          const entry = JSON.parse(line)

          return entry?.event === "renewal.execution" &&
            entry.renewal_cycle_id === renewalCycleId
            ? [String(entry.outcome)]
            : []
        } catch {
          return []
        }
      })
  }
}

function renewalLockKey(subscriptionId: string) {
  return `renewal:subscription:${subscriptionId}`
}

function expectBlockedAwaitingRefusal(error: unknown, renewalCycleId: string) {
  expect(error).toMatchObject({ type: MedusaError.Types.CONFLICT })

  const kind = classifyRenewalFailure(error)

  expect(isBlockedRenewalOutcome(kind)).toBe(true)
  expect(isAlertableRenewalFailure(kind)).toBe(false)
  expect(error).toMatchObject({
    message: renewalErrors.awaitingPayment(renewalCycleId).message,
  })
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ getContainer }) => {
    describe("renewal cycles awaiting their payment", () => {
      beforeEach(() => {
        jest.restoreAllMocks()
        jest.clearAllMocks()
      })

      it("parks the cycle when authorisation answers null, keeping the order, the settlement inputs and the subscription's dates", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const activityLogModule =
          container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const locking = container.resolve(Modules.LOCKING)

        const dueAt = new Date("2026-05-10T10:00:00.000Z")
        const orderId = "ord_rc1_park_001"
        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-RC1-PARK-001",
          next_renewal_at: dueAt,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          scheduled_for: dueAt,
        })

        const { sessionIds } = stubRenewalCharge(container, {
          subscription,
          order_id: orderId,
        })
        answerAuthorizationWithNull(container)
        const executionOutcomes = spyOnRenewalLog(container)

        await processRenewalCycleWorkflow(container).run({
          input: {
            renewal_cycle_id: cycle.id,
            trigger_type: "scheduler",
            correlation_id: "corr-rc1-park-001",
          },
        })

        const parked = await renewalModule.retrieveRenewalCycle(cycle.id)
        const attempts = await renewalModule.listRenewalAttempts({
          renewal_cycle_id: cycle.id,
        })
        const cycles = await renewalModule.listRenewalCycles({
          subscription_id: subscription.id,
        })
        const subscriptionAfter = await subscriptionModule.retrieveSubscription(
          subscription.id
        )
        const outcomeEntries = await activityLogModule.listSubscriptionLogs({
          subscription_id: subscription.id,
          event_type: [
            ActivityLogEventType.RENEWAL_SUCCEEDED,
            ActivityLogEventType.RENEWAL_FAILED,
          ],
        })
        const dunningCases = await dunningModule.listDunningCases({
          subscription_id: subscription.id,
        })

        expect(sessionIds).toHaveLength(1)
        expect(parked).toMatchObject({
          status: RenewalCycleStatus.AWAITING_PAYMENT,
          generated_order_id: orderId,
          attempt_count: 1,
        })
        expect(attempts).toHaveLength(1)
        expect(attempts[0]).toMatchObject({
          status: RenewalAttemptStatus.PROCESSING,
          payment_reference: sessionIds[0],
        })
        expect(parked.settlement_inputs).toEqual({
          attempt_id: attempts[0].id,
          audit: {
            correlation_id: "corr-rc1-park-001",
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
        expect(cycles.map((record) => record.id)).toEqual([cycle.id])
        expect(subscriptionAfter.status).toEqual(SubscriptionStatus.ACTIVE)
        expect(new Date(subscriptionAfter.next_renewal_at!).toISOString()).toEqual(
          dueAt.toISOString()
        )
        expect(subscriptionAfter.last_renewal_at).toBeNull()
        expect(outcomeEntries).toHaveLength(0)
        expect(executionOutcomes(cycle.id)).toContain("started")
        expect(executionOutcomes(cycle.id)).not.toContain("succeeded")
        expect(executionOutcomes(cycle.id)).not.toContain("failed")
        expect(dunningCases).toHaveLength(0)

        const lockKey = renewalLockKey(subscription.id)

        await expect(
          locking.acquire(lockKey, { ownerId: "rc1-lock-probe", expire: 5 })
        ).resolves.toBeUndefined()
        await locking.release(lockKey, { ownerId: "rc1-lock-probe" })
      })

      it("parks a plan-change cycle with the new variant's snapshot and leaves the plan change unapplied", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

        const dueAt = new Date("2026-05-11T10:00:00.000Z")
        const orderId = "ord_rc1_plan_001"
        const productId = "prod_rc1_plan"
        const oldVariantId = "variant_rc1_old"
        const newVariantId = "variant_rc1_new"
        const newVariantSnapshot: SubscriptionSourceSnapshot = {
          product_id: productId,
          variant_id: newVariantId,
          title: "New Variant",
          subtitle: null,
          quantity: 1,
          unit_price: 7500,
          sku: "NEW-SKU",
          is_discountable: true,
          is_tax_inclusive: false,
          requires_shipping: true,
          tax_lines: [],
          adjustments: [],
        }

        await createPlanOfferSeed(container, {
          name: "RC1 plan change offer",
          scope: PlanOfferScope.VARIANT,
          product_id: productId,
          variant_id: newVariantId,
          is_enabled: true,
          allowed_frequencies: [{ interval: FrequencyInterval.MONTH, value: 1 }],
        })

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-RC1-PLAN-001",
          next_renewal_at: dueAt,
          product_id: productId,
          variant_id: oldVariantId,
          source_snapshot: {
            product_id: productId,
            variant_id: oldVariantId,
            title: "Old Variant",
            subtitle: null,
            quantity: 1,
            unit_price: 5000,
            sku: "OLD-SKU",
            is_discountable: true,
            is_tax_inclusive: false,
            requires_shipping: true,
            tax_lines: [],
            adjustments: [],
          },
        })

        await subscriptionModule.updateSubscriptions({
          id: subscription.id,
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

        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          scheduled_for: dueAt,
        })

        stubRenewalCharge(container, {
          subscription,
          order_id: orderId,
          order_item: newVariantSnapshot,
        })
        answerAuthorizationWithNull(container)

        await processRenewalCycleWorkflow(container).run({
          input: {
            renewal_cycle_id: cycle.id,
            trigger_type: "scheduler",
          },
        })

        const parked = await renewalModule.retrieveRenewalCycle(cycle.id)
        const subscriptionAfter = await subscriptionModule.retrieveSubscription(
          subscription.id
        )

        expect(parked.status).toEqual(RenewalCycleStatus.AWAITING_PAYMENT)
        expect(parked.settlement_inputs).toMatchObject({
          source_snapshot: {
            product_id: productId,
            variant_id: newVariantId,
            title: "New Variant",
            quantity: 1,
            unit_price: 7500,
            sku: "NEW-SKU",
          },
        })
        expect(subscriptionAfter.variant_id).toEqual(oldVariantId)
        expect(subscriptionAfter.source_snapshot).toMatchObject({
          variant_id: oldVariantId,
          unit_price: 5000,
        })
        expect(subscriptionAfter.pending_update_data).toMatchObject({
          variant_id: newVariantId,
        })
      })

      it("refuses forced and manual runs of a cycle awaiting its payment as blocked and never alertable", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const activityLogModule =
          container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)

        const dueAt = new Date("2026-05-12T10:00:00.000Z")
        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-RC1-REFUSE-001",
          next_renewal_at: dueAt,
          skip_next_cycle: true,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          scheduled_for: dueAt,
          status: RenewalCycleStatus.AWAITING_PAYMENT,
          generated_order_id: "ord_rc1_refuse_001",
          attempt_count: 1,
        })
        await createRenewalAttemptSeed(container, {
          renewal_cycle_id: cycle.id,
          status: RenewalAttemptStatus.PROCESSING,
          payment_reference: "payses_rc1_refuse_001",
        })

        const forceError = await forceRenewalCycleWorkflow(container)
          .run({
            input: {
              renewal_cycle_id: cycle.id,
              triggered_by: "admin_rc1",
            },
          })
          .catch((error: unknown) => error)
        const manualError = await processRenewalCycleWorkflow(container)
          .run({
            input: {
              renewal_cycle_id: cycle.id,
              trigger_type: "manual",
              triggered_by: "admin_rc1",
            },
          })
          .catch((error: unknown) => error)

        expectBlockedAwaitingRefusal(forceError, cycle.id)
        expectBlockedAwaitingRefusal(manualError, cycle.id)

        const cycleAfter = await renewalModule.retrieveRenewalCycle(cycle.id)
        const attempts = await renewalModule.listRenewalAttempts({
          renewal_cycle_id: cycle.id,
        })
        const forceEntries = await activityLogModule.listSubscriptionLogs({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.RENEWAL_FORCE_REQUESTED,
        })

        expect(cycleAfter).toMatchObject({
          status: RenewalCycleStatus.AWAITING_PAYMENT,
          attempt_count: 1,
        })
        expect(attempts).toHaveLength(1)
        expect(attempts[0].status).toEqual(RenewalAttemptStatus.PROCESSING)
        expect(forceEntries).toHaveLength(0)
      })

      it("never hands a cycle awaiting its payment to the scheduler", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const dueAt = new Date("2026-05-13T10:00:00.000Z")
        const awaiting = await createRenewalCycleSeed(container, {
          subscription_id: "sub_rc1_due_awaiting",
          scheduled_for: dueAt,
          status: RenewalCycleStatus.AWAITING_PAYMENT,
        })
        const scheduled = await createRenewalCycleSeed(container, {
          subscription_id: "sub_rc1_due_scheduled",
          scheduled_for: dueAt,
          status: RenewalCycleStatus.SCHEDULED,
        })

        const due = await renewalModule.listDueRenewalCyclesForWindow({
          dueBefore: new Date("2026-05-14T00:00:00.000Z"),
          cursor: "",
          limit: 100,
        })
        const dueIds = due.map((record) => record.id)

        expect(dueIds).toContain(scheduled.id)
        expect(dueIds).not.toContain(awaiting.id)
      })

      it("keeps a parked cycle awaiting its payment when a later step of the run fails", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const activityLogModule =
          container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const locking = container.resolve(Modules.LOCKING)

        const dueAt = new Date("2026-05-15T10:00:00.000Z")
        const orderId = "ord_rc1_late_failure_001"
        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-RC1-LATE-FAILURE-001",
          next_renewal_at: dueAt,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          scheduled_for: dueAt,
        })

        const { sessionIds } = stubRenewalCharge(container, {
          subscription,
          order_id: orderId,
        })
        answerAuthorizationWithNull(container)

        const lockKey = renewalLockKey(subscription.id)
        const release = locking.release.bind(locking)
        let releaseRefused = false

        jest
          .spyOn(locking, "release")
          .mockImplementation(async (keys, args) => {
            const list = Array.isArray(keys) ? keys : [keys]

            if (!releaseRefused && list.includes(lockKey)) {
              releaseRefused = true
              throw new Error("lock store unavailable")
            }

            return release(keys, args)
          })

        await expect(
          processRenewalCycleWorkflow(container).run({
            input: {
              renewal_cycle_id: cycle.id,
              trigger_type: "scheduler",
            },
          })
        ).rejects.toMatchObject({
          message: expect.stringContaining("lock store unavailable"),
        })

        const cycleAfter = await renewalModule.retrieveRenewalCycle(cycle.id)
        const attempts = await renewalModule.listRenewalAttempts({
          renewal_cycle_id: cycle.id,
        })
        const failedEntries = await activityLogModule.listSubscriptionLogs({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.RENEWAL_FAILED,
        })
        const dunningCases = await dunningModule.listDunningCases({
          subscription_id: subscription.id,
        })

        expect(cycleAfter).toMatchObject({
          status: RenewalCycleStatus.AWAITING_PAYMENT,
          generated_order_id: orderId,
        })
        expect(attempts).toHaveLength(1)
        expect(cycleAfter.settlement_inputs).toMatchObject({
          attempt_id: attempts[0].id,
        })
        expect(attempts[0]).toMatchObject({
          status: RenewalAttemptStatus.PROCESSING,
          payment_reference: sessionIds[0],
        })
        expect(failedEntries).toHaveLength(0)
        expect(dunningCases).toHaveLength(0)
      })

      it("settles the cycle in the same run when authorisation returns a payment", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const activityLogModule =
          container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)
        const paymentModule =
          container.resolve<IPaymentModuleService>(Modules.PAYMENT)

        const dueAt = new Date("2026-05-16T10:00:00.000Z")
        const orderId = "ord_rc1_sync_001"
        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-RC1-SYNC-001",
          next_renewal_at: dueAt,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          scheduled_for: dueAt,
        })

        const { sessionIds } = stubRenewalCharge(container, {
          subscription,
          order_id: orderId,
        })

        await processRenewalCycleWorkflow(container).run({
          input: {
            renewal_cycle_id: cycle.id,
            trigger_type: "scheduler",
          },
        })

        const settled = await renewalModule.retrieveRenewalCycle(cycle.id)
        const attempts = await renewalModule.listRenewalAttempts({
          renewal_cycle_id: cycle.id,
        })
        const cycles = await renewalModule.listRenewalCycles({
          subscription_id: subscription.id,
        })
        const subscriptionAfter = await subscriptionModule.retrieveSubscription(
          subscription.id
        )
        const succeededEntries = await activityLogModule.listSubscriptionLogs({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.RENEWAL_SUCCEEDED,
        })
        const payments = await paymentModule.listPayments({
          payment_session_id: sessionIds[0],
        })

        expect(settled).toMatchObject({
          status: RenewalCycleStatus.SUCCEEDED,
          generated_order_id: orderId,
        })
        expect(attempts).toHaveLength(1)
        expect(attempts[0].status).toEqual(RenewalAttemptStatus.SUCCEEDED)
        expect(payments).toHaveLength(1)
        expect(payments[0].captured_at).toBeTruthy()
        expect(
          new Date(subscriptionAfter.next_renewal_at!).getTime()
        ).toBeGreaterThan(dueAt.getTime())
        expect(subscriptionAfter.last_renewal_at).toBeTruthy()
        expect(succeededEntries).toHaveLength(1)
        expect(cycles).toHaveLength(2)
        expect(
          cycles.find((record) => record.id !== cycle.id)?.status
        ).toEqual(RenewalCycleStatus.SCHEDULED)
      })
    })
  },
})

jest.setTimeout(60 * 1000)
