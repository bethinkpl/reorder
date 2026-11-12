import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import { DateTime } from "luxon"
import { RENEWAL_MODULE } from ".."
import RenewalAttempt from "../models/renewal-attempt"
import RenewalCycle from "../models/renewal-cycle"
import RenewalJobCursor from "../models/renewal-job-cursor"
import RenewalModuleService from "../service"
import {
  RenewalAttemptStatus,
  RenewalApprovalStatus,
  RenewalCycleStatus,
} from "../types"

moduleIntegrationTestRunner<RenewalModuleService>({
  moduleName: RENEWAL_MODULE,
  moduleModels: [RenewalCycle, RenewalAttempt, RenewalJobCursor],
  resolve: "./src/modules/renewal",
  testSuite: ({ service }) => {
    describe("RenewalModuleService", () => {
      it("creates and retrieves a renewal cycle", async () => {
        const created = await service.createRenewalCycles({
          subscription_id: "sub_module_001",
          scheduled_for: new Date("2026-03-30T10:00:00.000Z"),
          processed_at: null,
          status: RenewalCycleStatus.SCHEDULED,
          approval_required: true,
          approval_status: RenewalApprovalStatus.PENDING,
          approval_decided_at: null,
          approval_decided_by: null,
          approval_reason: null,
          generated_order_id: null,
          applied_pending_update_data: null,
          last_error: null,
          attempt_count: 0,
          metadata: {
            source: "module-test",
          },
        } as any)

        const retrieved = await service.retrieveRenewalCycle(created.id)

        expect(retrieved.id).toEqual(created.id)
        expect(retrieved.subscription_id).toEqual("sub_module_001")
        expect(retrieved.status).toEqual(RenewalCycleStatus.SCHEDULED)
        expect(retrieved.approval_status).toEqual(RenewalApprovalStatus.PENDING)
      })

      it("creates an attempt and updates renewal processing state", async () => {
        const cycle = await service.createRenewalCycles({
          subscription_id: "sub_module_002",
          scheduled_for: new Date("2026-03-30T11:00:00.000Z"),
          processed_at: null,
          status: RenewalCycleStatus.SCHEDULED,
          approval_required: false,
          approval_status: null,
          approval_decided_at: null,
          approval_decided_by: null,
          approval_reason: null,
          generated_order_id: null,
          applied_pending_update_data: null,
          last_error: null,
          attempt_count: 0,
          metadata: null,
        } as any)

        const attempt = await service.createRenewalAttempts({
          renewal_cycle_id: cycle.id,
          attempt_no: 1,
          started_at: new Date("2026-03-30T11:01:00.000Z"),
          finished_at: null,
          status: RenewalAttemptStatus.PROCESSING,
          error_code: null,
          error_message: null,
          payment_reference: null,
          order_id: null,
          metadata: {
            trigger_type: "scheduler",
          },
        } as any)

        await service.updateRenewalCycles({
          id: cycle.id,
          status: RenewalCycleStatus.PROCESSING,
          attempt_count: 1,
        } as any)

        const updatedCycle = await service.retrieveRenewalCycle(cycle.id)
        const retrievedAttempt = await service.retrieveRenewalAttempt(attempt.id)

        expect(updatedCycle.status).toEqual(RenewalCycleStatus.PROCESSING)
        expect(updatedCycle.attempt_count).toEqual(1)
        expect(retrievedAttempt.renewal_cycle_id).toEqual(cycle.id)
        expect(retrievedAttempt.status).toEqual(RenewalAttemptStatus.PROCESSING)
      })
    })

    describe("windowed keyset scheduler queries", () => {
      const JOB_NAME = "process-renewal-cycles"
      const PAST = new Date("2026-06-01T10:00:00.000Z")
      const FUTURE = new Date("2027-01-01T00:00:00.000Z")

      type CreateCycleInput = Parameters<
        RenewalModuleService["createRenewalCycles"]
      >[0]

      // Fully-populated seed literal, typed against the generated create input so
      // no `as any` is needed; callers only override id/status/scheduled_for.
      const seedCycle = (overrides: CreateCycleInput) => {
        const data: CreateCycleInput = {
          subscription_id: "sub_keyset",
          scheduled_for: PAST,
          processed_at: null,
          status: RenewalCycleStatus.SCHEDULED,
          approval_required: false,
          approval_status: null,
          approval_decided_at: null,
          approval_decided_by: null,
          approval_reason: null,
          generated_order_id: null,
          applied_pending_update_data: null,
          last_error: null,
          attempt_count: 0,
          metadata: null,
          ...overrides,
        }

        return service.createRenewalCycles(data)
      }

      // Exclusive upper bound = start of the next UTC day, matching the job's window.
      const dueBefore = () =>
        DateTime.utc().plus({ days: 1 }).startOf("day").toJSDate()

      beforeEach(async () => {
        const cycles = await service.listRenewalCycles({}, { take: 1000 })
        if (cycles.length) {
          await service.deleteRenewalCycles(cycles.map((c) => c.id))
        }

        const cursors = await service.listRenewalJobCursors({}, { take: 1000 })
        if (cursors.length) {
          await service.deleteRenewalJobCursors(cursors.map((c) => c.id))
        }
      })

      it("advances the keyset with no gaps or duplicates", async () => {
        for (const suffix of ["01", "02", "03", "04", "05"]) {
          await seedCycle({ id: `rncyc_test_${suffix}` })
        }

        const cutoff = dueBefore()

        const page1 = await service.listDueRenewalCyclesForWindow({
          dueBefore: cutoff,
          cursor: "",
          limit: 2,
        })
        expect(page1.map((r) => r.id)).toEqual([
          "rncyc_test_01",
          "rncyc_test_02",
        ])

        const page2 = await service.listDueRenewalCyclesForWindow({
          dueBefore: cutoff,
          cursor: page1[page1.length - 1].id,
          limit: 2,
        })
        expect(page2.map((r) => r.id)).toEqual([
          "rncyc_test_03",
          "rncyc_test_04",
        ])

        const page3 = await service.listDueRenewalCyclesForWindow({
          dueBefore: cutoff,
          cursor: page2[page2.length - 1].id,
          limit: 2,
        })
        expect(page3.map((r) => r.id)).toEqual(["rncyc_test_05"])

        // The concatenated pages cover every id exactly once, ascending: the
        // core exactly-once-per-day coverage guarantee.
        const walked = [...page1, ...page2, ...page3].map((r) => r.id)
        expect(walked).toEqual([
          "rncyc_test_01",
          "rncyc_test_02",
          "rncyc_test_03",
          "rncyc_test_04",
          "rncyc_test_05",
        ])
      })

      it("does not revisit ids at or below an advanced cursor, but re-walks them from an empty cursor", async () => {
        for (const suffix of ["01", "02", "03", "04", "05"]) {
          await seedCycle({ id: `rncyc_test_${suffix}` })
        }
        // A lower id (sorts between 03 and 04) inserted after the walk already
        // advanced its cursor past rncyc_test_04.
        await seedCycle({ id: "rncyc_test_03b" })

        const cutoff = dueBefore()

        const afterCursor = await service.listDueRenewalCyclesForWindow({
          dueBefore: cutoff,
          cursor: "rncyc_test_04",
          limit: 100,
        })
        // id must be strictly greater than the cursor, so 03b is NOT resurfaced
        // within the same walk — only ids above the cursor return.
        expect(afterCursor.map((r) => r.id)).toEqual(["rncyc_test_05"])
        expect(afterCursor.map((r) => r.id)).not.toContain("rncyc_test_03b")

        const fromEmpty = await service.listDueRenewalCyclesForWindow({
          dueBefore: cutoff,
          cursor: "",
          limit: 100,
        })
        // A fresh daily walk (cursor reset to "") returns 03b in its ascending slot.
        expect(fromEmpty.map((r) => r.id)).toEqual([
          "rncyc_test_01",
          "rncyc_test_02",
          "rncyc_test_03",
          "rncyc_test_03b",
          "rncyc_test_04",
          "rncyc_test_05",
        ])
      })

      it("excludes succeeded and future-dated cycles, includes past-due failed cycles", async () => {
        await seedCycle({ id: "rncyc_test_01" })
        await seedCycle({ id: "rncyc_test_02" })
        await seedCycle({
          id: "rncyc_test_succeeded",
          status: RenewalCycleStatus.SUCCEEDED,
        })
        await seedCycle({
          id: "rncyc_test_future",
          scheduled_for: FUTURE,
        })
        await seedCycle({
          id: "rncyc_test_failed",
          status: RenewalCycleStatus.FAILED,
        })

        const rows = await service.listDueRenewalCyclesForWindow({
          dueBefore: dueBefore(),
          cursor: "",
          limit: 100,
        })
        const ids = rows.map((r) => r.id)

        // Terminal SUCCEEDED excluded by status; future-dated excluded by the
        // window bound; FAILED past-due retained for retry on this window day.
        expect(ids).not.toContain("rncyc_test_succeeded")
        expect(ids).not.toContain("rncyc_test_future")
        expect(ids).toContain("rncyc_test_failed")
        expect(ids).toContain("rncyc_test_01")
        expect(ids).toContain("rncyc_test_02")
      })

      it("resets the cursor across UTC days and upserts a single row", async () => {
        // No row yet => empty cursor.
        expect(
          await service.getRenewalJobCursor(JOB_NAME, "2026-06-01")
        ).toEqual("")

        await service.advanceRenewalJobCursor(
          JOB_NAME,
          "2026-06-01",
          "rncyc_test_03"
        )
        expect(
          await service.getRenewalJobCursor(JOB_NAME, "2026-06-01")
        ).toEqual("rncyc_test_03")

        // A different window key is a new UTC day => cursor resets to empty.
        expect(
          await service.getRenewalJobCursor(JOB_NAME, "2026-06-02")
        ).toEqual("")

        // Advancing again for the same job upserts the single row, not a new one.
        await service.advanceRenewalJobCursor(
          JOB_NAME,
          "2026-06-02",
          "rncyc_test_09"
        )

        const cursors = await service.listRenewalJobCursors({
          job_name: JOB_NAME,
        })
        expect(cursors).toHaveLength(1)
        expect(cursors[0].window_key).toEqual("2026-06-02")
        expect(cursors[0].cursor).toEqual("rncyc_test_09")
      })
    })
  },
})

jest.setTimeout(60 * 1000)
