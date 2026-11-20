import type {
  IEventBusModuleService,
  IPaymentModuleService,
  MedusaContainer,
} from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { DUNNING_MODULE } from "../../modules/dunning"
import type DunningModuleService from "../../modules/dunning/service"
import {
  CLOSED_DUNNING_CASE_STATUSES,
  DunningAttemptStatus,
} from "../../modules/dunning/types"
import { RENEWAL_MODULE } from "../../modules/renewal"
import type RenewalModuleService from "../../modules/renewal/service"
import {
  CLOSED_RENEWAL_CYCLE_STATUSES,
  RenewalAttemptStatus,
} from "../../modules/renewal/types"
import {
  LatePaymentCapturedReason,
  type LatePaymentCapturedEventData,
  SubscriptionEvents,
} from "../../modules/subscription/events"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import type SubscriptionModuleService from "../../modules/subscription/service"
import { TERMINAL_SUBSCRIPTION_STATUSES } from "../../modules/subscription/types"
import { loadOrderAmounts } from "../steps/run-dunning-retry"
import {
  readRenewalSessionMarkers,
  signalNamesAttempt,
} from "./renewal-session-marker"
import { runUnderLock } from "./run-under-lock"

const LOCK_WAIT_SECONDS = 30
const LOCK_HOLD_SECONDS = 120

export const CAPTURED_AFTER_CLOSE_ERROR_CODE = "captured_after_close"

export const NO_PAYMENT_SIGNAL_ERROR_CODE = "no_payment_signal"

/** Where an attempt records the capture it has been reconciled with, so a redelivery does nothing. */
const LATE_CAPTURE_METADATA_KEY = "late_payment_captured"

export type TrackedCharge =
  | {
    kind: "renewal"
    session_id: string
    renewal_cycle_id: string
    renewal_attempt_id: string | null
  }
  | {
    kind: "dunning"
    session_id: string
    dunning_case_id: string
    dunning_attempt_id: string
  }

export type TrackedCaptureInput = {
  charge: TrackedCharge
  payment_id: string
  payment_collection_id: string
  subscription_id: string
  order_id: string | null
  /** An involuntary churn the capture pays off: the operator may reverse it and keep the money. */
  kept_for_churn_reversal: boolean
}

type AttemptRecord = {
  id: string
  status: string
  metadata: Record<string, unknown> | null
}

type LateCaptureMarker = {
  payment_id: string
  reason: LatePaymentCapturedReason | null
  at: string
}

type TrackedState = {
  attempt: AttemptRecord | null
  /** Still in flight: nothing has closed the attempt yet. */
  attempt_open: boolean
  /** Closed without having taken money, so this capture is not accounted for anywhere. */
  attempt_unapplied: boolean
  parent_closed: boolean
  renewal_cycle_id: string | undefined
}

export function readTrackedCharge(
  session: { id: string, context: Record<string, unknown> | null } | null | undefined
): TrackedCharge | null {
  if (!session) {
    return null
  }

  const renewal = readRenewalSessionMarkers(session.context)

  if (renewal.renewal_cycle_id) {
    return {
      kind: "renewal",
      session_id: session.id,
      renewal_cycle_id: renewal.renewal_cycle_id,
      renewal_attempt_id: renewal.renewal_attempt_id,
    }
  }

  const caseId = session.context?.dunning_case_id
  const attemptId = session.context?.dunning_attempt_id

  if (typeof caseId === "string" && caseId && typeof attemptId === "string" && attemptId) {
    return {
      kind: "dunning",
      session_id: session.id,
      dunning_case_id: caseId,
      dunning_attempt_id: attemptId,
    }
  }

  return null
}

/** The captured payment of a session, which a lost `payment.captured` never reported. */
export async function findCapturedPaymentId(
  container: MedusaContainer,
  sessionId: string
): Promise<string | null> {
  const payments = await container
    .resolve<IPaymentModuleService>(Modules.PAYMENT)
    .listPayments({ payment_session_id: sessionId })

  return payments.find((payment) => payment.captured_at)?.id ?? null
}

function readMarker(attempt: AttemptRecord | null): LateCaptureMarker | null {
  const marker = attempt?.metadata?.[LATE_CAPTURE_METADATA_KEY]

  return marker && typeof marker === "object" ? (marker as LateCaptureMarker) : null
}

async function loadTrackedState(
  container: MedusaContainer,
  charge: TrackedCharge
): Promise<TrackedState> {
  if (charge.kind === "renewal") {
    const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
    const [cycle] = await renewalModule.listRenewalCycles({ id: charge.renewal_cycle_id })
    const attempts = cycle
      ? await renewalModule.listRenewalAttempts({ renewal_cycle_id: cycle.id })
      : []
    const attempt = attempts.find((candidate) =>
      signalNamesAttempt(candidate, {
        session_id: charge.session_id,
        attempt_id: charge.renewal_attempt_id,
      })
    )

    return {
      attempt: attempt ?? null,
      attempt_open: attempt?.status === RenewalAttemptStatus.PROCESSING,
      attempt_unapplied: Boolean(attempt && attempt.status !== RenewalAttemptStatus.SUCCEEDED),
      parent_closed: Boolean(cycle && CLOSED_RENEWAL_CYCLE_STATUSES.includes(cycle.status)),
      renewal_cycle_id: charge.renewal_cycle_id,
    }
  }

  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const [dunningCase] = await dunningModule.listDunningCases({ id: charge.dunning_case_id })
  const [attempt] = dunningCase
    ? await dunningModule.listDunningAttempts({
        id: charge.dunning_attempt_id,
        dunning_case_id: dunningCase.id,
      })
    : []

  return {
    attempt: attempt ?? null,
    attempt_open: attempt?.status === DunningAttemptStatus.PROCESSING,
    attempt_unapplied: Boolean(attempt && attempt.status !== DunningAttemptStatus.SUCCEEDED),
    parent_closed: Boolean(
      dunningCase && CLOSED_DUNNING_CASE_STATUSES.includes(dunningCase.status)
    ),
    renewal_cycle_id: dunningCase?.renewal_cycle_id,
  }
}

/**
 * The renewal order's over-payment not yet claimed by a capture this plugin already asked the host
 * to refund. Without it two late captures on one order would both be reported as the surplus.
 */
async function unclaimedOverpayment(
  container: MedusaContainer,
  orderId: string,
  paymentId: string
): Promise<number> {
  const overpaid = -(await loadOrderAmounts(container, orderId)).pending

  if (overpaid <= 0) {
    return 0
  }

  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const cycles = await renewalModule.listRenewalCycles({ generated_order_id: orderId })
  const cases = await dunningModule.listDunningCases({ renewal_order_id: orderId })
  const attempts: AttemptRecord[] = [
    ...(cycles.length
      ? await renewalModule.listRenewalAttempts({
          renewal_cycle_id: cycles.map(({ id }) => id),
        })
      : []),
    ...(cases.length
      ? await dunningModule.listDunningAttempts({
          dunning_case_id: cases.map(({ id }) => id),
        })
      : []),
  ]
  const claimedIds = attempts
    .map(readMarker)
    .filter((marker): marker is LateCaptureMarker => Boolean(marker?.reason))
    .map((marker) => marker.payment_id)
    .filter((id) => id !== paymentId)

  if (!claimedIds.length) {
    return overpaid
  }

  const claimed = await container
    .resolve<IPaymentModuleService>(Modules.PAYMENT)
    .listPayments({ id: claimedIds }, { relations: ["refunds"] })
  const awaitingRefund = claimed.reduce((sum, payment) => {
    const refunded = (payment.refunds ?? []).reduce(
      (total, refund) => total + Number(refund.amount),
      0
    )

    return sum + Math.max(Number(payment.amount) - refunded, 0)
  }, 0)

  return overpaid - awaitingRefund
}

function resolveReason(input: {
  charge: TrackedCharge
  terminal: boolean
  kept_for_churn_reversal: boolean
  attempt_unapplied: boolean
  parent_closed: boolean
  overpaid: boolean
}): LatePaymentCapturedReason | null {
  if (input.terminal && !input.kept_for_churn_reversal && input.attempt_unapplied) {
    return LatePaymentCapturedReason.SUBSCRIPTION_TERMINAL
  }

  if (!input.overpaid) {
    return null
  }

  if (input.parent_closed && input.attempt_unapplied) {
    return input.charge.kind === "renewal"
      ? LatePaymentCapturedReason.CYCLE_CLOSED
      : LatePaymentCapturedReason.CASE_CLOSED
  }

  return LatePaymentCapturedReason.ORDER_OVERPAID
}

async function recordOnAttempt(
  container: MedusaContainer,
  charge: TrackedCharge,
  attempt: AttemptRecord,
  update: {
    close: boolean
    marker: LateCaptureMarker
  }
) {
  const metadata = {
    ...(attempt.metadata ?? {}),
    [LATE_CAPTURE_METADATA_KEY]: update.marker,
  }
  const closing = update.close
    ? {
        finished_at: new Date(update.marker.at),
        error_code: CAPTURED_AFTER_CLOSE_ERROR_CODE,
        error_message: `Payment '${update.marker.payment_id}' was captured after this attempt's ${charge.kind === "renewal" ? "renewal" : "dunning case"} had closed; it was not applied`,
      }
    : {}

  if (charge.kind === "renewal") {
    await container.resolve<RenewalModuleService>(RENEWAL_MODULE).updateRenewalAttempts({
      id: attempt.id,
      ...(update.close ? { status: RenewalAttemptStatus.SUCCEEDED } : {}),
      ...closing,
      metadata,
    })

    return
  }

  await container.resolve<DunningModuleService>(DUNNING_MODULE).updateDunningAttempts({
    id: attempt.id,
    ...(update.close ? { status: DunningAttemptStatus.SUCCEEDED } : {}),
    ...closing,
    metadata,
  })
}

async function reconcileUnderLock(
  container: MedusaContainer,
  input: TrackedCaptureInput
): Promise<LatePaymentCapturedEventData | null> {
  const { charge } = input
  const subscription = await container
    .resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
    .retrieveSubscription(input.subscription_id)
  const state = await loadTrackedState(container, charge)
  const { attempt } = state

  if (readMarker(attempt)?.payment_id === input.payment_id) {
    return null
  }

  const terminal = TERMINAL_SUBSCRIPTION_STATUSES.includes(subscription.status)
  const overpaid = input.order_id
    ? (await unclaimedOverpayment(container, input.order_id, input.payment_id)) > 0
    : false
  const reason = resolveReason({
    charge,
    terminal,
    kept_for_churn_reversal: input.kept_for_churn_reversal,
    attempt_unapplied: state.attempt_unapplied,
    parent_closed: state.parent_closed,
    overpaid,
  })
  const close =
    (state.attempt_open && (terminal || state.parent_closed)) ||
    (state.attempt_unapplied && reason === LatePaymentCapturedReason.SUBSCRIPTION_TERMINAL)

  if (attempt && (close || reason)) {
    await recordOnAttempt(container, charge, attempt, {
      close,
      marker: { payment_id: input.payment_id, reason, at: new Date().toISOString() },
    })
  }

  if (!reason) {
    return null
  }

  return {
    subscription_id: subscription.id,
    payment_id: input.payment_id,
    order_id: input.order_id,
    payment_collection_id: input.payment_collection_id,
    ...(charge.kind === "renewal"
      ? { renewal_cycle_id: charge.renewal_cycle_id }
      : {
          renewal_cycle_id: state.renewal_cycle_id,
          dunning_case_id: charge.dunning_case_id,
          dunning_attempt_id: charge.dunning_attempt_id,
        }),
    reason,
  }
}

async function emitLatePaymentCaptured(
  container: MedusaContainer,
  data: LatePaymentCapturedEventData
) {
  const logger = container.resolve("logger")

  logger.error(
    JSON.stringify({
      domain: "subscriptions",
      event: SubscriptionEvents.LATE_PAYMENT_CAPTURED,
      ...data,
      alertable: true,
      message: `Payment '${data.payment_id}' was captured but not applied to subscription '${data.subscription_id}' (${data.reason}); the host app is asked to refund it`,
    })
  )

  try {
    await container.resolve<IEventBusModuleService>(Modules.EVENT_BUS).emit({
      name: SubscriptionEvents.LATE_PAYMENT_CAPTURED,
      data,
    })
  } catch (error) {
    logger.error(
      JSON.stringify({
        domain: "subscriptions",
        event: `${SubscriptionEvents.LATE_PAYMENT_CAPTURED}.emit_failed`,
        subscription_id: data.subscription_id,
        payment_id: data.payment_id,
        alertable: true,
        message: error instanceof Error ? error.message : String(error),
      })
    )
  }
}

/**
 * Reconciles a captured payment of a session this plugin created with the attempt that submitted
 * it, once the normal settlement has run: an attempt whose cycle, case or subscription closed
 * while the charge was in flight is closed as captured, and a capture the plugin will not apply
 * is reported once as `subscription.late_payment_captured` for the host app to refund.
 *
 * Runs under the subscription's renewal lock, which serialises every tracked capture of the order,
 * and the case's lock for a dunning retry. Never throws: it runs off a delivered event, and the
 * awaiting-payment sweeps deliver the capture again while its attempt is still processing.
 */
export async function reconcileTrackedCapture(
  container: MedusaContainer,
  input: TrackedCaptureInput
): Promise<void> {
  const { charge } = input

  try {
    const lockOptions = { wait_seconds: LOCK_WAIT_SECONDS, hold_seconds: LOCK_HOLD_SECONDS }
    const event = await runUnderLock(
      container,
      `renewal:subscription:${input.subscription_id}`,
      () =>
        charge.kind === "renewal"
          ? reconcileUnderLock(container, input)
          : runUnderLock(
              container,
              `dunning:${charge.dunning_case_id}`,
              () => reconcileUnderLock(container, input),
              lockOptions
            ),
      lockOptions
    )

    if (event) {
      await emitLatePaymentCaptured(container, event)
    }
  } catch (error) {
    container.resolve("logger").error(
      JSON.stringify({
        domain: "subscriptions",
        event: "tracked_capture_reconciliation_failed",
        subscription_id: input.subscription_id,
        payment_id: input.payment_id,
        payment_session_id: charge.session_id,
        alertable: true,
        message: error instanceof Error ? error.message : String(error),
      })
    )
  }
}
