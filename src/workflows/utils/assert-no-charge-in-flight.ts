import type { MedusaContainer } from "@medusajs/framework/types"
import { MedusaError } from "@medusajs/framework/utils"
import { DUNNING_MODULE } from "../../modules/dunning"
import type DunningModuleService from "../../modules/dunning/service"
import { CHARGE_IN_FLIGHT_DUNNING_CASE_STATUSES } from "../../modules/dunning/types"
import { RENEWAL_MODULE } from "../../modules/renewal"
import type RenewalModuleService from "../../modules/renewal/service"
import { CHARGE_IN_FLIGHT_RENEWAL_CYCLE_STATUSES } from "../../modules/renewal/types"

export const RENEWAL_PAYMENT_IN_PROGRESS = "renewal_payment_in_progress"

export async function assertNoChargeInFlight(
  container: MedusaContainer,
  subscription_id: string
) {
  const [cycles, dunningCases] = await Promise.all([
    container.resolve<RenewalModuleService>(RENEWAL_MODULE).listRenewalCycles(
      {
        subscription_id,
        status: [...CHARGE_IN_FLIGHT_RENEWAL_CYCLE_STATUSES],
      },
      { select: ["id"], take: 1 }
    ),
    container.resolve<DunningModuleService>(DUNNING_MODULE).listDunningCases(
      {
        subscription_id,
        status: [...CHARGE_IN_FLIGHT_DUNNING_CASE_STATUSES],
      },
      { select: ["id"], take: 1 }
    ),
  ])

  if (cycles.length || dunningCases.length) {
    throw new MedusaError(
      MedusaError.Types.CONFLICT,
      `Subscription '${subscription_id}' can't be changed while a renewal payment is in progress; try again once the payment has been settled or has failed`,
      RENEWAL_PAYMENT_IN_PROGRESS
    )
  }
}
