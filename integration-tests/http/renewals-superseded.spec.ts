import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import { RenewalCycleStatus } from "../../src/modules/renewal/types"
import {
  createRenewalCycleSeed,
  createSubscriptionSeed,
} from "../helpers/renewal-fixtures"
import {
  forceRenewalCycleWorkflow,
  processRenewalCycleWorkflow,
} from "../../src/workflows"
import processRenewalCyclesJob from "../../src/jobs/process-renewal-cycles"

const DAY_MS = 24 * 60 * 60 * 1000

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ getContainer }) => {
    describe("superseded renewal cycles (subscription-level idempotency)", () => {
      // The durable cursor persists across `it` blocks within the same UTC day.
      // Reset it before each test so keyset selection starts from an empty
      // cursor and the catch-up window is evaluated deterministically.
      beforeEach(async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const rows = await renewalModule.listRenewalJobCursors({})
        if (rows.length) {
          await renewalModule.deleteRenewalJobCursors(rows.map((r) => r.id))
        }
      })

      it("charges exactly once when two non-terminal due cycles exist for one subscription", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const t2 = new Date()
        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-REN-SUPERSEDED-001",
          status: SubscriptionStatus.ACTIVE,
          skip_next_cycle: true,
          next_renewal_at: t2,
        })

        // Seeding order is load-bearing: ULID ids make the scheduler process
        // cycles in creation order, so the stale FAILED cycle A runs first and
        // must be blocked by the superseded guard before B succeeds.
        const cycleA = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          scheduled_for: new Date(Date.now() - DAY_MS),
          status: RenewalCycleStatus.FAILED,
        })
        const cycleB = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          scheduled_for: t2,
        })

        await processRenewalCyclesJob(container, { scheduledFor: new Date() })

        const processedB = await renewalModule.retrieveRenewalCycle(cycleB.id)
        expect(processedB.status).toEqual(RenewalCycleStatus.SUCCEEDED)

        // The superseded FAILED cycle was fetched (due, non-terminal) but the
        // guard rejected it without side effects: no order, no attempt.
        const untouchedA = await renewalModule.retrieveRenewalCycle(cycleA.id)
        expect(untouchedA.status).toEqual(RenewalCycleStatus.FAILED)
        expect(untouchedA.generated_order_id).toBeNull()
        expect(untouchedA.attempt_count).toEqual(0)
      })

      it("rejects direct workflow execution of a cycle not matching next_renewal_at, without side effects", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        // Fixture default next_renewal_at is now + 30 days -> misaligned with
        // a cycle due now by construction.
        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-REN-SUPERSEDED-002",
          status: SubscriptionStatus.ACTIVE,
          skip_next_cycle: true,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          scheduled_for: new Date(),
        })

        await expect(
          processRenewalCycleWorkflow(container).run({
            input: {
              renewal_cycle_id: cycle.id,
              trigger_type: "scheduler",
            },
          })
        ).rejects.toMatchObject({
          message: expect.stringContaining("is superseded"),
        })

        const rejectedCycle = await renewalModule.retrieveRenewalCycle(cycle.id)
        expect(rejectedCycle.status).toEqual(RenewalCycleStatus.SCHEDULED)
        expect(rejectedCycle.attempt_count).toEqual(0)
      })

      it("blocks admin force of a superseded cycle", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-REN-SUPERSEDED-003",
          status: SubscriptionStatus.ACTIVE,
          skip_next_cycle: true,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          scheduled_for: new Date(),
        })

        await expect(
          forceRenewalCycleWorkflow(container).run({
            input: {
              renewal_cycle_id: cycle.id,
            },
          })
        ).rejects.toMatchObject({
          message: expect.stringContaining("is superseded"),
        })

        const rejectedCycle = await renewalModule.retrieveRenewalCycle(cycle.id)
        expect(rejectedCycle.status).toEqual(RenewalCycleStatus.SCHEDULED)
        expect(rejectedCycle.attempt_count).toEqual(0)
      })

      it("deletes stale SCHEDULED siblings after a successful renewal and reconciles the next cycle", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const due = new Date()
        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-REN-SUPERSEDED-004",
          status: SubscriptionStatus.ACTIVE,
          skip_next_cycle: true,
          next_renewal_at: due,
        })

        // Stale SCHEDULED sibling seeded FIRST so the scheduler visits it
        // before the aligned cycle (creation-ordered ULID ids).
        const staleCycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          scheduled_for: new Date(Date.now() - 3 * DAY_MS),
        })
        const alignedCycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          scheduled_for: due,
        })

        await processRenewalCyclesJob(container, { scheduledFor: new Date() })

        const processedAligned = await renewalModule.retrieveRenewalCycle(
          alignedCycle.id
        )
        expect(processedAligned.status).toEqual(RenewalCycleStatus.SUCCEEDED)

        // The stale SCHEDULED sibling was guard-blocked during the run and
        // then deleted by the post-success reconcile.
        const remainingCycles = await renewalModule.listRenewalCycles({
          subscription_id: subscription.id,
        })
        expect(remainingCycles.map((c) => c.id)).not.toContain(staleCycle.id)

        // A fresh SCHEDULED cycle exists, aligned with the subscription's
        // advanced next_renewal_at (exact-ms invariant).
        const refreshedSubscription =
          await subscriptionModule.retrieveSubscription(subscription.id)
        expect(refreshedSubscription.next_renewal_at).toBeTruthy()

        const nextScheduled = remainingCycles.filter(
          (c) => c.status === RenewalCycleStatus.SCHEDULED
        )
        expect(nextScheduled).toHaveLength(1)
        expect(new Date(nextScheduled[0].scheduled_for).getTime()).toEqual(
          new Date(refreshedSubscription.next_renewal_at!).getTime()
        )
      })
    })
  },
})

jest.setTimeout(60 * 1000)
