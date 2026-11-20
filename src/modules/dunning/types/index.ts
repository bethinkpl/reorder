import type { ReportedPaymentFailure } from "../../../common/types/reported-payment-failure"

export enum DunningCaseStatus {
  OPEN = "open",
  RETRY_SCHEDULED = "retry_scheduled",
  RETRYING = "retrying",
  AWAITING_PAYMENT = "awaiting_payment",
  AWAITING_MANUAL_RESOLUTION = "awaiting_manual_resolution",
  RECOVERED = "recovered",
  UNRECOVERED = "unrecovered",
}

export const CLOSED_DUNNING_CASE_STATUSES: readonly DunningCaseStatus[] = [
  DunningCaseStatus.RECOVERED,
  DunningCaseStatus.UNRECOVERED,
]

export const ACTIVE_DUNNING_CASE_STATUSES: readonly DunningCaseStatus[] = [
  DunningCaseStatus.OPEN,
  DunningCaseStatus.RETRY_SCHEDULED,
  DunningCaseStatus.RETRYING,
  DunningCaseStatus.AWAITING_PAYMENT,
  DunningCaseStatus.AWAITING_MANUAL_RESOLUTION,
]

/** A case in one of these has a retry charge the provider may still settle. */
export const CHARGE_IN_FLIGHT_DUNNING_CASE_STATUSES: readonly DunningCaseStatus[] = [
  DunningCaseStatus.RETRYING,
  DunningCaseStatus.AWAITING_PAYMENT,
]

/** Why a case closed, recovered or not: its `recovery_reason`. */
export enum DunningRecoveryReason {
  PAYMENT_RECOVERED = "payment_recovered",
  CUSTOMER_PAYMENT = "customer_payment",
  MARKED_RECOVERED_BY_ADMIN = "marked_recovered_by_admin",
  REVERSED_BY_ADMIN = "reversed_by_admin",
  RETRY_SCHEDULE_EXHAUSTED = "retry_schedule_exhausted",
  RETRY_LIMIT_EXHAUSTED = "retry_limit_exhausted",
  PERMANENT_PAYMENT_FAILURE = "permanent_payment_failure",
  SUBSCRIPTION_NOT_RETRYABLE = "subscription_not_retryable",
  SUBSCRIPTION_CANCELLED_BY_CUSTOMER = "subscription_cancelled_by_customer",
  MARKED_UNRECOVERED_BY_ADMIN = "marked_unrecovered_by_admin",
}

/** Where the renewal payment failure that opens a case was raised. */
export enum DunningPaymentFailureSource {
  PAYMENT_PROVIDER = "payment_provider",
  PAYMENT_SESSION = "payment_session",
  PAYMENT_CAPTURE = "payment_capture",
}

export enum DunningAttemptStatus {
  PROCESSING = "processing",
  SUCCEEDED = "succeeded",
  FAILED = "failed",
  ABORTED = "aborted",
}

export type DunningRetrySchedule = {
  strategy: "fixed_intervals"
  intervals: number[]
  timezone: "UTC"
  source: "default_policy" | "manual_override"
}

export type DunningCaseData = {
  id: string
  subscription_id: string
  renewal_cycle_id: string
  renewal_order_id: string | null
  status: DunningCaseStatus
  attempt_count: number
  max_attempts: number
  retry_schedule: DunningRetrySchedule | null
  next_retry_at: string | null
  last_payment_error_code: string | null
  last_payment_error_message: string | null
  last_attempt_at: string | null
  recovered_at: string | null
  closed_at: string | null
  recovery_reason: string | null
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export type DunningAttemptData = {
  id: string
  dunning_case_id: string
  attempt_no: number
  started_at: string
  finished_at: string | null
  status: DunningAttemptStatus
  error_code: string | null
  error_message: string | null
  payment_reference: string | null
  reported_payment_failure: ReportedPaymentFailure | null
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}
