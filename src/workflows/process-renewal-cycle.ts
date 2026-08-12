import {
  createHook,
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import { z } from "zod"
import { ensureNextRenewalCycleStep } from "./steps/ensure-next-renewal-cycle"
import { resolveRenewalCycleSubscriptionStep } from "./steps/resolve-renewal-cycle-subscription"
import { rebuildAnalyticsDailySnapshotsWorkflow } from "./rebuild-analytics-daily-snapshots"
import {
  authorizeRenewalPaymentStep,
  buildRenewalOrderItemsStep,
  createRenewalOrderStep,
  finalizeRenewalCycleStep,
  prepareRenewalCycleStep,
  ProcessRenewalCycleStepInput,
} from "./steps/process-renewal-cycle"
import { labelSubscriptionOrderAdjustmentsStep } from "./steps/label-subscription-order-adjustments"
import { buildAnalyticsIncrementalRebuildInput } from "./utils/analytics-incremental"

export const setPaymentSessionDataResult = z
  .record(z.string(), z.unknown())
  .optional()

/**
 * Discounts the host app wants applied to the renewal order's line item.
 * `code` is intentionally not part of the contract: code-bearing adjustments
 * are deleted by `createOrderWorkflow`'s promotion refresh. Unknown keys are
 * stripped by zod, so a handler cannot smuggle one in.
 */
export const resolveRenewalAdjustmentsResult = z
  .array(
    z.object({
      amount: z.number().positive(),
      description: z.string().nullish(),
      provider_id: z.string().nullish(),
      promotion_id: z.string().nullish(),
    })
  )
  .optional()

export const processRenewalCycleWorkflow = createWorkflow(
  "process-renewal-cycle",
  function (input: ProcessRenewalCycleStepInput) {
    const scope = resolveRenewalCycleSubscriptionStep(input)

    const lockKey = transform({ scope }, function ({ scope }) {
      return `renewal:subscription:${scope.subscription_id}`
    })

    acquireLockStep({
      key: lockKey,
      timeout: 10,
      ttl: 120,
    })

    const context = prepareRenewalCycleStep(input)
    const buildResult = buildRenewalOrderItemsStep(context)

    const resolveRenewalAdjustments = createHook(
      "resolveRenewalAdjustments",
      {
        subscription: context.subscription,
        renewal_cycle_id: context.renewal_cycle_id,
        currency_code: buildResult.currency_code,
        line_gross_total: buildResult.line_gross_total,
        items: buildResult.items,
      },
      {
        resultValidator: resolveRenewalAdjustmentsResult,
      }
    )
    const extraAdjustments = resolveRenewalAdjustments.getResult()

    const orderResult = createRenewalOrderStep({
      context,
      build_result: buildResult,
      extra_adjustments: extraAdjustments,
    })

    labelSubscriptionOrderAdjustmentsStep({
      order_id: orderResult.generated_order_id,
    })

    const setPaymentSessionData = createHook(
      "setPaymentSessionData",
      {
        payment_collections: orderResult.payment_collections,
        subscription: context.subscription,
        order: orderResult.order,
      },
      {
        resultValidator: setPaymentSessionDataResult,
      }
    )
    const paymentSessionData = setPaymentSessionData.getResult()

    authorizeRenewalPaymentStep({
      context,
      order_result: orderResult,
      payment_session_data: paymentSessionData,
    })

    const result = finalizeRenewalCycleStep({
      context,
      order_result: orderResult,
    })

    const ensureInput = transform({ result }, function ({ result }) {
      return {
        subscription_id: result.subscription_id,
      }
    })

    ensureNextRenewalCycleStep(ensureInput)

    const incrementalAnalyticsInput = transform({ input }, function ({ input }) {
      return buildAnalyticsIncrementalRebuildInput({
        occurred_at: new Date(),
        trigger_source: "renewal_processed",
        correlation_id: input.correlation_id ?? null,
        triggered_by: input.triggered_by ?? null,
      })
    })
    rebuildAnalyticsDailySnapshotsWorkflow.runAsStep({
      input: incrementalAnalyticsInput,
    })

    releaseLockStep({
      key: lockKey,
    })

    return new WorkflowResponse(result, {
      hooks: [setPaymentSessionData, resolveRenewalAdjustments],
    })
  }
)

export default processRenewalCycleWorkflow
