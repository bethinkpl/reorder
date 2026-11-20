import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import { assertNoRenewalPaymentInProgressStep } from "./steps/assert-no-renewal-payment-in-progress"
import { createSubscriptionLogEventStep } from "./steps/create-subscription-log-event"
import { ensureNextRenewalCycleStep } from "./steps/ensure-next-renewal-cycle"
import {
  pauseSubscriptionStep,
  PauseSubscriptionStepInput,
} from "./steps/pause-subscription"
import { normalizeActivityLogEvent } from "../modules/activity-log/utils/normalize-log-event"
import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../modules/activity-log/types"
import { toISOStringOrNull } from "./utils/date-output"
import { renewalSubscriptionLockKey } from "../modules/renewal/utils/lock-key"

export const pauseSubscriptionWorkflow = createWorkflow(
  "pause-subscription",
  function (input: PauseSubscriptionStepInput) {
    const renewalLockKey = transform({ input }, function ({ input }) {
      return renewalSubscriptionLockKey(input.id)
    })

    acquireLockStep({
      key: renewalLockKey,
      timeout: 5,
      ttl: 120,
      executeOnSubWorkflow: true,
    }).config({
      name: "acquire-pause-subscription-renewal-lock",
    })

    const dunningLocks = assertNoRenewalPaymentInProgressStep({
      subscription_id: input.id,
      action: "be paused",
    })

    const subscriptionChange = pauseSubscriptionStep(input)
    const logInput = transform(
      { subscriptionChange, input },
      function ({ subscriptionChange, input }) {
        return {
          log_event: normalizeActivityLogEvent({
            subscription_id: subscriptionChange.current.id,
            customer_id: subscriptionChange.current.customer_id,
            event_type: ActivityLogEventType.SUBSCRIPTION_PAUSED,
            actor_type: ActivityLogActorType.USER,
            actor_id: input.triggered_by ?? null,
            display: {
              subscription_reference: subscriptionChange.current.reference,
              customer_name:
                subscriptionChange.current.customer_snapshot?.full_name ?? null,
              product_title:
                subscriptionChange.current.product_snapshot?.product_title ?? null,
              variant_title:
                subscriptionChange.current.product_snapshot?.variant_title ?? null,
            },
            previous_state: {
              status: subscriptionChange.previous.status,
              paused_at: toISOStringOrNull(subscriptionChange.previous.paused_at),
            },
            new_state: {
              status: subscriptionChange.current.status,
              paused_at: toISOStringOrNull(subscriptionChange.current.paused_at),
            },
            reason: input.reason ?? null,
            metadata: {
              source: "admin",
              effective_at: toISOStringOrNull(subscriptionChange.current.paused_at),
            },
            dedupe: {
              scope: "subscription",
              target_id: subscriptionChange.current.id,
              qualifier: toISOStringOrNull(subscriptionChange.current.paused_at),
            },
          }),
        }
      }
    )
    createSubscriptionLogEventStep(logInput)
    const ensureInput = transform({ subscriptionChange }, function ({ subscriptionChange }) {
      return {
        subscription_id: subscriptionChange.current.id,
      }
    })
    const renewal_cycle = ensureNextRenewalCycleStep(ensureInput)

    releaseLockStep({
      key: dunningLocks.keys,
      ownerId: dunningLocks.owner_id,
      executeOnSubWorkflow: true,
    }).config({
      name: "release-pause-subscription-dunning-locks",
    })

    releaseLockStep({
      key: renewalLockKey,
      executeOnSubWorkflow: true,
    }).config({
      name: "release-pause-subscription-renewal-lock",
    })

    return new WorkflowResponse({
      subscription: subscriptionChange.current,
      renewal_cycle,
    })
  }
)

export default pauseSubscriptionWorkflow
