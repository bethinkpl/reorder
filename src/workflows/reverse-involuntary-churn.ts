import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import {
  reverseInvoluntaryChurnStep,
  type ReverseInvoluntaryChurnStepInput,
} from "./steps/reverse-involuntary-churn"

export const reverseInvoluntaryChurnWorkflow = createWorkflow(
  "reverse-involuntary-churn",
  function (input: ReverseInvoluntaryChurnStepInput) {
    const lockKey = transform({ input }, function ({ input }) {
      return `dunning:${input.dunning_case_id}`
    })

    acquireLockStep({
      key: lockKey,
      timeout: 5,
      ttl: 120,
    })

    const result = reverseInvoluntaryChurnStep(input)

    releaseLockStep({
      key: lockKey,
    })

    return new WorkflowResponse(result)
  }
)

export default reverseInvoluntaryChurnWorkflow
