import type { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { randomUUID } from "node:crypto"

const RETRY_INTERVAL_MS = 300

// What the redis, in-memory and postgres providers raise for a held key. Matched by message, since
// they share the CONFLICT type with most renewal and dunning errors.
const LOCK_BUSY_MESSAGE = /^Failed to acquire lock|^Timed-out acquiring lock|is already locked\.$/

export type WithLockOptions = {
  wait_seconds: number
  ttl_seconds: number
}

export function isLockBusy(error: unknown): boolean {
  return error instanceof Error && LOCK_BUSY_MESSAGE.test(error.message)
}

/**
 * Not `locking.execute`: its wait can't go below a second, and before Medusa 2.22 its lease is that
 * wait and its release ignores the owner. This lease is never renewed, so `fn` must finish within
 * `ttl_seconds`.
 */
export async function withLock<T>(
  container: MedusaContainer,
  key: string,
  options: WithLockOptions,
  fn: () => Promise<T>
): Promise<T> {
  const locking = container.resolve(Modules.LOCKING)
  const ownerId = randomUUID()
  const deadline = Date.now() + options.wait_seconds * 1000

  for (;;) {
    try {
      await locking.acquire(key, { expire: options.ttl_seconds, ownerId })
      break
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error
      }

      await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS))
    }
  }

  try {
    return await fn()
  } finally {
    await locking.release(key, { ownerId })
  }
}
