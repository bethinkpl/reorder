/**
 * Well past the 120 s a retry run holds its case's lock, which it never renews: a case still
 * `retrying` this long after its attempt started belongs to a run that died or failed to park it.
 * A younger one may belong to a run still waiting on the provider, even when its lock has lapsed.
 */
export const STALE_RETRY_MINUTES = 10

export function isStaleRetry(startedAt: Date | string, now: Date = new Date(Date.now())) {
  return now.getTime() - new Date(startedAt).getTime() >= STALE_RETRY_MINUTES * 60 * 1000
}
