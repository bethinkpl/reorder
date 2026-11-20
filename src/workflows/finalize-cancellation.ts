import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import { closeSubscriptionDunningStep } from "./steps/close-subscription-dunning"
import { createSubscriptionLogEventStep } from "./steps/create-subscription-log-event"
import { endAwaitingRenewalCyclesStep } from "./steps/end-awaiting-renewal-cycles"
import { ensureNextRenewalCycleStep } from "./steps/ensure-next-renewal-cycle"
import {
  finalizeCancellationStep,
  type FinalizeCancellationStepInput,
} from "./steps/finalize-cancellation"
import { resolveCancellationCaseSubscriptionStep } from "./steps/resolve-cancellation-case-subscription"
import { buildCancellationFinalizedLogEvent } from "./steps/shared-cancellation-log"
import { renewalSubscriptionLockKey } from "../modules/renewal/utils/lock-key"

export const finalizeCancellationWorkflow = createWorkflow(
  "finalize-cancellation",
  function (input: FinalizeCancellationStepInput) {
    const scope = resolveCancellationCaseSubscriptionStep({
      cancellation_case_id: input.cancellation_case_id,
    })
    const renewalLockKey = transform({ scope }, function ({ scope }) {
      return renewalSubscriptionLockKey(scope.subscription_id)
    })

    acquireLockStep({
      key: renewalLockKey,
      timeout: 5,
      ttl: 120,
      executeOnSubWorkflow: true,
    }).config({
      name: "acquire-finalize-cancellation-renewal-lock",
    })

    const closeDunningInput = transform({ scope, input }, function ({ scope, input }) {
      return {
        subscription_id: scope.subscription_id,
        triggered_by: input.finalized_by ?? null,
        reason: input.reason ?? null,
      }
    })
    closeSubscriptionDunningStep(closeDunningInput)

    const result = finalizeCancellationStep(input)
    const endAwaitingInput = transform({ result, input }, function ({ result, input }) {
      return {
        subscription: result.subscription,
        cancelled_at: result.current.finalized_at ?? new Date(),
        actor_id: input.finalized_by ?? null,
        reason: result.current.reason,
        source: input.source ?? "admin",
      }
    })
    endAwaitingRenewalCyclesStep(endAwaitingInput)
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
