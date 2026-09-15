import type { MedusaContainer } from "@medusajs/framework/types"
import { CANCELLATION_MODULE } from "../../modules/cancellation"
import type CancellationModuleService from "../../modules/cancellation/service"
import {
  CancellationCaseStatus,
  CancellationFinalOutcome,
  CancellationReasonCategory,
} from "../../modules/cancellation/types"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import type SubscriptionModuleService from "../../modules/subscription/service"
import { SubscriptionStatus, TERMINAL_SUBSCRIPTION_STATUSES } from "../../modules/subscription/types"

export const INVOLUNTARY_CHURN_REASON = "Subscription payment could not be recovered"

export type SettleSubscriptionPaymentFailureInput = {
  subscription_id: string
  dunning_case_id: string
  recovery_reason: string
  at?: Date
}

type SubscriptionRecord = {
  id: string
  status: SubscriptionStatus
  metadata: Record<string, unknown> | null
}

type CancellationCaseRecord = {
  id: string
  subscription_id: string
  status: CancellationCaseStatus
}

const OPEN_CANCELLATION_STATUSES = [
  CancellationCaseStatus.REQUESTED,
  CancellationCaseStatus.EVALUATING_RETENTION,
  CancellationCaseStatus.RETENTION_OFFERED,
]

export async function settleSubscriptionPaymentFailure(
  container: MedusaContainer,
  input: SettleSubscriptionPaymentFailureInput
): Promise<SubscriptionStatus> {
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

  const subscription = (await subscriptionModule.retrieveSubscription(
    input.subscription_id
  )) as SubscriptionRecord

  if (TERMINAL_SUBSCRIPTION_STATUSES.includes(subscription.status)) {
    return subscription.status
  }

  const settledAt = input.at ?? new Date()

  await subscriptionModule.updateSubscriptions({
    id: subscription.id,
    status: SubscriptionStatus.PAYMENT_FAILED,
    next_renewal_at: null,
    metadata: {
      ...(subscription.metadata ?? {}),
      payment_failure_context: {
        dunning_case_id: input.dunning_case_id,
        recovery_reason: input.recovery_reason,
        settled_at: settledAt.toISOString(),
      },
    },
  })

  await recordInvoluntaryChurn(container, {
    subscription_id: subscription.id,
    dunning_case_id: input.dunning_case_id,
    recovery_reason: input.recovery_reason,
    settled_at: settledAt,
  })

  return SubscriptionStatus.PAYMENT_FAILED
}

async function recordInvoluntaryChurn(
  container: MedusaContainer,
  input: {
    subscription_id: string
    dunning_case_id: string
    recovery_reason: string
    settled_at: Date
  }
) {
  const cancellationModule =
    container.resolve<CancellationModuleService>(CANCELLATION_MODULE)

  const metadata = {
    involuntary: true,
    dunning_case_id: input.dunning_case_id,
    recovery_reason: input.recovery_reason,
  }

  const existing = (await cancellationModule.listCancellationCases({
    subscription_id: input.subscription_id,
    status: OPEN_CANCELLATION_STATUSES,
  } as any)) as CancellationCaseRecord[]

  const openCase = existing[0]

  if (openCase) {
    await cancellationModule.updateCancellationCases({
      id: openCase.id,
      status: CancellationCaseStatus.CANCELED,
      final_outcome: CancellationFinalOutcome.CANCELED,
      reason_category: CancellationReasonCategory.BILLING,
      finalized_at: input.settled_at,
      cancellation_effective_at: input.settled_at,
      metadata,
    } as any)

    return
  }

  await cancellationModule.createCancellationCases({
    subscription_id: input.subscription_id,
    status: CancellationCaseStatus.CANCELED,
    reason: INVOLUNTARY_CHURN_REASON,
    reason_category: CancellationReasonCategory.BILLING,
    final_outcome: CancellationFinalOutcome.CANCELED,
    finalized_at: input.settled_at,
    cancellation_effective_at: input.settled_at,
    metadata,
  } as any)
}
