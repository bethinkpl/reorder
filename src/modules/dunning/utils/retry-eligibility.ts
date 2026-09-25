import { DunningCaseStatus } from "../types"
import { dunningErrors } from "./errors"
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
  RETRY_NOT_DUE = "retry_not_due",
  MANUAL_RESOLUTION_REQUIRED = "manual_resolution_required",
}

export type RetryEligibilityInput = {
  dunningCase: {
    status: DunningCaseStatus
    attempt_count: number
    max_attempts: number
    renewal_order_id: string | null
    retry_schedule: unknown | null
    next_retry_at?: Date | string | null
    metadata?: Record<string, unknown> | null
  } | null
  subscriptionStatus: SubscriptionStatus
  paymentContext: SubscriptionPaymentContext | null
  /**
   * Only supplied by the scheduled runner, which may not retry before `next_retry_at`. A manual
   * retry ignores the schedule, so callers asking "can this be retried now" leave it out.
   */
  now?: Date
  /**
   * Only the storefront sets this: a case parked by the retry engine needs an operator, and a
   * customer-triggered retry would only park it again.
   */
  block_parked?: boolean
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

function isRetryDue(nextRetryAt: Date | string | null | undefined, now: Date): boolean {
  if (!nextRetryAt) {
    return false
  }

  const due = nextRetryAt instanceof Date ? nextRetryAt : new Date(nextRetryAt)

  return !Number.isNaN(due.getTime()) && due <= now
}

const eligible: RetryEligibility = { eligible: true, blocked_reason: null }

const blocked = (reason: RetryBlockedReason): RetryEligibility => ({
  eligible: false,
  blocked_reason: reason,
})

/**
 * The single source of truth for "may this dunning case be charged again". `runDunningRetryStep`
 * enforces it before doing any work, and the store and admin payloads report it so neither ever
 * offers a retry the workflow would refuse.
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

  if (
    input.block_parked &&
    dunningCase.status === DunningCaseStatus.AWAITING_MANUAL_RESOLUTION &&
    dunningCase.metadata?.park_reason
  ) {
    return blocked(RetryBlockedReason.MANUAL_RESOLUTION_REQUIRED)
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

  if (input.now && !isRetryDue(dunningCase.next_retry_at, input.now)) {
    return blocked(RetryBlockedReason.RETRY_NOT_DUE)
  }

  return eligible
}

/**
 * The error `runDunningRetryStep` raises for a blocked retry. `SUBSCRIPTION_NOT_RETRYABLE` is
 * absent on purpose: the workflow settles the case before throwing, so it owns that branch.
 */
export function toRetryBlockedError(
  reason: RetryBlockedReason,
  dunningCase: { id: string, status: DunningCaseStatus }
) {
  switch (reason) {
    case RetryBlockedReason.CASE_CLOSED:
      return dunningCase.status === DunningCaseStatus.RECOVERED
        ? dunningErrors.alreadyRecovered(dunningCase.id)
        : dunningErrors.alreadyUnrecovered(dunningCase.id)
    case RetryBlockedReason.RETRY_IN_PROGRESS:
      return dunningErrors.retryAlreadyProcessing(dunningCase.id)
    case RetryBlockedReason.MAX_ATTEMPTS_REACHED:
      return dunningErrors.maxAttemptsExceeded(dunningCase.id)
    case RetryBlockedReason.RETRY_NOT_DUE:
      return dunningErrors.retryNotDue(dunningCase.id)
    case RetryBlockedReason.MANUAL_RESOLUTION_REQUIRED:
      return dunningErrors.conflict(
        `DunningCase '${dunningCase.id}' needs manual resolution before it can be retried`
      )
    case RetryBlockedReason.MISSING_RENEWAL_ORDER:
      return dunningErrors.invalidData(
        `DunningCase '${dunningCase.id}' is missing renewal_order_id`
      )
    case RetryBlockedReason.MISSING_RETRY_SCHEDULE:
      return dunningErrors.invalidData(
        `DunningCase '${dunningCase.id}' is missing retry_schedule`
      )
    case RetryBlockedReason.NO_PAYMENT_METHOD:
      return dunningErrors.invalidData(
        `DunningCase '${dunningCase.id}' has no saved payment method to charge`
      )
    default:
      return dunningErrors.invalidData(
        `DunningCase '${dunningCase.id}' cannot be retried (${reason})`
      )
  }
}
