/**
 * What the locking providers answer when another owner holds the key: the in-memory and Redis
 * providers when an acquire is refused or times out, Postgres also when another owner inserted the
 * lock first. Anchored, so a database statement timeout is never mistaken for a busy lock.
 */
const LOCK_BUSY_MESSAGES = [
  /^Timed-out acquiring lock\.$/,
  /^Failed to acquire lock for key ".+"$/,
  /^".+" is already locked\.$/,
]

/** Also reads the serialised plain object a workflow rethrows in place of its step's error. */
export function isLockBusyError(error: unknown): boolean {
  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : null

  return message !== null && LOCK_BUSY_MESSAGES.some((pattern) => pattern.test(message))
}
