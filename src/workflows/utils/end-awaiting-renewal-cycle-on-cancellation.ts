import type { MedusaContainer } from "@medusajs/framework/types"
import { ACTIVITY_LOG_MODULE } from "../../modules/activity-log"
import type ActivityLogModuleService from "../../modules/activity-log/service"
import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../../modules/activity-log/types"
import { normalizeActivityLogEvent } from "../../modules/activity-log/utils/normalize-log-event"
import { RENEWAL_MODULE } from "../../modules/renewal"
import type RenewalModuleService from "../../modules/renewal/service"
import {
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../modules/renewal/types"
import { persistSubscriptionLogEvent } from "../steps/create-subscription-log-event"
import type {
  CancellationLogSource,
  CancellationSubscriptionDisplayRecord,
} from "../steps/shared-cancellation-log"
import { toISOStringOrNull } from "./date-output"

const CANCELLATION_ERROR_CODE = "subscription_cancelled"

export type EndedAwaitingRenewalCycle = {
  cycle: {
    id: string
    status: RenewalCycleStatus
    processed_at: string | null
    last_error: string | null
  }
  attempts: {
    id: string
    status: RenewalAttemptStatus
    finished_at: string | null
    error_code: string | null
    error_message: string | null
  }[]
  subscription_log_id: string | null
}

type RenewalCycleRecord = Awaited<
  ReturnType<RenewalModuleService["listRenewalCycles"]>
>[number]

export type EndAwaitingRenewalCyclesOnCancellationInput = {
  subscription: CancellationSubscriptionDisplayRecord
  cancelled_at: Date | string
  actor_id: string | null
  actor_type?: ActivityLogActorType
  reason: string | null
  /** `scheduler` when a sweep ends a cycle a failed cancellation left behind. */
  source: CancellationLogSource | "scheduler"
}

function toDateOrNull(value: string | null) {
  return value ? new Date(value) : null
}

export async function endAwaitingRenewalCyclesOnCancellation(
  container: MedusaContainer,
  input: EndAwaitingRenewalCyclesOnCancellationInput
): Promise<EndedAwaitingRenewalCycle[]> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)

  const cycles = await renewalModule.listRenewalCycles({
    subscription_id: input.subscription.id,
    status: RenewalCycleStatus.AWAITING_PAYMENT,
  })
  const ended: EndedAwaitingRenewalCycle[] = []

  try {
    for (const cycle of cycles) {
      const entry: EndedAwaitingRenewalCycle = {
        cycle: {
          id: cycle.id,
          status: cycle.status,
          processed_at: toISOStringOrNull(cycle.processed_at),
          last_error: cycle.last_error,
        },
        attempts: [],
        subscription_log_id: null,
      }

      // Recorded before its writes, so a throw half way through still restores this cycle.
      ended.push(entry)
      await endCycle(container, input, cycle, entry)
    }
  } catch (error) {
    await restoreAwaitingRenewalCycles(container, ended)

    throw error
  }

  return ended
}

async function endCycle(
  container: MedusaContainer,
  input: EndAwaitingRenewalCyclesOnCancellationInput,
  cycle: RenewalCycleRecord,
  entry: EndedAwaitingRenewalCycle
) {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const { subscription } = input
  const finishedAt = new Date(input.cancelled_at)
  const message = `Renewal ended unpaid: subscription '${subscription.id}' was cancelled while the renewal awaited its payment`

  const attempts = await renewalModule.listRenewalAttempts({
    renewal_cycle_id: cycle.id,
    status: RenewalAttemptStatus.PROCESSING,
  })

  // An attempt that submitted its charge stays processing: the provider may still settle it, and
  // its late signal finds it through the session it is recorded on.
  for (const attempt of attempts.filter(({ payment_reference }) => !payment_reference)) {
    entry.attempts.push({
      id: attempt.id,
      status: attempt.status,
      finished_at: toISOStringOrNull(attempt.finished_at),
      error_code: attempt.error_code,
      error_message: attempt.error_message,
    })

    await renewalModule.updateRenewalAttempts({
      id: attempt.id,
      status: RenewalAttemptStatus.FAILED,
      finished_at: finishedAt,
      error_code: CANCELLATION_ERROR_CODE,
      error_message: message,
    })
  }

  await renewalModule.updateRenewalCycles({
    id: cycle.id,
    status: RenewalCycleStatus.FAILED,
    processed_at: finishedAt,
    last_error: message,
  })

  const log = await persistSubscriptionLogEvent(
    container,
    normalizeActivityLogEvent({
      subscription_id: subscription.id,
      customer_id: subscription.customer_id,
      event_type: ActivityLogEventType.RENEWAL_FAILED,
      actor_type: input.actor_type ?? ActivityLogActorType.USER,
      actor_id: input.actor_id,
      display: {
        subscription_reference: subscription.reference,
        customer_name: subscription.customer_snapshot?.full_name ?? null,
        product_title: subscription.product_snapshot?.product_title ?? null,
        variant_title: subscription.product_snapshot?.variant_title ?? null,
      },
      previous_state: {
        status: cycle.status,
        attempt_count: cycle.attempt_count,
        processed_at: toISOStringOrNull(cycle.processed_at),
        generated_order_id: cycle.generated_order_id,
        last_error: cycle.last_error,
      },
      new_state: {
        status: RenewalCycleStatus.FAILED,
        attempt_count: cycle.attempt_count,
        processed_at: toISOStringOrNull(finishedAt),
        generated_order_id: cycle.generated_order_id,
        last_error: message,
      },
      reason: input.reason,
      metadata: {
        source: input.source,
        renewal_cycle_id: cycle.id,
        order_id: cycle.generated_order_id,
        reason_code: CANCELLATION_ERROR_CODE,
        scheduled_for: toISOStringOrNull(cycle.scheduled_for),
      },
      dedupe: {
        scope: "renewal",
        target_id: cycle.id,
        qualifier: toISOStringOrNull(finishedAt),
      },
    })
  )

  entry.subscription_log_id = log.action === "created" ? log.record.id : null
}

export async function restoreAwaitingRenewalCycles(
  container: MedusaContainer,
  ended: EndedAwaitingRenewalCycle[]
): Promise<void> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const activityLogModule =
    container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)

  for (const entry of ended) {
    await renewalModule.updateRenewalCycles({
      id: entry.cycle.id,
      status: entry.cycle.status,
      processed_at: toDateOrNull(entry.cycle.processed_at),
      last_error: entry.cycle.last_error,
    })

    for (const attempt of entry.attempts) {
      await renewalModule.updateRenewalAttempts({
        id: attempt.id,
        status: attempt.status,
        finished_at: toDateOrNull(attempt.finished_at),
        error_code: attempt.error_code,
        error_message: attempt.error_message,
      })
    }

    if (entry.subscription_log_id) {
      await activityLogModule.deleteSubscriptionLogs(entry.subscription_log_id)
    }
  }
}
