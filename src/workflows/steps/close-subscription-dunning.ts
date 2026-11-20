import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import {
  type ClosedDunningCase,
  closeDunningCasesOnCancellation,
  type CloseDunningCasesOnCancellationInput,
  restoreClosedDunningCases,
} from "../utils/close-dunning-cases-on-cancellation"

export type CloseSubscriptionDunningStepInput = CloseDunningCasesOnCancellationInput

type CloseSubscriptionDunningStepOutput = {
  subscription_id: string
  closed_dunning_case_ids: string[]
}

export const closeSubscriptionDunningStep = createStep(
  "close-subscription-dunning",
  async function (input: CloseSubscriptionDunningStepInput, { container }) {
    const closed = await closeDunningCasesOnCancellation(container, input)

    return new StepResponse<CloseSubscriptionDunningStepOutput, ClosedDunningCase[]>(
      {
        subscription_id: input.subscription_id,
        closed_dunning_case_ids: closed.map(({ id }) => id),
      },
      closed
    )
  },
  async function (closed: ClosedDunningCase[] | undefined, { container }) {
    if (!closed?.length) {
      return
    }

    await restoreClosedDunningCases(container, closed)
  }
)
