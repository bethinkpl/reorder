import { MedusaContainer } from "@medusajs/framework/types"
import { MedusaError, Modules } from "@medusajs/framework/utils"
import { DUNNING_MODULE } from "../modules/dunning"
import type DunningModuleService from "../modules/dunning/service"
import { CHARGE_IN_FLIGHT_DUNNING_CASE_STATUSES, DunningAttemptStatus, DunningCaseStatus } from "../modules/dunning/types"
import { RENEWAL_MODULE } from "../modules/renewal"
import type RenewalModuleService from "../modules/renewal/service"
import { CHARGE_IN_FLIGHT_RENEWAL_CYCLE_STATUSES, RenewalAttemptStatus, RenewalCycleStatus } from "../modules/renewal/types"
import {
  type ChargeMarker,
  handleChargeReconcileFailure,
  ranTenMinutesAgo,
  reconcileCharge,
} from "../workflows/utils/in-flight-charge"
import { isLockBusy } from "../workflows/utils/with-lock"

const JOB_NAME = "reconcile-in-flight-charges"
const JOB_LOCK_KEY = "jobs:reconcile-in-flight-charges"
const PAGE_SIZE = 200

type Row = { id: string }
type Page<T extends Row> = (after: string | undefined, take: number) => Promise<T[]>

async function forEachPage<T extends Row>(page: Page<T>, visit: (row: T) => Promise<void>) {
  let after: string | undefined

  for (;;) {
    const rows = await page(after, PAGE_SIZE)

    for (const row of rows) {
      await visit(row)
    }

    if (rows.length < PAGE_SIZE) {
      return
    }

    after = rows[rows.length - 1].id
  }
}

const cursor = (after: string | undefined) => (after ? { id: { $gt: after } } : {})
const byId = { order: { id: "ASC" as const } }
const newestFirst = { order: { attempt_no: "DESC" as const }, take: 1 }

async function collectCharges(container: MedusaContainer, now: Date) {
  const renewal = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const dunning = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const charges = new Map<string, ChargeMarker>()
  const add = (kind: ChargeMarker["kind"], row: Row | undefined) => {
    if (row) {
      charges.set(row.id, { kind, attempt_id: row.id })
    }
  }
  const unlessLive = <T extends Row & { started_at: Date }>(parked: boolean, newest: T | undefined) =>
    newest && (parked || ranTenMinutesAgo(newest.started_at, now)) ? newest : undefined

  await forEachPage(
    (after, take) =>
      renewal.listRenewalAttempts({ status: RenewalAttemptStatus.PROCESSING, ...cursor(after) }, { ...byId, take }),
    async (attempt) => add("renewal", ranTenMinutesAgo(attempt.started_at, now) ? attempt : undefined)
  )
  await forEachPage(
    (after, take) =>
      dunning.listDunningAttempts({ status: DunningAttemptStatus.PROCESSING, ...cursor(after) }, { ...byId, take }),
    async (attempt) => add("dunning", ranTenMinutesAgo(attempt.started_at, now) ? attempt : undefined)
  )
  await forEachPage(
    (after, take) =>
      renewal.listRenewalCycles({ status: [...CHARGE_IN_FLIGHT_RENEWAL_CYCLE_STATUSES], ...cursor(after) }, { ...byId, take }),
    async (cycle) => {
      const [newest] = await renewal.listRenewalAttempts({ renewal_cycle_id: cycle.id }, newestFirst)

      add("renewal", unlessLive(cycle.status === RenewalCycleStatus.AWAITING_PAYMENT, newest))
    }
  )
  await forEachPage(
    (after, take) =>
      dunning.listDunningCases({ status: [...CHARGE_IN_FLIGHT_DUNNING_CASE_STATUSES], ...cursor(after) }, { ...byId, take }),
    async (dunningCase) => {
      const [newest] = await dunning.listDunningAttempts({ dunning_case_id: dunningCase.id }, newestFirst)

      add("dunning", unlessLive(dunningCase.status === DunningCaseStatus.AWAITING_PAYMENT, newest))
    }
  )

  return [...charges.values()]
}

async function sweep(container: MedusaContainer) {
  const logger = container.resolve("logger")
  const charges = await collectCharges(container, new Date())
  let skipped = 0
  let failed = 0

  for (const charge of charges) {
    try {
      await reconcileCharge(container, { ...charge, signal: "sweep" })
    } catch (error) {
      if (isLockBusy(error) || (MedusaError.isMedusaError(error) && error.type === MedusaError.Types.NOT_FOUND)) {
        skipped += 1
        continue
      }

      failed += 1
      handleChargeReconcileFailure(container, error, { ...charge, signal: "sweep" })
    }
  }

  logger.info(
    JSON.stringify({
      domain: "subscriptions",
      event: "charge_sweep_completed",
      job_name: JOB_NAME,
      checked: charges.length,
      skipped,
      failed,
    })
  )
}

export default async function reconcileInFlightChargesJob(container: MedusaContainer) {
  const locking = container.resolve(Modules.LOCKING)

  try {
    await locking.execute(JOB_LOCK_KEY, () => sweep(container), { timeout: 1 })
  } catch (error) {
    const blocked = error instanceof Error && /timed-out acquiring lock|timeout/i.test(error.message)

    container.resolve("logger")[blocked ? "warn" : "error"](
      JSON.stringify({
        domain: "subscriptions",
        event: "charge_sweep_failed",
        job_name: JOB_NAME,
        alertable: !blocked,
        message: error instanceof Error ? error.message : String(error),
      })
    )
  }
}

export const config = {
  name: JOB_NAME,
  schedule: "*/30 * * * *",
}
