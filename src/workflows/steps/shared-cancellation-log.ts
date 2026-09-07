import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../../modules/activity-log/types"
import { normalizeActivityLogEvent } from "../../modules/activity-log/utils/normalize-log-event"
import type {
  CancellationCaseStatus,
  CancellationFinalOutcome,
  CancellationReasonCategory,
} from "../../modules/cancellation/types"
import { toISOStringOrNull } from "../utils/date-output"

export type CancellationSubscriptionDisplayRecord = {
  id: string
  reference: string
  customer_id: string
  customer_snapshot: {
    full_name?: string | null
  } | null
  product_snapshot: {
    product_title?: string | null
    variant_title?: string | null
  } | null
}

export type CancellationEntrySource =
  | "subscription_list"
  | "subscription_detail"
  | "admin_manual"
  | "customer_self_service"

export type CancellationLogSource = "admin" | "storefront"

export const DEFAULT_CANCELLATION_ENTRY_SOURCE: CancellationEntrySource =
  "admin_manual"

export function resolveCancellationLogSource(
  entrySource?: CancellationEntrySource | null
): CancellationLogSource {
  return entrySource === "customer_self_service" ? "storefront" : "admin"
}

export function resolveCancellationCaseOrigin(
  entrySource?: CancellationEntrySource | null
) {
  return entrySource === "customer_self_service"
    ? "customer_cancel_intent"
    : "admin_cancel_intent"
}

type CancellationCaseStartedLogRecord = {
  id: string
  subscription_id: string
  status: CancellationCaseStatus
  reason: string | null
  reason_category: CancellationReasonCategory | null
  notes: string | null
  updated_at: Date
}

type CancellationCaseFinalizedLogRecord = {
  id: string
  subscription_id: string
  status: CancellationCaseStatus
  reason: string | null
  reason_category: CancellationReasonCategory | null
  final_outcome: CancellationFinalOutcome | null
  cancellation_effective_at: Date | null
  finalized_at: Date | null
}

function buildDisplaySnapshot(
  subscription: CancellationSubscriptionDisplayRecord
) {
  return {
    subscription_reference: subscription.reference,
    customer_name: subscription.customer_snapshot?.full_name ?? null,
    product_title: subscription.product_snapshot?.product_title ?? null,
    variant_title: subscription.product_snapshot?.variant_title ?? null,
  }
}

export function buildCancellationCaseStartedLogEvent(input: {
  current: CancellationCaseStartedLogRecord
  previous: CancellationCaseStartedLogRecord | null
  subscription: CancellationSubscriptionDisplayRecord
  entry_source?: CancellationEntrySource | null
  triggered_by?: string | null
}) {
  const entrySource = input.entry_source ?? DEFAULT_CANCELLATION_ENTRY_SOURCE

  return normalizeActivityLogEvent({
    subscription_id: input.current.subscription_id,
    customer_id: input.subscription.customer_id,
    event_type: ActivityLogEventType.CANCELLATION_CASE_STARTED,
    actor_type: ActivityLogActorType.USER,
    actor_id: input.triggered_by ?? null,
    display: buildDisplaySnapshot(input.subscription),
    previous_state: input.previous
      ? {
          status: input.previous.status,
          reason: input.previous.reason,
          reason_category: input.previous.reason_category,
          notes: input.previous.notes,
        }
      : null,
    new_state: {
      status: input.current.status,
      reason: input.current.reason,
      reason_category: input.current.reason_category,
      notes: input.current.notes,
    },
    reason: input.current.reason ?? null,
    metadata: {
      source: resolveCancellationLogSource(entrySource),
      cancellation_case_id: input.current.id,
      trigger_type: entrySource,
    },
    dedupe: {
      scope: "cancellation",
      target_id: input.current.id,
      qualifier: toISOStringOrNull(input.current.updated_at),
    },
  })
}

export function buildCancellationFinalizedLogEvent(input: {
  current: CancellationCaseFinalizedLogRecord
  previous: CancellationCaseFinalizedLogRecord
  subscription: CancellationSubscriptionDisplayRecord
  finalized_by?: string | null
  effective_at?: "immediately" | "end_of_cycle"
  source?: CancellationLogSource
}) {
  return normalizeActivityLogEvent({
    subscription_id: input.current.subscription_id,
    customer_id: input.subscription.customer_id,
    event_type: ActivityLogEventType.CANCELLATION_FINALIZED,
    actor_type: ActivityLogActorType.USER,
    actor_id: input.finalized_by ?? null,
    display: buildDisplaySnapshot(input.subscription),
    previous_state: {
      status: input.previous.status,
      final_outcome: input.previous.final_outcome,
      cancellation_effective_at: toISOStringOrNull(
        input.previous.cancellation_effective_at
      ),
      reason: input.previous.reason,
      reason_category: input.previous.reason_category,
    },
    new_state: {
      status: input.current.status,
      final_outcome: input.current.final_outcome,
      cancellation_effective_at: toISOStringOrNull(
        input.current.cancellation_effective_at
      ),
      reason: input.current.reason,
      reason_category: input.current.reason_category,
    },
    reason: input.current.reason ?? null,
    metadata: {
      source: input.source ?? "admin",
      cancellation_case_id: input.current.id,
      effective_at: input.effective_at ?? "immediately",
    },
    dedupe: {
      scope: "cancellation",
      target_id: input.current.id,
      qualifier: toISOStringOrNull(input.current.finalized_at),
    },
  })
}
