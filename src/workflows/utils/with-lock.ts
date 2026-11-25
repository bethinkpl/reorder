import type { MedusaContainer } from "@medusajs/framework/types"
import { MedusaError, Modules } from "@medusajs/framework/utils"
import { randomUUID } from "node:crypto"

const RETRY_INTERVAL_MS = 300

export type WithLockOptions = {
  wait_seconds: number
  ttl_seconds: number
}

export function isLockBusy(error: unknown): boolean {
  if (MedusaError.isMedusaError(error) && error.type === MedusaError.Types.CONFLICT) {
    return true
  }

  return error instanceof Error && error.message.startsWith("Failed to acquire lock")
}

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
