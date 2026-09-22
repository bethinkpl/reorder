import { StepResponse } from "@medusajs/framework/workflows-sdk"

/**
 * Test-app hook registration for `resolveRenewalBillingAddress`.
 *
 * Same reason as `resolve-renewal-adjustments-test-hook.ts`: the test app runs
 * the plugin's COMPILED output while specs import the TS source, so the handler
 * has to be registered against the compiled workflow object for it to be the
 * one that executes. Specs drive it through the process-global delegate below.
 */
declare global {
  var __resolveRenewalBillingAddressTestDelegate:
    | ((input: unknown) => unknown)
    | undefined
}

const { processRenewalCycleWorkflow } = require("../../../.medusa/server/src/workflows")

processRenewalCycleWorkflow.hooks.resolveRenewalBillingAddress(async (input: unknown) => {
  return new StepResponse(
    globalThis.__resolveRenewalBillingAddressTestDelegate?.(input) as never
  )
})
