import type { IPaymentModuleService, MedusaContainer } from "@medusajs/framework/types"
import { MathBN, MedusaError, Modules } from "@medusajs/framework/utils"
import { DUNNING_MODULE } from "../../modules/dunning"
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
import { renewalSubscriptionLockKey } from "../../modules/renewal/utils/lock-key"
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
import { dunningRetryOutcomeEvents } from "./dunning-retry-events"
import { settleRenewalCycleSucceeded } from "./settle-renewal-cycle-succeeded"
import { isLockBusy, withLock } from "./with-lock"

const SIGNAL_LOCK_WAIT_SECONDS = 45
const LOCK_TTL_SECONDS = 120
const DEFAULT_ALERT_HOURS = 96
const HOUR_MS = 60 * 60 * 1000
const CAPTURED_AFTER_CLOSE = "captured_after_close"

export type ChargeKind = "renewal" | "dunning"
export type ChargeSignal = "captured" | "failed" | "sweep"
export type ChargeAction =
  | "settle" | "settle_foreign" | "fail" | "end_parent"
  | "late_capture" | "mark_captured" | "mark_applied" | "overdue_alert" | "close_attempt_failed"
export type ChargeMarker = { kind: ChargeKind, attempt_id: string }
export type ReportedChargeFailure = { session_id: string | null, code: string, message: string }
export type ReconcileChargeInput = ChargeMarker & (
  | { signal: "captured", payment_id: string }
  | { signal: "failed", failure: ReportedChargeFailure }
  | { signal: "sweep" }
)
export type ReconcileChargeResult = { actions: readonly ChargeAction[], reported: boolean }

type ParentStatuses = { inFlight: readonly string[], awaiting: string, settled: string, runHeld: string }

/** What the statuses of a renewal cycle and of a dunning case say about the charge they carry. */
const PARENT_STATUSES: Record<ChargeKind, ParentStatuses> = {
  renewal: {
    inFlight: CHARGE_IN_FLIGHT_RENEWAL_CYCLE_STATUSES,
    awaiting: RenewalCycleStatus.AWAITING_PAYMENT,
    settled: RenewalCycleStatus.SUCCEEDED,
    runHeld: RenewalCycleStatus.PROCESSING,
  },
  dunning: {
    inFlight: CHARGE_IN_FLIGHT_DUNNING_CASE_STATUSES,
    awaiting: DunningCaseStatus.AWAITING_PAYMENT,
    settled: DunningCaseStatus.RECOVERED,
    runHeld: DunningCaseStatus.RETRYING,
  },
}

export type RawChargeFacts = {
  kind: ChargeKind
  attempt: { id: string, status: string, started_at: Date | string, metadata: Record<string, unknown> | null }
  parent_status: string
  newest_attempt_id: string | null
  subscription_status: SubscriptionStatus
  order_has_dunning_case: boolean
  order_pending: number | null
  captured_payment_id: string | null
  /** An attempt started at or before this has waited too long for its answer. */
  overdue_before: Date
}

export type ChargeFacts = {
  parent: "in_flight" | "settled" | "closed"
  awaiting: boolean
  subscription: "churned" | "terminal" | "active"
  order: "paid" | "unpaid"
  attempt: "processing" | "failed" | "succeeded"
  captured: boolean
  reported: boolean
  overdue: boolean
  alerted: boolean
}

export function toChargeFacts(raw: RawChargeFacts): ChargeFacts {
  const statuses = PARENT_STATUSES[raw.kind]
  const { order_pending: pending, captured_payment_id: paymentId } = raw
  const { status, metadata } = raw.attempt
  const reportedPaymentId = (metadata?.late_payment_captured as { payment_id?: unknown } | undefined)?.payment_id

  return {
    parent: statuses.inFlight.includes(raw.parent_status) && raw.newest_attempt_id === raw.attempt.id
      ? "in_flight"
      : raw.parent_status === statuses.settled ? "settled" : "closed",
    awaiting: raw.parent_status === statuses.awaiting,
    subscription: raw.subscription_status === SubscriptionStatus.PAYMENT_FAILED && raw.order_has_dunning_case
      ? "churned"
      : TERMINAL_SUBSCRIPTION_STATUSES.includes(raw.subscription_status) ? "terminal" : "active",
    order: pending !== null && Number.isFinite(pending) && pending <= 0 ? "paid" : "unpaid",
    attempt: status === RenewalAttemptStatus.PROCESSING
      ? "processing"
      : status === RenewalAttemptStatus.SUCCEEDED ? "succeeded" : "failed",
    captured: paymentId !== null,
    reported: paymentId !== null && reportedPaymentId === paymentId,
    overdue: new Date(raw.attempt.started_at) <= raw.overdue_before,
    alerted: Boolean(metadata?.overdue_alerted_at),
  }
}

const overdueAlert = (f: ChargeFacts): ChargeAction[] => (f.overdue && !f.alerted ? ["overdue_alert"] : [])

/** The charge's own payment was captured: its event arrived, or the sweep found it. */
function decideCapture(f: ChargeFacts): ChargeAction[] {
  const inFlight = f.parent === "in_flight"

  if (f.reported) {
    return inFlight && f.subscription !== "active" ? ["end_parent"] : []
  }

  if (inFlight && f.subscription === "terminal") {
    return ["late_capture", "end_parent"]
  }

  if (f.parent === "closed" && f.subscription === "terminal" && f.attempt !== "succeeded") {
    return ["late_capture"]
  }

  if (f.subscription === "churned" && f.attempt !== "succeeded") {
    return ["mark_captured"]
  }

  if (inFlight) {
    return f.order === "paid" ? ["settle"] : overdueAlert(f)
  }

  if (f.attempt !== "processing") {
    return []
  }

  // The parent this capture settled, or a closed one whose dunning recovery applies the money: either
  // way the attempt is done, and left open the sweep would reload it for ever.
  return f.parent === "settled" ? ["mark_applied"] : ["mark_captured"]
}

function decideFailure(f: ChargeFacts): ChargeAction[] {
  if (f.attempt === "succeeded") {
    return []
  }

  if (f.parent !== "in_flight") {
    return f.attempt === "processing" ? ["close_attempt_failed"] : []
  }

  if (f.subscription !== "active") {
    return ["close_attempt_failed", "end_parent"]
  }

  // The order was paid another way, which the sweep settles.
  if (f.order === "paid") {
    return []
  }

  return f.awaiting || f.attempt === "processing" ? ["fail"] : []
}

/** The sweep found no capture of the charge's own. */
function decideSweep(f: ChargeFacts): ChargeAction[] {
  if (f.parent !== "in_flight") {
    return f.attempt === "processing" && f.overdue ? ["close_attempt_failed"] : []
  }

  if (f.subscription !== "active") {
    return ["end_parent"]
  }

  if (f.order === "paid") {
    return ["settle_foreign"]
  }

  // A failure recorded on the attempt whose parent never got to fail.
  if (f.awaiting && f.attempt === "failed") {
    return ["fail"]
  }

  return overdueAlert(f)
}

export function decideChargeActions(facts: ChargeFacts, signal: ChargeSignal): readonly ChargeAction[] {
  const on = signal === "sweep" && facts.captured ? "captured" : signal

  return on === "captured" ? decideCapture(facts) : on === "failed" ? decideFailure(facts) : decideSweep(facts)
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

type ChargeParent = Awaited<ReturnType<typeof loadChargeParent>>["parent"]

const lockKeyOf = (parent: ChargeParent) =>
  parent.kind === "renewal"
    ? renewalSubscriptionLockKey(parent.cycle.subscription_id)
    : `dunning:${parent.dunning_case.id}`

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
  const orderPending = orderId ? (await loadOrderAmounts(container, orderId)).pending : null

  const facts = toChargeFacts({
    kind: input.kind,
    attempt,
    parent_status: owner.status,
    newest_attempt_id: newest?.id ?? null,
    subscription_status: subscription.status,
    order_has_dunning_case: input.kind === "dunning" || churnCases.length > 0,
    order_pending: orderPending,
    captured_payment_id: payment?.id ?? null,
    overdue_before: new Date(now.getTime() - (alertHours > 0 ? alertHours : DEFAULT_ALERT_HOURS) * HOUR_MS),
  })

  return { attempt, parent, subscription, order_id: orderId, order_pending: orderPending, payment, facts }
}

type Charge = Awaited<ReturnType<typeof loadCharge>>
type RenewalCycle = Extract<ChargeParent, { kind: "renewal" }>["cycle"]

type AttemptUpdate = { status?: "succeeded" | "failed", error_code?: string, error_message?: string, marker?: object }

/** What settling, failing and ending a charge do on the kind of parent that carries it. */
type ChargeOps = {
  updateAttempt(update: AttemptUpdate): Promise<unknown>
  /** A dunning case settles through its recovery workflow once the lock is released. */
  settle(own: boolean): Promise<unknown>
  fail(failure: ReportedChargeFailure): Promise<unknown>
  end(): Promise<unknown>
  lateCaptureRefs: Pick<LatePaymentCapturedEventData, "renewal_cycle_id" | "dunning_case_id" | "dunning_attempt_id">
}

const attemptFields = (charge: Charge, now: Date, { status, error_code, error_message, marker }: AttemptUpdate) => ({
  id: charge.attempt.id,
  ...(status && { finished_at: now, error_code: error_code ?? null, error_message: error_message ?? null }),
  ...(marker && { metadata: { ...charge.attempt.metadata, ...marker } }),
})

function renewalOps(container: MedusaContainer, charge: Charge, cycle: RenewalCycle, now: Date): ChargeOps {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const { attempt, order_id: orderId, subscription } = charge
  const chargeContext = attempt.metadata?.charge_context as RenewalChargeContext | undefined
  const updateAttempt = (update: AttemptUpdate) => renewalModule.updateRenewalAttempts({
    ...attemptFields(charge, now, update),
    ...(update.status && {
      status: update.status === "succeeded" ? RenewalAttemptStatus.SUCCEEDED : RenewalAttemptStatus.FAILED,
    }),
  })

  return {
    updateAttempt,
    settle: async (own) => {
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

      if (reason !== "cycle_superseded") {
        return await ensureNextRenewalCycleWorkflow(container).run({ input: { subscription_id: cycle.subscription_id } })
      }

      // Billing already moved past this cycle: its payment closes it without moving the dates, and
      // the cycle that is actually due is left alone.
      await renewalModule.updateRenewalCycles({
        id: cycle.id,
        status: RenewalCycleStatus.SUCCEEDED,
        processed_at: now,
        generated_order_id: orderId,
        last_error: null,
      })

      if (own) {
        await updateAttempt({ status: "succeeded" })
      }
    },
    fail: async (failure) => {
      if (!chargeContext) {
        await updateAttempt({ status: "failed", error_code: failure.code, error_message: failure.message })

        return await renewalModule.updateRenewalCycles({
          id: cycle.id,
          status: RenewalCycleStatus.FAILED,
          processed_at: now,
          last_error: failure.message,
        })
      }

      const error = Object.assign(new Error(failure.message), { code: failure.code })

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
    },
    end: () => renewalModule.updateRenewalCycles({
      id: cycle.id,
      status: RenewalCycleStatus.FAILED,
      processed_at: now,
      last_error: `Subscription '${subscription.id}' is ${subscription.status}, so its pending renewal charge was ended`,
    }),
    lateCaptureRefs: { renewal_cycle_id: cycle.id },
  }
}

function dunningOps(container: MedusaContainer, charge: Charge, dunningCase: DunningCaseRecord, now: Date): ChargeOps {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const { attempt } = charge

  return {
    updateAttempt: (update) => dunningModule.updateDunningAttempts({
      ...attemptFields(charge, now, update),
      ...(update.status && {
        status: update.status === "succeeded" ? DunningAttemptStatus.SUCCEEDED : DunningAttemptStatus.FAILED,
      }),
    }),
    settle: async () => undefined,
    fail: async (failure) => {
      const { output } = await runDunningRetry(container, {
        dunning_case_id: dunningCase.id,
        reported_failure: { dunning_attempt_id: attempt.id, ...failure },
      })

      for (const event of dunningRetryOutcomeEvents(output)) {
        await emitDunningEvent(container, event)
      }
    },
    end: () => settleNonRetryableCase(dunningModule, dunningCase, charge.subscription.status, now),
    lateCaptureRefs: {
      renewal_cycle_id: dunningCase.renewal_cycle_id,
      dunning_case_id: dunningCase.id,
      dunning_attempt_id: attempt.id,
    },
  }
}

function toLatePaymentCapturedEvent(
  { payment, subscription, order_id: orderId }: Charge,
  refs: ChargeOps["lateCaptureRefs"]
): LatePaymentCapturedEventData {
  if (!payment) {
    throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, "A late capture has no captured payment to report")
  }

  return {
    subscription_id: subscription.id,
    payment_id: payment.id,
    order_id: orderId,
    payment_collection_id: payment.payment_collection_id,
    ...refs,
    reason: LatePaymentCapturedReason.SUBSCRIPTION_TERMINAL,
    refund_amount: MathBN.sum(0, ...(payment.captures ?? []).map(({ amount }) => amount)).toNumber(),
    currency_code: payment.currency_code,
  }
}

/** Reports a capture the plugin will not apply, so the host refunds it. True once it went out. */
async function emitLateCapture(container: MedusaContainer, charge: Charge, ops: ChargeOps) {
  const data = toLatePaymentCapturedEvent(charge, ops.lateCaptureRefs)
  const { output } = await emitDunningEvent(container, { eventName: SubscriptionEvents.LATE_PAYMENT_CAPTURED, data })

  if (!output.emitted) {
    return false
  }

  await ops.updateAttempt({
    status: "succeeded",
    error_code: CAPTURED_AFTER_CLOSE,
    marker: { late_payment_captured: { payment_id: data.payment_id } },
  })

  return true
}

function alert(container: MedusaContainer, charge: Charge, event: string, message: string) {
  container.resolve("logger").error(JSON.stringify({
    domain: "subscriptions",
    event,
    attempt_id: charge.attempt.id,
    subscription_id: charge.subscription.id,
    order_id: charge.order_id,
    alertable: true,
    message,
  }))
}

/** Applies the decided actions in order and says whether the charge's capture has been reported. */
async function applyChargeActions(
  container: MedusaContainer,
  charge: Charge,
  actions: readonly ChargeAction[],
  failure: ReportedChargeFailure | null,
  now: Date
) {
  const { attempt, parent } = charge
  const ops = parent.kind === "renewal"
    ? renewalOps(container, charge, parent.cycle, now)
    : dunningOps(container, charge, parent.dunning_case, now)
  const settle = (own: boolean) => {
    // Both apps refuse to take a paid order's money again, so an overpaid one needs a look.
    if (charge.order_pending !== null && charge.order_pending < 0) {
      alert(container, charge, "charge_paid_twice", `Order '${charge.order_id}' is overpaid after its charge settled`)
    }

    return ops.settle(own)
  }

  const handlers: Record<ChargeAction, () => Promise<unknown>> = {
    settle: () => settle(true),
    settle_foreign: () => settle(false),
    fail: () => ops.fail(failure ?? {
      session_id: attempt.payment_reference,
      code: attempt.error_code ?? "payment_failed",
      message: attempt.error_message ?? "Payment failed",
    }),
    end_parent: () => ops.end(),
    late_capture: () => emitLateCapture(container, charge, ops),
    mark_captured: () => ops.updateAttempt({ status: "succeeded", error_code: CAPTURED_AFTER_CLOSE }),
    mark_applied: () => ops.updateAttempt({ status: "succeeded" }),
    overdue_alert: async () => {
      alert(container, charge, "charge_awaiting_payment_overdue", `Attempt '${attempt.id}' still has no payment answer`)
      await ops.updateAttempt({ marker: { overdue_alerted_at: now.toISOString() } })
    },
    close_attempt_failed: () => ops.updateAttempt({
      status: "failed",
      error_code: failure?.code ?? "no_payment_signal",
      error_message: failure?.message,
    }),
  }
  const results = new Map<ChargeAction, unknown>()

  for (const action of actions) {
    results.set(action, await handlers[action]())
  }

  return charge.facts.reported || results.get("late_capture") === true
}

/** The dunning recovery workflow takes the case's lock itself, so it runs after the release. */
export async function reconcileCharge(
  container: MedusaContainer,
  input: ReconcileChargeInput
): Promise<ReconcileChargeResult> {
  // Only what picks the lock and its wait; everything the decision reads is loaded under the lock.
  const { attempt, newest, parent, owner } = await loadChargeParent(container, input)
  const inFlight = PARENT_STATUSES[input.kind].inFlight.includes(owner.status) && newest?.id === attempt.id

  // A finished attempt whose parent is no longer in flight has nothing left to apply on any signal,
  // so a capture event landing after its run settled doesn't wait for that run's lock.
  if (attempt.status === RenewalAttemptStatus.SUCCEEDED && !inFlight) {
    const reportedPaymentId = (attempt.metadata?.late_payment_captured as { payment_id?: unknown } | undefined)?.payment_id

    return { actions: [], reported: input.signal === "captured" && reportedPaymentId === input.payment_id }
  }

  // A run holding the lock settles a capture it got straight back, and one it parked is the sweep's.
  const noWait =
    input.signal === "sweep" ||
    (input.signal === "captured" && owner.status === PARENT_STATUSES[input.kind].runHeld)
  const failure = input.signal === "failed" ? input.failure : null
  let locked: ReconcileChargeResult & { charge: Charge }

  try {
    locked = await withLock(
      container,
      lockKeyOf(parent),
      { wait_seconds: noWait ? 0 : SIGNAL_LOCK_WAIT_SECONDS, ttl_seconds: LOCK_TTL_SECONDS },
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
      input: {
        dunning_case_id: charge.parent.dunning_case.id,
        payment_id: settle ? charge.payment?.id ?? null : null,
        source: settle ? "dunning_retry" : "customer_payment",
      },
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
