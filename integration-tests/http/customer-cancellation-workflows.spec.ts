import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules } from "@medusajs/framework/utils"
import path from "path"
import { ACTIVITY_LOG_MODULE } from "../../src/modules/activity-log"
import type ActivityLogModuleService from "../../src/modules/activity-log/service"
import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../../src/modules/activity-log/types"
import { CANCELLATION_MODULE } from "../../src/modules/cancellation"
import type CancellationModuleService from "../../src/modules/cancellation/service"
import {
  CancellationCaseStatus,
  CancellationFinalOutcome,
  CancellationReasonCategory,
} from "../../src/modules/cancellation/types"
import { DUNNING_MODULE } from "../../src/modules/dunning"
import type DunningModuleService from "../../src/modules/dunning/service"
import { DunningCaseStatus } from "../../src/modules/dunning/types"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import { RenewalCycleStatus } from "../../src/modules/renewal/types"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import {
  cancelSubscriptionByCustomerWorkflow,
  ensureNextRenewalCycleWorkflow,
  runDunningRetryWorkflow,
} from "../../src/workflows"
import {
  createDunningCaseSeed,
  createRenewalCycleSeed,
  createSubscriptionSeed,
} from "../helpers/cancellation-fixtures"

const CUSTOMER_ID = "cus_self_service"

function daysFromNow(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000)
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ getContainer }) => {
    describe("customer self-service cancellation", () => {
      it("cancels at the end of the paid cycle and clears the scheduled renewal", async () => {
        const container = getContainer()
        const cancellationModule =
          container.resolve<CancellationModuleService>(CANCELLATION_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const activityLogModule =
          container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)

        const nextRenewalAt = daysFromNow(18)
        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-CUST-CANCEL-001",
          status: SubscriptionStatus.ACTIVE,
          customer_id: CUSTOMER_ID,
          next_renewal_at: nextRenewalAt,
        })

        await ensureNextRenewalCycleWorkflow(container).run({
          input: {
            subscription_id: subscription.id,
          },
        })

        const { result } = await cancelSubscriptionByCustomerWorkflow(
          container
        ).run({
          input: {
            subscription_id: subscription.id,
            reason: "Too expensive for me right now",
            reason_category: CancellationReasonCategory.PRICE,
            triggered_by: CUSTOMER_ID,
          },
        })

        const updatedSubscription =
          await subscriptionModule.retrieveSubscription(subscription.id)
        const cases = await cancellationModule.listCancellationCases({
          subscription_id: subscription.id,
        } as any)
        const cycles = await renewalModule.listRenewalCycles({
          subscription_id: subscription.id,
        } as any)

        expect(result.case_status).toEqual(CancellationCaseStatus.CANCELED)
        expect(result.final_outcome).toEqual(CancellationFinalOutcome.CANCELED)
        expect(new Date(result.cancel_effective_at).toISOString()).toEqual(
          nextRenewalAt.toISOString()
        )

        expect(updatedSubscription.status).toEqual(SubscriptionStatus.CANCELLED)
        expect(updatedSubscription.cancelled_at).toBeTruthy()
        expect(updatedSubscription.next_renewal_at).toBeNull()
        expect(updatedSubscription.cancel_effective_at?.toISOString()).toEqual(
          nextRenewalAt.toISOString()
        )

        expect(cases).toHaveLength(1)
        expect(cases[0]).toMatchObject({
          status: CancellationCaseStatus.CANCELED,
          final_outcome: CancellationFinalOutcome.CANCELED,
          reason: "Too expensive for me right now",
          reason_category: CancellationReasonCategory.PRICE,
          finalized_by: CUSTOMER_ID,
        })
        expect(cases[0].metadata).toMatchObject({
          origin: "customer_cancel_intent",
        })

        expect(
          cycles.filter(
            (cycle) => cycle.status === RenewalCycleStatus.SCHEDULED
          )
        ).toHaveLength(0)

        const startedLogs = await activityLogModule.listSubscriptionLogs({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.CANCELLATION_CASE_STARTED,
        } as any)
        const finalizedLogs = await activityLogModule.listSubscriptionLogs({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.CANCELLATION_FINALIZED,
        } as any)

        expect(startedLogs).toHaveLength(1)
        expect(startedLogs[0].metadata).toMatchObject({
          source: "storefront",
          trigger_type: "customer_self_service",
        })
        expect(finalizedLogs).toHaveLength(1)
        expect(finalizedLogs[0]).toMatchObject({
          actor_type: ActivityLogActorType.USER,
          actor_id: CUSTOMER_ID,
        })
        expect(finalizedLogs[0].metadata).toMatchObject({
          source: "storefront",
          effective_at: "end_of_cycle",
        })
      })

      it("cancels a past-due subscription immediately and closes its dunning case", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

        const failedRenewalAt = daysFromNow(-6)
        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-CUST-CANCEL-002",
          status: SubscriptionStatus.PAST_DUE,
          customer_id: CUSTOMER_ID,
          next_renewal_at: failedRenewalAt,
        })
        const renewal = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.FAILED,
          scheduled_for: failedRenewalAt,
        })
        const dunningCase = await createDunningCaseSeed(container, {
          subscription_id: subscription.id,
          renewal_cycle_id: renewal.id,
          status: DunningCaseStatus.RETRY_SCHEDULED,
        })

        const { result } = await cancelSubscriptionByCustomerWorkflow(
          container
        ).run({
          input: {
            subscription_id: subscription.id,
            reason: "Cannot pay right now",
            triggered_by: CUSTOMER_ID,
          },
        })

        const updatedSubscription =
          await subscriptionModule.retrieveSubscription(subscription.id)
        const updatedDunningCase = await dunningModule.retrieveDunningCase(
          dunningCase.id
        )

        expect(updatedSubscription.status).toEqual(SubscriptionStatus.CANCELLED)
        expect(
          new Date(result.cancel_effective_at).getTime()
        ).toBeGreaterThan(failedRenewalAt.getTime())
        expect(
          updatedSubscription.cancel_effective_at?.toISOString()
        ).toEqual(updatedSubscription.cancelled_at?.toISOString())

        expect(updatedDunningCase.status).toEqual(
          DunningCaseStatus.UNRECOVERED
        )
        expect(updatedDunningCase.next_retry_at).toBeNull()
        expect(updatedDunningCase.closed_at).toBeTruthy()
        expect(updatedDunningCase.recovery_reason).toEqual(
          "subscription_cancelled_by_customer"
        )
      })

      it("cancels a paused subscription immediately even with a future anchor", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-CUST-CANCEL-003",
          status: SubscriptionStatus.PAUSED,
          customer_id: CUSTOMER_ID,
          next_renewal_at: daysFromNow(25),
        })

        await cancelSubscriptionByCustomerWorkflow(container).run({
          input: {
            subscription_id: subscription.id,
            reason: "No longer needed",
            triggered_by: CUSTOMER_ID,
          },
        })

        const updatedSubscription =
          await subscriptionModule.retrieveSubscription(subscription.id)

        expect(updatedSubscription.status).toEqual(SubscriptionStatus.CANCELLED)
        expect(
          updatedSubscription.cancel_effective_at?.toISOString()
        ).toEqual(updatedSubscription.cancelled_at?.toISOString())
      })

      it("clears a pending skip so it cannot survive the cancellation", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-CUST-CANCEL-004",
          status: SubscriptionStatus.ACTIVE,
          customer_id: CUSTOMER_ID,
          next_renewal_at: daysFromNow(12),
          skip_next_cycle: true,
        })

        await cancelSubscriptionByCustomerWorkflow(container).run({
          input: {
            subscription_id: subscription.id,
            reason: "Changed my mind about the plan",
            triggered_by: CUSTOMER_ID,
          },
        })

        const updatedSubscription =
          await subscriptionModule.retrieveSubscription(subscription.id)

        expect(updatedSubscription.skip_next_cycle).toEqual(false)
      })

      it("refuses to cancel while a dunning retry is in flight", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-CUST-CANCEL-005",
          status: SubscriptionStatus.PAST_DUE,
          customer_id: CUSTOMER_ID,
          next_renewal_at: daysFromNow(-3),
        })
        const renewal = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.FAILED,
          scheduled_for: daysFromNow(-3),
        })
        await createDunningCaseSeed(container, {
          subscription_id: subscription.id,
          renewal_cycle_id: renewal.id,
          status: DunningCaseStatus.RETRYING,
        })

        await expect(
          cancelSubscriptionByCustomerWorkflow(container).run({
            input: {
              subscription_id: subscription.id,
              reason: "Please cancel",
              triggered_by: CUSTOMER_ID,
            },
          })
        ).rejects.toMatchObject({
          message: expect.stringContaining("retry is in flight"),
        })

        const untouchedSubscription =
          await subscriptionModule.retrieveSubscription(subscription.id)

        expect(untouchedSubscription.status).toEqual(
          SubscriptionStatus.PAST_DUE
        )
        expect(untouchedSubscription.cancelled_at).toBeNull()
      })

      it("waits for a concurrent retry to release its case before closing it", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const locking = container.resolve(Modules.LOCKING)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-CUST-CANCEL-009",
          status: SubscriptionStatus.PAST_DUE,
          customer_id: CUSTOMER_ID,
          next_renewal_at: daysFromNow(-3),
        })
        const renewal = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.FAILED,
          scheduled_for: daysFromNow(-3),
        })
        const dunningCase = await createDunningCaseSeed(container, {
          subscription_id: subscription.id,
          renewal_cycle_id: renewal.id,
          status: DunningCaseStatus.RETRY_SCHEDULED,
        })

        await locking.acquire(`dunning:${dunningCase.id}`, { expire: 30 })

        const cancellation = cancelSubscriptionByCustomerWorkflow(
          container
        ).run({
          input: {
            subscription_id: subscription.id,
            reason: "Please cancel",
            triggered_by: CUSTOMER_ID,
          },
        })
        const settled = cancellation.then(
          () => "resolved",
          () => "rejected"
        )

        await new Promise((resolve) => setTimeout(resolve, 300))

        const caseWhileLocked = await dunningModule.retrieveDunningCase(
          dunningCase.id
        )

        expect(caseWhileLocked.status).toEqual(
          DunningCaseStatus.RETRY_SCHEDULED
        )

        await dunningModule.updateDunningCases({
          id: dunningCase.id,
          status: DunningCaseStatus.RETRYING,
        } as any)
        await locking.release(`dunning:${dunningCase.id}`)

        await expect(settled).resolves.toEqual("rejected")
        await expect(cancellation).rejects.toMatchObject({
          message: expect.stringContaining("retry is in flight"),
        })

        const finalCase = await dunningModule.retrieveDunningCase(
          dunningCase.id
        )
        const untouchedSubscription =
          await subscriptionModule.retrieveSubscription(subscription.id)

        expect(finalCase.status).toEqual(DunningCaseStatus.RETRYING)
        expect(finalCase.closed_at).toBeNull()
        expect(untouchedSubscription.status).toEqual(
          SubscriptionStatus.PAST_DUE
        )
        expect(untouchedSubscription.cancelled_at).toBeNull()
      })

      it("rejects a second cancellation and leaves the first one untouched", async () => {
        const container = getContainer()
        const cancellationModule =
          container.resolve<CancellationModuleService>(CANCELLATION_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-CUST-CANCEL-006",
          status: SubscriptionStatus.ACTIVE,
          customer_id: CUSTOMER_ID,
          next_renewal_at: daysFromNow(9),
        })

        await cancelSubscriptionByCustomerWorkflow(container).run({
          input: {
            subscription_id: subscription.id,
            reason: "First cancellation",
            triggered_by: CUSTOMER_ID,
          },
        })

        const cancelledSubscription =
          await subscriptionModule.retrieveSubscription(subscription.id)

        await expect(
          cancelSubscriptionByCustomerWorkflow(container).run({
            input: {
              subscription_id: subscription.id,
              reason: "Second cancellation",
              triggered_by: CUSTOMER_ID,
            },
          })
        ).rejects.toMatchObject({
          message: expect.stringContaining("cancelled"),
        })

        const stillCancelledSubscription =
          await subscriptionModule.retrieveSubscription(subscription.id)
        const cases = await cancellationModule.listCancellationCases({
          subscription_id: subscription.id,
        } as any)

        expect(cases).toHaveLength(1)
        expect(cases[0].reason).toEqual("First cancellation")
        expect(
          stillCancelledSubscription.cancelled_at?.toISOString()
        ).toEqual(cancelledSubscription.cancelled_at?.toISOString())
        expect(
          stillCancelledSubscription.cancel_effective_at?.toISOString()
        ).toEqual(cancelledSubscription.cancel_effective_at?.toISOString())
      })
    })

    describe("dunning retries against non-retryable subscriptions", () => {
      it("closes the case when the subscription is already cancelled", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-CUST-CANCEL-007",
          status: SubscriptionStatus.CANCELLED,
          next_renewal_at: null,
        })
        const renewal = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.FAILED,
          scheduled_for: daysFromNow(-4),
        })
        const dunningCase = await createDunningCaseSeed(container, {
          subscription_id: subscription.id,
          renewal_cycle_id: renewal.id,
          renewal_order_id: "order_non_retryable",
          status: DunningCaseStatus.RETRY_SCHEDULED,
        })

        await expect(
          runDunningRetryWorkflow(container).run({
            input: {
              dunning_case_id: dunningCase.id,
            },
          })
        ).rejects.toMatchObject({
          message: expect.stringContaining("no longer retryable"),
        })

        const settledCase = await dunningModule.retrieveDunningCase(
          dunningCase.id
        )

        expect(settledCase.status).toEqual(DunningCaseStatus.UNRECOVERED)
        expect(settledCase.next_retry_at).toBeNull()
        expect(settledCase.closed_at).toBeTruthy()
        expect(settledCase.recovery_reason).toEqual(
          "subscription_not_retryable"
        )
      })

      it("parks the case for manual resolution when the subscription is paused", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-CUST-CANCEL-008",
          status: SubscriptionStatus.PAUSED,
          next_renewal_at: daysFromNow(14),
        })
        const renewal = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.FAILED,
          scheduled_for: daysFromNow(-4),
        })
        const dunningCase = await createDunningCaseSeed(container, {
          subscription_id: subscription.id,
          renewal_cycle_id: renewal.id,
          renewal_order_id: "order_non_retryable",
          status: DunningCaseStatus.RETRY_SCHEDULED,
        })

        await expect(
          runDunningRetryWorkflow(container).run({
            input: {
              dunning_case_id: dunningCase.id,
            },
          })
        ).rejects.toMatchObject({
          message: expect.stringContaining("no longer retryable"),
        })

        const parkedCase = await dunningModule.retrieveDunningCase(
          dunningCase.id
        )

        expect(parkedCase.status).toEqual(
          DunningCaseStatus.AWAITING_MANUAL_RESOLUTION
        )
        expect(parkedCase.next_retry_at).toBeNull()
        expect(parkedCase.closed_at).toBeNull()
      })
    })
  },
})

jest.setTimeout(60 * 1000)
