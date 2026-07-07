import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules } from "@medusajs/framework/utils"
import { DateTime } from "luxon"
import path from "path"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import { RenewalCycleStatus } from "../../src/modules/renewal/types"
import {
  createRenewalCycleSeed,
  createSubscriptionSeed,
} from "../helpers/renewal-fixtures"
import processRenewalCyclesJob from "../../src/jobs/process-renewal-cycles"

const LOCK_KEY = "jobs:renewal-cycles"
const JOB_NAME = "process-renewal-cycles"
const DAY_MS = 24 * 60 * 60 * 1000

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ getContainer }) => {
    describe("renewal scheduler job (windowed catch-up + single-instance lock)", () => {
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

      it("processes today's and prior-day due cycles, excludes future and terminal cycles", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        // (a) SCHEDULED, due today -> should be renewed (SUCCEEDED)
        const subToday = await createSubscriptionSeed(container, {
          reference: "SUB-REN-SCHED-001",
          status: SubscriptionStatus.ACTIVE,
          skip_next_cycle: true,
        })
        const cycleToday = await createRenewalCycleSeed(container, {
          subscription_id: subToday.id,
          scheduled_for: new Date(),
        })

        // (b) SCHEDULED, due yesterday -> catch-up: should be renewed (SUCCEEDED)
        const subYesterday = await createSubscriptionSeed(container, {
          reference: "SUB-REN-SCHED-002",
          status: SubscriptionStatus.ACTIVE,
          skip_next_cycle: true,
        })
        const cycleYesterday = await createRenewalCycleSeed(container, {
          subscription_id: subYesterday.id,
          scheduled_for: new Date(Date.now() - DAY_MS),
        })

        // (c) SCHEDULED, due two days ahead -> excluded (>= start of next UTC day)
        const subFuture = await createSubscriptionSeed(container, {
          reference: "SUB-REN-SCHED-003",
          status: SubscriptionStatus.ACTIVE,
          skip_next_cycle: true,
        })
        const cycleFuture = await createRenewalCycleSeed(container, {
          subscription_id: subFuture.id,
          scheduled_for: new Date(Date.now() + 2 * DAY_MS),
        })

        // (d) already SUCCEEDED, due today -> excluded by status filter, untouched
        const subDone = await createSubscriptionSeed(container, {
          reference: "SUB-REN-SCHED-004",
          status: SubscriptionStatus.ACTIVE,
          skip_next_cycle: true,
        })
        const cycleDone = await createRenewalCycleSeed(container, {
          subscription_id: subDone.id,
          scheduled_for: new Date(),
          status: RenewalCycleStatus.SUCCEEDED,
        })
        const doneUpdatedAtBefore = new Date(cycleDone.updated_at).getTime()

        await processRenewalCyclesJob(container, { scheduledFor: new Date() })

        const processedToday = await renewalModule.retrieveRenewalCycle(
          cycleToday.id
        )
        const processedYesterday = await renewalModule.retrieveRenewalCycle(
          cycleYesterday.id
        )
        const untouchedFuture = await renewalModule.retrieveRenewalCycle(
          cycleFuture.id
        )
        const untouchedDone = await renewalModule.retrieveRenewalCycle(
          cycleDone.id
        )

        // Catch-up processes both today's and the prior-day cycle.
        expect(processedToday.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(processedYesterday.status).toEqual(RenewalCycleStatus.SUCCEEDED)

        // Future cycle excluded by the window upper bound (start of next UTC day).
        expect(untouchedFuture.status).toEqual(RenewalCycleStatus.SCHEDULED)

        // Terminal cycle excluded by the status filter and never re-run: status
        // stays SUCCEEDED and its row identity (updated_at) is unchanged.
        expect(untouchedDone.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(new Date(untouchedDone.updated_at).getTime()).toEqual(
          doneUpdatedAtBefore
        )

        // The durable cursor was advanced for this UTC day to a non-empty id.
        const [cursorRow] = await renewalModule.listRenewalJobCursors({
          job_name: JOB_NAME,
        })
        expect(cursorRow).toBeDefined()
        expect(cursorRow.window_key).toEqual(DateTime.utc().toISODate())
        expect(cursorRow.cursor).toBeTruthy()
      })

      it("skips work while the fleet-wide lock is held, then processes once it frees", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const locking = container.resolve(Modules.LOCKING)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-REN-SCHED-LOCK-001",
          status: SubscriptionStatus.ACTIVE,
          skip_next_cycle: true,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          scheduled_for: new Date(),
        })

        let lockHeld = false
        try {
          await locking.acquire(LOCK_KEY, {
            ownerId: "test-owner",
            expire: 60,
          })
          lockHeld = true

          await processRenewalCyclesJob(container, { scheduledFor: new Date() })

          const skipped = await renewalModule.retrieveRenewalCycle(cycle.id)
          expect(skipped.status).toEqual(RenewalCycleStatus.SCHEDULED)

          await locking.release(LOCK_KEY, { ownerId: "test-owner" })
          lockHeld = false
        } finally {
          if (lockHeld) {
            await locking.release(LOCK_KEY, { ownerId: "test-owner" })
          }
        }

        // Lock is free now: the job runs and renews the previously-skipped cycle.
        await processRenewalCyclesJob(container, { scheduledFor: new Date() })

        const processed = await renewalModule.retrieveRenewalCycle(cycle.id)
        expect(processed.status).toEqual(RenewalCycleStatus.SUCCEEDED)
      })
    })
  },
})

jest.setTimeout(60 * 1000)
