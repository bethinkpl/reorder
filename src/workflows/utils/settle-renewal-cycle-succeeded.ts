import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../../modules/activity-log/types"
import { normalizeActivityLogEvent } from "../../modules/activity-log/utils/normalize-log-event"
import { resolveProductSubscriptionConfig } from "../../modules/plan-offer/utils/effective-config"
import { RENEWAL_MODULE } from "../../modules/renewal"
import type RenewalModuleService from "../../modules/renewal/service"
import {
  type RenewalAppliedPendingUpdateData,
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../modules/renewal/types"
import {
  createRenewalCorrelationId,
  logRenewalEvent,
} from "../../modules/renewal/utils/observability"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import type SubscriptionModuleService from "../../modules/subscription/service"
import type {
  SubscriptionSourceSnapshot,
  SubscriptionType,
} from "../../modules/subscription/types"
import { addSubscriptionCadence } from "../../modules/subscription/utils/effective-next-renewal"
import type { FrequencyInterval } from "../../common/types/frequency-interval"
import { persistSubscriptionLogEvent } from "../steps/create-subscription-log-event"
import { buildPricingSnapshot } from "../steps/validate-subscription-cart"
import { toISOStringOrNull } from "./date-output"

type RenewalCycleRecord = {
  id: string
  subscription_id: string
  scheduled_for: Date | string
  status: RenewalCycleStatus
  generated_order_id: string | null
  applied_pending_update_data: RenewalAppliedPendingUpdateData | null
  attempt_count: number
  processed_at: Date | string | null
  last_error: string | null
}

type RenewalAttemptRecord = {
  id: string
  attempt_no: number
}

type RenewalCycleState = {
  status: RenewalCycleStatus
  attempt_count: number
  processed_at: string | null
  generated_order_id: string | null
  last_error: string | null
}

/** Who paid for the cycle. Recorded on the audit entry the settlement writes. */
export type RenewalSettlementSource =
  | "renewal"
  | "dunning_retry"
  | "customer_payment"

/**
 * What the renewal workflow knows and a recovery does not: the run that opened the cycle. Passing
 * it keeps the audit entry identical to the one the workflow used to write itself.
 */
export type RenewalSettlementAudit = {
  correlation_id: string
  trigger_type: "scheduler" | "manual"
  triggered_by: string | null
  attempt_no: number
  operation_started_at: number
  scheduled_for: string
  previous_state: RenewalCycleState
}

export type SettleRenewalCycleSucceededInput = {
  renewal_cycle_id: string
  subscription_id: string
  order_id: string | null
  finished_at: Date
  /** The attempt the caller owns. Without it the settlement records one of its own. */
  attempt_id?: string | null
  source_snapshot?: SubscriptionSourceSnapshot | null
  /** Defaults to the scheduled dunning retry: the one caller that settles without saying so. */
  source?: RenewalSettlementSource
  audit?: RenewalSettlementAudit
}

export type SettleRenewalCycleSucceededResult = {
  settled: boolean
  /** Why nothing was written; `null` on the settling run. */
  reason: "already_succeeded" | "cycle_superseded" | null
  renewal_cycle: RenewalCycleRecord
  applied_pending_changes: RenewalAppliedPendingUpdateData | null
}

async function nextAttemptNo(
  renewalModule: RenewalModuleService,
  cycle: RenewalCycleRecord
) {
  const attempts = (await renewalModule.listRenewalAttempts({
    renewal_cycle_id: cycle.id,
  } as never)) as unknown as RenewalAttemptRecord[]

  const highest = attempts.reduce(
    (max, attempt) => Math.max(max, attempt.attempt_no ?? 0),
    0
  )

  return Math.max(cycle.attempt_count, highest) + 1
}

/**
 * Closes a renewal cycle as succeeded: links the order, moves the subscription's billing dates
 * forward, applies whatever plan change the cycle carried, records the attempt and writes the
 * `renewal.succeeded` audit entry.
 *
 * Shared by `finalizeRenewalCycleStep` (the charge went through first time) and by both recovery
 * paths (the charge failed and the money arrived later), which must leave the same state behind.
 */
export async function settleRenewalCycleSucceeded(
  container: MedusaContainer,
  input: SettleRenewalCycleSucceededInput
): Promise<SettleRenewalCycleSucceededResult> {
  const startedAtMs = Date.now()
  const logger = container.resolve("logger")
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
  const source = input.source ?? "dunning_retry"

  const cycle = (await renewalModule.retrieveRenewalCycle(
    input.renewal_cycle_id
  )) as unknown as RenewalCycleRecord

  const appliedPendingChanges = cycle.applied_pending_update_data

  if (cycle.status === RenewalCycleStatus.SUCCEEDED) {
    // A recovery settled this cycle while a renewal run was between prepare and finalize. That
    // run's attempt row is nobody else's to close, and it would sit PROCESSING forever. It leaves
    // the cycle with two succeeded attempts, which is the honest record of what happened.
    if (input.attempt_id) {
      await renewalModule.updateRenewalAttempts({
        id: input.attempt_id,
        status: RenewalAttemptStatus.SUCCEEDED,
        finished_at: input.finished_at,
        order_id: input.order_id,
        error_code: null,
        error_message: null,
      })
    }

    return {
      settled: false,
      reason: "already_succeeded",
      renewal_cycle: cycle,
      applied_pending_changes: appliedPendingChanges,
    }
  }

  const subscription = (await subscriptionModule.retrieveSubscription(
    input.subscription_id
  )) as SubscriptionType

  const scheduledAnchor = new Date(cycle.scheduled_for)
  const currentNextRenewalAt = subscription.next_renewal_at
    ? new Date(subscription.next_renewal_at)
    : null

  // Billing has already moved past this cycle, so settling it now would rewind `next_renewal_at`
  // and leave the caller deleting the cycle that is actually due. A null date is not "past": it is
  // what an involuntary churn leaves behind, and that cycle is still this one.
  if (
    currentNextRenewalAt &&
    currentNextRenewalAt.getTime() > scheduledAnchor.getTime()
  ) {
    return {
      settled: false,
      reason: "cycle_superseded",
      renewal_cycle: cycle,
      applied_pending_changes: appliedPendingChanges,
    }
  }

  if (input.order_id) {
    const link = container.resolve(ContainerRegistrationKeys.LINK)

    await link.create({
      [RENEWAL_MODULE]: {
        renewal_cycle_id: cycle.id,
      },
      [Modules.ORDER]: {
        order_id: input.order_id,
      },
    })

    await link.create({
      [SUBSCRIPTION_MODULE]: {
        subscription_id: subscription.id,
      },
      [Modules.ORDER]: {
        order_id: input.order_id,
      },
    })
  }

  const nextInterval =
    appliedPendingChanges?.frequency_interval ?? subscription.frequency_interval
  const nextValue =
    appliedPendingChanges?.frequency_value ?? subscription.frequency_value
  const nextRenewalAt = addSubscriptionCadence(
    scheduledAnchor,
    nextInterval,
    nextValue
  )
  const finishedAt = input.finished_at

  const nextProductSnapshot = appliedPendingChanges
    ? {
        ...subscription.product_snapshot,
        variant_id: appliedPendingChanges.variant_id,
        variant_title: appliedPendingChanges.variant_title,
        sku: appliedPendingChanges.sku ?? subscription.product_snapshot.sku,
      }
    : subscription.product_snapshot

  // A plan change re-negotiates the deal: the frozen pricing snapshot must
  // be rebuilt from the live plan config for the NEW variant and frequency,
  // or the signup discount would keep applying to the new plan's price on
  // every future cycle.
  let nextPricingSnapshot = subscription.pricing_snapshot

  if (appliedPendingChanges) {
    const effectiveConfig = await resolveProductSubscriptionConfig(container, {
      product_id: subscription.product_id,
      variant_id: appliedPendingChanges.variant_id,
    })

    nextPricingSnapshot = effectiveConfig.is_enabled
      ? buildPricingSnapshot(
          effectiveConfig.discount_per_frequency,
          nextInterval as FrequencyInterval,
          nextValue
        )
      : null
  }

  await subscriptionModule.updateSubscriptions({
    id: subscription.id,
    variant_id: appliedPendingChanges?.variant_id ?? subscription.variant_id,
    frequency_interval: nextInterval,
    frequency_value: nextValue,
    product_snapshot: nextProductSnapshot,
    pricing_snapshot: nextPricingSnapshot,
    next_renewal_at: nextRenewalAt,
    last_renewal_at: finishedAt,
    skip_next_cycle: false,
    pending_update_data: appliedPendingChanges
      ? null
      : subscription.pending_update_data,
    ...(input.source_snapshot ? { source_snapshot: input.source_snapshot } : {}),
  })

  const updatedCycle = (await renewalModule.updateRenewalCycles({
    id: cycle.id,
    status: RenewalCycleStatus.SUCCEEDED,
    processed_at: finishedAt,
    generated_order_id: input.order_id,
    last_error: null,
  })) as unknown as RenewalCycleRecord

  let settledAttemptNo = input.audit?.attempt_no ?? 0

  if (input.attempt_id) {
    await renewalModule.updateRenewalAttempts({
      id: input.attempt_id,
      status: RenewalAttemptStatus.SUCCEEDED,
      finished_at: finishedAt,
      order_id: input.order_id,
      error_code: null,
      error_message: null,
    })
  } else {
    // A recovery must not overwrite the attempt that recorded the decline: its error code is the
    // only record of why the case was opened.
    settledAttemptNo = await nextAttemptNo(renewalModule, cycle)

    await renewalModule.createRenewalAttempts({
      renewal_cycle_id: cycle.id,
      attempt_no: settledAttemptNo,
      started_at: finishedAt,
      finished_at: finishedAt,
      status: RenewalAttemptStatus.SUCCEEDED,
      error_code: null,
      error_message: null,
      payment_reference: null,
      order_id: input.order_id,
      metadata: { source },
    })
  }

  const audit = input.audit
  const correlationId =
    audit?.correlation_id ?? createRenewalCorrelationId(`renewal-${source}`)
  const previousState: RenewalCycleState = audit?.previous_state ?? {
    status: cycle.status,
    attempt_count: cycle.attempt_count,
    processed_at: toISOStringOrNull(cycle.processed_at),
    generated_order_id: cycle.generated_order_id,
    last_error: cycle.last_error,
  }

  logRenewalEvent(logger, "info", {
    event: "renewal.execution",
    outcome: "succeeded",
    correlation_id: correlationId,
    renewal_cycle_id: cycle.id,
    subscription_id: subscription.id,
    ...(audit ? { trigger_type: audit.trigger_type } : {}),
    triggered_by: audit?.triggered_by ?? null,
    attempt_no: settledAttemptNo,
    duration_ms: Date.now() - (audit?.operation_started_at ?? startedAtMs),
    success_count: 1,
    failure_count: 0,
    metadata: {
      generated_order_id: input.order_id,
      applied_pending_changes: Boolean(appliedPendingChanges),
      ...(audit ? {} : { source }),
    },
  })

  await persistSubscriptionLogEvent(container, normalizeActivityLogEvent({
    subscription_id: subscription.id,
    customer_id: subscription.customer_id,
    event_type: ActivityLogEventType.RENEWAL_SUCCEEDED,
    actor_type: audit
      ? audit.trigger_type === "manual"
        ? ActivityLogActorType.USER
        : ActivityLogActorType.SCHEDULER
      : ActivityLogActorType.SYSTEM,
    actor_id: audit?.triggered_by ?? null,
    display: {
      subscription_reference: subscription.reference,
      customer_name: subscription.customer_snapshot?.full_name ?? null,
      product_title: subscription.product_snapshot.product_title ?? null,
      variant_title:
        appliedPendingChanges?.variant_title ??
        subscription.product_snapshot.variant_title ??
        null,
    },
    previous_state: previousState,
    new_state: {
      status: updatedCycle.status,
      attempt_count: updatedCycle.attempt_count,
      processed_at: toISOStringOrNull(updatedCycle.processed_at),
      generated_order_id: updatedCycle.generated_order_id,
      last_error: updatedCycle.last_error,
      applied_pending_update_data: appliedPendingChanges,
    },
    metadata: {
      source: audit
        ? audit.trigger_type === "manual"
          ? "admin"
          : "scheduler"
        : source,
      renewal_cycle_id: cycle.id,
      order_id: input.order_id,
      trigger_type: audit?.trigger_type ?? null,
      scheduled_for: audit?.scheduled_for ?? scheduledAnchor.toISOString(),
    },
    correlation_id: correlationId,
    dedupe: {
      scope: "renewal",
      target_id: cycle.id,
      qualifier: toISOStringOrNull(updatedCycle.processed_at),
    },
  }))

  return {
    settled: true,
    reason: null,
    renewal_cycle: updatedCycle,
    applied_pending_changes: appliedPendingChanges,
  }
}
