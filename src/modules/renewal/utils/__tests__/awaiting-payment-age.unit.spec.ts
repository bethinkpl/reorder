import {
  DEFAULT_AWAITING_PAYMENT_ALERT_HOURS,
  isAwaitingPaymentOverdue,
  isOverdueAlertDue,
  OVERDUE_ALERTED_FOR_KEY,
  resolveAwaitingPaymentAlertHours,
  withOverdueAlertMarker,
} from "../awaiting-payment-age"

const HOUR_MS = 60 * 60 * 1000
const PARKED_AT = new Date("2026-03-01T10:00:00.000Z")

describe("isAwaitingPaymentOverdue", () => {
  it.each([
    { name: "one millisecond under the limit", offsetMs: 96 * HOUR_MS - 1, limit: 96, overdue: false },
    { name: "exactly at the limit", offsetMs: 96 * HOUR_MS, limit: 96, overdue: false },
    { name: "one millisecond over the limit", offsetMs: 96 * HOUR_MS + 1, limit: 96, overdue: true },
    { name: "just parked", offsetMs: 0, limit: 96, overdue: false },
    { name: "over a shorter configured limit", offsetMs: 2 * HOUR_MS + 1, limit: 2, overdue: true },
    { name: "under a shorter configured limit", offsetMs: 2 * HOUR_MS - 1, limit: 2, overdue: false },
  ])("is $overdue $name", ({ offsetMs, limit, overdue }) => {
    const now = new Date(PARKED_AT.getTime() + offsetMs)

    expect(isAwaitingPaymentOverdue(PARKED_AT, now, limit)).toBe(overdue)
  })

  it("reads a parked time given as an ISO string", () => {
    const now = new Date(PARKED_AT.getTime() + 96 * HOUR_MS + 1)

    expect(isAwaitingPaymentOverdue(PARKED_AT.toISOString(), now, 96)).toBe(true)
  })
})

describe("isOverdueAlertDue", () => {
  const overdueNow = new Date(PARKED_AT.getTime() + 96 * HOUR_MS + 1)
  const youngNow = new Date(PARKED_AT.getTime() + 96 * HOUR_MS)

  it.each([
    { name: "an overdue charge never alerted", now: overdueNow, alertedFor: undefined, due: true },
    { name: "a charge still under the limit", now: youngNow, alertedFor: undefined, due: false },
    { name: "an overdue charge already alerted", now: overdueNow, alertedFor: "attempt_current", due: false },
    { name: "an overdue charge after an earlier charge alerted", now: overdueNow, alertedFor: "attempt_earlier", due: true },
  ])("is $due for $name", ({ now, alertedFor, due }) => {
    expect(
      isOverdueAlertDue({
        metadata: alertedFor ? { [OVERDUE_ALERTED_FOR_KEY]: alertedFor } : null,
        alert_key: "attempt_current",
        submitted_at: PARKED_AT,
        now,
        limit_hours: 96,
      })
    ).toBe(due)
  })

  it("keeps the row's other metadata when it records the alert", () => {
    expect(
      withOverdueAlertMarker({ last_trigger_type: "scheduler" }, "attempt_current")
    ).toEqual({
      last_trigger_type: "scheduler",
      [OVERDUE_ALERTED_FOR_KEY]: "attempt_current",
    })
  })
})

describe("resolveAwaitingPaymentAlertHours", () => {
  it.each([
    { raw: "48", expected: 48 },
    { raw: "1", expected: 1 },
    { raw: "0", expected: DEFAULT_AWAITING_PAYMENT_ALERT_HOURS },
    { raw: "-5", expected: DEFAULT_AWAITING_PAYMENT_ALERT_HOURS },
    { raw: "abc", expected: DEFAULT_AWAITING_PAYMENT_ALERT_HOURS },
    { raw: "", expected: DEFAULT_AWAITING_PAYMENT_ALERT_HOURS },
  ])("resolves '$raw' to $expected", ({ raw, expected }) => {
    expect(resolveAwaitingPaymentAlertHours(raw)).toBe(expected)
  })

  it("defaults to 96 hours", () => {
    expect(DEFAULT_AWAITING_PAYMENT_ALERT_HOURS).toBe(96)
    expect(resolveAwaitingPaymentAlertHours(undefined)).toBe(96)
  })
})
