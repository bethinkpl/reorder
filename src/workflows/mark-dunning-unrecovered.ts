import {
  createWorkflow,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { DunningEvents } from "../modules/dunning/events"
import { emitDunningEventStep } from "./steps/emit-dunning-event"
import {
  markDunningUnrecoveredStep,
  type MarkDunningUnrecoveredStepInput,
} from "./steps/mark-dunning-unrecovered"

export const markDunningUnrecoveredWorkflow = createWorkflow(
  "mark-dunning-unrecovered",
  function (input: MarkDunningUnrecoveredStepInput) {
    const result = markDunningUnrecoveredStep(input)

    // Only the run that actually moved the subscription may notify: a subscription that was
    // already terminal has had its customer told once already.
    when(
      "emit-dunning-payment-failed",
      { result },
      function ({ result }) {
        return result.settled_now === true
      }
    ).then(function () {
      emitDunningEventStep({
        eventName: DunningEvents.PAYMENT_FAILED,
        data: {
          subscription_id: result.subscription_id,
          dunning_case_id: result.id,
          recovery_reason: "marked_unrecovered_by_admin",
        },
      }).config({
        name: "emit-dunning-payment-failed-event",
      })
    })

    return new WorkflowResponse(result)
  }
)

export default markDunningUnrecoveredWorkflow
