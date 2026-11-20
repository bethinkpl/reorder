export const DEFAULT_AWAITING_PAYMENT_ALERT_HOURS = 96

export const AWAITING_PAYMENT_ALERT_HOURS_ENV =
  "RENEWAL_AWAITING_PAYMENT_ALERT_HOURS"

/**
 * Longer than the slowest settlement a provider in use may still deliver (BLIK through Przelewy24
 * can take up to ~73 h), so a charge resolved as failed can no longer be paid afterwards.
 */
export const DEFAULT_AWAITING_PAYMENT_RESOLVE_MIN_HOURS = 96

export const AWAITING_PAYMENT_RESOLVE_MIN_HOURS_ENV =
  "RENEWAL_AWAITING_PAYMENT_RESOLVE_MIN_HOURS"

export const AWAITING_PAYMENT_OVERDUE_EVENT = "renewal.awaiting_payment_overdue"

const HOUR_MS = 60 * 60 * 1000

function parsePositiveHours(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback
  }

  const parsed = Number.parseInt(raw, 10)

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return fallback
  }

  return parsed
}

/** How long a charge may await the provider before it raises an alert. */
export function resolveAwaitingPaymentAlertHours(
  raw: string | undefined = process.env[AWAITING_PAYMENT_ALERT_HOURS_ENV]
): number {
  return parsePositiveHours(raw, DEFAULT_AWAITING_PAYMENT_ALERT_HOURS)
}

/**
 * How long a charge must have awaited the provider before an admin may resolve it as failed.
 * Independent of the alert hours: lowering the alert must not let a charge that can still settle
 * be failed and charged again through dunning.
 */
export function resolveAwaitingPaymentResolveMinHours(
  raw: string | undefined = process.env[AWAITING_PAYMENT_RESOLVE_MIN_HOURS_ENV]
): number {
  return parsePositiveHours(raw, DEFAULT_AWAITING_PAYMENT_RESOLVE_MIN_HOURS)
}

/** The moment after which a charge submitted at `submittedAt` has waited longer than `limitHours`. */
export function awaitingPaymentLimitEndsAt(
  submittedAt: Date | string,
  limitHours: number
): Date {
  return new Date(new Date(submittedAt).getTime() + limitHours * HOUR_MS)
}

export function isAwaitingPaymentOverdue(
  parkedAt: Date | string,
  now: Date,
  limitHours: number
): boolean {
  return now.getTime() > awaitingPaymentLimitEndsAt(parkedAt, limitHours).getTime()
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
