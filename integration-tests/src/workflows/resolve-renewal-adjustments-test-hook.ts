import { StepResponse } from "@medusajs/framework/workflows-sdk"

/**
 * Test-app hook registration for `resolveRenewalAdjustments`.
 *
 * The test app executes the plugin's COMPILED output (`.medusa/server`) while
 * specs import the TS source — two separate compositions of every workflow,
 * where the last one to register owns the executing handler map. Registering
 * here against the compiled workflow object (the same module instance the
 * app's resource loaders compose) puts the handler on the composition that
 * actually runs. Specs drive it through the process-global delegate below
 * (the global object is shared across jest's module registries).
 */
declare global {
  var __resolveRenewalAdjustmentsTestDelegate:
    | ((input: unknown) => unknown)
    | undefined
}

const { processRenewalCycleWorkflow } = require("../../../.medusa/server/src/workflows")

processRenewalCycleWorkflow.hooks.resolveRenewalAdjustments(async (input: unknown) => {
  return new StepResponse(
    globalThis.__resolveRenewalAdjustmentsTestDelegate?.(input) as never
  )
})
