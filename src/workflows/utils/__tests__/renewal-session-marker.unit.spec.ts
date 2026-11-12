import {
  readRenewalSessionMarkers,
  signalNamesAttempt,
} from "../renewal-session-marker"

describe("readRenewalSessionMarkers", () => {
  it.each([
    {
      name: "both markers",
      context: { renewal_cycle_id: "rc_1", renewal_attempt_id: "ra_1" },
      expected: { renewal_cycle_id: "rc_1", renewal_attempt_id: "ra_1" },
    },
    {
      name: "the cycle marker alone",
      context: { renewal_cycle_id: "rc_1" },
      expected: { renewal_cycle_id: "rc_1", renewal_attempt_id: null },
    },
    {
      name: "empty or non-string markers",
      context: { renewal_cycle_id: "", renewal_attempt_id: 42 },
      expected: { renewal_cycle_id: null, renewal_attempt_id: null },
    },
    {
      name: "no context",
      context: null,
      expected: { renewal_cycle_id: null, renewal_attempt_id: null },
    },
  ])("reads $name", ({ context, expected }) => {
    expect(readRenewalSessionMarkers(context)).toEqual(expected)
  })
})

describe("signalNamesAttempt", () => {
  const latest = (payment_reference: string | null) => ({
    id: "ra_latest",
    payment_reference,
  })

  it.each([
    {
      name: "the marker names the attempt, which recorded no session",
      attempt: latest(null),
      signal: { session_id: "payses_1", attempt_id: "ra_latest" },
      expected: true,
    },
    {
      name: "the marker names the attempt, which recorded this session",
      attempt: latest("payses_1"),
      signal: { session_id: "payses_1", attempt_id: "ra_latest" },
      expected: true,
    },
    {
      name: "the marker names the attempt, which recorded another session",
      attempt: latest("payses_2"),
      signal: { session_id: "payses_1", attempt_id: "ra_latest" },
      expected: false,
    },
    {
      name: "the marker names an earlier attempt",
      attempt: latest(null),
      signal: { session_id: "payses_1", attempt_id: "ra_earlier" },
      expected: false,
    },
    {
      name: "no marker, and the attempt recorded this session",
      attempt: latest("payses_1"),
      signal: { session_id: "payses_1", attempt_id: null },
      expected: true,
    },
    {
      name: "no marker, and the attempt recorded another session",
      attempt: latest("payses_2"),
      signal: { session_id: "payses_1", attempt_id: null },
      expected: false,
    },
    {
      name: "no marker, and the attempt recorded no session",
      attempt: latest(null),
      signal: { session_id: "payses_1", attempt_id: null },
      expected: false,
    },
    {
      name: "neither a marker nor a session, and the attempt recorded no session",
      attempt: latest(null),
      signal: { session_id: null, attempt_id: null },
      expected: false,
    },
  ])("$name: $expected", ({ attempt, signal, expected }) => {
    expect(signalNamesAttempt(attempt, signal)).toBe(expected)
  })
})
