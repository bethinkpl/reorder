import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { DUNNING_MODULE } from "../../modules/dunning"
import { DunningEvents } from "../../modules/dunning/events"
import type DunningModuleService from "../../modules/dunning/service"
import {
  DunningAttemptStatus,
  DunningCaseStatus,
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

const LOCK_TIMEOUT_SECONDS = 30

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

async function isAwaitingPayment(
  dunningModule: DunningModuleService,
  caseId: string
) {
  const [dunningCase] = await dunningModule.listDunningCases({ id: caseId })

  return dunningCase?.status === DunningCaseStatus.AWAITING_PAYMENT
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

  if (!(await isAwaitingPayment(dunningModule, markers.dunning_case_id))) {
    return
  }

  const locking = container.resolve(Modules.LOCKING)

  const output = await locking.execute(
    `dunning:${markers.dunning_case_id}`,
    async () => await failAttemptUnderLock(container, input, markers),
    { timeout: LOCK_TIMEOUT_SECONDS }
  )

  if (output) {
    await emitOutcomeEvents(container, output)
  }
}

async function failAttemptUnderLock(
  container: MedusaContainer,
  input: FailAwaitingDunningAttemptInput,
  markers: RetryMarkers
): Promise<RunDunningRetryStepOutput | null> {
  const startedAtMs = Date.now()
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

  const dunningCase = await loadDunningCase(container, markers.dunning_case_id)

  if (dunningCase.status !== DunningCaseStatus.AWAITING_PAYMENT) {
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

  if (
    !latest ||
    latest.id !== markers.dunning_attempt_id ||
    latest.status !== DunningAttemptStatus.PROCESSING
  ) {
    return null
  }

  const subscription = await subscriptionModule.retrieveSubscription(
    dunningCase.subscription_id
  )
  const correlationId = latest.metadata?.correlation_id

  return await settleDeclinedRetryAttempt(container, {
    dunningCase,
    subscription,
    attempt: latest,
    attemptNo: latest.attempt_no,
    consumedAttempts: dunningCase.attempt_count,
    outcome: classifyReportedPaymentFailure({
      action: input.action,
      reason: input.reason,
      payment_reference: input.session_id,
    }),
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

async function emitOutcomeEvents(
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
