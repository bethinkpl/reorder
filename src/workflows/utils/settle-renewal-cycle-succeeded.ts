import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { resolveProductSubscriptionConfig } from "../../modules/plan-offer/utils/effective-config"
import { RENEWAL_MODULE } from "../../modules/renewal"
import type RenewalModuleService from "../../modules/renewal/service"
import {
  type RenewalAppliedPendingUpdateData,
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../modules/renewal/types"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import type SubscriptionModuleService from "../../modules/subscription/service"
import type {
  SubscriptionSourceSnapshot,
  SubscriptionType,
} from "../../modules/subscription/types"
import { addSubscriptionCadence } from "../../modules/subscription/utils/effective-next-renewal"
import type { FrequencyInterval } from "../../common/types/frequency-interval"
import { buildPricingSnapshot } from "../steps/validate-subscription-cart"

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

export type SettleRenewalCycleSucceededInput = {
  renewal_cycle_id: string
  subscription_id: string
  order_id: string | null
  finished_at: Date
  /** The attempt the caller owns. Without it the cycle's highest-numbered attempt is settled. */
  attempt_id?: string | null
  source_snapshot?: SubscriptionSourceSnapshot | null
}

export type SettleRenewalCycleSucceededResult = {
  /** False when the cycle was already `SUCCEEDED`, in which case nothing was written. */
  settled: boolean
  renewal_cycle: RenewalCycleRecord
  applied_pending_changes: RenewalAppliedPendingUpdateData | null
}

async function resolveAttemptId(
  renewalModule: RenewalModuleService,
  cycleId: string,
  attemptId?: string | null
) {
  if (attemptId) {
    return attemptId
  }

  const attempts = (await renewalModule.listRenewalAttempts({
    renewal_cycle_id: cycleId,
  } as never)) as unknown as RenewalAttemptRecord[]

  const latest = attempts.reduce<RenewalAttemptRecord | null>(
    (highest, attempt) =>
      !highest || (attempt.attempt_no ?? 0) >= (highest.attempt_no ?? 0)
        ? attempt
        : highest,
    null
  )

  return latest?.id ?? null
}

/**
 * Closes a renewal cycle as succeeded: links the order, moves the subscription's billing dates
 * forward, applies whatever plan change the cycle carried and marks the cycle and its attempt.
 *
 * Shared by `finalizeRenewalCycleStep` (the charge went through first time) and by both recovery
 * paths (the charge failed and the money arrived later), which must leave exactly the same state
 * behind. Idempotent: a cycle that is already `SUCCEEDED` is left untouched.
 */
export async function settleRenewalCycleSucceeded(
  container: MedusaContainer,
  input: SettleRenewalCycleSucceededInput
): Promise<SettleRenewalCycleSucceededResult> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

  const cycle = (await renewalModule.retrieveRenewalCycle(
    input.renewal_cycle_id
  )) as unknown as RenewalCycleRecord

  const appliedPendingChanges = cycle.applied_pending_update_data

  if (cycle.status === RenewalCycleStatus.SUCCEEDED) {
    return {
      settled: false,
      renewal_cycle: cycle,
      applied_pending_changes: appliedPendingChanges,
    }
  }

  const subscription = (await subscriptionModule.retrieveSubscription(
    input.subscription_id
  )) as SubscriptionType

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

  const scheduledAnchor = new Date(cycle.scheduled_for)
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

  const attemptId = await resolveAttemptId(
    renewalModule,
    cycle.id,
    input.attempt_id
  )

  if (attemptId) {
    await renewalModule.updateRenewalAttempts({
      id: attemptId,
      status: RenewalAttemptStatus.SUCCEEDED,
      finished_at: finishedAt,
      order_id: input.order_id,
      error_code: null,
      error_message: null,
    })
  }

  return {
    settled: true,
    renewal_cycle: updatedCycle,
    applied_pending_changes: appliedPendingChanges,
  }
}
