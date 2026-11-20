import type { MedusaContainer } from "@medusajs/framework/types"
import { DUNNING_MODULE } from "../../modules/dunning"
import type DunningModuleService from "../../modules/dunning/service"
import { DunningAttemptStatus, DunningCaseStatus } from "../../modules/dunning/types"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import type SubscriptionModuleService from "../../modules/subscription/service"
import { SubscriptionStatus } from "../../modules/subscription/types"
import { SUBSCRIPTION_CANCELLED_REFUSAL } from "./settle-renewal-cycle-succeeded"

export const ALREADY_RECOVERED_REFUSAL = "already_recovered"
export const CASE_MOVED_ON_REFUSAL = "case_moved_on"

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
  /** The status the caller left the case in. Defaults to `dunning_case.status`. */
  expected_status?: DunningCaseStatus
  /** The attempt whose charge collected the money; closed as succeeded only when the case is. */
  attempt?: { id: string, metadata?: Record<string, unknown> | null }
  finished_at: Date
  recovery_reason: string
  payment_reference?: string | null
  /** Replaces the case metadata the caller already rewrote (audit entries, cleared streaks). */
  metadata?: Record<string, unknown> | null
}

export type SettleDunningCaseRecoveredResult = {
  recovered: boolean
  /** Why nothing was written; `null` on the recovering run. */
  reason:
    | typeof ALREADY_RECOVERED_REFUSAL
    | typeof CASE_MOVED_ON_REFUSAL
    | typeof SUBSCRIPTION_CANCELLED_REFUSAL
    | null
  dunning_case: RecoverableDunningCase
  subscription_status: SubscriptionStatus
}

/**
 * Closes a dunning case as recovered and hands its subscription back to `active`.
 *
 * Shared by the scheduled retry that collected the money and by the recovery the customer's own
 * payment triggers, so both leave the same case state behind. The case and the subscription are
 * read again here: a retry run's lock is not renewed, so a cancellation or the paid-case sweep may
 * have moved them on while its charge was out. Nothing is written then, and the attempt stays
 * unapplied so its capture can still be reconciled.
 */
export async function settleDunningCaseRecovered(
  container: MedusaContainer,
  input: SettleDunningCaseRecoveredInput
): Promise<SettleDunningCaseRecoveredResult> {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

  const current = (await dunningModule.retrieveDunningCase(
    input.dunning_case.id
  )) as RecoverableDunningCase
  const subscription = await subscriptionModule.retrieveSubscription(current.subscription_id)
  const refuse = (reason: SettleDunningCaseRecoveredResult["reason"]) => ({
    recovered: false,
    reason,
    dunning_case: current,
    subscription_status: subscription.status,
  })

  if (current.status === DunningCaseStatus.RECOVERED) {
    return refuse(ALREADY_RECOVERED_REFUSAL)
  }

  if (subscription.status === SubscriptionStatus.CANCELLED) {
    return refuse(SUBSCRIPTION_CANCELLED_REFUSAL)
  }

  if (current.status !== (input.expected_status ?? input.dunning_case.status)) {
    return refuse(CASE_MOVED_ON_REFUSAL)
  }

  if (input.attempt) {
    await dunningModule.updateDunningAttempts({
      id: input.attempt.id,
      status: DunningAttemptStatus.SUCCEEDED,
      finished_at: input.finished_at,
      error_code: null,
      error_message: null,
      payment_reference: input.payment_reference ?? null,
      ...(input.attempt.metadata ? { metadata: input.attempt.metadata } : {}),
    })
  }

  const metadata: Record<string, unknown> = {
    ...(input.metadata ?? current.metadata ?? {}),
    // Explicit nulls: the module merges JSON columns, so an omitted key would survive.
    park_reason: null,
    setup_failure_streak: null,
    session_conflict_count: null,
  }

  if (input.payment_reference) {
    metadata.recovery_payment_reference = input.payment_reference
  }

  const updatedCase = (await dunningModule.updateDunningCases({
    id: current.id,
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

  if (subscription.status === SubscriptionStatus.PAST_DUE) {
    await subscriptionModule.updateSubscriptions({
      id: subscription.id,
      status: SubscriptionStatus.ACTIVE,
    })
  }

  return {
    recovered: true,
    reason: null,
    dunning_case: updatedCase,
    subscription_status:
      subscription.status === SubscriptionStatus.PAST_DUE
        ? SubscriptionStatus.ACTIVE
        : subscription.status,
  }
}
