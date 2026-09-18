import type {
  IEventBusModuleService,
  MedusaContainer,
} from "@medusajs/framework/types"
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
 * otherwise fail the workflow and compensate the settlement that already committed.
 *
 * Deliberately emits ungrouped, unlike core's `emitEventStep`: a grouped event is merely buffered
 * here and published by the workflow's onFinish release, whose `.catch` cancels the transaction —
 * compensating the dunning steps long after the settlement they follow committed. Dispatching from
 * inside the step keeps a bus failure in reach of the try/catch below.
 *
 * Exported for unit tests: `createStep` doesn't expose its handler.
 */
export async function emitDunningEvent(
  container: MedusaContainer,
  input: EmitDunningEventStepInput
) {
  try {
    const eventBus =
      container.resolve<IEventBusModuleService>(Modules.EVENT_BUS)

    await eventBus.emit({
      name: input.eventName,
      data: input.data,
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

export const emitDunningEventStep = createStep(
  "emit-dunning-event",
  async function (input: EmitDunningEventStepInput, { container }) {
    return await emitDunningEvent(container, input)
  }
)
