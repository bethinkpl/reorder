import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

type LogEntry = Record<string, unknown>

function parseLogEntry(line: unknown): LogEntry[] {
  try {
    const entry = JSON.parse(String(line))

    return entry && typeof entry === "object" ? [entry] : []
  } catch {
    return []
  }
}

export function watchLogs(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const spies = (["info", "warn", "error"] as const).map((level) => jest.spyOn(logger, level))

  return (match: LogEntry = {}) =>
    spies
      .flatMap((spy) => spy.mock.calls.flatMap(([line]) => parseLogEntry(line)))
      .filter((entry) => Object.entries(match).every(([key, value]) => entry[key] === value))
}

export function watchEvents(container: MedusaContainer) {
  const emit = jest.spyOn(container.resolve(Modules.EVENT_BUS), "emit")

  return (name: string) =>
    emit.mock.calls.flatMap(([message]) => [message].flat()).filter((message) => message?.name === name)
}

const REAL_TIMERS = [
  "hrtime",
  "nextTick",
  "performance",
  "queueMicrotask",
  "setImmediate",
  "clearImmediate",
  "setInterval",
  "clearInterval",
  "setTimeout",
  "clearTimeout",
] as const

export async function atTime<T>(now: number, run: () => Promise<T>, advanceTimers = true) {
  jest.useFakeTimers({ now, advanceTimers, doNotFake: [...REAL_TIMERS] })

  try {
    return await run()
  } finally {
    jest.useRealTimers()
  }
}

export function failOnce<T extends object>(
  service: T,
  method: keyof T & string,
  matches: (input: unknown) => boolean,
  message: string
) {
  const original = (service[method] as (...args: unknown[]) => Promise<unknown>).bind(service)
  let failed = false

  jest.spyOn(service, method as never).mockImplementation((async (...args: unknown[]) => {
    if (!failed && matches(args[0])) {
      failed = true
      throw new Error(message)
    }

    return await original(...args)
  }) as never)
}

export function lockRequested(container: MedusaContainer, key: string, owners: number) {
  const locking = container.resolve(Modules.LOCKING)
  const acquire = locking.acquire.bind(locking)
  const requested = new Set<unknown>()

  return new Promise<void>((resolve) => {
    jest.spyOn(locking, "acquire").mockImplementation(async (keys, args) => {
      if ([keys].flat().includes(key) && requested.add(args?.ownerId).size >= owners) {
        resolve()
      }

      return await acquire(keys, args)
    })
  })
}

export async function whileLockHeld<T>(container: MedusaContainer, key: string, run: () => Promise<T>) {
  const locking = container.resolve(Modules.LOCKING)
  const ownerId = `test-holder-${key}`

  await locking.acquire(key, { ownerId, expire: 60 })

  try {
    return await run()
  } finally {
    await locking.release(key, { ownerId })
  }
}
