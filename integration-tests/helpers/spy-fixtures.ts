import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

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
