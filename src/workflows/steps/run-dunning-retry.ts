import { MedusaContainer } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
} from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { BigNumberInput } from "@medusajs/types"
import {
  createOrUpdateOrderPaymentCollectionWorkflow,
  createPaymentSessionsWorkflow,
} from "@medusajs/medusa/core-flows"
import { DUNNING_MODULE } from "../../modules/dunning"
import type DunningModuleService from "../../modules/dunning/service"
import {
  DunningAttemptStatus,
  DunningCaseStatus,
  type DunningRetrySchedule,
} from "../../modules/dunning/types"
import { dunningErrors } from "../../modules/dunning/utils/errors"
import {
  classifyDunningFailure,
  createDunningCorrelationId,
  getDunningErrorMessage,
  isAlertableDunningFailure,
  logDunningEvent,
} from "../../modules/dunning/utils/observability"
import { calculateNextRetryAt } from "../../modules/dunning/utils/retry-schedule"
import {
  RetryBlockedReason,
  type RetryEligibility,
  resolveRetryEligibility,
  toRetryBlockedError,
} from "../../modules/dunning/utils/retry-eligibility"
import { ensureNextRenewalCycleWorkflow } from "../ensure-next-renewal-cycle"
import {
  hasCustomerPaymentInProgress,
  loadOrderPaymentCollections,
  type PaymentSessionRecord,
} from "../utils/customer-payment-in-progress"
import { recordOrderCaptureTransactions } from "../utils/record-order-capture-transactions"
import { settleDunningCaseRecovered } from "../utils/settle-dunning-recovery"
import {
  type RenewalSettlementSource,
  settleRenewalCycleSucceeded,
} from "../utils/settle-renewal-cycle-succeeded"
import { settleSubscriptionPaymentFailure } from "../utils/settle-subscription-payment-failure"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import type SubscriptionModuleService from "../../modules/subscription/service"
import { type SubscriptionPaymentContext, SubscriptionStatus } from "../../modules/subscription/types"
import { subscriptionErrors } from "../../modules/subscription/utils/errors"
import { refreshSubscriptionPaymentContext } from "../../modules/subscription/utils/resolve-captured-payment-method"

type SubscriptionRecord = {
  id: string
  status: SubscriptionStatus
  customer_id: string
  payment_context: SubscriptionPaymentContext | null
}

type DunningCaseRecord = {
  id: string
  subscription_id: string
  renewal_cycle_id: string
  renewal_order_id: string | null
  status: DunningCaseStatus
  attempt_count: number
  max_attempts: number
  retry_schedule: DunningRetrySchedule | null
  next_retry_at: Date | null
  last_payment_error_code: string | null
  last_payment_error_message: string | null
  last_attempt_at: Date | null
  recovered_at: Date | null
  closed_at: Date | null
  recovery_reason: string | null
  metadata: Record<string, unknown> | null
  created_at?: Date | string
}

type DunningAttemptRecord = {
  id: string
  dunning_case_id: string
  attempt_no: number
  started_at: Date
  finished_at: Date | null
  status: DunningAttemptStatus
  error_code: string | null
  error_message: string | null
  payment_reference: string | null
  metadata: Record<string, unknown> | null
}

type RetryTransitionSnapshot = {
  status: DunningCaseStatus
  attempt_count: number
  next_retry_at: Date | null
  last_attempt_at: Date | null
  metadata: Record<string, unknown> | null
}

type OrderRecord = {
  id: string
  total?: number | string | null
  summary?: {
    pending_difference?: number | string | null
  } | null
}

type PaymentRecord = {
  id: string
  amount: BigNumberInput
}

type PaymentRetryFailureOutcome = {
  kind:
    | "setup_failure"
    | "session_conflict"
    | "requires_action"
    | "temporary_failure"
    | "permanent_failure"
    | "indeterminate"
  payment_reference: string | null
  error_code: string
  error_message: string
  /** Whether the charge may already have been taken. Nothing may be recharged once it is true. */
  provider_reached: boolean
}

type PaymentRetryOutcome =
  | {
    kind: "recovery"
    payment_reference: string | null
    error_code: null
    error_message: null
    provider_reached: boolean
  }
  | PaymentRetryFailureOutcome

type DunningParkReason =
  | "requires_action"
  | "setup_failure"
  | "customer_payment_stalled"
  | "unreached_provider"
  | "indeterminate_provider_response"

/** How long a failure that never reached the provider waits before the scheduler tries again. */
const SETUP_FAILURE_RETRY_MINUTES = 60

/** How many setup failures in a row hand the case to an operator instead of rescheduling it. */
const SETUP_FAILURE_STREAK_LIMIT = 3

/**
 * How many ticks in a row may step aside for the customer before an operator is asked to look.
 * Parking costs the customer nothing: their own payment still recovers a parked case through the
 * capture subscriber.
 */
const SESSION_CONFLICT_LIMIT = 24

/**
 * The provider codes that name a dead card. Every other decline may still be taken later: Stripe
 * reports soft declines as `card_declined` and keeps the reason in a `decline_code` the provider
 * drops, so nothing but one of these codes may settle a case.
 */
const PERMANENT_DECLINE_CODES: readonly string[] = [
  "expired_card",
  "incorrect_number",
  "invalid_number",
  "lost_card",
  "stolen_card",
  "pickup_card",
  "card_not_supported",
  "invalid_account",
  "new_account_information_available",
]

export type RunDunningRetryStepInput = {
  dunning_case_id: string
  now?: string | Date | null
  ignore_schedule?: boolean
  triggered_by?: string | null
  reason?: string | null
  correlation_id?: string | null
  payment_session_data?: Record<string, unknown>
}

export type RunDunningRetryStepOutput = {
  dunning_case_id: string
  dunning_attempt_id: string
  outcome:
    | "recovered"
    | "retry_scheduled"
    | "unrecovered"
    | "awaiting_manual_resolution"
  subscription_id: string
  subscription_status: SubscriptionStatus
  renewal_order_id: string | null
  /** True only when this run moved the subscription to `payment_failed`. */
  settled_now: boolean
  /** True only when this run closed the case. A run that found it closed must not notify again. */
  recovered_now: boolean
  /**
   * Whether this run spent one of the case's attempts. A reschedule that charged nothing hands its
   * slot back, and nothing downstream may tell the customer their payment was tried and failed.
   */
  attempt_counted: boolean
  correlation_id: string
  attempt_no: number
  error_code: string | null
  next_retry_at: string | null
  recovery_reason: string | null
  park_reason: string | null
  time_to_recover_ms?: number | null
}

function appendRetryAuditMetadata(
  metadata: Record<string, unknown> | null,
  input: RunDunningRetryStepInput,
  at: string
) {
  const nextMetadata: Record<string, unknown> = {
    ...(metadata ?? {}),
    last_retry_triggered_by: input.triggered_by ?? null,
    last_retry_reason: input.reason ?? null,
  }

  if (!input.ignore_schedule) {
    return nextMetadata
  }

  const existing = Array.isArray(metadata?.manual_actions)
    ? [...(metadata?.manual_actions as Record<string, unknown>[])]
    : []

  existing.push({
    action: "retry_now",
    who: input.triggered_by ?? null,
    when: at,
    reason: input.reason ?? null,
  })

  return {
    ...nextMetadata,
    manual_actions: existing,
    last_manual_action: existing[existing.length - 1],
  }
}

function normalizeNow(now?: string | Date | null) {
  if (!now) {
    return new Date()
  }

  const normalized = now instanceof Date ? now : new Date(now)

  if (Number.isNaN(normalized.getTime())) {
    throw dunningErrors.invalidData("Dunning retry 'now' must be a valid date")
  }

  return normalized
}

async function loadDunningCase(
  container: MedusaContainer,
  id: string
): Promise<DunningCaseRecord> {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)

  try {
    return (await dunningModule.retrieveDunningCase(id)) as DunningCaseRecord
  } catch {
    throw dunningErrors.notFound("DunningCase", id)
  }
}

async function loadSubscription(
  container: MedusaContainer,
  id: string
): Promise<SubscriptionRecord> {
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

  try {
    return (await subscriptionModule.retrieveSubscription(id)) as SubscriptionRecord
  } catch {
    throw subscriptionErrors.notFound("Subscription", id)
  }
}

async function getNextAttemptNo(
  container: MedusaContainer,
  dunningCase: DunningCaseRecord
) {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const attempts = (await dunningModule.listDunningAttempts({
    dunning_case_id: dunningCase.id,
  } as any)) as DunningAttemptRecord[]

  const highestAttemptNo = attempts.reduce((max, attempt) => {
    return Math.max(max, attempt.attempt_no ?? 0)
  }, 0)

  return Math.max(dunningCase.attempt_count, highestAttemptNo) + 1
}

async function getLatestAttemptId(
  container: MedusaContainer,
  dunningCaseId: string
) {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const attempts = (await dunningModule.listDunningAttempts({
    dunning_case_id: dunningCaseId,
  } as any)) as DunningAttemptRecord[]

  const latest = attempts.reduce<DunningAttemptRecord | null>(
    (highest, attempt) =>
      !highest || (attempt.attempt_no ?? 0) >= (highest.attempt_no ?? 0)
        ? attempt
        : highest,
    null
  )

  return latest?.id ?? ""
}

/**
 * Whether any attempt on this case ever reached the provider. A decline the provider throws never
 * leaves a session behind, so the attempt row records that it got there; without either marker
 * nothing was ever declined and settling the case would churn over a fault on our side.
 */
async function hasReachedProvider(
  container: MedusaContainer,
  dunningCaseId: string
) {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const attempts = (await dunningModule.listDunningAttempts({
    dunning_case_id: dunningCaseId,
  } as any)) as DunningAttemptRecord[]

  return attempts.some(
    (attempt) =>
      Boolean(attempt.payment_reference) ||
      attempt.metadata?.provider_reached === true
  )
}

/**
 * `instanceof` is unreliable across module copies: the payment provider may carry its own
 * `@medusajs/utils`, and a missed decline would be parked as our own setup failure.
 */
function isMedusaErrorOfType(error: unknown, type: string) {
  return (
    Boolean(error) && MedusaError.isMedusaError(error) && error.type === type
  )
}

/** A decline the provider raised rather than returned: no session survives it. */
function isProviderDecline(error: unknown) {
  return isMedusaErrorOfType(
    error,
    MedusaError.Types.PAYMENT_AUTHORIZATION_ERROR
  )
}

/**
 * The order's total and the amount still owed on it.
 *
 * A dunning retry runs against an order an earlier attempt may already have
 * (partly) paid, so `pending_difference` - not the gross total - is what may be
 * collected. Passing the total for an already-paid order both double-charges
 * and makes `createOrUpdateOrderPaymentCollectionWorkflow` throw
 * "Amount cannot be greater than ...".
 */
export async function loadOrderAmounts(
  container: MedusaContainer,
  id: string
): Promise<{ total: number, pending: number }> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: ["id", "total", "summary.*"],
    filters: {
      id: [id],
    },
  })

  const order = (data as OrderRecord[])[0]

  if (!order) {
    throw dunningErrors.notFound("Order", id)
  }

  const total = Number(order.total ?? 0)
  const pendingDifference = order.summary?.pending_difference

  return {
    total,
    pending: pendingDifference == null ? total : Number(pendingDifference),
  }
}

async function settleNonRetryableCase(
  dunningModule: DunningModuleService,
  dunningCase: DunningCaseRecord,
  subscriptionStatus: SubscriptionStatus,
  now: Date
) {
  if (subscriptionStatus === SubscriptionStatus.CANCELLED) {
    await dunningModule.updateDunningCases({
      id: dunningCase.id,
      status: DunningCaseStatus.UNRECOVERED,
      next_retry_at: null,
      closed_at: now,
      recovery_reason: "subscription_not_retryable",
    } as any)

    return
  }

  await dunningModule.updateDunningCases({
    id: dunningCase.id,
    status: DunningCaseStatus.AWAITING_MANUAL_RESOLUTION,
    next_retry_at: null,
    metadata: {
      ...(dunningCase.metadata ?? {}),
      park_reason: null,
    },
  } as any)
}

function validateRetryableCase(
  dunningCase: DunningCaseRecord,
  subscription: SubscriptionRecord,
  now: Date,
  ignoreSchedule?: boolean
): RetryEligibility {
  const parkReason = dunningCase.metadata?.park_reason
  const isParked =
    dunningCase.status === DunningCaseStatus.AWAITING_MANUAL_RESOLUTION

  // The provider may already have taken this charge, and a new session would delete the one holding
  // it and charge again. Only an operator who reconciled it may reopen the case.
  if (isParked && parkReason === "indeterminate_provider_response") {
    throw dunningErrors.conflict(
      `DunningCase '${dunningCase.id}' has an unreconciled provider charge: reconcile it manually before retrying`
    )
  }

  // An admin retry-now on a parked case: the park, not the budget, is why the case is still open,
  // so its last spent slot must not dead-end it. Relaxing the ceiling rather than tolerating the
  // blocked reason keeps the checks that come after it (renewal order, retry schedule) running.
  const tolerateSpentBudget =
    Boolean(ignoreSchedule) && isParked && Boolean(parkReason)

  const relaxedCase = {
    ...dunningCase,
    max_attempts: tolerateSpentBudget
      ? Math.max(dunningCase.max_attempts, dunningCase.attempt_count + 1)
      : dunningCase.max_attempts,
  }

  const eligibility = resolveRetryEligibility({
    dunningCase: relaxedCase,
    subscriptionStatus: subscription.status,
    paymentContext: subscription.payment_context,
    now: ignoreSchedule ? undefined : now,
  })

  if (
    eligibility.eligible ||
    eligibility.blocked_reason === RetryBlockedReason.SUBSCRIPTION_NOT_RETRYABLE ||
    eligibility.blocked_reason === RetryBlockedReason.NO_PAYMENT_METHOD
  ) {
    return eligibility
  }

  throw toRetryBlockedError(eligibility.blocked_reason!, dunningCase)
}

function classifyPaymentRetryFailure(
  error: unknown,
  paymentSessionStatus?: string | null
): PaymentRetryFailureOutcome {
  const message =
    error instanceof Error ? error.message : "Dunning payment retry failed"
  const normalizedStatus = String(paymentSessionStatus ?? "").toLowerCase()
  const normalizedErrorCode = readPaymentErrorCode(error)
  const failure = {
    payment_reference: null,
    error_code:
      normalizedErrorCode || normalizedStatus || "payment_retry_failed",
    error_message: message,
    provider_reached: true,
  } as const

  // A routine 3DS/SCA challenge, not a dead card: the cardholder has to authenticate.
  if (
    normalizedStatus === "requires_more" ||
    normalizedErrorCode === "authentication_required"
  ) {
    return { kind: "requires_action", ...failure }
  }

  // The provider raises this for its own transport and API faults, which say nothing about the
  // card whatever code they carry.
  if (isMedusaErrorOfType(error, MedusaError.Types.UNEXPECTED_STATE)) {
    return { kind: "temporary_failure", ...failure }
  }

  // Only a code naming a dead card - or a session the provider cancelled itself - settles the case.
  // Wording never does: "Your card was declined" is what Stripe writes for declines a later attempt
  // would have been taken.
  if (
    PERMANENT_DECLINE_CODES.includes(normalizedErrorCode ?? "") ||
    normalizedStatus === "canceled" ||
    normalizedStatus === "cancelled"
  ) {
    return { kind: "permanent_failure", ...failure }
  }

  return { kind: "temporary_failure", ...failure }
}

function readRetryCounter(
  metadata: Record<string, unknown> | null | undefined,
  key: string
) {
  const count = Number(metadata?.[key] ?? 0)

  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
}

/** The counters that only track retries that never charged anything. */
function clearUnchargedRetryCounters(metadata: Record<string, unknown>) {
  const next = { ...metadata }
  delete next.setup_failure_streak
  delete next.session_conflict_count

  return next
}

function readPaymentErrorCode(error: unknown) {
  if (!error || typeof error !== "object") {
    return null
  }

  const record = error as Record<string, unknown>
  const candidates = [
    record.code,
    record.decline_code,
    (record.cause as Record<string, unknown> | undefined)?.code,
    (record.cause as Record<string, unknown> | undefined)?.decline_code,
    (record.payment_intent as Record<string, unknown> | undefined)?.last_payment_error,
    (record.raw as Record<string, unknown> | undefined)?.code,
    (record.raw as Record<string, unknown> | undefined)?.decline_code,
  ]

  for (const candidate of candidates) {
    const value = readNestedErrorCode(candidate)

    if (value) {
      return value
    }
  }

  return null
}

function readNestedErrorCode(value: unknown): string | null {
  if (!value) {
    return null
  }

  if (typeof value === "string" && value.trim()) {
    return value.trim().toLowerCase()
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    const candidates = [record.code, record.decline_code]

    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim().toLowerCase()
      }
    }
  }

  return null
}

/**
 * Records the session on the attempt row the moment it exists. The provider confirms the charge
 * while it creates the session, so a crash from here on must still leave the reference behind.
 * Never fatal: throwing here would skip the capture bookkeeping on money already taken.
 */
async function stampAttemptPaymentReference(
  container: MedusaContainer,
  attemptId: string | null | undefined,
  paymentReference: string
) {
  if (!attemptId) {
    return
  }

  try {
    const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)

    await dunningModule.updateDunningAttempts({
      id: attemptId,
      payment_reference: paymentReference,
    } as any)
  } catch (error) {
    container.resolve("logger").warn(
      `Failed to record payment session '${paymentReference}' on dunning attempt '${attemptId}': ${getDunningErrorMessage(error)}`
    )
  }
}

/** Exported for unit tests: covers the already-settled double-charge guard. */
function isIndeterminateSessionData(data: Record<string, unknown> | null | undefined) {
  if (!data || Object.keys(data).length === 0) {
    return true
  }

  return "indeterminate_due_to" in data
}

export async function executePaymentRetry(
  container: MedusaContainer,
  subscription: SubscriptionRecord,
  renewalOrderId: string,
  paymentSessionData?: Record<string, unknown>,
  attemptId?: string | null,
  dunningCaseId?: string | null
): Promise<PaymentRetryOutcome> {
  let paymentSession: PaymentSessionRecord | null = null

  try {
    const paymentContext = subscription.payment_context

    if (
      !paymentContext?.payment_provider_id ||
      !paymentContext.payment_method_id
    ) {
      throw dunningErrors.invalidData(
        `Subscription '${subscription.id}' is missing payment retry context`
      )
    }

    const { total, pending } = await loadOrderAmounts(container, renewalOrderId)

    if (total <= 0) {
      throw dunningErrors.invalidData(
        `Renewal order '${renewalOrderId}' doesn't have a collectible total`
      )
    }

    // An earlier attempt may have captured before aborting, leaving nothing
    // outstanding. Charging the total again would take the money twice, so treat
    // the already-settled order as the recovery it is instead.
    if (pending <= 0) {
      return {
        kind: "recovery",
        payment_reference: null,
        error_code: null,
        error_message: null,
        provider_reached: true,
      }
    }

    // The host app lets the customer pay the same renewal order through its own checkout, on a
    // collection of this order and under a different lock. Creating a retry session deletes every
    // session on the collection it picks, so a tick that lands mid-checkout would expire the page
    // the customer is looking at.
    if (
      hasCustomerPaymentInProgress(
        await loadOrderPaymentCollections(container, renewalOrderId),
        new Date()
      )
    ) {
      return {
        kind: "session_conflict",
        payment_reference: null,
        error_code: "customer_payment_in_progress",
        error_message: `Renewal order '${renewalOrderId}' has a payment the customer is in the middle of`,
        provider_reached: false,
      }
    }

    const paymentCollections =
      await createOrUpdateOrderPaymentCollectionWorkflow(container).run({
        input: {
          order_id: renewalOrderId,
          amount: pending,
        },
      })

    const paymentCollection = paymentCollections.result[0]

    if (!paymentCollection) {
      throw dunningErrors.invalidData(
        `No payment collection is available for renewal order '${renewalOrderId}'`
      )
    }

    const paymentSessionResult = await createPaymentSessionsWorkflow(container).run({
      input: {
        payment_collection_id: paymentCollection.id,
        provider_id: paymentContext.payment_provider_id,
        customer_id: subscription.customer_id,
        data: paymentSessionData ?? {
          payment_method: paymentContext.payment_method_id,
          off_session: true,
          confirm: true,
          capture_method: "automatic",
        },
        // What tells the next tick - and the host app - that this session is ours, so that skipping
        // a customer's session never skips our own leftover one.
        context: {
          dunning_case_id: dunningCaseId ?? null,
          dunning_attempt_id: attemptId ?? null,
        },
      },
    })

    paymentSession = paymentSessionResult.result as PaymentSessionRecord

    await stampAttemptPaymentReference(container, attemptId, paymentSession.id)

    // A provider that swallows its API error hands back a session with empty data (the stock Stripe
    // provider marks it `indeterminate_due_to`), so we can't tell whether the money moved. Another
    // retry would delete this session and charge a second time.
    if (isIndeterminateSessionData(paymentSession.data)) {
      return {
        kind: "indeterminate",
        payment_reference: paymentSession.id,
        error_code: "provider_response_indeterminate",
        error_message:
          "Payment provider returned a session without a provider reference",
        provider_reached: true,
      }
    }

    const paymentModule =
      container.resolve(Modules.PAYMENT)
    const payment = (await paymentModule.authorizePaymentSession(
      paymentSession.id,
      paymentSession.context ?? {}
    )) as PaymentRecord | null

    if (!payment?.id) {
      return {
        kind: "temporary_failure",
        payment_reference: paymentSession.id,
        error_code: "payment_authorization_missing",
        error_message: "Payment authorization did not return a payment reference",
        provider_reached: true,
      }
    }

    let captureError: unknown = null

    try {
      await paymentModule.capturePayment({
        payment_id: payment.id,
        amount: payment.amount,
      })
    } catch (error) {
      captureError = error
    }

    // Record what the capture settled, so the next retry (and the renewal flow's
    // reused-order guard) sees the order as paid instead of charging it again.
    //
    // Runs even when the capture call above failed: an auto-capturing provider
    // has already taken the money at authorize time, and this retry's failure
    // just schedules another one that would otherwise collect it again. The
    // helper only writes rows for captures that exist, so it no-ops when nothing
    // was actually captured.
    //
    // Not fatal: the money is already captured and the provider webhook writes
    // the same rows later.
    try {
      await recordOrderCaptureTransactions(container, renewalOrderId, payment.id)
    } catch (transactionError) {
      container.resolve("logger").warn(
        `Captured dunning retry payment '${payment.id}' but failed to record its order transaction on '${renewalOrderId}': ${getDunningErrorMessage(transactionError)}`
      )
    }

    if (captureError) {
      throw captureError
    }

    return {
      kind: "recovery",
      payment_reference: payment.id,
      error_code: null,
      error_message: null,
      provider_reached: true,
    }
  } catch (error) {
    // A decline the provider throws leaves no session behind, so only an error raised before the
    // provider was ever asked may hand the attempt budget back.
    if (!paymentSession?.id && !isProviderDecline(error)) {
      return {
        kind: "setup_failure",
        payment_reference: null,
        error_code: readPaymentErrorCode(error) ?? "payment_session_setup_failed",
        error_message:
          error instanceof Error ? error.message : "Dunning payment retry failed",
        provider_reached: false,
      }
    }

    let paymentSessionStatus: string | null = paymentSession?.status ?? null

    if (paymentSession?.id) {
      const paymentModule =
        container.resolve(Modules.PAYMENT)
      const sessions = (await paymentModule.listPaymentSessions({
        id: [paymentSession.id],
      })) as PaymentSessionRecord[]

      paymentSessionStatus = sessions[0]?.status ?? paymentSessionStatus
    }

    const outcome = classifyPaymentRetryFailure(error, paymentSessionStatus)

    return {
      ...outcome,
      payment_reference: paymentSession?.id ?? outcome.payment_reference,
      provider_reached: true,
    }
  }
}

type ParkForManualResolutionInput = {
  dunningCase: DunningCaseRecord
  caseMetadata: Record<string, unknown> | null
  attempt: DunningAttemptRecord
  attemptStatus: DunningAttemptStatus
  attemptNo: number
  attemptCount: number
  /** Whether the parked attempt kept its budget slot. False for an aborted, uncharged attempt. */
  attemptCounted: boolean
  parkReason: DunningParkReason
  outcome: PaymentRetryFailureOutcome
  finishedAt: Date
  correlationId: string
  durationMs: number
  subscriptionStatus: SubscriptionStatus
  /** Tells the step the case is already safe, so its catch returns the park instead of undoing it. */
  markCaseParked: (output: RunDunningRetryStepOutput) => void
}

/**
 * Hands the case to an operator instead of settling it, and returns rather than throws: past the
 * RETRYING transition the step's catch rolls the case back to its pre-retry snapshot, which would
 * undo the park and leave the scheduler free to pick the case up again. The case is written before
 * the attempt row for the same reason - a half-written park leaves the case safe, not retryable.
 */
async function parkForManualResolution(
  container: MedusaContainer,
  input: ParkForManualResolutionInput
): Promise<StepResponse<RunDunningRetryStepOutput>> {
  const logger = container.resolve("logger")
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)

  const updatedCase = await dunningModule.updateDunningCases({
    id: input.dunningCase.id,
    status: DunningCaseStatus.AWAITING_MANUAL_RESOLUTION,
    attempt_count: input.attemptCount,
    next_retry_at: null,
    last_attempt_at: input.finishedAt,
    last_payment_error_code: input.outcome.error_code,
    last_payment_error_message: input.outcome.error_message,
    metadata: {
      ...(input.caseMetadata ?? {}),
      park_reason: input.parkReason,
    },
  } as any)

  const output: RunDunningRetryStepOutput = {
    dunning_case_id: updatedCase.id,
    dunning_attempt_id: input.attempt.id,
    outcome: "awaiting_manual_resolution",
    subscription_id: updatedCase.subscription_id,
    subscription_status: input.subscriptionStatus,
    renewal_order_id: input.dunningCase.renewal_order_id,
    settled_now: false,
    recovered_now: false,
    correlation_id: input.correlationId,
    attempt_no: input.attemptNo,
    error_code: input.outcome.error_code,
    next_retry_at: null,
    recovery_reason: null,
    park_reason: input.parkReason,
    attempt_counted: input.attemptCounted,
  }

  input.markCaseParked(output)

  await dunningModule.updateDunningAttempts({
    id: input.attempt.id,
    finished_at: input.finishedAt,
    status: input.attemptStatus,
    error_code: input.outcome.error_code,
    error_message: input.outcome.error_message,
    payment_reference: input.outcome.payment_reference,
    metadata: {
      ...(input.attempt.metadata ?? {}),
      provider_reached: input.outcome.provider_reached,
    },
  } as any)

  logDunningEvent(logger, "error", {
    event: "dunning.retry",
    outcome: "failed",
    correlation_id: input.correlationId,
    dunning_case_id: updatedCase.id,
    subscription_id: updatedCase.subscription_id,
    renewal_cycle_id: updatedCase.renewal_cycle_id,
    attempt_no: input.attemptNo,
    duration_ms: input.durationMs,
    failure_count: 1,
    avg_attempts: input.attemptNo,
    alertable: true,
    message: input.outcome.error_message,
    metadata: {
      retry_outcome: "awaiting_manual_resolution",
      park_reason: input.parkReason,
      error_code: input.outcome.error_code,
      payment_reference: input.outcome.payment_reference,
    },
  })

  return new StepResponse<RunDunningRetryStepOutput>(output)
}

type RescheduleUnchargedAttemptInput = {
  dunningCase: DunningCaseRecord
  caseMetadata: Record<string, unknown>
  attempt: DunningAttemptRecord
  attemptNo: number
  /** The budget the case keeps: an attempt that charged nothing hands its slot back. */
  attemptCount: number
  outcome: PaymentRetryFailureOutcome
  finishedAt: Date
  correlationId: string
  subscriptionStatus: SubscriptionStatus
}

/**
 * Ends an attempt that never charged anything: its audit row is aborted, the attempt slot goes back
 * to the budget and the scheduler is pointed at a later tick. Shared by the setup failure that
 * never reached the provider and the tick that stepped aside for the customer's own payment.
 */
async function rescheduleUnchargedAttempt(
  container: MedusaContainer,
  input: RescheduleUnchargedAttemptInput
): Promise<{
  output: RunDunningRetryStepOutput
  updatedCase: DunningCaseRecord
  retryAt: Date
}> {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const retryAt = new Date(
    input.finishedAt.getTime() + SETUP_FAILURE_RETRY_MINUTES * 60 * 1000
  )

  await dunningModule.updateDunningAttempts({
    id: input.attempt.id,
    finished_at: input.finishedAt,
    status: DunningAttemptStatus.ABORTED,
    error_code: input.outcome.error_code,
    error_message: input.outcome.error_message,
    payment_reference: null,
    metadata: {
      ...(input.attempt.metadata ?? {}),
      provider_reached: input.outcome.provider_reached,
    },
  } as any)

  const updatedCase = (await dunningModule.updateDunningCases({
    id: input.dunningCase.id,
    status: DunningCaseStatus.RETRY_SCHEDULED,
    attempt_count: input.attemptCount,
    next_retry_at: retryAt,
    last_attempt_at: input.finishedAt,
    last_payment_error_code: input.outcome.error_code,
    last_payment_error_message: input.outcome.error_message,
    recovered_at: null,
    closed_at: null,
    recovery_reason: null,
    metadata: input.caseMetadata,
  } as any)) as DunningCaseRecord

  return {
    updatedCase,
    retryAt,
    output: {
      dunning_case_id: updatedCase.id,
      dunning_attempt_id: input.attempt.id,
      outcome: "retry_scheduled",
      subscription_id: updatedCase.subscription_id,
      subscription_status: input.subscriptionStatus,
      renewal_order_id: input.dunningCase.renewal_order_id,
      settled_now: false,
      recovered_now: false,
      correlation_id: input.correlationId,
      attempt_no: input.attemptNo,
      error_code: input.outcome.error_code,
      next_retry_at: retryAt.toISOString(),
      recovery_reason: null,
      park_reason: null,
      attempt_counted: false,
    },
  }
}

/** Exported for unit tests: `createStep` doesn't expose its handler. */
/**
 * The bookkeeping a recovered charge owes the renewal cycle it paid for.
 *
 * Deliberately non-fatal: the case is closed and the money is in by the time this runs, and a
 * throw would land in the caller's catch, which rolls the case back to where the retry found it.
 */
async function finalizeRecoveredRenewal(
  container: MedusaContainer,
  input: {
    dunningCase: DunningCaseRecord
    subscription: SubscriptionRecord
    finishedAt: Date
    correlationId: string
    refreshPaymentContext: boolean
    /** Who actually paid, for the audit entry the settlement writes. */
    source: RenewalSettlementSource
  }
) {
  const { dunningCase, subscription } = input

  const nonFatal = async (what: string, run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      logDunningEvent(container.resolve("logger"), "error", {
        event: "dunning.retry",
        outcome: "failed",
        correlation_id: input.correlationId,
        dunning_case_id: dunningCase.id,
        subscription_id: subscription.id,
        renewal_cycle_id: dunningCase.renewal_cycle_id,
        alertable: true,
        message: `DunningCase '${dunningCase.id}' was recovered but ${what} failed: ${getDunningErrorMessage(error)}`,
      })
    }
  }

  if (input.refreshPaymentContext) {
    await nonFatal("refreshing its payment context", () =>
      refreshSubscriptionPaymentContext(container, subscription)
    )
  }

  await nonFatal("settling its renewal cycle", async () => {
    const settlement = await settleRenewalCycleSucceeded(container, {
      renewal_cycle_id: dunningCase.renewal_cycle_id,
      subscription_id: subscription.id,
      order_id: dunningCase.renewal_order_id,
      finished_at: input.finishedAt,
      source: input.source,
    })

    // Billing has already moved past the cycle this case was opened for, so the next cycle is
    // somebody else's and already correct: scheduling one here would delete it.
    if (settlement.reason === "cycle_superseded") {
      return
    }

    await ensureNextRenewalCycleWorkflow(container).run({
      input: { subscription_id: subscription.id },
    })
  })
}

export async function runDunningRetry(
  container: MedusaContainer,
  input: RunDunningRetryStepInput
): Promise<StepResponse<RunDunningRetryStepOutput>> {
  const logger = container.resolve("logger")
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const now = normalizeNow(input.now)
  const startedAtMs = Date.now()
  const correlationId =
    input.correlation_id ??
    createDunningCorrelationId(`dunning-retry-${input.ignore_schedule ? "manual" : "scheduled"}`)

  const dunningCase = await loadDunningCase(container, input.dunning_case_id)
  const attemptNo = await getNextAttemptNo(container, dunningCase)
  const transitionSnapshot: RetryTransitionSnapshot = {
    status: dunningCase.status,
    attempt_count: dunningCase.attempt_count,
    next_retry_at: dunningCase.next_retry_at,
    last_attempt_at: dunningCase.last_attempt_at,
    metadata: dunningCase.metadata ?? null,
  }
  // Budget position, not row number: `attempt_no` stays monotonic across aborted rows, so it can
  // neither index the retry schedule nor drive the attempt limit.
  const consumedAttempts = transitionSnapshot.attempt_count + 1
  let transitionedToRetrying = false
  // A holder rather than a plain `let`: the catch has to read what the park wrote from inside it.
  const parked: { output: RunDunningRetryStepOutput | null } = { output: null }
  const markCaseParked = (output: RunDunningRetryStepOutput) => {
    parked.output = output
  }

  logDunningEvent(logger, "info", {
    event: "dunning.retry",
    outcome: "started",
    correlation_id: correlationId,
    dunning_case_id: dunningCase.id,
    subscription_id: dunningCase.subscription_id,
    renewal_cycle_id: dunningCase.renewal_cycle_id,
    attempt_no: attemptNo,
    metadata: {
      triggered_by: input.triggered_by ?? null,
      reason: input.reason ?? null,
      ignore_schedule: Boolean(input.ignore_schedule),
    },
  })

  try {
    const subscription = await loadSubscription(
      container,
      dunningCase.subscription_id
    )

    // A case the customer's own payment already closed, with a run the scheduler was still
    // holding: the order owes nothing, so this is a no-op rather than the `alreadyRecovered`
    // conflict the eligibility guard would raise.
    if (
      dunningCase.status === DunningCaseStatus.RECOVERED &&
      dunningCase.renewal_order_id &&
      (await loadOrderAmounts(container, dunningCase.renewal_order_id)).pending <= 0
    ) {
      return new StepResponse<RunDunningRetryStepOutput>({
        dunning_case_id: dunningCase.id,
        dunning_attempt_id: await getLatestAttemptId(container, dunningCase.id),
        outcome: "recovered",
        subscription_id: dunningCase.subscription_id,
        subscription_status: subscription.status,
        renewal_order_id: dunningCase.renewal_order_id,
        settled_now: false,
        recovered_now: false,
        correlation_id: correlationId,
        attempt_no: dunningCase.attempt_count,
        error_code: null,
        next_retry_at: null,
        recovery_reason: dunningCase.recovery_reason,
        park_reason: null,
        attempt_counted: false,
      })
    }

    const eligibility = validateRetryableCase(
      dunningCase,
      subscription,
      now,
      input.ignore_schedule
    )

    if (
      eligibility.blocked_reason === RetryBlockedReason.SUBSCRIPTION_NOT_RETRYABLE
    ) {
      await settleNonRetryableCase(
        dunningModule,
        dunningCase,
        subscription.status,
        now
      )

      throw dunningErrors.subscriptionNotRetryable(
        dunningCase.id,
        subscription.id,
        subscription.status
      )
    }

    if (eligibility.blocked_reason === RetryBlockedReason.NO_PAYMENT_METHOD) {
      // A card the customer has yet to add is theirs to fix, so the case must not carry a park
      // reason that tells the storefront an operator has to step in first.
      await dunningModule.updateDunningCases({
        id: dunningCase.id,
        status: DunningCaseStatus.AWAITING_MANUAL_RESOLUTION,
        next_retry_at: null,
        metadata: {
          ...(dunningCase.metadata ?? {}),
          park_reason: null,
        },
      } as any)

      throw dunningErrors.noPaymentMethod(dunningCase.id, subscription.id)
    }

    const startedAt = now
    const retryMetadata: Record<string, unknown> = {
      ...appendRetryAuditMetadata(
        dunningCase.metadata,
        input,
        startedAt.toISOString()
      ),
      park_reason: null,
    }

    await dunningModule.updateDunningCases({
      id: dunningCase.id,
      status: DunningCaseStatus.RETRYING,
      attempt_count: consumedAttempts,
      next_retry_at: null,
      last_attempt_at: startedAt,
      metadata: retryMetadata,
    } as any)
    transitionedToRetrying = true

    const attempt = (await dunningModule.createDunningAttempts({
      dunning_case_id: dunningCase.id,
      attempt_no: attemptNo,
      started_at: startedAt,
      finished_at: null,
      status: DunningAttemptStatus.PROCESSING,
      error_code: null,
      error_message: null,
      payment_reference: null,
      metadata: {
        triggered_by: input.triggered_by ?? null,
        reason: input.reason ?? null,
        correlation_id: correlationId,
      },
    } as any)) as DunningAttemptRecord

    const outcome = await executePaymentRetry(
      container,
      subscription,
      dunningCase.renewal_order_id!,
      input.payment_session_data,
      attempt.id,
      dunningCase.id
    )
    const finishedAt = new Date()
    // Any answer from the provider ends whatever setup-failure streak the case was carrying.
    const caseMetadata = outcome.provider_reached
      ? clearUnchargedRetryCounters(retryMetadata)
      : retryMetadata

    if (outcome.kind === "recovery") {
      await dunningModule.updateDunningAttempts({
        id: attempt.id,
        finished_at: finishedAt,
        status: DunningAttemptStatus.SUCCEEDED,
        error_code: null,
        error_message: null,
        payment_reference: outcome.payment_reference,
        metadata: {
          ...(attempt.metadata ?? {}),
          provider_reached: outcome.provider_reached,
        },
      } as any)

      // A recovery with no payment of its own is one the order came back already settled from, so
      // the credit belongs to whoever actually paid it rather than to this retry.
      const recoveryReason =
        outcome.payment_reference === null
          ? "customer_payment"
          : "payment_recovered"

      const { dunning_case: updatedCase } = await settleDunningCaseRecovered(
        container,
        {
          dunning_case: dunningCase,
          subscription,
          finished_at: finishedAt,
          recovery_reason: recoveryReason,
          payment_reference: outcome.payment_reference,
          metadata: caseMetadata,
        }
      )

      await finalizeRecoveredRenewal(container, {
        dunningCase,
        subscription,
        finishedAt,
        correlationId,
        // A recovery without a payment of its own is one someone else already paid, so the card
        // that settled it is not the one the subscription is holding.
        refreshPaymentContext: outcome.payment_reference === null,
        source:
          outcome.payment_reference === null
            ? "customer_payment"
            : "dunning_retry",
      })

      const createdAt = updatedCase.created_at
        ? new Date(updatedCase.created_at)
        : dunningCase.created_at
          ? new Date(dunningCase.created_at)
          : null
      const timeToRecoverMs = createdAt
        ? finishedAt.getTime() - createdAt.getTime()
        : null

      logDunningEvent(logger, "info", {
        event: "dunning.retry",
        outcome: "succeeded",
        correlation_id: correlationId,
        dunning_case_id: updatedCase.id,
        subscription_id: updatedCase.subscription_id,
        renewal_cycle_id: updatedCase.renewal_cycle_id,
        attempt_no: attemptNo,
        duration_ms: Date.now() - startedAtMs,
        success_count: 1,
        recovered_count: 1,
        avg_attempts: attemptNo,
        avg_time_to_recover_ms: timeToRecoverMs ?? undefined,
        metadata: {
          retry_outcome: "recovered",
          payment_reference: outcome.payment_reference,
        },
      })

      return new StepResponse<RunDunningRetryStepOutput>({
        dunning_case_id: updatedCase.id,
        dunning_attempt_id: attempt.id,
        outcome: "recovered",
        subscription_id: updatedCase.subscription_id,
        subscription_status: SubscriptionStatus.ACTIVE,
        renewal_order_id: dunningCase.renewal_order_id,
        settled_now: false,
        recovered_now: true,
        correlation_id: correlationId,
        attempt_no: attemptNo,
        error_code: null,
        next_retry_at: null,
        recovery_reason: recoveryReason,
        park_reason: null,
        attempt_counted: true,
        time_to_recover_ms: timeToRecoverMs,
      })
    }

    // The customer is paying the renewal order themselves right now. Our own session would delete
    // theirs mid-checkout, so this tick steps aside whole: nothing was charged, the attempt slot
    // goes back and the scheduler comes round later. It never parks - the customer finishing that
    // payment is the outcome we want, and no operator can help it along.
    if (outcome.kind === "session_conflict") {
      const sessionConflictCount =
        readRetryCounter(dunningCase.metadata, "session_conflict_count") + 1

      if (sessionConflictCount >= SESSION_CONFLICT_LIMIT) {
        return await parkForManualResolution(container, {
          dunningCase,
          caseMetadata: {
            ...retryMetadata,
            session_conflict_count: sessionConflictCount,
          },
          attempt,
          attemptStatus: DunningAttemptStatus.ABORTED,
          attemptNo,
          attemptCount: transitionSnapshot.attempt_count,
          attemptCounted: false,
          parkReason: "customer_payment_stalled",
          outcome,
          finishedAt,
          correlationId,
          durationMs: Date.now() - startedAtMs,
          subscriptionStatus: subscription.status,
          markCaseParked,
        })
      }

      const { output, updatedCase, retryAt } = await rescheduleUnchargedAttempt(
        container,
        {
          dunningCase,
          caseMetadata: {
            ...retryMetadata,
            session_conflict_count: sessionConflictCount,
          },
          attempt,
          attemptNo,
          attemptCount: transitionSnapshot.attempt_count,
          outcome,
          finishedAt,
          correlationId,
          subscriptionStatus: subscription.status,
        }
      )

      logDunningEvent(logger, "info", {
        event: "dunning.retry",
        outcome: "blocked",
        correlation_id: correlationId,
        dunning_case_id: updatedCase.id,
        subscription_id: updatedCase.subscription_id,
        renewal_cycle_id: updatedCase.renewal_cycle_id,
        attempt_no: attemptNo,
        duration_ms: Date.now() - startedAtMs,
        blocked_count: 1,
        rescheduled_count: 1,
        alertable: false,
        message: outcome.error_message,
        metadata: {
          retry_outcome: "retry_scheduled",
          error_code: outcome.error_code,
          session_conflict_count: sessionConflictCount,
          next_retry_at: retryAt.toISOString(),
        },
      })

      return new StepResponse<RunDunningRetryStepOutput>(output)
    }

    // No payment session was ever created, so nothing was charged. Keep the audit row, give the
    // budget its attempt back and let the scheduler try again once the fault has had time to clear:
    // a provider outage of a few minutes must not park every case that retried during it. Only a
    // fault that keeps coming back is something an operator has to look at.
    if (outcome.kind === "setup_failure") {
      const setupFailureStreak =
        readRetryCounter(dunningCase.metadata, "setup_failure_streak") + 1
      const setupFailureMetadata = {
        ...retryMetadata,
        setup_failure_streak: setupFailureStreak,
      }

      if (setupFailureStreak >= SETUP_FAILURE_STREAK_LIMIT) {
        return await parkForManualResolution(container, {
          dunningCase,
          caseMetadata: setupFailureMetadata,
          attempt,
          attemptStatus: DunningAttemptStatus.ABORTED,
          attemptNo,
          attemptCount: transitionSnapshot.attempt_count,
          attemptCounted: false,
          parkReason: "setup_failure",
          outcome,
          finishedAt,
          correlationId,
          durationMs: Date.now() - startedAtMs,
          subscriptionStatus: subscription.status,
          markCaseParked,
        })
      }

      const { output, updatedCase, retryAt } = await rescheduleUnchargedAttempt(
        container,
        {
          dunningCase,
          caseMetadata: setupFailureMetadata,
          attempt,
          attemptNo,
          attemptCount: transitionSnapshot.attempt_count,
          outcome,
          finishedAt,
          correlationId,
          subscriptionStatus: subscription.status,
        }
      )

      logDunningEvent(logger, "warn", {
        event: "dunning.retry",
        outcome: "failed",
        correlation_id: correlationId,
        dunning_case_id: updatedCase.id,
        subscription_id: updatedCase.subscription_id,
        renewal_cycle_id: updatedCase.renewal_cycle_id,
        attempt_no: attemptNo,
        duration_ms: Date.now() - startedAtMs,
        failure_count: 1,
        rescheduled_count: 1,
        avg_attempts: attemptNo,
        failure_kind: "unexpected_error",
        alertable: false,
        message: outcome.error_message,
        metadata: {
          retry_outcome: "retry_scheduled",
          error_code: outcome.error_code,
          setup_failure_streak: setupFailureStreak,
          next_retry_at: retryAt.toISOString(),
        },
      })

      return new StepResponse<RunDunningRetryStepOutput>(output)
    }

    // The provider was reached and asked for cardholder authentication, so the attempt counts -
    // but nobody can answer that challenge from a background retry.
    if (outcome.kind === "requires_action") {
      return await parkForManualResolution(container, {
        dunningCase,
        caseMetadata,
        attempt,
        attemptStatus: DunningAttemptStatus.FAILED,
        attemptNo,
        attemptCount: consumedAttempts,
        attemptCounted: true,
        parkReason: "requires_action",
        outcome,
        finishedAt,
        correlationId,
        durationMs: Date.now() - startedAtMs,
        subscriptionStatus: subscription.status,
        markCaseParked,
      })
    }

    // The provider took the charge but answered with nothing we can reconcile against, so the money
    // may already be gone. The attempt is spent: a fresh session would delete this one and recharge.
    if (outcome.kind === "indeterminate") {
      return await parkForManualResolution(container, {
        dunningCase,
        caseMetadata,
        attempt,
        attemptStatus: DunningAttemptStatus.FAILED,
        attemptNo,
        attemptCount: consumedAttempts,
        attemptCounted: true,
        parkReason: "indeterminate_provider_response",
        outcome,
        finishedAt,
        correlationId,
        durationMs: Date.now() - startedAtMs,
        subscriptionStatus: subscription.status,
        markCaseParked,
      })
    }

    await dunningModule.updateDunningAttempts({
      id: attempt.id,
      finished_at: finishedAt,
      status: DunningAttemptStatus.FAILED,
      error_code: outcome.error_code,
      error_message: outcome.error_message,
      payment_reference: outcome.payment_reference,
      metadata: {
        ...(attempt.metadata ?? {}),
        provider_reached: outcome.provider_reached,
      },
    } as any)

    const shouldCloseAsUnrecovered =
      outcome.kind === "permanent_failure" ||
      consumedAttempts >= dunningCase.max_attempts

    if (shouldCloseAsUnrecovered) {
      if (!(await hasReachedProvider(container, dunningCase.id))) {
        return await parkForManualResolution(container, {
          dunningCase,
          caseMetadata,
          attempt,
          attemptStatus: DunningAttemptStatus.FAILED,
          attemptNo,
          attemptCount: consumedAttempts,
          attemptCounted: true,
          parkReason: "unreached_provider",
          outcome,
          finishedAt,
          correlationId,
          durationMs: Date.now() - startedAtMs,
          subscriptionStatus: subscription.status,
          markCaseParked,
        })
      }

      const recoveryReason =
        outcome.kind === "permanent_failure"
          ? "permanent_payment_failure"
          : "retry_limit_exhausted"

      const settlement = await settleSubscriptionPaymentFailure(container, {
        subscription_id: subscription.id,
        dunning_case_id: dunningCase.id,
        recovery_reason: recoveryReason,
        at: finishedAt,
      })

      const updatedCase = await dunningModule.updateDunningCases({
        id: dunningCase.id,
        status: DunningCaseStatus.UNRECOVERED,
        next_retry_at: null,
        last_attempt_at: finishedAt,
        last_payment_error_code: outcome.error_code,
        last_payment_error_message: outcome.error_message,
        closed_at: finishedAt,
        recovery_reason: recoveryReason,
        metadata: caseMetadata,
      } as any)

      logDunningEvent(logger, "warn", {
        event: "dunning.retry",
        outcome: "failed",
        correlation_id: correlationId,
        dunning_case_id: updatedCase.id,
        subscription_id: updatedCase.subscription_id,
        renewal_cycle_id: updatedCase.renewal_cycle_id,
        attempt_no: attemptNo,
        duration_ms: Date.now() - startedAtMs,
        failure_count: 1,
        unrecovered_count: 1,
        avg_attempts: attemptNo,
        failure_kind: "retry_exhausted",
        alertable: outcome.kind === "permanent_failure",
        message: outcome.error_message,
        metadata: {
          retry_outcome: "unrecovered",
          error_code: outcome.error_code,
          payment_reference: outcome.payment_reference,
        },
      })

      return new StepResponse<RunDunningRetryStepOutput>({
        dunning_case_id: updatedCase.id,
        dunning_attempt_id: attempt.id,
        outcome: "unrecovered",
        subscription_id: updatedCase.subscription_id,
        subscription_status: settlement.status,
        renewal_order_id: dunningCase.renewal_order_id,
        settled_now: settlement.settled,
        recovered_now: false,
        correlation_id: correlationId,
        attempt_no: attemptNo,
        error_code: outcome.error_code,
        next_retry_at: null,
        recovery_reason: recoveryReason,
        park_reason: null,
        attempt_counted: true,
      })
    }

    const nextRetryAt = calculateNextRetryAt(
      dunningCase.retry_schedule!,
      consumedAttempts,
      finishedAt
    )

    if (!nextRetryAt) {
      if (!(await hasReachedProvider(container, dunningCase.id))) {
        return await parkForManualResolution(container, {
          dunningCase,
          caseMetadata,
          attempt,
          attemptStatus: DunningAttemptStatus.FAILED,
          attemptNo,
          attemptCount: consumedAttempts,
          attemptCounted: true,
          parkReason: "unreached_provider",
          outcome,
          finishedAt,
          correlationId,
          durationMs: Date.now() - startedAtMs,
          subscriptionStatus: subscription.status,
          markCaseParked,
        })
      }

      const settlement = await settleSubscriptionPaymentFailure(container, {
        subscription_id: subscription.id,
        dunning_case_id: dunningCase.id,
        recovery_reason: "retry_schedule_exhausted",
        at: finishedAt,
      })

      const updatedCase = await dunningModule.updateDunningCases({
        id: dunningCase.id,
        status: DunningCaseStatus.UNRECOVERED,
        next_retry_at: null,
        last_attempt_at: finishedAt,
        last_payment_error_code: outcome.error_code,
        last_payment_error_message: outcome.error_message,
        closed_at: finishedAt,
        recovery_reason: "retry_schedule_exhausted",
        metadata: caseMetadata,
      } as any)

      logDunningEvent(logger, "warn", {
        event: "dunning.retry",
        outcome: "failed",
        correlation_id: correlationId,
        dunning_case_id: updatedCase.id,
        subscription_id: updatedCase.subscription_id,
        renewal_cycle_id: updatedCase.renewal_cycle_id,
        attempt_no: attemptNo,
        duration_ms: Date.now() - startedAtMs,
        failure_count: 1,
        unrecovered_count: 1,
        avg_attempts: attemptNo,
        failure_kind: "retry_exhausted",
        alertable: false,
        message: outcome.error_message,
        metadata: {
          retry_outcome: "unrecovered",
          error_code: outcome.error_code,
          payment_reference: outcome.payment_reference,
        },
      })

      return new StepResponse<RunDunningRetryStepOutput>({
        dunning_case_id: updatedCase.id,
        dunning_attempt_id: attempt.id,
        outcome: "unrecovered",
        subscription_id: updatedCase.subscription_id,
        subscription_status: settlement.status,
        renewal_order_id: dunningCase.renewal_order_id,
        settled_now: settlement.settled,
        recovered_now: false,
        correlation_id: correlationId,
        attempt_no: attemptNo,
        error_code: outcome.error_code,
        next_retry_at: null,
        recovery_reason: "retry_schedule_exhausted",
        park_reason: null,
        attempt_counted: true,
      })
    }

    const updatedCase = await dunningModule.updateDunningCases({
      id: dunningCase.id,
      status: DunningCaseStatus.RETRY_SCHEDULED,
      next_retry_at: nextRetryAt,
      last_attempt_at: finishedAt,
      last_payment_error_code: outcome.error_code,
      last_payment_error_message: outcome.error_message,
      recovered_at: null,
      closed_at: null,
      recovery_reason: null,
      metadata: caseMetadata,
    } as any)

    logDunningEvent(logger, "warn", {
      event: "dunning.retry",
      outcome: "failed",
      correlation_id: correlationId,
      dunning_case_id: updatedCase.id,
      subscription_id: updatedCase.subscription_id,
      renewal_cycle_id: updatedCase.renewal_cycle_id,
      attempt_no: attemptNo,
      duration_ms: Date.now() - startedAtMs,
      failure_count: 1,
      rescheduled_count: 1,
      avg_attempts: attemptNo,
      failure_kind: "unexpected_error",
      alertable: outcome.kind === "temporary_failure",
      message: outcome.error_message,
      metadata: {
        retry_outcome: "retry_scheduled",
        error_code: outcome.error_code,
        payment_reference: outcome.payment_reference,
        next_retry_at: nextRetryAt.toISOString(),
      },
    })

    return new StepResponse<RunDunningRetryStepOutput>({
      dunning_case_id: updatedCase.id,
      dunning_attempt_id: attempt.id,
      outcome: "retry_scheduled",
      subscription_id: updatedCase.subscription_id,
      subscription_status: subscription.status,
      renewal_order_id: dunningCase.renewal_order_id,
      settled_now: false,
      recovered_now: false,
      correlation_id: correlationId,
      attempt_no: attemptNo,
      error_code: outcome.error_code,
      next_retry_at: nextRetryAt.toISOString(),
      recovery_reason: null,
      park_reason: null,
      attempt_counted: true,
    })
  } catch (error) {
    const failureKind = classifyDunningFailure(error)
    logDunningEvent(logger, isAlertableDunningFailure(failureKind) ? "error" : "warn", {
      event: "dunning.retry",
      outcome: isAlertableDunningFailure(failureKind) ? "failed" : "blocked",
      correlation_id: correlationId,
      dunning_case_id: dunningCase.id,
      subscription_id: dunningCase.subscription_id,
      renewal_cycle_id: dunningCase.renewal_cycle_id,
      attempt_no: attemptNo,
      duration_ms: Date.now() - startedAtMs,
      failure_count: 1,
      failure_kind: failureKind,
      alertable: isAlertableDunningFailure(failureKind),
      message: getDunningErrorMessage(error),
      metadata: {
        triggered_by: input.triggered_by ?? null,
        reason: input.reason ?? null,
        ignore_schedule: Boolean(input.ignore_schedule),
      },
    })

    // A parked case is already in a safe state, and rolling it back would hand it straight back to
    // the scheduler. The park is the step's answer, so it is returned rather than thrown: failing
    // the workflow here would also swallow the `dunning_parked` event the park has to raise. Its
    // attempt row may be left processing, which the admin can see.
    if (parked.output) {
      logDunningEvent(logger, "error", {
        event: "dunning.retry",
        outcome: "failed",
        correlation_id: correlationId,
        dunning_case_id: dunningCase.id,
        subscription_id: dunningCase.subscription_id,
        renewal_cycle_id: dunningCase.renewal_cycle_id,
        attempt_no: attemptNo,
        duration_ms: Date.now() - startedAtMs,
        failure_count: 1,
        alertable: true,
        message: `DunningCase '${dunningCase.id}' was parked but its attempt row was left unfinished: ${getDunningErrorMessage(error)}`,
        metadata: {
          retry_outcome: "awaiting_manual_resolution",
          partial_park: true,
        },
      })

      return new StepResponse<RunDunningRetryStepOutput>(parked.output)
    }

    if (transitionedToRetrying) {
      await dunningModule.updateDunningCases({
        id: dunningCase.id,
        status: transitionSnapshot.status,
        attempt_count: transitionSnapshot.attempt_count,
        next_retry_at: transitionSnapshot.next_retry_at,
        last_attempt_at: transitionSnapshot.last_attempt_at,
        metadata: transitionSnapshot.metadata,
      } as any)
    }

    throw error
  }
}

export const runDunningRetryStep = createStep(
  "run-dunning-retry",
  async function (input: RunDunningRetryStepInput, { container }) {
    return await runDunningRetry(container, input)
  }
)
