export const DEFAULT_AWAITING_PAYMENT_ALERT_HOURS = 96

export const AWAITING_PAYMENT_ALERT_HOURS_ENV =
  "RENEWAL_AWAITING_PAYMENT_ALERT_HOURS"

export const AWAITING_PAYMENT_OVERDUE_EVENT = "renewal.awaiting_payment_overdue"

const HOUR_MS = 60 * 60 * 1000

export function resolveAwaitingPaymentAlertHours(
  raw: string | undefined = process.env[AWAITING_PAYMENT_ALERT_HOURS_ENV]
): number {
  if (!raw) {
    return DEFAULT_AWAITING_PAYMENT_ALERT_HOURS
  }

  const parsed = Number.parseInt(raw, 10)

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return DEFAULT_AWAITING_PAYMENT_ALERT_HOURS
  }

  return parsed
}

export function isAwaitingPaymentOverdue(
  parkedAt: Date | string,
  now: Date,
  limitHours: number
): boolean {
  return now.getTime() - new Date(parkedAt).getTime() > limitHours * HOUR_MS
}

export const OVERDUE_ALERTED_FOR_KEY = "awaiting_payment_overdue_alerted_for"

export function isOverdueAlertDue(input: {
  metadata: Record<string, unknown> | null
  alert_key: string
  submitted_at: Date | string
  now: Date
  limit_hours: number
}): boolean {
  return (
    input.metadata?.[OVERDUE_ALERTED_FOR_KEY] !== input.alert_key &&
    isAwaitingPaymentOverdue(input.submitted_at, input.now, input.limit_hours)
  )
}

export function withOverdueAlertMarker(
  metadata: Record<string, unknown> | null,
  alertKey: string
): Record<string, unknown> {
  return { ...(metadata ?? {}), [OVERDUE_ALERTED_FOR_KEY]: alertKey }
}
