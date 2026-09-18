export enum DunningCaseAdminStatus {
  OPEN = "open",
  RETRY_SCHEDULED = "retry_scheduled",
  RETRYING = "retrying",
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
  status: "scheduled" | "processing" | "succeeded" | "failed"
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

export type DunningRetryBlockedReason =
  | "no_active_case"
  | "retry_in_progress"
  | "case_closed"
  | "subscription_not_retryable"
  | "no_payment_method"
  | "max_attempts_reached"
  | "missing_renewal_order"
  | "missing_retry_schedule"
  | "retry_not_due"
  | "manual_resolution_required"

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
