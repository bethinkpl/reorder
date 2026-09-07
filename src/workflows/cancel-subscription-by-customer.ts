import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import type { CancellationReasonCategory } from "../modules/cancellation/types"
import { closeSubscriptionDunningStep } from "./steps/close-subscription-dunning"
import { createSubscriptionLogEventStep } from "./steps/create-subscription-log-event"
import { ensureNextRenewalCycleStep } from "./steps/ensure-next-renewal-cycle"
import { finalizeCancellationStep } from "./steps/finalize-cancellation"
import {
  buildCancellationCaseStartedLogEvent,
  buildCancellationFinalizedLogEvent,
} from "./steps/shared-cancellation-log"
import { startCancellationCaseStep } from "./steps/start-cancellation-case"

const CUSTOMER_ENTRY_SOURCE = "customer_self_service" as const
const CUSTOMER_LOG_SOURCE = "storefront" as const
const CUSTOMER_CANCELLATION_TIMING = "end_of_cycle" as const

export type CancelSubscriptionByCustomerWorkflowInput = {
  subscription_id: string
  reason: string
  reason_category?: CancellationReasonCategory | null
  notes?: string | null
  triggered_by?: string | null
  metadata?: Record<string, unknown> | null
}

export const cancelSubscriptionByCustomerWorkflow = createWorkflow(
  "cancel-subscription-by-customer",
  function (input: CancelSubscriptionByCustomerWorkflowInput) {
    const subscriptionLockKey = transform({ input }, function ({ input }) {
      return `subscription:${input.subscription_id}`
    })
    const renewalLockKey = transform({ input }, function ({ input }) {
      return `renewal:subscription:${input.subscription_id}`
    })

    acquireLockStep({
      key: subscriptionLockKey,
      timeout: 5,
      ttl: 120,
    }).config({
      name: "acquire-customer-cancellation-subscription-lock",
    })

    acquireLockStep({
      key: renewalLockKey,
      timeout: 5,
      ttl: 120,
    }).config({
      name: "acquire-customer-cancellation-renewal-lock",
    })

    const closeDunningInput = transform({ input }, function ({ input }) {
      return {
        subscription_id: input.subscription_id,
        triggered_by: input.triggered_by ?? null,
        reason: input.reason,
      }
    })
    closeSubscriptionDunningStep(closeDunningInput)

    const startInput = transform({ input }, function ({ input }) {
      return {
        subscription_id: input.subscription_id,
        reason: input.reason,
        reason_category: input.reason_category ?? null,
        notes: input.notes ?? null,
        metadata: input.metadata ?? null,
        entry_context: {
          source: CUSTOMER_ENTRY_SOURCE,
          triggered_by: input.triggered_by ?? null,
          reason: input.reason,
        },
      }
    })
    const caseResult = startCancellationCaseStep(startInput)

    const startLogInput = transform(
      { caseResult, input },
      function ({ caseResult, input }) {
        return {
          log_event: buildCancellationCaseStartedLogEvent({
            current: caseResult.current,
            previous: caseResult.previous,
            subscription: caseResult.subscription,
            entry_source: CUSTOMER_ENTRY_SOURCE,
            triggered_by: input.triggered_by ?? null,
          }),
        }
      }
    )
    createSubscriptionLogEventStep(startLogInput).config({
      name: "create-customer-cancellation-started-log-event",
    })

    const finalizeInput = transform(
      { caseResult, input },
      function ({ caseResult, input }) {
        return {
          cancellation_case_id: caseResult.current.id,
          reason: input.reason,
          reason_category: input.reason_category ?? null,
          notes: input.notes ?? null,
          finalized_by: input.triggered_by ?? null,
          effective_at: CUSTOMER_CANCELLATION_TIMING,
          source: CUSTOMER_LOG_SOURCE,
          metadata: input.metadata ?? null,
        }
      }
    )
    const finalizeResult = finalizeCancellationStep(finalizeInput)

    const finalizeLogInput = transform(
      { finalizeResult, input },
      function ({ finalizeResult, input }) {
        return {
          log_event: buildCancellationFinalizedLogEvent({
            current: finalizeResult.current,
            previous: finalizeResult.previous,
            subscription: finalizeResult.subscription,
            finalized_by: input.triggered_by ?? null,
            effective_at: CUSTOMER_CANCELLATION_TIMING,
            source: CUSTOMER_LOG_SOURCE,
          }),
        }
      }
    )
    createSubscriptionLogEventStep(finalizeLogInput).config({
      name: "create-customer-cancellation-finalized-log-event",
    })

    const ensureInput = transform(
      { finalizeResult },
      function ({ finalizeResult }) {
        return {
          subscription_id: finalizeResult.subscription_id,
        }
      }
    )
    const renewal_cycle = ensureNextRenewalCycleStep(ensureInput)

    releaseLockStep({
      key: renewalLockKey,
    }).config({
      name: "release-customer-cancellation-renewal-lock",
    })

    releaseLockStep({
      key: subscriptionLockKey,
    }).config({
      name: "release-customer-cancellation-subscription-lock",
    })

    const output = transform(
      { finalizeResult, renewal_cycle },
      function ({ finalizeResult, renewal_cycle }) {
        return {
          cancellation_case_id: finalizeResult.cancellation_case_id,
          subscription_id: finalizeResult.subscription_id,
          case_status: finalizeResult.case_status,
          final_outcome: finalizeResult.final_outcome,
          cancel_effective_at: finalizeResult.cancel_effective_at,
          renewal_cycle,
        }
      }
    )

    return new WorkflowResponse(output)
  }
)

export default cancelSubscriptionByCustomerWorkflow
