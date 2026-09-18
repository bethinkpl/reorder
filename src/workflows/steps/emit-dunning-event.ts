import type { EventMetadata, IEventBusModuleService } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import {
  createDunningCorrelationId,
  getDunningErrorMessage,
  logDunningEvent,
} from "../../modules/dunning/utils/observability"

export type EmitDunningEventStepInput = {
  eventName: string
  data: Record<string, unknown>
}

function pickString(data: Record<string, unknown>, key: string) {
  const value = data[key]

  return typeof value === "string" ? value : undefined
}

/**
 * Notifying the customer is not worth losing the case over: an event bus that is down would
 * otherwise fail the workflow and compensate the settlement that already committed. Mirrors
 * core's `emitEventStep` (grouping included) but swallows the emit failure into an alertable log.
 */
export const emitDunningEventStep = createStep(
  "emit-dunning-event",
  async function (
    input: EmitDunningEventStepInput,
    { container, eventGroupId }
  ) {
    try {
      const eventBus = container.resolve<IEventBusModuleService>(
        Modules.EVENT_BUS
      )

      const metadata: EventMetadata = {}

      if (eventGroupId) {
        metadata.eventGroupId = eventGroupId
      }

      await eventBus.emit({
        name: input.eventName,
        data: input.data,
        metadata,
      })

      return new StepResponse({ eventName: input.eventName, emitted: true })
    } catch (error) {
      const logger = container.resolve("logger")

      logDunningEvent(logger, "error", {
        event: "dunning.event",
        outcome: "failed",
        correlation_id:
          pickString(input.data, "correlation_id") ??
          createDunningCorrelationId("event"),
        dunning_case_id: pickString(input.data, "dunning_case_id"),
        subscription_id: pickString(input.data, "subscription_id"),
        alertable: true,
        message: getDunningErrorMessage(error),
        metadata: {
          event_name: input.eventName,
        },
      })

      return new StepResponse({ eventName: input.eventName, emitted: false })
    }
  }
)
