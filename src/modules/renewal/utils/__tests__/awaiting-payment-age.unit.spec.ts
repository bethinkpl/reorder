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
const after = (ms: number) => new Date(PARKED_AT.getTime() + ms)

describe("isAwaitingPaymentOverdue", () => {
  it.each([
    ["one millisecond under the limit", PARKED_AT, 96 * HOUR_MS - 1, 96, false],
    ["exactly at the limit", PARKED_AT, 96 * HOUR_MS, 96, false],
    ["one millisecond over the limit", PARKED_AT, 96 * HOUR_MS + 1, 96, true],
    ["over a shorter configured limit", PARKED_AT, 2 * HOUR_MS + 1, 2, true],
    ["over the limit, parked time as an ISO string", PARKED_AT.toISOString(), 96 * HOUR_MS + 1, 96, true],
  ])("%s", (_name, parkedAt, offsetMs, limit, overdue) => {
    expect(isAwaitingPaymentOverdue(parkedAt, after(offsetMs), limit)).toBe(overdue)
  })
})

describe("isOverdueAlertDue", () => {
  it.each([
    ["an overdue charge never alerted", 96 * HOUR_MS + 1, undefined, true],
    ["a charge still under the limit", 96 * HOUR_MS, undefined, false],
    ["an overdue charge already alerted", 96 * HOUR_MS + 1, "attempt_current", false],
    ["an overdue charge after an earlier charge alerted", 96 * HOUR_MS + 1, "attempt_earlier", true],
  ])("%s", (_name, offsetMs, alertedFor, due) => {
    expect(
      isOverdueAlertDue({
        metadata: alertedFor ? { [OVERDUE_ALERTED_FOR_KEY]: alertedFor } : null,
        alert_key: "attempt_current",
        submitted_at: PARKED_AT,
        now: after(offsetMs),
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
    ["1", 1],
    ["0", DEFAULT_AWAITING_PAYMENT_ALERT_HOURS],
    ["abc", DEFAULT_AWAITING_PAYMENT_ALERT_HOURS],
    [undefined, 96],
  ])("resolves %j to %d", (raw, expected) => {
    expect(resolveAwaitingPaymentAlertHours(raw)).toBe(expected)
  })
})
