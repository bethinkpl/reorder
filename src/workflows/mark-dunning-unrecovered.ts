import {
  createWorkflow,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { emitEventStep } from "@medusajs/medusa/core-flows"
import { DunningEvents } from "../modules/dunning/events"
import { SubscriptionStatus } from "../modules/subscription/types"
import {
  markDunningUnrecoveredStep,
  type MarkDunningUnrecoveredStepInput,
} from "./steps/mark-dunning-unrecovered"

export const markDunningUnrecoveredWorkflow = createWorkflow(
  "mark-dunning-unrecovered",
  function (input: MarkDunningUnrecoveredStepInput) {
    const result = markDunningUnrecoveredStep(input)

    // A subscription that was already terminal keeps its previous status, and its customer has
    // been told once already.
    when(
      "emit-dunning-payment-failed",
      { result },
      function ({ result }) {
        return result.subscription_status === SubscriptionStatus.PAYMENT_FAILED
      }
    ).then(function () {
      emitEventStep({
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
