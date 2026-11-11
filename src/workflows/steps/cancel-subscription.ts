import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import SubscriptionModuleService from "../../modules/subscription/service"
import { CANCELLABLE_SUBSCRIPTION_STATUSES, SubscriptionStatus } from "../../modules/subscription/types"
import { resolveCancelEffectiveAt } from "./finalize-cancellation"
import { subscriptionErrors } from "../../modules/subscription/utils/errors"
import {
  endAwaitingRenewalCyclesOnCancellation,
  type EndedAwaitingRenewalCycle,
  restoreAwaitingRenewalCycles,
} from "../utils/end-awaiting-renewal-cycle-on-cancellation"
import {
  asSubscriptionUpdateInput,
  asSubscriptionWorkflowRecord,
  SubscriptionWorkflowRecord,
  SubscriptionWorkflowStepResult,
} from "./pause-subscription"

export type CancelSubscriptionStepInput = {
  id: string
  reason?: string
  effective_at?: "immediately" | "end_of_cycle"
  triggered_by?: string | null
}

type CancelSubscriptionCompensation = {
  subscription: SubscriptionWorkflowRecord
  ended_awaiting_renewals: EndedAwaitingRenewalCycle[]
}

export const cancelSubscriptionStep = createStep(
  "cancel-subscription",
  async function (input: CancelSubscriptionStepInput, { container }) {
    const subscriptionModuleService: SubscriptionModuleService =
      container.resolve(SUBSCRIPTION_MODULE)

    const subscription = await subscriptionModuleService.retrieveSubscription(
      input.id
    )

    if (!CANCELLABLE_SUBSCRIPTION_STATUSES.includes(subscription.status)) {
      throw subscriptionErrors.invalidState(
        input.id,
        "be cancelled",
        subscription.status
      )
    }

    const cancelledAt = new Date()
    const cancelEffectiveAt = resolveCancelEffectiveAt({
      status: subscription.status,
      next_renewal_at: subscription.next_renewal_at,
      effective_at: input.effective_at,
      cancelled_at: cancelledAt,
    })

    const updated = await subscriptionModuleService.updateSubscriptions({
      id: input.id,
      status: SubscriptionStatus.CANCELLED,
      cancelled_at: cancelledAt,
      cancel_effective_at: cancelEffectiveAt,
      next_renewal_at: null,
      metadata: {
        ...(subscription.metadata ?? {}),
        cancel_context: {
          reason: input.reason ?? null,
          effective_at: input.effective_at ?? "immediately",
          cancelled_at: cancelledAt.toISOString(),
          triggered_by: input.triggered_by ?? null,
        },
      },
    })

    const previous = asSubscriptionWorkflowRecord(subscription)
    const endedAwaitingRenewals = await endAwaitingRenewalCyclesOnCancellation(
      container,
      {
        subscription: previous,
        cancelled_at: cancelledAt,
        actor_id: input.triggered_by ?? null,
        reason: input.reason ?? null,
        source: "admin",
      }
    )

    return new StepResponse<SubscriptionWorkflowStepResult, CancelSubscriptionCompensation>(
      {
        current: asSubscriptionWorkflowRecord(updated),
        previous,
      },
      {
        subscription: previous,
        ended_awaiting_renewals: endedAwaitingRenewals,
      }
    )
  },
  async function (compensation: CancelSubscriptionCompensation | undefined, { container }) {
    if (!compensation) {
      return
    }

    const subscriptionModuleService: SubscriptionModuleService =
      container.resolve(SUBSCRIPTION_MODULE)

    await restoreAwaitingRenewalCycles(
      container,
      compensation.ended_awaiting_renewals
    )
    await subscriptionModuleService.updateSubscriptions(
      asSubscriptionUpdateInput(compensation.subscription)
    )
  }
)
