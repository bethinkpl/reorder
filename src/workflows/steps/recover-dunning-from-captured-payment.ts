import type { MedusaContainer } from "@medusajs/framework/types"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { DUNNING_MODULE } from "../../modules/dunning"
import type DunningModuleService from "../../modules/dunning/service"
import { DunningCaseStatus } from "../../modules/dunning/types"
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
import { settleRenewalCycleSucceeded } from "../utils/settle-renewal-cycle-succeeded"
import { loadOrderAmounts } from "./run-dunning-retry"

const RECOVERY_REASON = "customer_payment"

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
    reason: string | null
  ): StepResponse<RecoverDunningFromCapturedPaymentStepOutput> =>
    new StepResponse<RecoverDunningFromCapturedPaymentStepOutput>({
      recovered,
      subscription_id: subscription.id,
      dunning_case_id: dunningCase.id,
      renewal_order_id: dunningCase.renewal_order_id,
      recovery_reason: recovered ? RECOVERY_REASON : null,
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
  const healCycle = async () => {
    try {
      const settlement = await settleRenewalCycleSucceeded(container, {
        renewal_cycle_id: dunningCase.renewal_cycle_id,
        subscription_id: subscription.id,
        order_id: dunningCase.renewal_order_id,
        finished_at: now,
        source: RECOVERY_REASON,
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

  await settleDunningCaseRecovered(container, {
    dunning_case: dunningCase,
    subscription,
    finished_at: now,
    recovery_reason: RECOVERY_REASON,
    payment_reference: input.payment_id,
  })

  await healCycle()

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
      payment_id: input.payment_id,
      renewal_order_id: dunningCase.renewal_order_id,
    },
  })

  return answer(true, null)
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
