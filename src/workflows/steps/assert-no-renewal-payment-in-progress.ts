import type { MedusaContainer } from "@medusajs/framework/types"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { DUNNING_MODULE } from "../../modules/dunning"
import type DunningModuleService from "../../modules/dunning/service"
import { CHARGE_IN_FLIGHT_DUNNING_CASE_STATUSES } from "../../modules/dunning/types"
import { RENEWAL_MODULE } from "../../modules/renewal"
import type RenewalModuleService from "../../modules/renewal/service"
import {
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../modules/renewal/types"
import { subscriptionErrors } from "../../modules/subscription/utils/errors"

export type AssertNoRenewalPaymentInProgressStepInput = {
  subscription_id: string
  action: string
}

/**
 * A cycle left processing with its attempt still open counts: its charge may have been submitted
 * before the run could record that it was waiting.
 */
async function describeRenewalPaymentInProgress(
  container: MedusaContainer,
  subscriptionId: string
): Promise<string | null> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const cycles = await renewalModule.listRenewalCycles({
    subscription_id: subscriptionId,
    status: [RenewalCycleStatus.AWAITING_PAYMENT, RenewalCycleStatus.PROCESSING],
  })

  for (const cycle of cycles) {
    if (cycle.status === RenewalCycleStatus.AWAITING_PAYMENT) {
      return `renewal '${cycle.id}' is awaiting its payment`
    }

    const [latest] = await renewalModule.listRenewalAttempts(
      { renewal_cycle_id: cycle.id },
      { order: { attempt_no: "DESC" }, take: 1 }
    )

    if (latest?.status === RenewalAttemptStatus.PROCESSING) {
      return `renewal '${cycle.id}' has a charge in progress`
    }
  }

  const [dunningCase] = await container
    .resolve<DunningModuleService>(DUNNING_MODULE)
    .listDunningCases(
      {
        subscription_id: subscriptionId,
        status: [...CHARGE_IN_FLIGHT_DUNNING_CASE_STATUSES],
      },
      { select: ["id"], take: 1 }
    )

  return dunningCase
    ? `dunning case '${dunningCase.id}' has a retry charge in progress`
    : null
}

/**
 * Run under the `renewal:subscription:<id>` lock, so no renewal run can submit a charge between the
 * check and the change.
 */
export const assertNoRenewalPaymentInProgressStep = createStep(
  "assert-no-renewal-payment-in-progress",
  async function (
    input: AssertNoRenewalPaymentInProgressStepInput,
    { container }
  ) {
    const charge = await describeRenewalPaymentInProgress(
      container,
      input.subscription_id
    )

    if (charge) {
      throw subscriptionErrors.renewalPaymentInProgress(
        input.subscription_id,
        input.action,
        charge
      )
    }

    return new StepResponse(undefined)
  }
)
