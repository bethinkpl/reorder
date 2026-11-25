import type { PaymentActions } from "@medusajs/framework/utils"
import type { PaymentAttemptErrorCode } from "./payment-attempt-error-code"

export type PaymentFailureAction =
  | `${PaymentActions}`
  | PaymentAttemptErrorCode.RESOLVED_UNPAID

export type PaymentFailureHandling = "applied" | "recorded" | "ignored"

export type RecordedPaymentFailureOutcome = "applied" | "order_paid" | "stale"

export type ReportedPaymentFailure = {
  session_id: string
  action: PaymentFailureAction
  reason: string | null
  received_at: string
}

export function toReportedPaymentFailure(
  input: Pick<ReportedPaymentFailure, "session_id" | "action" | "reason">
): ReportedPaymentFailure {
  return { session_id: input.session_id, action: input.action, reason: input.reason, received_at: new Date().toISOString() }
}

export function readReportedPaymentFailure(value: unknown): ReportedPaymentFailure | null {
  if (typeof value !== "object" || value === null) {
    return null
  }

  const record = value as Record<string, unknown>

  if (
    typeof record.session_id !== "string" ||
    typeof record.action !== "string" ||
    typeof record.received_at !== "string"
  ) {
    return null
  }

  return {
    session_id: record.session_id,
    action: record.action as PaymentFailureAction,
    reason: typeof record.reason === "string" ? record.reason : null,
    received_at: record.received_at,
  }
}
