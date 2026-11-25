import type { IPaymentModuleService, MedusaContainer } from "@medusajs/framework/types"
import { MathBN, MedusaError, Modules } from "@medusajs/framework/utils"
import { DUNNING_MODULE } from "../../modules/dunning"
import { DunningEvents } from "../../modules/dunning/events"
import type DunningModuleService from "../../modules/dunning/service"
import {
  CHARGE_IN_FLIGHT_DUNNING_CASE_STATUSES,
  DunningAttemptStatus,
  DunningCaseStatus,
} from "../../modules/dunning/types"
import { RENEWAL_MODULE } from "../../modules/renewal"
import type RenewalModuleService from "../../modules/renewal/service"
import {
  CHARGE_IN_FLIGHT_RENEWAL_CYCLE_STATUSES,
  type RenewalAppliedPendingUpdateData,
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../modules/renewal/types"
import { getRenewalErrorMessage } from "../../modules/renewal/utils/observability"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import {
  type LatePaymentCapturedEventData,
  LatePaymentCapturedReason,
  SubscriptionEvents,
} from "../../modules/subscription/events"
import type SubscriptionModuleService from "../../modules/subscription/service"
import {
  SubscriptionStatus,
  type SubscriptionType,
  TERMINAL_SUBSCRIPTION_STATUSES,
} from "../../modules/subscription/types"
import { ensureNextRenewalCycleWorkflow } from "../ensure-next-renewal-cycle"
import { recoverDunningFromCapturedPaymentWorkflow } from "../recover-dunning-from-captured-payment"
import { emitDunningEvent } from "../steps/emit-dunning-event"
import { createPaymentQualifiedRenewalError, recordRenewalFailure } from "../steps/process-renewal-cycle"
import {
  type DunningCaseRecord,
  loadOrderAmounts,
  runDunningRetry,
  settleNonRetryableCase,
} from "../steps/run-dunning-retry"
import { ChargeSessionMarker, findChargeSession, type RenewalChargeContext } from "./charge-session"
import { settleRenewalCycleSucceeded } from "./settle-renewal-cycle-succeeded"
import { isLockBusy, withLock } from "./with-lock"

const SIGNAL_LOCK_WAIT_SECONDS = 45
const DEFAULT_ALERT_HOURS = 96
const CAPTURED_AFTER_CLOSE = "captured_after_close"
const RUN_HELD_PARENT_STATUSES: readonly string[] = [RenewalCycleStatus.PROCESSING, DunningCaseStatus.RETRYING]

export type ChargeKind = "renewal" | "dunning"
export type ChargeSignal = "captured" | "failed" | "sweep"
export type ChargeAction =
  | "settle" | "settle_foreign" | "paid_twice" | "fail" | "end_parent"
  | "late_capture" | "mark_captured" | "mark_applied" | "overdue_alert" | "close_attempt_failed"
export type ChargeMarker = { kind: ChargeKind, attempt_id: string }
export type ReportedChargeFailure = { session_id: string | null, code: string, message: string }
export type ReconcileChargeInput = ChargeMarker & (
  | { signal: "captured", payment_id: string }
  | { signal: "failed", failure: ReportedChargeFailure }
  | { signal: "sweep" }
)
export type ReconcileChargeResult = { actions: readonly ChargeAction[], reported: boolean }

export type RawChargeFacts = {
  kind: ChargeKind
  attempt: { id: string, status: string, started_at: Date | string, metadata: Record<string, unknown> | null }
  parent_status: string
  newest_attempt_id: string | null
  subscription_status: SubscriptionStatus
  order_has_dunning_case: boolean
  order_pending: number | null
  captured_payment_id: string | null
  alert_hours: number
}

export type ChargeFacts = {
  parent: "in_flight" | "settled" | "closed"
  awaiting: boolean
  subscription: "churned" | "terminal" | "active"
  order: "overpaid" | "paid" | "unpaid"
  attempt: "processing" | "failed" | "succeeded"
  captured: boolean
  reported: boolean
  twice_alerted: boolean
  overdue: boolean
  alerted: boolean
}

const ageMs = (startedAt: Date | string, now: Date) => now.getTime() - new Date(startedAt).getTime()

export function ranTenMinutesAgo(startedAt: Date | string, now: Date) {
  return ageMs(startedAt, now) >= 10 * 60 * 1000
}

export function toChargeFacts(raw: RawChargeFacts, now: Date): ChargeFacts {
  const renewal = raw.kind === "renewal"
  const inFlight: readonly string[] = renewal
    ? CHARGE_IN_FLIGHT_RENEWAL_CYCLE_STATUSES
    : CHARGE_IN_FLIGHT_DUNNING_CASE_STATUSES
  const settled: string = renewal ? RenewalCycleStatus.SUCCEEDED : DunningCaseStatus.RECOVERED
  const { order_pending: pending, captured_payment_id: paymentId } = raw
  const { status, metadata } = raw.attempt
  const marks = (key: string) =>
    paymentId !== null && (metadata?.[key] as { payment_id?: unknown } | undefined)?.payment_id === paymentId

  return {
    parent: inFlight.includes(raw.parent_status) && raw.newest_attempt_id === raw.attempt.id
      ? "in_flight"
      : raw.parent_status === settled ? "settled" : "closed",
    awaiting: raw.parent_status === (renewal ? RenewalCycleStatus.AWAITING_PAYMENT : DunningCaseStatus.AWAITING_PAYMENT),
    subscription: raw.subscription_status === SubscriptionStatus.PAYMENT_FAILED && raw.order_has_dunning_case
      ? "churned"
      : TERMINAL_SUBSCRIPTION_STATUSES.includes(raw.subscription_status) ? "terminal" : "active",
    order: pending === null || !Number.isFinite(pending) || pending > 0 ? "unpaid" : pending < 0 ? "overpaid" : "paid",
    attempt: status === RenewalAttemptStatus.PROCESSING
      ? "processing"
      : status === RenewalAttemptStatus.SUCCEEDED ? "succeeded" : "failed",
    captured: paymentId !== null,
    reported: marks("late_payment_captured"),
    twice_alerted: marks("paid_twice_alerted"),
    overdue: ageMs(raw.attempt.started_at, now) >= raw.alert_hours * 60 * 60 * 1000,
    alerted: Boolean(metadata?.overdue_alerted_at),
  }
}

const inFlight = (f: ChargeFacts) => f.parent === "in_flight"

const DECISION_TABLE: readonly [readonly ChargeSignal[], (f: ChargeFacts) => boolean, readonly ChargeAction[]][] = [
  [["captured"], (f) => f.reported && inFlight(f) && f.subscription !== "active", ["end_parent"]],
  [["captured"], (f) => f.reported, []],
  [["failed"], (f) => f.attempt === "succeeded", []],
  [["captured"], (f) => inFlight(f) && f.subscription === "terminal", ["late_capture", "end_parent"]],
  [["failed"], (f) => inFlight(f) && f.subscription !== "active", ["close_attempt_failed", "end_parent"]],
  [["sweep"], (f) => inFlight(f) && f.subscription !== "active", ["end_parent"]],
  [
    ["captured"],
    (f) => f.parent === "closed" && f.subscription === "terminal" && f.attempt !== "succeeded",
    ["late_capture"],
  ],
  [["captured"], (f) => f.subscription === "churned" && f.attempt !== "succeeded", ["mark_captured"]],
  [["captured"], (f) => inFlight(f) && f.order === "paid", ["settle"]],
  [["captured"], (f) => inFlight(f) && f.order === "overpaid", ["settle", "paid_twice"]],
  [["failed"], (f) => inFlight(f) && f.order !== "unpaid", []],
  [["failed"], (f) => inFlight(f) && (f.awaiting || f.attempt === "processing"), ["fail"]],
  [["sweep"], (f) => inFlight(f) && f.order !== "unpaid", ["settle_foreign"]],
  [["sweep"], (f) => inFlight(f) && f.awaiting && f.attempt === "failed", ["fail"]],
  [["captured", "sweep"], (f) => inFlight(f) && f.overdue && !f.alerted, ["overdue_alert"]],
  [["captured", "sweep"], inFlight, []],
  [["captured"], (f) => f.parent === "settled" && f.order === "overpaid" && !f.twice_alerted, ["paid_twice"]],
  [["failed"], (f) => f.attempt === "processing", ["close_attempt_failed"]],
  [["captured"], (f) => f.parent === "settled" && f.attempt === "processing", ["mark_applied"]],
  [["sweep"], (f) => f.attempt === "processing" && f.overdue, ["close_attempt_failed"]],
]

export function decideChargeActions(facts: ChargeFacts, signal: ChargeSignal): readonly ChargeAction[] {
  const on = signal === "sweep" && facts.captured ? "captured" : signal

  return DECISION_TABLE.find(([signals, when]) => signals.includes(on) && when(facts))?.[2] ?? []
}

async function loadChargeParent(container: MedusaContainer, input: ChargeMarker) {
  const newestFirst = { order: { attempt_no: "DESC" as const }, take: 1 }

  if (input.kind === "renewal") {
    const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
    const attempt = await renewalModule.retrieveRenewalAttempt(input.attempt_id)
    const cycle = await renewalModule.retrieveRenewalCycle(attempt.renewal_cycle_id)
    const [newest] = await renewalModule.listRenewalAttempts({ renewal_cycle_id: cycle.id }, newestFirst)
    const orderId = attempt.order_id ?? cycle.generated_order_id

    return { attempt, newest, parent: { kind: "renewal" as const, cycle }, owner: cycle, order_id: orderId }
  }

  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const attempt = await dunningModule.retrieveDunningAttempt(input.attempt_id)
  const dunningCase = (await dunningModule.retrieveDunningCase(attempt.dunning_case_id)) as DunningCaseRecord
  const [newest] = await dunningModule.listDunningAttempts({ dunning_case_id: dunningCase.id }, newestFirst)
  const parent = { kind: "dunning" as const, dunning_case: dunningCase }

  return { attempt, newest, parent, owner: dunningCase, order_id: dunningCase.renewal_order_id }
}

async function loadCharge(container: MedusaContainer, input: ReconcileChargeInput, now: Date) {
  const { attempt, newest, parent, owner, order_id: orderId } = await loadChargeParent(container, input)
  const subscription = (await container
    .resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
    .retrieveSubscription(owner.subscription_id)) as SubscriptionType
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const marker = input.kind === "renewal" ? ChargeSessionMarker.RENEWAL : ChargeSessionMarker.DUNNING
  const session = input.signal === "sweep"
    ? await findChargeSession(container, { ...attempt, order_id: orderId }, marker)
    : null
  // `captured_at` is only set once a payment is captured in full.
  const payment = input.signal === "captured"
    ? await paymentModule.retrievePayment(input.payment_id, { relations: ["captures"] })
    : session
      ? (await paymentModule.listPayments({ payment_session_id: session.id }, { relations: ["captures"] }))
          .find(({ captures }) => captures?.length) ?? null
      : null
  const churnCases = input.kind === "renewal" && orderId && subscription.status === SubscriptionStatus.PAYMENT_FAILED
    ? await container
        .resolve<DunningModuleService>(DUNNING_MODULE)
        .listDunningCases({ renewal_order_id: orderId }, { select: ["id"], take: 1 })
    : []
  const alertHours = Number(process.env.RENEWAL_AWAITING_PAYMENT_ALERT_HOURS)

  const facts = toChargeFacts({
    kind: input.kind,
    attempt,
    parent_status: owner.status,
    newest_attempt_id: newest?.id ?? null,
    subscription_status: subscription.status,
    order_has_dunning_case: input.kind === "dunning" || churnCases.length > 0,
    order_pending: orderId ? (await loadOrderAmounts(container, orderId)).pending : null,
    captured_payment_id: payment?.id ?? null,
    alert_hours: alertHours > 0 ? alertHours : DEFAULT_ALERT_HOURS,
  }, now)
  const lockKey = parent.kind === "renewal" ? `renewal:subscription:${owner.subscription_id}` : `dunning:${owner.id}`

  return { attempt, parent, parent_status: owner.status, subscription, order_id: orderId, lock_key: lockKey, payment, facts }
}

type AttemptUpdate = { status?: "succeeded" | "failed", error_code?: string, error_message?: string, marker?: object }

async function applyChargeActions(
  container: MedusaContainer,
  charge: Awaited<ReturnType<typeof loadCharge>>,
  actions: readonly ChargeAction[],
  failure: ReportedChargeFailure | null,
  now: Date
) {
  const { attempt, facts, parent, subscription, order_id: orderId } = charge
  const payment = charge.payment!
  const chargeContext = attempt.metadata?.charge_context as RenewalChargeContext | undefined
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  let reported = facts.reported

  const update = async ({ status, error_code, error_message, marker }: AttemptUpdate) => {
    const fields = {
      id: attempt.id,
      ...(status && { finished_at: now, error_code: error_code ?? null, error_message: error_message ?? null }),
      ...(marker && { metadata: { ...attempt.metadata, ...marker } }),
    }
    const succeeded = status === "succeeded"

    if (parent.kind === "renewal") {
      await renewalModule.updateRenewalAttempts({
        ...fields,
        ...(status && { status: succeeded ? RenewalAttemptStatus.SUCCEEDED : RenewalAttemptStatus.FAILED }),
      })
    } else {
      await dunningModule.updateDunningAttempts({
        ...fields,
        ...(status && { status: succeeded ? DunningAttemptStatus.SUCCEEDED : DunningAttemptStatus.FAILED }),
      })
    }
  }
  const alert = (event: string, message: string) => container.resolve("logger").error(JSON.stringify({
    domain: "subscriptions",
    event,
    attempt_id: attempt.id,
    subscription_id: subscription.id,
    order_id: orderId,
    alertable: true,
    message,
  }))
  const settleRenewal = async (own: boolean) => {
    if (parent.kind !== "renewal") {
      return
    }

    const { cycle } = parent
    const { reason } = await settleRenewalCycleSucceeded(container, {
      renewal_cycle_id: cycle.id,
      subscription_id: cycle.subscription_id,
      order_id: orderId,
      finished_at: now,
      attempt_id: own ? attempt.id : null,
      source: own ? "renewal" : "customer_payment",
      source_snapshot: chargeContext?.source_snapshot,
      audit: chargeContext && { ...chargeContext, attempt_no: attempt.attempt_no },
    })

    if (reason === "cycle_superseded") {
      await renewalModule.updateRenewalCycles({
        id: cycle.id,
        status: RenewalCycleStatus.SUCCEEDED,
        processed_at: now,
        generated_order_id: orderId,
        last_error: null,
      })

      if (own) {
        await update({ status: "succeeded" })
      }
    }

    await ensureNextRenewalCycleWorkflow(container).run({ input: { subscription_id: cycle.subscription_id } })
  }

  const handlers: Record<ChargeAction, () => Promise<unknown>> = {
    settle: () => settleRenewal(true),
    settle_foreign: () => settleRenewal(false),
    fail: async () => {
      const failed = failure ?? {
        session_id: attempt.payment_reference,
        code: attempt.error_code ?? "payment_failed",
        message: attempt.error_message ?? "Payment failed",
      }

      if (parent.kind === "renewal") {
        const { cycle } = parent

        if (!chargeContext) {
          await update({ status: "failed", error_code: failed.code, error_message: failed.message })

          return await renewalModule.updateRenewalCycles({
            id: cycle.id,
            status: RenewalCycleStatus.FAILED,
            processed_at: now,
            last_error: failed.message,
          })
        }

        const error = Object.assign(new Error(failed.message), { code: failed.code })

        return await recordRenewalFailure(container, {
          ...chargeContext,
          renewal_cycle_id: cycle.id,
          subscription_id: cycle.subscription_id,
          attempt_id: attempt.id,
          attempt_no: attempt.attempt_no,
          applied_pending_changes: cycle.applied_pending_update_data as RenewalAppliedPendingUpdateData | null,
          scheduled_for: new Date(cycle.scheduled_for).toISOString(),
          subscription,
          cycle_previous_state: chargeContext.previous_state,
        }, createPaymentQualifiedRenewalError(error, "payment_provider", orderId!))
      }

      const { output: result } = await runDunningRetry(container, {
        dunning_case_id: parent.dunning_case.id,
        reported_failure: { dunning_attempt_id: attempt.id, ...failed },
      })
      const { subscription_id, dunning_case_id, attempt_no, error_code } = result
      const events: [boolean, string, Record<string, unknown>][] = [
        [
          result.outcome === "retry_scheduled" && result.attempt_counted === true,
          DunningEvents.ATTEMPT_FAILED,
          { subscription_id, dunning_case_id, attempt_no, error_code, next_retry_at: result.next_retry_at },
        ],
        [
          result.outcome === "unrecovered" && result.settled_now === true,
          DunningEvents.PAYMENT_FAILED,
          { subscription_id, dunning_case_id, recovery_reason: result.recovery_reason },
        ],
        [
          result.outcome === "awaiting_manual_resolution",
          DunningEvents.PARKED,
          { subscription_id, dunning_case_id, attempt_no, park_reason: result.park_reason, error_code },
        ],
      ]

      for (const [due, eventName, data] of events) {
        if (due) {
          await emitDunningEvent(container, { eventName, data })
        }
      }
    },
    end_parent: () => parent.kind === "dunning"
      ? settleNonRetryableCase(dunningModule, parent.dunning_case, subscription.status, now)
      : renewalModule.updateRenewalCycles({
          id: parent.cycle.id,
          status: RenewalCycleStatus.FAILED,
          processed_at: now,
          last_error: `Subscription '${subscription.id}' is ${subscription.status}, so its pending renewal charge was ended`,
        }),
    late_capture: async () => {
      const data: LatePaymentCapturedEventData = {
        subscription_id: subscription.id,
        payment_id: payment.id,
        order_id: orderId,
        payment_collection_id: payment.payment_collection_id,
        ...(parent.kind === "renewal"
          ? { renewal_cycle_id: parent.cycle.id }
          : {
              renewal_cycle_id: parent.dunning_case.renewal_cycle_id,
              dunning_case_id: parent.dunning_case.id,
              dunning_attempt_id: attempt.id,
            }),
        reason: LatePaymentCapturedReason.SUBSCRIPTION_TERMINAL,
        refund_amount: MathBN.sum(0, ...(payment.captures ?? []).map(({ amount }) => amount)).toNumber(),
        currency_code: payment.currency_code,
      }
      const { output } = await emitDunningEvent(container, { eventName: SubscriptionEvents.LATE_PAYMENT_CAPTURED, data })

      if (output.emitted) {
        reported = true
        await update({
          status: "succeeded",
          error_code: CAPTURED_AFTER_CLOSE,
          marker: { late_payment_captured: { payment_id: payment.id } },
        })
      }
    },
    paid_twice: async () => {
      if (facts.twice_alerted) {
        return
      }

      alert("charge_paid_twice", `Payment '${payment.id}' paid order '${orderId}' a second time`)
      await update({
        ...(facts.attempt === "processing" && !actions.includes("settle") && {
          status: "succeeded",
          error_code: CAPTURED_AFTER_CLOSE,
        }),
        marker: { paid_twice_alerted: { payment_id: payment.id } },
      })
    },
    mark_captured: () => update({ status: "succeeded", error_code: CAPTURED_AFTER_CLOSE }),
    mark_applied: () => update({ status: "succeeded" }),
    overdue_alert: async () => {
      alert("charge_awaiting_payment_overdue", `Attempt '${attempt.id}' still has no payment answer`)
      await update({ marker: { overdue_alerted_at: now.toISOString() } })
    },
    close_attempt_failed: () => update({
      status: "failed",
      error_code: failure?.code ?? "no_payment_signal",
      error_message: failure?.message,
    }),
  }

  for (const action of actions) {
    await handlers[action]()
  }

  return reported
}

/** The dunning recovery workflow takes the case's lock itself, so it runs after the release. */
export async function reconcileCharge(
  container: MedusaContainer,
  input: ReconcileChargeInput
): Promise<ReconcileChargeResult> {
  const { facts, parent_status: parentStatus, lock_key: lockKey } = await loadCharge(container, input, new Date())

  if (
    !decideChargeActions(facts, input.signal).length &&
    facts.attempt !== "processing" &&
    facts.parent !== "in_flight" &&
    facts.order !== "overpaid"
  ) {
    return { actions: [], reported: facts.reported }
  }

  const noWait =
    input.signal === "sweep" ||
    (input.signal === "captured" && RUN_HELD_PARENT_STATUSES.includes(parentStatus))
  const failure = input.signal === "failed" ? input.failure : null
  let locked: ReconcileChargeResult & { charge: Awaited<ReturnType<typeof loadCharge>> }

  try {
    locked = await withLock(
      container,
      lockKey,
      { wait_seconds: noWait ? 0 : SIGNAL_LOCK_WAIT_SECONDS, ttl_seconds: 120 },
      async () => {
        const now = new Date()
        const charge = await loadCharge(container, input, now)
        const actions = decideChargeActions(charge.facts, input.signal)

        return { charge, actions, reported: await applyChargeActions(container, charge, actions, failure, now) }
      }
    )
  } catch (error) {
    if (input.signal === "captured" && noWait && isLockBusy(error)) {
      return { actions: [], reported: false }
    }

    throw error
  }

  const { charge, actions, reported } = locked
  const settle = actions.includes("settle")

  if (charge.parent.kind === "dunning" && (settle || actions.includes("settle_foreign"))) {
    const { result } = await recoverDunningFromCapturedPaymentWorkflow(container).run({
      input: { dunning_case_id: charge.parent.dunning_case.id, payment_id: settle ? charge.payment!.id : null },
    })

    if (settle && result.recovered && charge.facts.attempt === "processing") {
      await container.resolve<DunningModuleService>(DUNNING_MODULE).updateDunningAttempts({
        id: charge.attempt.id,
        status: DunningAttemptStatus.SUCCEEDED,
        finished_at: new Date(),
      })
    }
  }

  return { actions, reported }
}

export function readChargeMarker(context: Record<string, unknown> | null | undefined): ChargeMarker | null {
  const renewal = context?.[ChargeSessionMarker.RENEWAL]
  const dunning = context?.[ChargeSessionMarker.DUNNING]

  return typeof renewal === "string" && renewal
    ? { kind: "renewal", attempt_id: renewal }
    : typeof dunning === "string" && dunning ? { kind: "dunning", attempt_id: dunning } : null
}

export async function findChargeByPaymentReference(
  container: MedusaContainer,
  sessionId: string
): Promise<ChargeMarker | null> {
  const [renewal] = await container
    .resolve<RenewalModuleService>(RENEWAL_MODULE)
    .listRenewalAttempts({ payment_reference: sessionId }, { select: ["id"], take: 1 })

  if (renewal) {
    return { kind: "renewal", attempt_id: renewal.id }
  }

  const [dunning] = await container
    .resolve<DunningModuleService>(DUNNING_MODULE)
    .listDunningAttempts({ payment_reference: sessionId }, { select: ["id"], take: 1 })

  return dunning ? { kind: "dunning", attempt_id: dunning.id } : null
}

export function handleChargeReconcileFailure(
  container: MedusaContainer,
  error: unknown,
  input: ChargeMarker & { signal: ChargeSignal }
) {
  if (MedusaError.isMedusaError(error) && error.type === MedusaError.Types.NOT_FOUND) {
    return false
  }

  const busy = isLockBusy(error)
  const message = getRenewalErrorMessage(error)

  container.resolve("logger")[busy ? "warn" : "error"](
    JSON.stringify({ domain: "subscriptions", event: "charge_reconcile_failed", ...input, alertable: !busy, message })
  )

  return true
}
