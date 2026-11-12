import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { CANCELLATION_MODULE } from "../../modules/cancellation"
import type CancellationModuleService from "../../modules/cancellation/service"
import { cancellationErrors } from "../../modules/cancellation/utils/errors"

export type ResolveCancellationCaseSubscriptionStepInput = {
  cancellation_case_id: string
}

export const resolveCancellationCaseSubscriptionStep = createStep(
  "resolve-cancellation-case-subscription",
  async function (
    input: ResolveCancellationCaseSubscriptionStepInput,
    { container }
  ) {
    const cancellationModule =
      container.resolve<CancellationModuleService>(CANCELLATION_MODULE)

    try {
      const cancellationCase = await cancellationModule.retrieveCancellationCase(
        input.cancellation_case_id
      )

      return new StepResponse({
        subscription_id: cancellationCase.subscription_id,
      })
    } catch {
      throw cancellationErrors.notFound(
        "CancellationCase",
        input.cancellation_case_id
      )
    }
  }
)
