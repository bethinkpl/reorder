import { StepResponse } from "@medusajs/framework/workflows-sdk"

declare global {
  var __applyRenewalCreditsTestDelegate:
    | ((input: unknown) => unknown)
    | undefined
}

const { processRenewalCycleWorkflow } = require("../../../.medusa/server/src/workflows")

processRenewalCycleWorkflow.hooks.applyRenewalCredits(async (input: unknown) => {
  await globalThis.__applyRenewalCreditsTestDelegate?.(input)

  return new StepResponse(undefined)
})
