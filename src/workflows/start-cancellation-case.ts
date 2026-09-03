import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { createSubscriptionLogEventStep } from "./steps/create-subscription-log-event"
import {
  startCancellationCaseStep,
  type StartCancellationCaseStepInput,
} from "./steps/start-cancellation-case"
import { buildCancellationCaseStartedLogEvent } from "./steps/shared-cancellation-log"

export const startCancellationCaseWorkflow = createWorkflow(
  "start-cancellation-case",
  function (input: StartCancellationCaseStepInput) {
    const result = startCancellationCaseStep(input)
    const logInput = transform({ result, input }, function ({ result, input }) {
      return {
        log_event: buildCancellationCaseStartedLogEvent({
          current: result.current,
          previous: result.previous,
          subscription: result.subscription,
          entry_source: input.entry_context?.source ?? null,
          triggered_by: input.entry_context?.triggered_by ?? null,
        }),
      }
    })
    createSubscriptionLogEventStep(logInput)

    return new WorkflowResponse(result)
  }
)

export default startCancellationCaseWorkflow
