/**
 * A provider's failure report for an attempt's charge that could not be applied when it arrived,
 * because another holder kept the attempt's lock. The awaiting-payment sweeps apply it later.
 */
export type ReportedPaymentFailure = {
  session_id: string
  action: string
  reason: string | null
  received_at: string
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
    action: record.action,
    reason: typeof record.reason === "string" ? record.reason : null,
    received_at: record.received_at,
  }
}
