import {
  InjectManager,
  MedusaContext,
  MedusaService,
} from "@medusajs/framework/utils"
import { Context } from "@medusajs/framework/types"
import { EntityManager } from "@medusajs/framework/mikro-orm/knex"
import RenewalAttempt from "./models/renewal-attempt"
import RenewalCycle from "./models/renewal-cycle"
import RenewalJobCursor from "./models/renewal-job-cursor"
import { DueRenewalCycleRecord } from "./utils/scheduler-query"

type ListDueRenewalCyclesForWindowInput = {
  dueBefore: Date
  cursor: string
  limit: number
}

class RenewalModuleService extends MedusaService({
  RenewalCycle,
  RenewalAttempt,
  RenewalJobCursor,
}) {
  /**
   * Read the durable cursor for `jobName`. Returns "" when no cursor row
   * exists or when the stored window differs from `windowKey` (daily reset),
   * so a new UTC day always restarts the keyset walk from the beginning.
   */
  async getRenewalJobCursor(
    jobName: string,
    windowKey: string
  ): Promise<string> {
    const [row] = await this.listRenewalJobCursors({ job_name: jobName })

    if (!row || row.window_key !== windowKey) {
      return ""
    }

    return row.cursor ?? ""
  }

  /**
   * Upsert the durable cursor for `jobName` to `cursor` within `windowKey`,
   * stamping `last_run_at`. Advance-after semantics: called with the max
   * examined renewal_cycle id once a page has been processed.
   */
  async advanceRenewalJobCursor(
    jobName: string,
    windowKey: string,
    cursor: string
  ): Promise<void> {
    const [row] = await this.listRenewalJobCursors({ job_name: jobName })

    if (row) {
      await this.updateRenewalJobCursors({
        id: row.id,
        window_key: windowKey,
        cursor,
        last_run_at: new Date(),
      })
      return
    }

    await this.createRenewalJobCursors({
      job_name: jobName,
      window_key: windowKey,
      cursor,
      last_run_at: new Date(),
    })
  }

  /**
   * Keyset-fetch the next page of non-terminal renewal cycles due before
   * `dueBefore`, ordered by the immutable text primary key `id`. Raw SQL is
   * required because the Query module and auto-generated list filters ignore
   * `$gt` on a text `id` and only offer offset pagination — offset is unsafe
   * for exactly-once coverage here (see the job docs). `cursor = ""` yields
   * `id > ''`, i.e. every row. `deleted_at IS NULL` is explicit because raw
   * SQL bypasses the soft-delete filter the auto CRUD applies.
   */
  @InjectManager()
  async listDueRenewalCyclesForWindow(
    input: ListDueRenewalCyclesForWindowInput,
    @MedusaContext() sharedContext: Context<EntityManager> = {}
  ): Promise<DueRenewalCycleRecord[]> {
    const sql = `
      SELECT id, subscription_id, scheduled_for, status, approval_required, approval_status
      FROM renewal_cycle
      WHERE deleted_at IS NULL
        AND status IN ('scheduled', 'failed')
        AND scheduled_for < ?
        AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `

    const rows = await sharedContext.manager!.execute(sql, [
      input.dueBefore,
      input.cursor,
      input.limit,
    ])

    return rows as DueRenewalCycleRecord[]
  }
}

export default RenewalModuleService
