import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { DUNNING_MODULE } from "../../modules/dunning"
import type DunningModuleService from "../../modules/dunning/service"
import {
  DunningAttemptStatus,
  DunningCaseStatus,
} from "../../modules/dunning/types"
import { dunningErrors } from "../../modules/dunning/utils/errors"
import {
  createDunningCorrelationId,
  getDunningErrorMessage,
  logDunningEvent,
} from "../../modules/dunning/utils/observability"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import type SubscriptionModuleService from "../../modules/subscription/service"
import { SubscriptionStatus } from "../../modules/subscription/types"
import { subscriptionErrors } from "../../modules/subscription/utils/errors"
import { ensureNextRenewalCycleWorkflow } from "../ensure-next-renewal-cycle"
import { settleDunningCaseRecovered } from "../utils/settle-dunning-recovery"
import {
  type RenewalSettlementSource,
  settleRenewalCycleSucceeded,
} from "../utils/settle-renewal-cycle-succeeded"
import { loadOrderAmounts } from "./run-dunning-retry"

const RECOVERY_REASON = "customer_payment"
const RETRY_RECOVERY_REASON = "payment_recovered"

type DunningCaseRecord = {
  id: string
  subscription_id: string
  renewal_cycle_id: string
  renewal_order_id: string | null
  status: DunningCaseStatus
  metadata: Record<string, unknown> | null
  created_at?: Date | string
}

type SubscriptionRecord = {
  id: string
  status: SubscriptionStatus
}

type CapturedPaymentRecord = {
  id: string
  payment_session?: { context?: Record<string, unknown> | null } | null
}

type RetryAttemptPayment = {
  attempt_id: string
  payment_id: string
}

export type RecoverDunningFromCapturedPaymentStepInput = {
  dunning_case_id: string
  /** Null when the reconciler found the order paid without an event naming the payment. */
  payment_id: string | null
}

export type RecoverDunningFromCapturedPaymentStepOutput = {
  recovered: boolean
  subscription_id: string
  dunning_case_id: string
  renewal_order_id: string | null
  recovery_reason: string | null
  /** Why nothing was recovered; `null` on the recovering run. */
  reason: string | null
}

async function loadDunningCase(container: MedusaContainer, id: string) {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)

  try {
    return (await dunningModule.retrieveDunningCase(id)) as DunningCaseRecord
  } catch {
    throw dunningErrors.notFound("DunningCase", id)
  }
}

async function loadSubscription(container: MedusaContainer, id: string) {
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

  try {
    return (await subscriptionModule.retrieveSubscription(id)) as SubscriptionRecord
  } catch {
    throw subscriptionErrors.notFound("Subscription", id)
  }
}

async function findRetryAttemptForPayment(
  container: MedusaContainer,
  dunningCaseId: string,
  paymentId: string
): Promise<RetryAttemptPayment | null> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)

  const { data: payments } = await query.graph({
    entity: "payment",
    fields: ["id", "payment_session.context"],
    filters: { id: paymentId },
  })

  const payment: CapturedPaymentRecord | undefined = payments[0]
  const context = payment?.payment_session?.context
  const attemptId = context?.dunning_attempt_id

  if (context?.dunning_case_id !== dunningCaseId || typeof attemptId !== "string") {
    return null
  }

  const [attempt] = await dunningModule.listDunningAttempts({
    id: attemptId,
    dunning_case_id: dunningCaseId,
    status: DunningAttemptStatus.PROCESSING,
  })

  return attempt ? { attempt_id: attempt.id, payment_id: paymentId } : null
}

async function findCapturedAwaitingAttempt(
  container: MedusaContainer,
  dunningCaseId: string
): Promise<RetryAttemptPayment | null> {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const paymentModule = container.resolve(Modules.PAYMENT)

  const attempts = await dunningModule.listDunningAttempts({
    dunning_case_id: dunningCaseId,
    status: DunningAttemptStatus.PROCESSING,
  })
  const awaiting = attempts.reduce<(typeof attempts)[number] | null>(
    (highest, attempt) =>
      !highest || attempt.attempt_no > highest.attempt_no ? attempt : highest,
    null
  )

  if (!awaiting?.payment_reference) {
    return null
  }

  const payments = await paymentModule.listPayments({
    payment_session_id: awaiting.payment_reference,
  })
  const captured = payments.find((payment) => payment.captured_at)

  return captured ? { attempt_id: awaiting.id, payment_id: captured.id } : null
}

async function findRetryAttemptPayment(
  container: MedusaContainer,
  dunningCase: DunningCaseRecord,
  paymentId: string | null
) {
  if (paymentId) {
    return await findRetryAttemptForPayment(container, dunningCase.id, paymentId)
  }

  if (dunningCase.status === DunningCaseStatus.AWAITING_PAYMENT) {
    return await findCapturedAwaitingAttempt(container, dunningCase.id)
  }

  return null
}

/**
 * Closes a dunning case the customer settled themselves, by paying the renewal order through the
 * host app instead of waiting for the next scheduled retry.
 *
 * Runs under the case's lock, so the case and the subscription are reloaded here rather than
 * handed in. Idempotent in both directions: a case that is already `RECOVERED` still has its
 * renewal cycle healed (the retry engine used to close cases without settling the cycle), and a
 * cycle that is already `SUCCEEDED` is left alone.
 *
 * Exported for unit tests: `createStep` doesn't expose its handler.
 */
export async function recoverDunningFromCapturedPayment(
  container: MedusaContainer,
  input: RecoverDunningFromCapturedPaymentStepInput,
  now = new Date()
): Promise<StepResponse<RecoverDunningFromCapturedPaymentStepOutput>> {
  const logger = container.resolve("logger")
  const correlationId = createDunningCorrelationId("dunning-customer-recovery")
  const dunningCase = await loadDunningCase(container, input.dunning_case_id)
  const subscription = await loadSubscription(
    container,
    dunningCase.subscription_id
  )

  const answer = (
    recovered: boolean,
    reason: string | null,
    recoveryReason: string = RECOVERY_REASON
  ): StepResponse<RecoverDunningFromCapturedPaymentStepOutput> =>
    new StepResponse<RecoverDunningFromCapturedPaymentStepOutput>({
      recovered,
      subscription_id: subscription.id,
      dunning_case_id: dunningCase.id,
      renewal_order_id: dunningCase.renewal_order_id,
      recovery_reason: recovered ? recoveryReason : null,
      reason,
    })

  if (!dunningCase.renewal_order_id) {
    return answer(false, "missing_renewal_order")
  }

  // A partial capture leaves the period unpaid, so the case has to stay open for the next retry.
  const { pending } = await loadOrderAmounts(
    container,
    dunningCase.renewal_order_id
  )

  if (pending > 0) {
    return answer(false, "order_not_fully_paid")
  }

  // Deliberately non-fatal: by the time this runs the case is closed and the money is in, and a
  // throw would abandon a recovery nothing revisits - the case would no longer look open to
  // either the scheduler or the reconciler.
  const healCycle = async (source: RenewalSettlementSource = RECOVERY_REASON) => {
    try {
      const settlement = await settleRenewalCycleSucceeded(container, {
        renewal_cycle_id: dunningCase.renewal_cycle_id,
        subscription_id: subscription.id,
        order_id: dunningCase.renewal_order_id,
        finished_at: now,
        source,
      })

      // Billing already moved past this cycle, so the upcoming cycle is somebody else's and
      // re-deriving it here would delete the one that is actually due.
      if (settlement.reason === "cycle_superseded") {
        return
      }

      await ensureNextRenewalCycleWorkflow(container).run({
        input: { subscription_id: subscription.id },
      })
    } catch (error) {
      logDunningEvent(logger, "error", {
        event: "dunning.customer_recovery",
        outcome: "failed",
        correlation_id: correlationId,
        dunning_case_id: dunningCase.id,
        subscription_id: subscription.id,
        renewal_cycle_id: dunningCase.renewal_cycle_id,
        alertable: true,
        message: `DunningCase '${dunningCase.id}' was recovered but settling its renewal cycle failed: ${getDunningErrorMessage(error)}`,
        metadata: {
          payment_id: input.payment_id,
          renewal_order_id: dunningCase.renewal_order_id,
        },
      })
    }
  }

  if (dunningCase.status === DunningCaseStatus.UNRECOVERED) {
    logDunningEvent(logger, "error", {
      event: "dunning.customer_recovery",
      outcome: "blocked",
      correlation_id: correlationId,
      dunning_case_id: dunningCase.id,
      subscription_id: subscription.id,
      renewal_cycle_id: dunningCase.renewal_cycle_id,
      alertable: true,
      message: `A captured payment landed on DunningCase '${dunningCase.id}', which was already settled as unrecovered: reverse the churn with 'reverseInvoluntaryChurnWorkflow' before the subscription can bill again`,
      metadata: {
        payment_id: input.payment_id,
        renewal_order_id: dunningCase.renewal_order_id,
        subscription_status: subscription.status,
      },
    })

    return answer(false, "case_settled_unrecovered")
  }

  // An older recovery that closed the case without settling its cycle: heal the cycle, leave the
  // case as it is.
  if (dunningCase.status === DunningCaseStatus.RECOVERED) {
    await healCycle()

    return answer(false, "already_recovered")
  }

  const retryPayment = await findRetryAttemptPayment(
    container,
    dunningCase,
    input.payment_id
  )
  const recoveryReason = retryPayment ? RETRY_RECOVERY_REASON : RECOVERY_REASON

  if (retryPayment) {
    await container.resolve<DunningModuleService>(DUNNING_MODULE).updateDunningAttempts({
      id: retryPayment.attempt_id,
      status: DunningAttemptStatus.SUCCEEDED,
      finished_at: now,
      error_code: null,
      error_message: null,
      payment_reference: retryPayment.payment_id,
    })
  }

  await settleDunningCaseRecovered(container, {
    dunning_case: dunningCase,
    subscription,
    finished_at: now,
    recovery_reason: recoveryReason,
    payment_reference: retryPayment?.payment_id ?? input.payment_id,
  })

  await healCycle(retryPayment ? "dunning_retry" : RECOVERY_REASON)

  logDunningEvent(logger, "info", {
    event: "dunning.customer_recovery",
    outcome: "succeeded",
    correlation_id: correlationId,
    dunning_case_id: dunningCase.id,
    subscription_id: subscription.id,
    renewal_cycle_id: dunningCase.renewal_cycle_id,
    success_count: 1,
    recovered_count: 1,
    metadata: {
      payment_id: retryPayment?.payment_id ?? input.payment_id,
      renewal_order_id: dunningCase.renewal_order_id,
      recovery_reason: recoveryReason,
    },
  })

  return answer(true, null, recoveryReason)
}

export const recoverDunningFromCapturedPaymentStep = createStep(
  "recover-dunning-from-captured-payment",
  async function (
    input: RecoverDunningFromCapturedPaymentStepInput,
    { container }
  ) {
    return await recoverDunningFromCapturedPayment(container, input)
  }
)
