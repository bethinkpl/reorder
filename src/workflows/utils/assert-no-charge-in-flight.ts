import type { MedusaContainer } from "@medusajs/framework/types"
import { MedusaError } from "@medusajs/framework/utils"
import { DUNNING_MODULE } from "../../modules/dunning"
import type DunningModuleService from "../../modules/dunning/service"
import { CHARGE_IN_FLIGHT_DUNNING_CASE_STATUSES } from "../../modules/dunning/types"
import { RENEWAL_MODULE } from "../../modules/renewal"
import type RenewalModuleService from "../../modules/renewal/service"
import { CHARGE_IN_FLIGHT_RENEWAL_CYCLE_STATUSES } from "../../modules/renewal/types"
import { renewalSubscriptionLockKey } from "../../modules/renewal/utils/lock-key"
import { isLockBusy, withLock } from "./with-lock"

export const RENEWAL_PAYMENT_IN_PROGRESS = "renewal_payment_in_progress"

const chargeInFlight = (subscriptionId: string) =>
  new MedusaError(
    MedusaError.Types.CONFLICT,
    `Subscription '${subscriptionId}' can't be changed while a renewal payment is in progress; try again once the payment has been settled or has failed`,
    RENEWAL_PAYMENT_IN_PROGRESS
  )

async function assertNoChargeInFlight(
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
    throw chargeInFlight(subscription_id)
  }
}

/**
 * Runs `write` under the subscription's renewal lock once no charge is in flight. A held lock is a
 * renewal run charging right now, so it is refused the same way rather than waited for.
 */
export async function withNoChargeInFlight<T>(
  container: MedusaContainer,
  subscriptionId: string,
  write: () => Promise<T>
): Promise<T> {
  try {
    return await withLock(
      container,
      renewalSubscriptionLockKey(subscriptionId),
      { wait_seconds: 0, ttl_seconds: 120 },
      async () => {
        await assertNoChargeInFlight(container, subscriptionId)

        return await write()
      }
    )
  } catch (error) {
    throw isLockBusy(error) ? chargeInFlight(subscriptionId) : error
  }
}
