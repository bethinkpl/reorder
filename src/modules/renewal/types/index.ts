import type { FrequencyInterval } from "../../../common/types/frequency-interval"
import type { ReportedPaymentFailure } from "../../../common/types/reported-payment-failure"

export enum RenewalCycleStatus {
  SCHEDULED = "scheduled",
  PROCESSING = "processing",
  SUCCEEDED = "succeeded",
  FAILED = "failed",
  AWAITING_PAYMENT = "awaiting_payment",
}

/** A cycle in one of these no longer waits on a charge it submitted. */
export const CLOSED_RENEWAL_CYCLE_STATUSES: readonly RenewalCycleStatus[] = [
  RenewalCycleStatus.SUCCEEDED,
  RenewalCycleStatus.FAILED,
]

export enum RenewalAttemptStatus {
  PROCESSING = "processing",
  SUCCEEDED = "succeeded",
  FAILED = "failed",
}

export enum RenewalApprovalStatus {
  PENDING = "pending",
  APPROVED = "approved",
  REJECTED = "rejected",
}

export type RenewalApprovalSummary = {
  approval_required: boolean
  approval_status: RenewalApprovalStatus | null
  approval_decided_at: string | null
  approval_decided_by: string | null
  approval_reason: string | null
}

export type RenewalAppliedPendingUpdateData = {
  variant_id: string
  variant_title: string
  sku: string | null
  frequency_interval: FrequencyInterval
  frequency_value: number
  effective_at: string | null
  /** The applied request's `requested_at`; absent on cycles written before it was recorded. */
  requested_at?: string | null
}

export type RenewalCycleData = RenewalApprovalSummary & {
  id: string
  subscription_id: string
  scheduled_for: string
  processed_at: string | null
  status: RenewalCycleStatus
  generated_order_id: string | null
  applied_pending_update_data: RenewalAppliedPendingUpdateData | null
  last_error: string | null
  attempt_count: number
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export type RenewalAttemptData = {
  id: string
  renewal_cycle_id: string
  attempt_no: number
  started_at: string
  finished_at: string | null
  status: RenewalAttemptStatus
  error_code: string | null
  error_message: string | null
  payment_reference: string | null
  order_id: string | null
  reported_payment_failure: ReportedPaymentFailure | null
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}
