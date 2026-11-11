import type { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { RENEWAL_MODULE } from "../../modules/renewal"
import type RenewalModuleService from "../../modules/renewal/service"
import {
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../modules/renewal/types"
import {
  createRenewalCorrelationId,
  logRenewalEvent,
} from "../../modules/renewal/utils/observability"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import type SubscriptionModuleService from "../../modules/subscription/service"
import { TERMINAL_SUBSCRIPTION_STATUSES } from "../../modules/subscription/types"
import { ensureNextRenewalCycleWorkflow } from "../ensure-next-renewal-cycle"
import { loadOrderAmounts } from "../steps/run-dunning-retry"
import {
  readStoredSettlementInputs,
  settleRenewalCycleSucceeded,
} from "./settle-renewal-cycle-succeeded"

const RENEWAL_LOCK_TIMEOUT_SECONDS = 30

const LOCK_WORTHY_STATUSES: readonly RenewalCycleStatus[] = [
  RenewalCycleStatus.AWAITING_PAYMENT,
  RenewalCycleStatus.PROCESSING,
]

export type SettleAwaitingRenewalCycleOutcome =
  | "settled"
  | "closed_superseded"
  | "not_awaiting"
  | "order_unpaid"
  | "subscription_terminal"

export async function settleAwaitingRenewalCycleUnderLock(
  container: MedusaContainer,
  renewalCycleId: string
): Promise<SettleAwaitingRenewalCycleOutcome> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

  const cycle = await renewalModule.retrieveRenewalCycle(renewalCycleId)

  if (cycle.status !== RenewalCycleStatus.AWAITING_PAYMENT) {
    return "not_awaiting"
  }

  const orderId = cycle.generated_order_id

  if (!orderId || (await loadOrderAmounts(container, orderId)).pending > 0) {
    return "order_unpaid"
  }

  const subscription = await subscriptionModule.retrieveSubscription(
    cycle.subscription_id
  )

  if (TERMINAL_SUBSCRIPTION_STATUSES.includes(subscription.status)) {
    return "subscription_terminal"
  }

  const stored = readStoredSettlementInputs(cycle.settlement_inputs)
  const finishedAt = new Date()

  const settlement = await settleRenewalCycleSucceeded(container, {
    renewal_cycle_id: cycle.id,
    subscription_id: cycle.subscription_id,
    order_id: orderId,
    finished_at: finishedAt,
    attempt_id: stored.attempt_id,
    audit: stored.audit ?? undefined,
    source_snapshot: stored.source_snapshot,
    source: "renewal",
  })

  if (settlement.reason === "already_succeeded") {
    return "not_awaiting"
  }

  if (settlement.reason === "cycle_superseded") {
    await renewalModule.updateRenewalCycles({
      id: cycle.id,
      status: RenewalCycleStatus.SUCCEEDED,
      processed_at: finishedAt,
      last_error: null,
    })

    if (stored.attempt_id) {
      await renewalModule.updateRenewalAttempts({
        id: stored.attempt_id,
        status: RenewalAttemptStatus.SUCCEEDED,
        finished_at: finishedAt,
        order_id: orderId,
        error_code: null,
        error_message: null,
      })
    }

    logRenewalEvent(container.resolve("logger"), "warn", {
      event: "renewal.awaiting_payment_settlement",
      outcome: "succeeded",
      correlation_id:
        stored.audit?.correlation_id ??
        createRenewalCorrelationId("renewal-awaiting-payment"),
      renewal_cycle_id: cycle.id,
      subscription_id: cycle.subscription_id,
      message: `RenewalCycle '${cycle.id}' was paid after the subscription's next renewal date moved past it: closed as succeeded, billing dates left as they are`,
      metadata: { order_id: orderId },
    })

    return "closed_superseded"
  }

  await ensureNextRenewalCycleWorkflow(container).run({
    input: { subscription_id: cycle.subscription_id },
  })

  return "settled"
}

/**
 * Takes the renewal run's own lock, so a payment confirmed before the run has parked the cycle
 * waits for it instead of finding the cycle still `processing`.
 */
export async function settleAwaitingRenewalCycle(
  container: MedusaContainer,
  renewalCycleId: string
): Promise<SettleAwaitingRenewalCycleOutcome> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const cycle = await renewalModule.retrieveRenewalCycle(renewalCycleId)

  if (!LOCK_WORTHY_STATUSES.includes(cycle.status)) {
    return "not_awaiting"
  }

  return await container
    .resolve(Modules.LOCKING)
    .execute(
      `renewal:subscription:${cycle.subscription_id}`,
      () => settleAwaitingRenewalCycleUnderLock(container, renewalCycleId),
      { timeout: RENEWAL_LOCK_TIMEOUT_SECONDS }
    )
}
