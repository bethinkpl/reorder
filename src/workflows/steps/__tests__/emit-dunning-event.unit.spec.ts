import type { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { DunningEvents } from "../../../modules/dunning/events"
import { emitDunningEvent } from "../emit-dunning-event"

type BuildContainerOptions = {
  emit?: jest.Mock
  resolveError?: Error
}

function buildContainer(options: BuildContainerOptions = {}) {
  const emit = options.emit ?? jest.fn(async () => undefined)
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }

  const container = {
    resolve: (key: string) => {
      if (key === "logger") {
        return logger
      }

      if (key === Modules.EVENT_BUS) {
        if (options.resolveError) {
          throw options.resolveError
        }

        return { emit }
      }

      throw new Error(`Unexpected resolve('${key}')`)
    },
  } as unknown as MedusaContainer

  return { container, emit, logger }
}

const payload = {
  subscription_id: "sub_1",
  dunning_case_id: "dun_1",
  recovery_reason: "retry_limit_exhausted",
}

/** `logDunningEvent` writes one JSON line per call. */
function loggedError(logger: { error: jest.Mock }) {
  expect(logger.error).toHaveBeenCalledTimes(1)

  return JSON.parse(logger.error.mock.calls[0][0])
}

describe("emitDunningEvent", () => {
  it("dispatches the event ungrouped and reports it as emitted", async () => {
    const { container, emit, logger } = buildContainer()

    const response = await emitDunningEvent(container, {
      eventName: DunningEvents.PAYMENT_FAILED,
      data: payload,
    })

    expect(emit).toHaveBeenCalledTimes(1)
    // No `metadata.eventGroupId`: grouping would defer the publish past this try/catch.
    expect(emit).toHaveBeenCalledWith({
      name: DunningEvents.PAYMENT_FAILED,
      data: payload,
    })
    expect(response.output).toEqual({
      eventName: DunningEvents.PAYMENT_FAILED,
      emitted: true,
    })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it("swallows a rejecting event bus into an alertable log", async () => {
    const { container, logger } = buildContainer({
      emit: jest.fn(async () => {
        throw new Error("Redis connection lost")
      }),
    })

    const response = await emitDunningEvent(container, {
      eventName: DunningEvents.PAYMENT_FAILED,
      data: payload,
    })

    expect(response.output).toEqual({
      eventName: DunningEvents.PAYMENT_FAILED,
      emitted: false,
    })
    expect(loggedError(logger)).toMatchObject({
      domain: "dunning",
      event: "dunning.event",
      outcome: "failed",
      alertable: true,
      subscription_id: "sub_1",
      dunning_case_id: "dun_1",
      message: "Redis connection lost",
      metadata: { event_name: DunningEvents.PAYMENT_FAILED },
    })
  })

  it("swallows an unresolvable event bus the same way", async () => {
    const { container, logger } = buildContainer({
      resolveError: new Error("Could not resolve 'event_bus'"),
    })

    const response = await emitDunningEvent(container, {
      eventName: DunningEvents.STARTED,
      data: payload,
    })

    expect(response.output).toEqual({
      eventName: DunningEvents.STARTED,
      emitted: false,
    })
    expect(loggedError(logger)).toMatchObject({
      event: "dunning.event",
      outcome: "failed",
      alertable: true,
      message: "Could not resolve 'event_bus'",
      metadata: { event_name: DunningEvents.STARTED },
    })
  })

  it("prefers the payload's correlation id over a generated one", async () => {
    const { container, logger } = buildContainer({
      emit: jest.fn(async () => {
        throw new Error("Redis connection lost")
      }),
    })

    await emitDunningEvent(container, {
      eventName: DunningEvents.ATTEMPT_FAILED,
      data: { ...payload, correlation_id: "retry-abc" },
    })

    expect(loggedError(logger).correlation_id).toBe("retry-abc")
  })
})
