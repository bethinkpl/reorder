import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { RENEWAL_MODULE } from "../../modules/renewal"
import type RenewalModuleService from "../../modules/renewal/service"
import { renewalErrors } from "../../modules/renewal/utils/errors"

export type ResolveRenewalCycleSubscriptionStepInput = {
  renewal_cycle_id: string
}

/**
 * Resolves the subscription that owns a renewal cycle so the execution
 * workflow can take a subscription-scoped lock BEFORE any mutation.
 * `subscription_id` is immutable on a cycle, so reading it ahead of the
 * lock is race-free.
 */
export const resolveRenewalCycleSubscriptionStep = createStep(
  "resolve-renewal-cycle-subscription",
  async function (
    input: ResolveRenewalCycleSubscriptionStepInput,
    { container }
  ) {
    const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)

    try {
      const cycle = await renewalModule.retrieveRenewalCycle(
        input.renewal_cycle_id
      )

      return new StepResponse({ subscription_id: cycle.subscription_id })
    } catch {
      throw renewalErrors.notFound("RenewalCycle", input.renewal_cycle_id)
    }
  }
)
