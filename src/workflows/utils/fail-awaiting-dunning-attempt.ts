import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { DUNNING_MODULE } from "../../modules/dunning"
import { DunningEvents } from "../../modules/dunning/events"
import type DunningModuleService from "../../modules/dunning/service"
import {
  CHARGE_IN_FLIGHT_DUNNING_CASE_STATUSES,
  DunningAttemptStatus,
} from "../../modules/dunning/types"
import { createDunningCorrelationId } from "../../modules/dunning/utils/observability"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import type SubscriptionModuleService from "../../modules/subscription/service"
import { emitDunningEvent } from "../steps/emit-dunning-event"
import {
  classifyReportedPaymentFailure,
  loadDunningCase,
  type RunDunningRetryStepOutput,
  settleDeclinedRetryAttempt,
} from "../steps/run-dunning-retry"
import { runUnderLock } from "./run-under-lock"

const RUN_LOCK_WAIT_SECONDS = 5
const LOCK_HOLD_SECONDS = 120

export type FailAwaitingDunningAttemptInput = {
  session_id: string
  action: string
  reason: string | null
}

type PaymentSessionRecord = {
  id: string
  context: Record<string, unknown> | null
}

type RetryMarkers = {
  dunning_case_id: string
  dunning_attempt_id: string
}

async function readRetryMarkers(
  container: MedusaContainer,
  sessionId: string
): Promise<RetryMarkers | null> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: sessions } = await query.graph({
    entity: "payment_session",
    fields: ["id", "context"],
    filters: { id: sessionId },
  })

  const session: PaymentSessionRecord | undefined = sessions[0]
  const caseId = session?.context?.dunning_case_id
  const attemptId = session?.context?.dunning_attempt_id

  if (
    typeof caseId !== "string" ||
    !caseId ||
    typeof attemptId !== "string" ||
    !attemptId
  ) {
    return null
  }

  return { dunning_case_id: caseId, dunning_attempt_id: attemptId }
}

async function isWorthWaitingFor(
  dunningModule: DunningModuleService,
  caseId: string
) {
  const [dunningCase] = await dunningModule.listDunningCases({ id: caseId })

  return Boolean(
    dunningCase && CHARGE_IN_FLIGHT_DUNNING_CASE_STATUSES.includes(dunningCase.status)
  )
}

export async function failAwaitingDunningAttempt(
  container: MedusaContainer,
  input: FailAwaitingDunningAttemptInput
): Promise<void> {
  const markers = await readRetryMarkers(container, input.session_id)

  if (!markers) {
    return
  }

  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)

  if (!(await isWorthWaitingFor(dunningModule, markers.dunning_case_id))) {
    return
  }

  const output = await runUnderLock(
    container,
    `dunning:${markers.dunning_case_id}`,
    () =>
      failAwaitingDunningAttemptUnderLock(container, {
        ...input,
        ...markers,
      }),
    { wait_seconds: RUN_LOCK_WAIT_SECONDS, hold_seconds: LOCK_HOLD_SECONDS }
  )

  if (output) {
    await emitDunningAttemptOutcomeEvents(container, output)
  }
}

export type FailAwaitingDunningAttemptUnderLockInput = RetryMarkers & {
  session_id: string | null
  action: string
  reason: string | null
  message?: string
}

/**
 * Fails the case's in-flight attempt as a reported decline: reschedules the case, or closes it as
 * unrecovered on its last attempt. The caller holds `dunning:<case_id>` and emits the outcome's
 * events with `emitDunningAttemptOutcomeEvents`.
 */
export async function failAwaitingDunningAttemptUnderLock(
  container: MedusaContainer,
  input: FailAwaitingDunningAttemptUnderLockInput
): Promise<RunDunningRetryStepOutput | null> {
  const startedAtMs = Date.now()
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

  const dunningCase = await loadDunningCase(container, input.dunning_case_id)

  if (!CHARGE_IN_FLIGHT_DUNNING_CASE_STATUSES.includes(dunningCase.status)) {
    return null
  }

  const attempts = await dunningModule.listDunningAttempts({
    dunning_case_id: dunningCase.id,
  })
  const latest = attempts.reduce<(typeof attempts)[number] | null>(
    (highest, attempt) =>
      !highest || attempt.attempt_no > highest.attempt_no ? attempt : highest,
    null
  )

  if (!latest || latest.id !== input.dunning_attempt_id) {
    return null
  }

  const onThisSession =
    input.session_id !== null && latest.payment_reference === input.session_id
  const inFlight =
    latest.status === DunningAttemptStatus.PROCESSING &&
    (onThisSession || latest.payment_reference === null)
  const halfFailed = latest.status === DunningAttemptStatus.FAILED && onThisSession

  if (!inFlight && !halfFailed) {
    return null
  }

  const subscription = await subscriptionModule.retrieveSubscription(
    dunningCase.subscription_id
  )
  const correlationId = latest.metadata?.correlation_id
  const outcome = classifyReportedPaymentFailure({
    action: input.action,
    reason: input.reason,
    payment_reference: input.session_id,
  })

  return await settleDeclinedRetryAttempt(container, {
    dunningCase,
    subscription,
    attempt: latest,
    attemptNo: latest.attempt_no,
    consumedAttempts: dunningCase.attempt_count,
    outcome: input.message ? { ...outcome, error_message: input.message } : outcome,
    caseMetadata: dunningCase.metadata ?? {},
    finishedAt: new Date(),
    correlationId:
      typeof correlationId === "string"
        ? correlationId
        : createDunningCorrelationId("dunning-payment-failure"),
    startedAtMs,
    markCaseParked: () => {},
  })
}

export async function emitDunningAttemptOutcomeEvents(
  container: MedusaContainer,
  output: RunDunningRetryStepOutput
) {
  if (output.outcome === "retry_scheduled" && output.attempt_counted) {
    await emitDunningEvent(container, {
      eventName: DunningEvents.ATTEMPT_FAILED,
      data: {
        subscription_id: output.subscription_id,
        dunning_case_id: output.dunning_case_id,
        attempt_no: output.attempt_no,
        error_code: output.error_code,
        next_retry_at: output.next_retry_at,
      },
    })
  }

  if (output.outcome === "unrecovered" && output.settled_now) {
    await emitDunningEvent(container, {
      eventName: DunningEvents.PAYMENT_FAILED,
      data: {
        subscription_id: output.subscription_id,
        dunning_case_id: output.dunning_case_id,
        recovery_reason: output.recovery_reason,
      },
    })
  }

  if (output.outcome === "awaiting_manual_resolution") {
    await emitDunningEvent(container, {
      eventName: DunningEvents.PARKED,
      data: {
        subscription_id: output.subscription_id,
        dunning_case_id: output.dunning_case_id,
        attempt_no: output.attempt_no,
        park_reason: output.park_reason,
        error_code: output.error_code,
      },
    })
  }
}
