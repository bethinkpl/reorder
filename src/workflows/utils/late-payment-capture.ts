import type {
  IEventBusModuleService,
  IPaymentModuleService,
  MedusaContainer,
} from "@medusajs/framework/types"
import { MathBN, Modules } from "@medusajs/framework/utils"
import { PaymentAttemptErrorCode } from "../../common/types/payment-attempt-error-code"
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
import { renewalSubscriptionLockKey } from "../../modules/renewal/utils/lock-key"
import { dunningCaseLockKey } from "../../modules/dunning/utils/lock-key"
import { SubscriptionLogEvents } from "../../modules/subscription/utils/observability"

const LOCK_WAIT_SECONDS = 30
const LOCK_HOLD_SECONDS = 120

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
  refund_amount?: number | null
  at: string
}

type PaymentBalance = {
  currency_code: string
  captured: number
  refunded: number
}

type TrackedState = {
  attempt: AttemptRecord | null
  attempt_open: boolean
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

async function loadPaymentBalances(
  container: MedusaContainer,
  paymentIds: string[]
): Promise<Map<string, PaymentBalance>> {
  const payments = await container
    .resolve<IPaymentModuleService>(Modules.PAYMENT)
    .listPayments({ id: paymentIds }, { relations: ["captures", "refunds"] })

  return new Map(
    payments.map((payment) => [
      payment.id,
      {
        currency_code: payment.currency_code,
        captured: MathBN.sum(0, ...(payment.captures ?? []).map(({ amount }) => amount)).toNumber(),
        refunded: MathBN.sum(0, ...(payment.refunds ?? []).map(({ amount }) => amount)).toNumber(),
      },
    ])
  )
}

function unrefunded(balance: PaymentBalance, of: number = balance.captured): number {
  return MathBN.max(0, MathBN.sub(of, balance.refunded)).toNumber()
}

/**
 * Without subtracting earlier claims, two late captures on one order would both be reported as the
 * surplus.
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
  const claims = attempts
    .map(readMarker)
    .filter((marker): marker is LateCaptureMarker =>
      Boolean(marker?.reason && marker.payment_id !== paymentId)
    )

  if (!claims.length) {
    return overpaid
  }

  const balances = await loadPaymentBalances(
    container,
    claims.map(({ payment_id }) => payment_id)
  )
  // A claim the host has refunded is already out of the order's paid total; only what it still
  // owes stands against the surplus.
  const awaitingRefund = MathBN.sum(
    0,
    ...claims.map((claim) => {
      const balance = balances.get(claim.payment_id)

      return balance ? unrefunded(balance, claim.refund_amount ?? balance.captured) : 0
    })
  )

  return MathBN.sub(overpaid, awaitingRefund).toNumber()
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
        error_code: PaymentAttemptErrorCode.CAPTURED_AFTER_CLOSE,
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
  const surplus = input.order_id
    ? await unclaimedOverpayment(container, input.order_id, input.payment_id)
    : 0
  const reason = resolveReason({
    charge,
    terminal,
    kept_for_churn_reversal: input.kept_for_churn_reversal,
    attempt_unapplied: state.attempt_unapplied,
    parent_closed: state.parent_closed,
    overpaid: surplus > 0,
  })
  const refund = reason ? await refundFor(container, input.payment_id, reason, surplus) : null
  const close =
    (state.attempt_open && (terminal || state.parent_closed)) ||
    (state.attempt_unapplied && reason === LatePaymentCapturedReason.SUBSCRIPTION_TERMINAL)

  // An attempt that already failed is marked even when nothing is reported, so that a redelivery
  // after a later cancellation can't report a capture that was applied in the meantime.
  const failedBefore = state.attempt_unapplied && !state.attempt_open

  if (attempt && (close || reason || failedBefore)) {
    await recordOnAttempt(container, charge, attempt, {
      close,
      marker: {
        payment_id: input.payment_id,
        reason,
        refund_amount: refund?.refund_amount ?? null,
        at: new Date().toISOString(),
      },
    })
  }

  if (!reason || !refund) {
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
    ...refund,
  }
}

async function refundFor(
  container: MedusaContainer,
  paymentId: string,
  reason: LatePaymentCapturedReason,
  surplus: number
): Promise<Pick<LatePaymentCapturedEventData, "refund_amount" | "currency_code">> {
  const balance = (await loadPaymentBalances(container, [paymentId])).get(paymentId)

  if (!balance) {
    throw new Error(`Payment '${paymentId}' was not found`)
  }

  const refundable = unrefunded(balance)

  return {
    refund_amount:
      reason === LatePaymentCapturedReason.ORDER_OVERPAID
        ? MathBN.min(surplus, refundable).toNumber()
        : refundable,
    currency_code: balance.currency_code,
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
      message: `Payment '${data.payment_id}' was captured but not applied to subscription '${data.subscription_id}' (${data.reason}); the host app is asked to refund ${data.refund_amount} ${data.currency_code} of it`,
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
 * The subscription's renewal lock serialises every tracked capture of the order. Never throws: it
 * runs off a delivered event, and the awaiting-payment sweeps deliver the capture again while its
 * attempt is still processing.
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
      renewalSubscriptionLockKey(input.subscription_id),
      () =>
        charge.kind === "renewal"
          ? reconcileUnderLock(container, input)
          : runUnderLock(
              container,
              dunningCaseLockKey(charge.dunning_case_id),
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
        event: SubscriptionLogEvents.TRACKED_CAPTURE_RECONCILIATION_FAILED,
        subscription_id: input.subscription_id,
        payment_id: input.payment_id,
        payment_session_id: charge.session_id,
        alertable: true,
        message: error instanceof Error ? error.message : String(error),
      })
    )
  }
}
