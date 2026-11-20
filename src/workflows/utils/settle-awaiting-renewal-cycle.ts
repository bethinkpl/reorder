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
  type RenewalSessionSignal,
  signalNamesAttempt,
} from "./renewal-session-marker"
import { tryUnderLock } from "./run-under-lock"
import {
  readStoredSettlementInputs,
  settleRenewalCycleSucceeded,
  type StoredRenewalSettlementInputs,
} from "./settle-renewal-cycle-succeeded"

const RENEWAL_LOCK_TIMEOUT_SECONDS = 30
const PROCESSING_LOCK_HOLD_SECONDS = 120

type SettleOptions = { processing_signal?: RenewalSessionSignal }

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

async function findProcessingAttempt(
  renewalModule: RenewalModuleService,
  renewalCycleId: string,
  signal: RenewalSessionSignal
): Promise<RenewalAttemptRecord | null> {
  const [latest] = await renewalModule.listRenewalAttempts(
    { renewal_cycle_id: renewalCycleId },
    { order: { attempt_no: "DESC" }, take: 1 }
  )

  return latest?.status === RenewalAttemptStatus.PROCESSING &&
    signalNamesAttempt(latest, signal)
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
    // A run with the skip flag set charges nothing, so one that submitted a charge skipped nothing.
    consumed_skip_next_cycle: false,
  }
}

export async function settleAwaitingRenewalCycleUnderLock(
  container: MedusaContainer,
  renewalCycleId: string,
  options: SettleOptions = {}
): Promise<SettleAwaitingRenewalCycleOutcome> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

  const cycle = await renewalModule.retrieveRenewalCycle(renewalCycleId)
  let stored: StoredRenewalSettlementInputs

  if (cycle.status === RenewalCycleStatus.AWAITING_PAYMENT) {
    stored = readStoredSettlementInputs(cycle.settlement_inputs)
  } else if (
    options.processing_signal &&
    cycle.status === RenewalCycleStatus.PROCESSING
  ) {
    const attempt = await findProcessingAttempt(
      renewalModule,
      cycle.id,
      options.processing_signal
    )

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
    consumed_skip_next_cycle: stored.consumed_skip_next_cycle ?? undefined,
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

export async function settleAwaitingRenewalCycle(
  container: MedusaContainer,
  renewalCycleId: string,
  options: SettleOptions = {}
): Promise<SettleAwaitingRenewalCycleOutcome> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const cycle = await renewalModule.retrieveRenewalCycle(renewalCycleId)
  const lockKey = `renewal:subscription:${cycle.subscription_id}`
  const settle = () =>
    settleAwaitingRenewalCycleUnderLock(container, renewalCycleId, options)

  if (cycle.status === RenewalCycleStatus.AWAITING_PAYMENT) {
    return await container
      .resolve(Modules.LOCKING)
      .execute(lockKey, settle, { timeout: RENEWAL_LOCK_TIMEOUT_SECONDS })
  }

  if (
    !options.processing_signal ||
    cycle.status !== RenewalCycleStatus.PROCESSING
  ) {
    return "not_awaiting"
  }

  const run = await tryUnderLock(container, lockKey, settle, {
    wait_seconds: 0,
    hold_seconds: PROCESSING_LOCK_HOLD_SECONDS,
  })

  if (run.acquired) {
    return run.result
  }

  // Most likely the run that submitted the charge, which parks the cycle for the capture to be
  // settled by the awaiting-payment sweep; a cycle it fails to park is settled there as well.
  logRenewalEvent(container.resolve("logger"), "info", {
    event: "renewal.awaiting_payment_settlement",
    correlation_id: createRenewalCorrelationId("renewal-awaiting-payment"),
    renewal_cycle_id: cycle.id,
    subscription_id: cycle.subscription_id,
    alertable: false,
    message: `RenewalCycle '${cycle.id}' is still processing under another holder of its renewal lock; settling its captured payment is deferred to the awaiting-payment sweep`,
  })

  return "not_awaiting"
}
