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
