import {
  createWorkflow,
  transform,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import { normalizeActivityLogEvent } from "../modules/activity-log/utils/normalize-log-event"
import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../modules/activity-log/types"
import { RetentionOfferType } from "../modules/cancellation/types"
import { assertNoRenewalPaymentInProgressStep } from "./steps/assert-no-renewal-payment-in-progress"
import { createSubscriptionLogEventStep } from "./steps/create-subscription-log-event"
import {
  applyRetentionOfferStep,
  type ApplyRetentionOfferStepInput,
} from "./steps/apply-retention-offer"
import { resolveCancellationCaseSubscriptionStep } from "./steps/resolve-cancellation-case-subscription"

export const applyRetentionOfferWorkflow = createWorkflow(
  "apply-retention-offer",
  function (input: ApplyRetentionOfferStepInput) {
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
      name: "acquire-apply-retention-offer-renewal-lock",
    })

    when(
      "assert-pause-offer-without-renewal-payment-in-progress",
      { input },
      function ({ input }) {
        return input.offer_type === RetentionOfferType.PAUSE_OFFER
      }
    ).then(function () {
      assertNoRenewalPaymentInProgressStep({
        subscription_id: scope.subscription_id,
        action: "be paused",
      })
    })

    const result = applyRetentionOfferStep(input)
    const logInput = transform({ result, input }, function ({ result, input }) {
      return {
        log_event: normalizeActivityLogEvent({
          subscription_id: result.current.subscription_id,
          customer_id: result.subscription.customer_id,
          event_type: ActivityLogEventType.CANCELLATION_OFFER_APPLIED,
          actor_type: ActivityLogActorType.USER,
          actor_id: input.decided_by ?? null,
          display: {
            subscription_reference: result.subscription.reference,
            customer_name: result.subscription.customer_snapshot?.full_name ?? null,
            product_title: result.subscription.product_snapshot?.product_title ?? null,
            variant_title: result.subscription.product_snapshot?.variant_title ?? null,
          },
          previous_state: {
            status: result.previous.status,
            final_outcome: result.previous.final_outcome,
          },
          new_state: {
            status: result.current.status,
            final_outcome: result.current.final_outcome,
          },
          reason: input.decision_reason ?? null,
          metadata: {
            source: "admin",
            cancellation_case_id: result.current.id,
            retention_offer_event_id: result.retention_offer_event_id,
            trigger_type: input.offer_type,
          },
          dedupe: {
            scope: "cancellation",
            target_id: result.current.id,
            qualifier: result.retention_offer_event_id,
          },
        }),
      }
    })
    createSubscriptionLogEventStep(logInput)

    releaseLockStep({
      key: renewalLockKey,
      executeOnSubWorkflow: true,
    }).config({
      name: "release-apply-retention-offer-renewal-lock",
    })

    return new WorkflowResponse(result)
  }
)

export default applyRetentionOfferWorkflow
