import { randomUUID } from "crypto"
import { setTimeout as delay } from "node:timers/promises"
import type { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

const RETRY_INTERVAL_MS = 300

/**
 * `locking.execute` uses its wait as the lock's lifetime too, so a short wait would let the lock
 * lapse while the job is still writing. This waits at most `wait_seconds` and holds the lock for up
 * to `hold_seconds`.
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
