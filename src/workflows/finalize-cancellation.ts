import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import { createSubscriptionLogEventStep } from "./steps/create-subscription-log-event"
import { ensureNextRenewalCycleStep } from "./steps/ensure-next-renewal-cycle"
import {
  finalizeCancellationStep,
  type FinalizeCancellationStepInput,
} from "./steps/finalize-cancellation"
import { resolveCancellationCaseSubscriptionStep } from "./steps/resolve-cancellation-case-subscription"
import { buildCancellationFinalizedLogEvent } from "./steps/shared-cancellation-log"

export const finalizeCancellationWorkflow = createWorkflow(
  "finalize-cancellation",
  function (input: FinalizeCancellationStepInput) {
    const scope = resolveCancellationCaseSubscriptionStep({
      cancellation_case_id: input.cancellation_case_id,
    })
    const renewalLockKey = transform({ scope }, function ({ scope }) {
      return `renewal:subscription:${scope.subscription_id}`
    })

    acquireLockStep({
      key: renewalLockKey,
      timeout: 5,
      ttl: 120,
      executeOnSubWorkflow: true,
    }).config({
      name: "acquire-finalize-cancellation-renewal-lock",
    })

    const result = finalizeCancellationStep(input)
    const logInput = transform({ result, input }, function ({ result, input }) {
      return {
        log_event: buildCancellationFinalizedLogEvent({
          current: result.current,
          previous: result.previous,
          subscription: result.subscription,
          finalized_by: input.finalized_by ?? null,
          effective_at: input.effective_at,
          source: input.source,
        }),
      }
    })
    createSubscriptionLogEventStep(logInput)
    const ensureInput = transform({ result }, function ({ result }) {
      return {
        subscription_id: result.subscription_id,
      }
    })
    const renewal_cycle = ensureNextRenewalCycleStep(ensureInput)

    releaseLockStep({
      key: renewalLockKey,
      executeOnSubWorkflow: true,
    }).config({
      name: "release-finalize-cancellation-renewal-lock",
    })

    const output = transform(
      { result, renewal_cycle },
      function ({ result, renewal_cycle }) {
        return {
          cancellation_case_id: result.cancellation_case_id,
          subscription_id: result.subscription_id,
          case_status: result.case_status,
          final_outcome: result.final_outcome,
          cancel_effective_at: result.cancel_effective_at,
          renewal_cycle,
        }
      }
    )

    return new WorkflowResponse(output)
  }
)

export default finalizeCancellationWorkflow
