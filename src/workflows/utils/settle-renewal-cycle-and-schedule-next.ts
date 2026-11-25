import type { MedusaContainer } from "@medusajs/framework/types"
import type { RenewalSettlementSource } from "../../modules/renewal/types"
import { ensureNextRenewalCycleWorkflow } from "../ensure-next-renewal-cycle"
import {
  settleRenewalCycleSucceeded,
  SUBSCRIPTION_CANCELLED_REFUSAL,
} from "./settle-renewal-cycle-succeeded"

export async function settleRenewalCycleAndScheduleNext(
  container: MedusaContainer,
  input: {
    renewal_cycle_id: string
    subscription_id: string
    order_id: string | null
    finished_at: Date
    source: RenewalSettlementSource
  }
): Promise<void> {
  const settlement = await settleRenewalCycleSucceeded(container, {
    ...input,
    // Dunning only follows a charge, and a run with the skip set charges nothing: a skip the
    // subscription has now was requested after the cycle ran, for a later one.
    consumed_skip_next_cycle: false,
  })

  if (settlement.reason === SUBSCRIPTION_CANCELLED_REFUSAL) {
    return
  }

  // Also after a supersession: an earlier settlement of this cycle may have moved the dates and
  // failed before it scheduled the next cycle.
  await ensureNextRenewalCycleWorkflow(container).run({
    input: { subscription_id: input.subscription_id },
  })
}
