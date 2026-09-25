import {
  createWorkflow,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { DunningEvents } from "../modules/dunning/events"
import { emitDunningEventStep } from "./steps/emit-dunning-event"
import {
  startDunningStep,
  type StartDunningStepInput,
} from "./steps/start-dunning"

export const startDunningWorkflow = createWorkflow(
  "start-dunning",
  function (input: StartDunningStepInput) {
    const result = startDunningStep(input)

    // Only on creation: `updated` is re-entry for the same renewal cycle and would re-notify the
    // customer on every repeated failure of that cycle.
    when(
      "emit-dunning-started",
      { result },
      function ({ result }) {
        return result.action === "created"
      }
    ).then(function () {
      emitDunningEventStep({
        eventName: DunningEvents.STARTED,
        data: {
          subscription_id: result.subscription_id,
          dunning_case_id: result.dunning_case_id,
          renewal_cycle_id: result.renewal_cycle_id,
          attempt_count: result.attempt_count,
          next_retry_at: result.next_retry_at,
        },
      }).config({
        name: "emit-dunning-started-event",
      })
    })

    return new WorkflowResponse(result)
  }
)

export default startDunningWorkflow
