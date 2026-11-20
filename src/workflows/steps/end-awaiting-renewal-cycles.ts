import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import {
  endAwaitingRenewalCyclesOnCancellation,
  type EndAwaitingRenewalCyclesOnCancellationInput,
  type EndedAwaitingRenewalCycle,
  restoreAwaitingRenewalCycles,
} from "../utils/end-awaiting-renewal-cycle-on-cancellation"

export type EndAwaitingRenewalCyclesStepInput =
  EndAwaitingRenewalCyclesOnCancellationInput

/**
 * Its own step so a failure in a later step restores the ended cycles. A throwing step is not
 * compensated, so a failure inside it is undone by the helper itself.
 */
export const endAwaitingRenewalCyclesStep = createStep(
  "end-awaiting-renewal-cycles",
  async function (input: EndAwaitingRenewalCyclesStepInput, { container }) {
    const ended = await endAwaitingRenewalCyclesOnCancellation(container, input)

    return new StepResponse<string[], EndedAwaitingRenewalCycle[]>(
      ended.map((entry) => entry.cycle.id),
      ended
    )
  },
  async function (
    ended: EndedAwaitingRenewalCycle[] | undefined,
    { container }
  ) {
    if (!ended?.length) {
      return
    }

    await restoreAwaitingRenewalCycles(container, ended)
  }
)
