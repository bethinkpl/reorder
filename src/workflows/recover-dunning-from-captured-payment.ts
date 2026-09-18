import {
  createWorkflow,
  transform,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import { DunningEvents } from "../modules/dunning/events"
import { emitDunningEventStep } from "./steps/emit-dunning-event"
import {
  recoverDunningFromCapturedPaymentStep,
  type RecoverDunningFromCapturedPaymentStepInput,
} from "./steps/recover-dunning-from-captured-payment"

export const recoverDunningFromCapturedPaymentWorkflow = createWorkflow(
  "recover-dunning-from-captured-payment",
  function (input: RecoverDunningFromCapturedPaymentStepInput) {
    const lockKey = transform({ input }, function ({ input }) {
      return `dunning:${input.dunning_case_id}`
    })

    // Waits longer than the scheduled retry does: this runs off a payment the customer already
    // made, so giving up on the lock would leave their subscription past_due.
    acquireLockStep({
      key: lockKey,
      timeout: 30,
      ttl: 120,
    })

    const result = recoverDunningFromCapturedPaymentStep(input)

    when(
      "emit-dunning-recovered",
      { result },
      function ({ result }) {
        return result.recovered === true
      }
    ).then(function () {
      emitDunningEventStep({
        eventName: DunningEvents.RECOVERED,
        data: {
          subscription_id: result.subscription_id,
          dunning_case_id: result.dunning_case_id,
          renewal_order_id: result.renewal_order_id,
          recovery_reason: result.recovery_reason,
        },
      }).config({
        name: "emit-dunning-recovered-event",
      })
    })

    releaseLockStep({
      key: lockKey,
    })

    return new WorkflowResponse(result)
  }
)

export default recoverDunningFromCapturedPaymentWorkflow
