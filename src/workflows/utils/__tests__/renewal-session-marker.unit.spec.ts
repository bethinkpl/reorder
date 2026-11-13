import {
  readRenewalSessionMarkers,
  signalNamesAttempt,
} from "../renewal-session-marker"

describe("readRenewalSessionMarkers", () => {
  it.each([
    ["both markers", { renewal_cycle_id: "rc_1", renewal_attempt_id: "ra_1" }, "rc_1", "ra_1"],
    ["the cycle marker alone", { renewal_cycle_id: "rc_1" }, "rc_1", null],
    ["empty or non-string markers", { renewal_cycle_id: "", renewal_attempt_id: 42 }, null, null],
    ["no context", null, null, null],
  ])("reads %s", (_name, context, cycleId, attemptId) => {
    expect(readRenewalSessionMarkers(context)).toEqual({
      renewal_cycle_id: cycleId,
      renewal_attempt_id: attemptId,
    })
  })
})

describe("signalNamesAttempt", () => {
  it.each([
    ["the marker names the attempt, which recorded no session", null, "payses_1", "ra_latest", true],
    ["the marker names the attempt, which recorded this session", "payses_1", "payses_1", "ra_latest", true],
    ["the marker names the attempt, which recorded another session", "payses_2", "payses_1", "ra_latest", false],
    ["the marker names an earlier attempt", null, "payses_1", "ra_earlier", false],
    ["no marker, and the attempt recorded this session", "payses_1", "payses_1", null, true],
    ["no marker, and the attempt recorded another session", "payses_2", "payses_1", null, false],
    ["neither a marker nor a session, and the attempt recorded no session", null, null, null, false],
  ])("%s: %s", (_name, paymentReference, sessionId, attemptId, expected) => {
    expect(
      signalNamesAttempt(
        { id: "ra_latest", payment_reference: paymentReference },
        { session_id: sessionId, attempt_id: attemptId }
      )
    ).toBe(expected)
  })
})
