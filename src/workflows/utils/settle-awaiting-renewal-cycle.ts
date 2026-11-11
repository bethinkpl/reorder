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
import { toISOStringOrNull } from "./date-output"
import {
  readStoredSettlementInputs,
  settleRenewalCycleSucceeded,
  type StoredRenewalSettlementInputs,
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

type RenewalCycleRecord = Awaited<
  ReturnType<RenewalModuleService["retrieveRenewalCycle"]>
>

type RenewalAttemptRecord = Awaited<
  ReturnType<RenewalModuleService["listRenewalAttempts"]>
>[number]

async function findSubmittedAttempt(
  renewalModule: RenewalModuleService,
  renewalCycleId: string
): Promise<RenewalAttemptRecord | null> {
  const [latest] = await renewalModule.listRenewalAttempts(
    { renewal_cycle_id: renewalCycleId },
    { order: { attempt_no: "DESC" }, take: 1 }
  )

  return latest?.status === RenewalAttemptStatus.PROCESSING &&
    latest.payment_reference
    ? latest
    : null
}

function readMetadataString(
  metadata: Record<string, unknown> | null,
  key: string
): string | null {
  const value = metadata?.[key]

  return typeof value === "string" ? value : null
}

function settlementInputsOfSubmittedAttempt(
  cycle: RenewalCycleRecord,
  attempt: RenewalAttemptRecord
): StoredRenewalSettlementInputs {
  const stored = readStoredSettlementInputs(cycle.settlement_inputs)

  if (stored.attempt_id === attempt.id) {
    return stored
  }

  return {
    attempt_id: attempt.id,
    audit: {
      correlation_id:
        readMetadataString(cycle.metadata, "last_correlation_id") ??
        createRenewalCorrelationId("renewal-awaiting-payment"),
      trigger_type:
        readMetadataString(cycle.metadata, "last_trigger_type") === "manual"
          ? "manual"
          : "scheduler",
      triggered_by: readMetadataString(cycle.metadata, "last_triggered_by"),
      attempt_no: attempt.attempt_no,
      operation_started_at: new Date(attempt.started_at).getTime(),
      scheduled_for: new Date(cycle.scheduled_for).toISOString(),
      previous_state: {
        status: cycle.status,
        attempt_count: cycle.attempt_count,
        processed_at: toISOStringOrNull(cycle.processed_at),
        generated_order_id: cycle.generated_order_id,
        last_error: cycle.last_error,
      },
    },
    source_snapshot: null,
  }
}

/**
 * `include_processing` also settles a `processing` cycle whose latest attempt carries a submitted
 * charge: a run that could not park it. Only safe under the renewal lock, which a live run holds.
 */
export async function settleAwaitingRenewalCycleUnderLock(
  container: MedusaContainer,
  renewalCycleId: string,
  options: { include_processing?: boolean } = {}
): Promise<SettleAwaitingRenewalCycleOutcome> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

  const cycle = await renewalModule.retrieveRenewalCycle(renewalCycleId)
  let stored: StoredRenewalSettlementInputs

  if (cycle.status === RenewalCycleStatus.AWAITING_PAYMENT) {
    stored = readStoredSettlementInputs(cycle.settlement_inputs)
  } else if (
    options.include_processing &&
    cycle.status === RenewalCycleStatus.PROCESSING
  ) {
    const attempt = await findSubmittedAttempt(renewalModule, cycle.id)

    if (!attempt) {
      return "not_awaiting"
    }

    stored = settlementInputsOfSubmittedAttempt(cycle, attempt)
  } else {
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
      () =>
        settleAwaitingRenewalCycleUnderLock(container, renewalCycleId, {
          include_processing: true,
        }),
      { timeout: RENEWAL_LOCK_TIMEOUT_SECONDS }
    )
}
