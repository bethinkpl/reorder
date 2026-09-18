import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import {
  reverseInvoluntaryChurnStep,
  type ReverseInvoluntaryChurnStepInput,
} from "./steps/reverse-involuntary-churn"

export const reverseInvoluntaryChurnWorkflow = createWorkflow(
  "reverse-involuntary-churn",
  function (input: ReverseInvoluntaryChurnStepInput) {
    const result = reverseInvoluntaryChurnStep(input)

    return new WorkflowResponse(result)
  }
)

export default reverseInvoluntaryChurnWorkflow
