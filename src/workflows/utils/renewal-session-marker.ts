export type RenewalSessionSignal = {
  session_id: string | null
  attempt_id: string | null
}

export type RenewalSessionMarkers = {
  renewal_cycle_id: string | null
  renewal_attempt_id: string | null
}

function readMarker(
  context: Record<string, unknown> | null | undefined,
  key: keyof RenewalSessionMarkers
): string | null {
  const value = context?.[key]

  return typeof value === "string" && value ? value : null
}

export function readRenewalSessionMarkers(
  context: Record<string, unknown> | null | undefined
): RenewalSessionMarkers {
  return {
    renewal_cycle_id: readMarker(context, "renewal_cycle_id"),
    renewal_attempt_id: readMarker(context, "renewal_attempt_id"),
  }
}

export function signalNamesAttempt(
  attempt: { id: string, payment_reference: string | null },
  signal: RenewalSessionSignal
): boolean {
  if (signal.attempt_id) {
    return (
      attempt.id === signal.attempt_id &&
      (attempt.payment_reference === null ||
        attempt.payment_reference === signal.session_id)
    )
  }

  return (
    attempt.payment_reference !== null &&
    attempt.payment_reference === signal.session_id
  )
}
