import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { createSubscriptionLogEventStep } from "./steps/create-subscription-log-event"
import { ensureNextRenewalCycleStep } from "./steps/ensure-next-renewal-cycle"
import {
  finalizeCancellationStep,
  type FinalizeCancellationStepInput,
} from "./steps/finalize-cancellation"
import { buildCancellationFinalizedLogEvent } from "./steps/shared-cancellation-log"
import { rebuildAnalyticsDailySnapshotsWorkflow } from "./rebuild-analytics-daily-snapshots"
import { buildAnalyticsIncrementalRebuildInput } from "./utils/analytics-incremental"

export const finalizeCancellationWorkflow = createWorkflow(
  "finalize-cancellation",
  function (input: FinalizeCancellationStepInput) {
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
    const incrementalAnalyticsInput = transform(
      { result, input },
      function ({ result, input }) {
        return buildAnalyticsIncrementalRebuildInput({
          occurred_at: result.current.finalized_at,
          trigger_source: "finalize_cancellation",
          correlation_id: input.metadata?.correlation_id as string | null | undefined,
          triggered_by: input.finalized_by ?? null,
        })
      }
    )
    rebuildAnalyticsDailySnapshotsWorkflow.runAsStep({
      input: incrementalAnalyticsInput,
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
