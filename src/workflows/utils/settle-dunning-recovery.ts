import type { MedusaContainer } from "@medusajs/framework/types"
import { DUNNING_MODULE } from "../../modules/dunning"
import type DunningModuleService from "../../modules/dunning/service"
import { DunningCaseStatus } from "../../modules/dunning/types"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import type SubscriptionModuleService from "../../modules/subscription/service"
import { SubscriptionStatus } from "../../modules/subscription/types"

export type RecoverableDunningCase = {
  id: string
  subscription_id: string
  renewal_cycle_id: string
  renewal_order_id: string | null
  status: DunningCaseStatus
  metadata: Record<string, unknown> | null
  created_at?: Date | string
}

export type SettleDunningCaseRecoveredInput = {
  dunning_case: RecoverableDunningCase
  subscription: { id: string, status: SubscriptionStatus }
  finished_at: Date
  recovery_reason: string
  payment_reference?: string | null
  /** Replaces the case metadata the caller already rewrote (audit entries, cleared streaks). */
  metadata?: Record<string, unknown> | null
}

export type SettleDunningCaseRecoveredResult = {
  /** False when the case was already `RECOVERED`, in which case nothing was written. */
  recovered: boolean
  dunning_case: RecoverableDunningCase
}

/**
 * Closes a dunning case as recovered and hands its subscription back to `active`.
 *
 * Shared by the scheduled retry that collected the money and by the recovery the customer's own
 * payment triggers, so both leave the same case state behind. Idempotent on a closed case.
 */
export async function settleDunningCaseRecovered(
  container: MedusaContainer,
  input: SettleDunningCaseRecoveredInput
): Promise<SettleDunningCaseRecoveredResult> {
  const dunningCase = input.dunning_case

  if (dunningCase.status === DunningCaseStatus.RECOVERED) {
    return { recovered: false, dunning_case: dunningCase }
  }

  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

  const metadata: Record<string, unknown> = {
    ...(input.metadata ?? dunningCase.metadata ?? {}),
    park_reason: null,
  }
  delete metadata.setup_failure_streak
  delete metadata.session_conflict_count

  if (input.payment_reference) {
    metadata.recovery_payment_reference = input.payment_reference
  }

  const updatedCase = (await dunningModule.updateDunningCases({
    id: dunningCase.id,
    status: DunningCaseStatus.RECOVERED,
    next_retry_at: null,
    last_attempt_at: input.finished_at,
    last_payment_error_code: null,
    last_payment_error_message: null,
    recovered_at: input.finished_at,
    closed_at: input.finished_at,
    recovery_reason: input.recovery_reason,
    metadata,
  } as never)) as unknown as RecoverableDunningCase

  if (input.subscription.status === SubscriptionStatus.PAST_DUE) {
    await subscriptionModule.updateSubscriptions({
      id: input.subscription.id,
      status: SubscriptionStatus.ACTIVE,
    })
  }

  return { recovered: true, dunning_case: updatedCase }
}
