import type { MedusaContainer } from "@medusajs/framework/types"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import type { FrequencyInterval } from "../../common/types/frequency-interval"
import { advanceCadence } from "../../common/utils/advance-cadence"
import { CANCELLATION_MODULE } from "../../modules/cancellation"
import type CancellationModuleService from "../../modules/cancellation/service"
import { CancellationFinalOutcome } from "../../modules/cancellation/types"
import { DUNNING_MODULE } from "../../modules/dunning"
import type DunningModuleService from "../../modules/dunning/service"
import { DunningCaseStatus } from "../../modules/dunning/types"
import { dunningErrors } from "../../modules/dunning/utils/errors"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import type SubscriptionModuleService from "../../modules/subscription/service"
import { SubscriptionStatus } from "../../modules/subscription/types"
import { ensureNextRenewalCycleWorkflow } from "../ensure-next-renewal-cycle"
import { INVOLUNTARY_CHURN_REASON } from "../utils/settle-subscription-payment-failure"

// `last_renewal_at` only moves on a *successful* renewal, so a single advance
// lands on the renewal that failed. Walk the cadence forward until it is
// strictly in the future: the missed period is forgiven, and the scheduler
// would otherwise charge on the next cron tick.
const MAX_CADENCE_ADVANCES = 120

type SubscriptionRecord = {
  id: string
  status: SubscriptionStatus
  frequency_interval: FrequencyInterval
  frequency_value: number
  started_at: Date
  trial_ends_at: Date | null
  last_renewal_at: Date | null
  next_renewal_at: Date | null
  metadata: Record<string, unknown> | null
}

type DunningCaseRecord = {
  id: string
  subscription_id: string
  status: DunningCaseStatus
  next_retry_at: Date | null
  recovered_at: Date | null
  closed_at: Date | null
  recovery_reason: string | null
  metadata: Record<string, unknown> | null
}

type CancellationCaseRecord = {
  id: string
  subscription_id: string
  reason: string | null
  metadata: Record<string, unknown> | null
}

export type ReverseInvoluntaryChurnStepInput = {
  dunning_case_id: string
  triggered_by?: string | null
  reason: string
}

type SubscriptionSnapshot = {
  id: string
  status: SubscriptionStatus
  next_renewal_at: Date | null
  metadata: Record<string, unknown> | null
}

type CancellationCaseSnapshot = {
  id: string
  metadata: Record<string, unknown> | null
}

export type ReverseInvoluntaryChurnCompensation = {
  previous_case: DunningCaseRecord
  previous_subscription: SubscriptionSnapshot
  previous_cancellation_case: CancellationCaseSnapshot | null
}

function appendAuditMetadata(
  metadata: Record<string, unknown> | null,
  action: string,
  input: ReverseInvoluntaryChurnStepInput,
  at: string
) {
  const existing = Array.isArray(metadata?.manual_actions)
    ? [...(metadata?.manual_actions as Record<string, unknown>[])]
    : []

  existing.push({
    action,
    who: input.triggered_by ?? null,
    when: at,
    reason: input.reason ?? null,
  })

  return {
    ...(metadata ?? {}),
    manual_actions: existing,
    last_manual_action: existing[existing.length - 1],
  }
}

function resolveNextRenewalAt(subscription: SubscriptionRecord, now: Date) {
  // Settlement nulled `next_renewal_at`, and a trial subscription that never
  // renewed is anchored on the end of its trial rather than on `started_at`.
  let cursor =
    subscription.last_renewal_at ??
    subscription.trial_ends_at ??
    subscription.started_at

  for (let index = 0; index < MAX_CADENCE_ADVANCES; index++) {
    const advanced = advanceCadence(
      cursor,
      subscription.frequency_interval,
      subscription.frequency_value
    )

    if (!advanced) {
      throw dunningErrors.invalidData(
        `Subscription '${subscription.id}' has an invalid renewal cadence interval '${subscription.frequency_interval}'`
      )
    }

    cursor = advanced

    if (cursor.getTime() > now.getTime()) {
      return cursor
    }
  }

  throw dunningErrors.conflict(
    `Subscription '${subscription.id}' cadence didn't reach a future renewal date within ${MAX_CADENCE_ADVANCES} advances`
  )
}

// Settlement either creates the churn row or converts an open customer-initiated
// case in place, keeping the customer's own `reason`. Both carry the case id, so
// that is what identifies the row this reversal has to answer for.
async function findSettlementCancellationCase(
  cancellationModule: CancellationModuleService,
  subscriptionId: string,
  dunningCaseId: string
) {
  const cancellationCases = (await cancellationModule.listCancellationCases({
    subscription_id: subscriptionId,
    final_outcome: CancellationFinalOutcome.CANCELED,
  } as any)) as CancellationCaseRecord[]

  return (
    cancellationCases.find(
      (cancellationCase) =>
        cancellationCase.metadata?.dunning_case_id === dunningCaseId
    ) ?? null
  )
}

export async function reverseInvoluntaryChurn(
  container: MedusaContainer,
  input: ReverseInvoluntaryChurnStepInput,
  now: Date = new Date()
) {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
  const cancellationModule =
    container.resolve<CancellationModuleService>(CANCELLATION_MODULE)

  const dunningCase = (await dunningModule.retrieveDunningCase(
    input.dunning_case_id
  )) as DunningCaseRecord

  const subscription = (await subscriptionModule.retrieveSubscription(
    dunningCase.subscription_id
  )) as SubscriptionRecord

  if (
    dunningCase.status !== DunningCaseStatus.UNRECOVERED ||
    subscription.status !== SubscriptionStatus.PAYMENT_FAILED
  ) {
    throw dunningErrors.notReversible(
      dunningCase.id,
      dunningCase.status,
      subscription.status
    )
  }

  const cancellationCase = await findSettlementCancellationCase(
    cancellationModule,
    subscription.id,
    dunningCase.id
  )

  // The customer asked to leave and settlement only converted their case: the
  // cancellation stands on its own, so reactivating and re-billing is refused.
  if (cancellationCase && cancellationCase.reason !== INVOLUNTARY_CHURN_REASON) {
    throw dunningErrors.customerCancellationStands(
      dunningCase.id,
      cancellationCase.id
    )
  }

  const nextRenewalAt = resolveNextRenewalAt(subscription, now)
  const reversedAt = now.toISOString()

  await subscriptionModule.updateSubscriptions({
    id: subscription.id,
    status: SubscriptionStatus.ACTIVE,
    next_renewal_at: nextRenewalAt,
    metadata: {
      ...(subscription.metadata ?? {}),
      reversal_context: {
        dunning_case_id: dunningCase.id,
        reversed_at: reversedAt,
        triggered_by: input.triggered_by ?? null,
        reason: input.reason,
        cancellation_case_reversed: Boolean(cancellationCase),
      },
    },
  } as any)

  const updatedCase = await dunningModule.updateDunningCases({
    id: dunningCase.id,
    status: DunningCaseStatus.RECOVERED,
    next_retry_at: null,
    recovered_at: now,
    closed_at: now,
    recovery_reason: "reversed_by_admin",
    metadata: appendAuditMetadata(
      dunningCase.metadata,
      "reverse_involuntary_churn",
      input,
      reversedAt
    ),
  } as any)

  if (cancellationCase) {
    await cancellationModule.updateCancellationCases({
      id: cancellationCase.id,
      metadata: {
        ...(cancellationCase.metadata ?? {}),
        reversed: true,
        reversed_at: reversedAt,
        reversed_by: input.triggered_by ?? null,
      },
    } as any)
  }

  // Runs last: it reads the subscription's freshly written `next_renewal_at`
  // to recreate the SCHEDULED cycle that settlement deleted.
  await ensureNextRenewalCycleWorkflow(container).run({
    input: { subscription_id: subscription.id },
  })

  return new StepResponse(updatedCase, {
    previous_case: dunningCase,
    previous_subscription: {
      id: subscription.id,
      status: subscription.status,
      next_renewal_at: subscription.next_renewal_at,
      metadata: subscription.metadata,
    },
    previous_cancellation_case: cancellationCase
      ? {
          id: cancellationCase.id,
          metadata: cancellationCase.metadata,
        }
      : null,
  } satisfies ReverseInvoluntaryChurnCompensation)
}

export async function revertInvoluntaryChurnReversal(
  container: MedusaContainer,
  compensation: ReverseInvoluntaryChurnCompensation | undefined
) {
  if (!compensation) {
    return
  }

  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
  const cancellationModule =
    container.resolve<CancellationModuleService>(CANCELLATION_MODULE)

  await subscriptionModule.updateSubscriptions(
    compensation.previous_subscription as any
  )

  await dunningModule.updateDunningCases(compensation.previous_case as any)

  if (compensation.previous_cancellation_case) {
    await cancellationModule.updateCancellationCases(
      compensation.previous_cancellation_case as any
    )
  }
}

export const reverseInvoluntaryChurnStep = createStep(
  "reverse-involuntary-churn",
  async function (input: ReverseInvoluntaryChurnStepInput, { container }) {
    return await reverseInvoluntaryChurn(container, input)
  },
  async function (
    compensation: ReverseInvoluntaryChurnCompensation | undefined,
    { container }
  ) {
    await revertInvoluntaryChurnReversal(container, compensation)
  }
)
