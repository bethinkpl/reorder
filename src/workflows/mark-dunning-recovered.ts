import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import {
  markDunningRecoveredStep,
  type MarkDunningRecoveredStepInput,
} from "./steps/mark-dunning-recovered"

export const markDunningRecoveredWorkflow = createWorkflow(
  "mark-dunning-recovered",
  function (input: MarkDunningRecoveredStepInput) {
    const lockKey = transform({ input }, function ({ input }) {
      return `dunning:${input.dunning_case_id}`
    })

    acquireLockStep({
      key: lockKey,
      timeout: 5,
      ttl: 120,
    })

    const result = markDunningRecoveredStep(input)

    releaseLockStep({
      key: lockKey,
    })

    return new WorkflowResponse(result)
  }
)

export default markDunningRecoveredWorkflow
