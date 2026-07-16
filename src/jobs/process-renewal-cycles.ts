import { Logger, MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { randomUUID } from "crypto"
import { setTimeout as delay } from "node:timers/promises"
import { DateTime } from "luxon"
import { RENEWAL_MODULE } from "../modules/renewal"
import type RenewalModuleService from "../modules/renewal/service"
import {
  isApprovalEligible,
  type DueRenewalCycleRecord,
} from "../modules/renewal/utils/scheduler-query"
import {
  classifyRenewalFailure,
  createRenewalCorrelationId,
  getRenewalErrorMessage,
  isAlertableRenewalFailure,
  logRenewalEvent,
} from "../modules/renewal/utils/observability"
import { processRenewalCycleWorkflow } from "../workflows"

const JOB_NAME = "process-renewal-cycles"
const LOCK_KEY = "jobs:renewal-cycles"
// Fleet-wide lock TTL. Exceeds a worst-case full page so a crashed run's lock
// self-expires; the provider must be cross-process (redis/postgres) for the
// single-instance guarantee to hold across processes.
const LOCK_TTL_SECONDS = 600
// Reads a positive-integer override from the environment. Env files are
// loaded by the consuming app via Medusa's loadEnv before job files are
// evaluated, so reading process.env at module scope is safe. Unset, non-numeric,
// zero, or negative values fall back to the default.
function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]

  if (!raw) {
    return fallback
  }

  const parsed = Number.parseInt(raw, 10)

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

// Records fetched per run (one keyset page), NOT the number of renewals done.
const JOB_BATCH_SIZE = positiveIntFromEnv(
  "SUBSCRIPTION_RENEWAL_JOB_BATCH_SIZE",
  100
)
// Renewal workflows run concurrently within a chunk.
const CONCURRENT_RENEWAL_BATCH_SIZE = positiveIntFromEnv(
  "SUBSCRIPTION_RENEWAL_CONCURRENT_BATCH_SIZE",
  5
)
// Gap between consecutive concurrent chunks, in ms.
const RENEWAL_SEPARATION_DELAY = 1000

async function processCycle(
  container: MedusaContainer,
  logger: Logger,
  cycle: DueRenewalCycleRecord,
  jobCorrelationId: string
) {
  const cycleCorrelationId = `${jobCorrelationId}:${cycle.id}`
  const startedAt = Date.now()

  try {
    await processRenewalCycleWorkflow(container).run({
      input: {
        renewal_cycle_id: cycle.id,
        trigger_type: "scheduler",
        correlation_id: cycleCorrelationId,
      },
    })

    logRenewalEvent(logger, "info", {
      event: "renewal.job.cycle",
      job_name: JOB_NAME,
      outcome: "succeeded",
      correlation_id: cycleCorrelationId,
      renewal_cycle_id: cycle.id,
      subscription_id: cycle.subscription_id,
      trigger_type: "scheduler",
      duration_ms: Date.now() - startedAt,
      success_count: 1,
      failure_count: 0,
    })

    return "succeeded" as const
  } catch (error) {
    const message = getRenewalErrorMessage(error)
    const failureKind = classifyRenewalFailure(error)
    const isBlockedKind =
      failureKind === "already_processing" ||
      failureKind === "duplicate_execution" ||
      failureKind === "cycle_superseded"
    const level = isBlockedKind ? "warn" : "error"

    logRenewalEvent(logger, level, {
      event: "renewal.job.cycle",
      job_name: JOB_NAME,
      outcome: isBlockedKind ? "blocked" : "failed",
      correlation_id: cycleCorrelationId,
      renewal_cycle_id: cycle.id,
      subscription_id: cycle.subscription_id,
      trigger_type: "scheduler",
      duration_ms: Date.now() - startedAt,
      success_count: 0,
      failure_count: 1,
      failure_kind: failureKind,
      alertable: isAlertableRenewalFailure(failureKind),
      message,
    })

    return isBlockedKind ? ("blocked" as const) : ("failed" as const)
  }
}

export default async function processRenewalCyclesJob(
  container: MedusaContainer,
  context?: { scheduledFor?: Date }
) {
  const logger = container.resolve<Logger>("logger")
  const locking = container.resolve(Modules.LOCKING)
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const ownerId = randomUUID()
  const jobCorrelationId = createRenewalCorrelationId(JOB_NAME)
  const startedAt = Date.now()

  // Window is anchored on the current UTC day regardless of each cycle's exact
  // scheduled time. `scheduledFor` is used only for observability (per the job
  // docs: slots are skippable and must not drive the dataset boundary).
  const nowUtc = DateTime.utc()
  const windowKey = nowUtc.toISODate()!
  const dueBefore = nowUtc.plus({ days: 1 }).startOf("day").toJSDate()

  logRenewalEvent(logger, "info", {
    event: "renewal.job",
    job_name: JOB_NAME,
    outcome: "started",
    correlation_id: jobCorrelationId,
    batch_size: JOB_BATCH_SIZE,
    metadata: {
      window_key: windowKey,
      concurrent_batch_size: CONCURRENT_RENEWAL_BATCH_SIZE,
      due_before: dueBefore.toISOString(),
      scheduled_for: context?.scheduledFor?.toISOString() ?? null,
    },
  })

  try {
    await locking.acquire(LOCK_KEY, { ownerId, expire: LOCK_TTL_SECONDS })
  } catch (error) {
    // Contention is expected (fail-fast skip), but a provider outage lands
    // here too — surface the underlying error so ops can tell them apart.
    logRenewalEvent(logger, "warn", {
      event: "renewal.job",
      job_name: JOB_NAME,
      outcome: "blocked",
      correlation_id: jobCorrelationId,
      failure_kind: "already_processing",
      alertable: false,
      message: `Renewal scheduler skipped; lock not acquired: ${getRenewalErrorMessage(error)}`,
    })
    return
  }

  try {
    const cursor = await renewalModule.getRenewalJobCursor(JOB_NAME, windowKey)
    const fetched = await renewalModule.listDueRenewalCyclesForWindow({
      dueBefore,
      cursor,
      limit: JOB_BATCH_SIZE,
    })

    if (fetched.length === 0) {
      logRenewalEvent(logger, "info", {
        event: "renewal.job",
        job_name: JOB_NAME,
        outcome: "completed",
        correlation_id: jobCorrelationId,
        duration_ms: Date.now() - startedAt,
        batch_size: JOB_BATCH_SIZE,
        scanned_count: 0,
        processed_count: 0,
        success_count: 0,
        failure_count: 0,
        blocked_count: 0,
        message: "Renewal scheduler window empty; nothing due",
        metadata: { window_key: windowKey, cursor },
      })
      return
    }

    const renewable = fetched.filter(isApprovalEligible)

    let succeeded = 0
    let failed = 0
    let blocked = 0

    for (let i = 0; i < renewable.length; i += CONCURRENT_RENEWAL_BATCH_SIZE) {
      const chunk = renewable.slice(i, i + CONCURRENT_RENEWAL_BATCH_SIZE)

      const results = await Promise.allSettled(
        chunk.map((cycle) =>
          processCycle(container, logger, cycle, jobCorrelationId)
        )
      )

      for (const result of results) {
        const outcome = result.status === "fulfilled" ? result.value : "failed"

        if (outcome === "succeeded") {
          succeeded += 1
        } else if (outcome === "blocked") {
          blocked += 1
        } else {
          failed += 1
        }
      }

      if (i + CONCURRENT_RENEWAL_BATCH_SIZE < renewable.length) {
        await delay(RENEWAL_SEPARATION_DELAY)
      }
    }

    // Advance-after: move the cursor past every examined record (including
    // approval-skipped ones) to the max fetched id. A crash before this line
    // just re-fetches the same page next run; per-cycle idempotency makes
    // reprocessing a no-op.
    const nextCursor = fetched[fetched.length - 1].id
    await renewalModule.advanceRenewalJobCursor(JOB_NAME, windowKey, nextCursor)

    logRenewalEvent(logger, "info", {
      event: "renewal.job",
      job_name: JOB_NAME,
      outcome: "completed",
      correlation_id: jobCorrelationId,
      duration_ms: Date.now() - startedAt,
      batch_size: JOB_BATCH_SIZE,
      scanned_count: fetched.length,
      processed_count: renewable.length,
      success_count: succeeded,
      failure_count: failed,
      blocked_count: blocked,
      message: "Renewal scheduler window batch completed",
      metadata: { window_key: windowKey, cursor: nextCursor },
    })
  } catch (error) {
    logRenewalEvent(logger, "error", {
      event: "renewal.job",
      job_name: JOB_NAME,
      outcome: "failed",
      correlation_id: jobCorrelationId,
      duration_ms: Date.now() - startedAt,
      batch_size: JOB_BATCH_SIZE,
      alertable: true,
      failure_kind: "unexpected_error",
      message: getRenewalErrorMessage(error),
    })
  } finally {
    await locking.release(LOCK_KEY, { ownerId })
  }
}

export const config = {
  name: JOB_NAME,
  // Runs only inside the daily renewal window. The cron is evaluated in the
  // process timezone (not guaranteed UTC), so set SUBSCRIPTION_RENEWAL_CRON to
  // land the window where you want relative to UTC. Default: every 5 min in the
  // 05:00-08:55 hour range, i.e. the half-open [05:00, 09:00) UTC window when
  // the process runs in UTC.
  schedule: process.env.SUBSCRIPTION_RENEWAL_CRON ?? "*/5 5-8 * * *",
}
