import { RenewalCycleAdminStatus } from "./renewal"

export enum DunningCaseAdminStatus {
  OPEN = "open",
  RETRY_SCHEDULED = "retry_scheduled",
  RETRYING = "retrying",
  AWAITING_PAYMENT = "awaiting_payment",
  AWAITING_MANUAL_RESOLUTION = "awaiting_manual_resolution",
  RECOVERED = "recovered",
  UNRECOVERED = "unrecovered",
}

export enum DunningAttemptAdminStatus {
  PROCESSING = "processing",
  SUCCEEDED = "succeeded",
  FAILED = "failed",
  ABORTED = "aborted",
}

export type DunningAdminSubscriptionSummary = {
  subscription_id: string
  reference: string
  status:
    | "pending_payment"
    | "active"
    | "paused"
    | "cancelled"
    | "past_due"
    | "payment_failed"
  customer_name: string
  product_title: string
  variant_title: string
  sku: string | null
  payment_provider_id: string | null
}

export type DunningAdminRenewalSummary = {
  renewal_cycle_id: string
  status: RenewalCycleAdminStatus
  scheduled_for: string
  generated_order_id: string | null
}

export type DunningAdminOrderSummary = {
  order_id: string
  display_id: number | string
  status: string
}

export type DunningRetryScheduleSummary = {
  strategy: "fixed_intervals"
  intervals: number[]
  timezone: "UTC"
  source: "default_policy" | "manual_override"
}

export type DunningAttemptAdminRecord = {
  id: string
  attempt_no: number
  status: DunningAttemptAdminStatus
  started_at: string
  finished_at: string | null
  error_code: string | null
  error_message: string | null
  payment_reference: string | null
  metadata: Record<string, unknown> | null
}

export enum DunningRetryBlockedReason {
  NO_ACTIVE_CASE = "no_active_case",
  RETRY_IN_PROGRESS = "retry_in_progress",
  PAYMENT_IN_PROGRESS = "payment_in_progress",
  CASE_CLOSED = "case_closed",
  SUBSCRIPTION_NOT_RETRYABLE = "subscription_not_retryable",
  NO_PAYMENT_METHOD = "no_payment_method",
  MAX_ATTEMPTS_REACHED = "max_attempts_reached",
  MISSING_RENEWAL_ORDER = "missing_renewal_order",
  MISSING_RETRY_SCHEDULE = "missing_retry_schedule",
  RETRY_NOT_DUE = "retry_not_due",
  MANUAL_RESOLUTION_REQUIRED = "manual_resolution_required",
}

/**
 * The retry charge of a case awaiting its payment: when it was submitted, and the moment after which
 * an unpaid one can be resolved as failed.
 */
export type DunningAwaitingPaymentAdminSummary = {
  submitted_at: string
  can_fail_after: string
}

export type DunningCaseAdminDetail = {
  id: string
  status: DunningCaseAdminStatus
  subscription: DunningAdminSubscriptionSummary
  renewal: DunningAdminRenewalSummary | null
  order: DunningAdminOrderSummary | null
  retry_eligible: boolean
  retry_blocked_reason: DunningRetryBlockedReason | null
  attempt_count: number
  max_attempts: number
  retry_schedule: DunningRetryScheduleSummary | null
  next_retry_at: string | null
  last_payment_error_code: string | null
  last_payment_error_message: string | null
  last_attempt_at: string | null
  recovered_at: string | null
  closed_at: string | null
  recovery_reason: string | null
  attempts: DunningAttemptAdminRecord[]
  awaiting_payment: DunningAwaitingPaymentAdminSummary | null
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export type DunningCaseAdminListItem = {
  id: string
  status: DunningCaseAdminStatus
  subscription: DunningAdminSubscriptionSummary
  renewal: DunningAdminRenewalSummary | null
  order: DunningAdminOrderSummary | null
  attempt_count: number
  max_attempts: number
  next_retry_at: string | null
  last_attempt_at: string | null
  last_payment_error_code: string | null
  updated_at: string
}

export type DunningCaseAdminListResponse = {
  dunning_cases: DunningCaseAdminListItem[]
  count: number
  limit: number
  offset: number
}

export type DunningCaseAdminDetailResponse = {
  dunning_case: DunningCaseAdminDetail
}

export type RetryNowDunningAdminRequest = {
  reason?: string | null
}

export enum DunningAwaitingPaymentAdminResolution {
  RECOVERED = "recovered",
  FAILED = "failed",
}

export type ResolveAwaitingDunningPaymentAdminResponse = DunningCaseAdminDetailResponse & {
  resolution: DunningAwaitingPaymentAdminResolution
}

export type MarkRecoveredDunningAdminRequest = {
  reason?: string | null
}

export type MarkUnrecoveredDunningAdminRequest = {
  reason: string
}

export type ReverseChurnDunningAdminRequest = {
  reason: string
}

export type UpdateDunningRetryScheduleAdminRequest = {
  reason?: string | null
  intervals: number[]
  max_attempts: number
}
