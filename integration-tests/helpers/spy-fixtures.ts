import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { PaymentAttemptErrorCode } from "../../src/common/types/payment-attempt-error-code"

type LogEntry = Record<string, unknown>

export function watchLogs(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const spies = (["info", "warn", "error"] as const).map((level) => jest.spyOn(logger, level))

  return function entries(match: LogEntry = {}): LogEntry[] {
    return spies
      .flatMap((spy) => spy.mock.calls.map(([line]) => String(line)))
      .flatMap((line): LogEntry[] => {
        try {
          const entry = JSON.parse(line)

          return entry && typeof entry === "object" ? [entry] : []
        } catch {
          return []
        }
      })
      .filter((entry) => Object.entries(match).every(([key, value]) => entry[key] === value))
  }
}

export function watchEvents(container: MedusaContainer) {
  const emit = jest.spyOn(container.resolve(Modules.EVENT_BUS), "emit")

  return function emitted(name: string) {
    return emit.mock.calls
      .flatMap(([message]) => (Array.isArray(message) ? message : [message]))
      .filter((message) => message?.name === name)
  }
}

export async function atTime<T>(now: number, run: () => Promise<T>) {
  const clock = jest.spyOn(Date, "now").mockReturnValue(now)

  try {
    return await run()
  } finally {
    clock.mockRestore()
  }
}

export function interceptOnce<TArgs extends unknown[], TResult>(
  original: (...args: TArgs) => Promise<TResult>,
  matches: (...args: TArgs) => boolean,
  interject: () => Promise<unknown>
) {
  let intercepted = false

  return async (...args: TArgs): Promise<TResult> => {
    if (!intercepted && matches(...args)) {
      intercepted = true
      await interject()
    }

    return await original(...args)
  }
}

export function failOnce<T extends object, D = Record<string, unknown>>(
  service: T,
  method: keyof T & string,
  matches: (data: D) => boolean,
  message: string
) {
  const original = (service[method] as (...args: unknown[]) => Promise<unknown>).bind(service)

  jest.spyOn(service, method as never).mockImplementation(
    interceptOnce(original, (data) => matches((data ?? {}) as D), async () => {
      throw new Error(message)
    }) as never
  )

  return { message }
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

export async function expectLockFree(container: MedusaContainer, key: string) {
  const locking = container.resolve(Modules.LOCKING)

  await expect(locking.acquire(key, { ownerId: "lock-probe", expire: 5 })).resolves.toBeUndefined()
  await locking.release(key, { ownerId: "lock-probe" })
}

export function expectCapturedAfterClose(
  attempts: unknown[],
  lateCaptures: { data?: unknown }[],
  expected: { attempt: Record<string, unknown>, event: Record<string, unknown> }
) {
  expect(attempts).toEqual([
    expect.objectContaining({
      status: "succeeded",
      error_code: PaymentAttemptErrorCode.CAPTURED_AFTER_CLOSE,
      ...expected.attempt,
    }),
  ])
  expect(lateCaptures.map((message) => message.data)).toEqual([expect.objectContaining(expected.event)])
}
