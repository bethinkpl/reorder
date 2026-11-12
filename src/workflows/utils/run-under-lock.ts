import { randomUUID } from "crypto"
import { setTimeout as delay } from "node:timers/promises"
import type { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

const RETRY_INTERVAL_MS = 300

const LOCK_WAIT_TIMEOUT_MESSAGES = [
  /^Timed-out acquiring lock\.$/,
  /^Failed to acquire lock for key ".+"$/,
  /^".+" is already locked\.$/,
]

/**
 * The errors the locking providers (in-memory, Redis, Postgres) throw while another holder keeps the
 * lock: `execute` once its wait runs out, `acquire` at once.
 */
export function isLockWaitTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    LOCK_WAIT_TIMEOUT_MESSAGES.some((pattern) => pattern.test(error.message))
  )
}

/**
 * In Medusa 2.12 `locking.execute` also uses its wait (`timeout`) as the lock's lifetime, so a short
 * wait lets the lock lapse mid-job; newer versions (2.22) give `execute` its own renewed `expire`.
 */
export async function runUnderLock<T>(
  container: MedusaContainer,
  key: string,
  job: () => Promise<T>,
  options: { wait_seconds: number, hold_seconds: number }
): Promise<T> {
  const locking = container.resolve(Modules.LOCKING)
  const ownerId = randomUUID()
  const tryUntil = Date.now() + options.wait_seconds * 1000

  while (true) {
    try {
      await locking.acquire(key, { ownerId, expire: options.hold_seconds })
      break
    } catch (error) {
      if (Date.now() >= tryUntil) {
        throw error
      }
    }

    await delay(RETRY_INTERVAL_MS)
  }

  try {
    return await job()
  } finally {
    await locking.release(key, { ownerId })
  }
}
