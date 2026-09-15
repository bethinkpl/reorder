import { DunningCaseStatus } from "../types"
import {
  CHARGEABLE_SUBSCRIPTION_STATUSES,
  type SubscriptionPaymentContext,
  type SubscriptionStatus,
} from "../../subscription/types"

export enum RetryBlockedReason {
  NO_ACTIVE_CASE = "no_active_case",
  RETRY_IN_PROGRESS = "retry_in_progress",
  CASE_CLOSED = "case_closed",
  SUBSCRIPTION_NOT_RETRYABLE = "subscription_not_retryable",
  NO_PAYMENT_METHOD = "no_payment_method",
  MAX_ATTEMPTS_REACHED = "max_attempts_reached",
  MISSING_RENEWAL_ORDER = "missing_renewal_order",
  MISSING_RETRY_SCHEDULE = "missing_retry_schedule",
}

export type RetryEligibilityInput = {
  dunningCase: {
    status: DunningCaseStatus
    attempt_count: number
    max_attempts: number
    renewal_order_id: string | null
    retry_schedule: unknown | null
  } | null
  subscriptionStatus: SubscriptionStatus
  paymentContext: SubscriptionPaymentContext | null
}

export type RetryEligibility = {
  eligible: boolean
  blocked_reason: RetryBlockedReason | null
}

const RETRYABLE_CASE_STATUSES: readonly DunningCaseStatus[] = [
  DunningCaseStatus.OPEN,
  DunningCaseStatus.RETRY_SCHEDULED,
  DunningCaseStatus.AWAITING_MANUAL_RESOLUTION,
]

const eligible: RetryEligibility = { eligible: true, blocked_reason: null }

const blocked = (reason: RetryBlockedReason): RetryEligibility => ({
  eligible: false,
  blocked_reason: reason,
})

/**
 * Mirrors every precondition `runDunningRetryStep` enforces, so a storefront or
 * admin that trusts `eligible` never offers a retry the workflow will refuse.
 */
export function resolveRetryEligibility(input: RetryEligibilityInput): RetryEligibility {
  const { dunningCase } = input

  if (!dunningCase) {
    return blocked(RetryBlockedReason.NO_ACTIVE_CASE)
  }

  if (dunningCase.status === DunningCaseStatus.RETRYING) {
    return blocked(RetryBlockedReason.RETRY_IN_PROGRESS)
  }

  if (!RETRYABLE_CASE_STATUSES.includes(dunningCase.status)) {
    return blocked(RetryBlockedReason.CASE_CLOSED)
  }

  if (!CHARGEABLE_SUBSCRIPTION_STATUSES.includes(input.subscriptionStatus)) {
    return blocked(RetryBlockedReason.SUBSCRIPTION_NOT_RETRYABLE)
  }

  if (!input.paymentContext?.payment_method_id) {
    return blocked(RetryBlockedReason.NO_PAYMENT_METHOD)
  }

  if (dunningCase.attempt_count >= dunningCase.max_attempts) {
    return blocked(RetryBlockedReason.MAX_ATTEMPTS_REACHED)
  }

  if (!dunningCase.renewal_order_id) {
    return blocked(RetryBlockedReason.MISSING_RENEWAL_ORDER)
  }

  if (!dunningCase.retry_schedule) {
    return blocked(RetryBlockedReason.MISSING_RETRY_SCHEDULE)
  }

  return eligible
}
