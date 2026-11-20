import { randomUUID } from "crypto"
import { setTimeout as delay } from "node:timers/promises"
import type { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { isLockBusyError } from "../../common/utils/lock-busy-error"

const RETRY_INTERVAL_MS = 300

/**
 * Not `locking.execute`: in some Medusa versions its wait (`timeout`) is also the lock's lifetime, so a
 * short wait lets the lock lapse mid-job. Acquire/release with an explicit `expire` avoids that.
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

export type LockedRun<T> =
  | { acquired: true, result: T }
  | { acquired: false, error: unknown }

export async function tryUnderLock<T>(
  container: MedusaContainer,
  key: string,
  job: () => Promise<T>,
  options: { wait_seconds: number, hold_seconds: number }
): Promise<LockedRun<T>> {
  let acquired = false

  try {
    const result = await runUnderLock(
      container,
      key,
      () => {
        acquired = true

        return job()
      },
      options
    )

    return { acquired: true, result }
  } catch (error) {
    if (!acquired && isLockBusyError(error)) {
      return { acquired: false, error }
    }

    throw error
  }
}
