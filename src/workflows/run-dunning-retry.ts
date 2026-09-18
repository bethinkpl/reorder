import {
  createHook,
  createWorkflow,
  transform,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import {
  acquireLockStep,
  emitEventStep,
  releaseLockStep,
  useQueryGraphStep,
} from "@medusajs/medusa/core-flows"
import { DunningEvents } from "../modules/dunning/events"
import { SubscriptionStatus } from "../modules/subscription/types"
import { setPaymentSessionDataResult } from "./process-renewal-cycle"
import {
  runDunningRetryStep,
  type RunDunningRetryStepInput,
} from "./steps/run-dunning-retry"

/**
 * `payment_session_data` is owned by the `setPaymentSessionData` hook, so it is
 * kept out of the public input and callers cannot inject it.
 */
export type RunDunningRetryWorkflowInput = Omit<
  RunDunningRetryStepInput,
  "payment_session_data"
>

export const runDunningRetryWorkflow = createWorkflow(
  "run-dunning-retry",
  function (input: RunDunningRetryWorkflowInput) {
    const lockKey = transform({ input }, function ({ input }) {
      return `dunning:${input.dunning_case_id}`
    })

    acquireLockStep({
      key: lockKey,
      timeout: 5,
      ttl: 120,
    })

    const caseQuery = useQueryGraphStep({
      entity: "dunning_case",
      fields: ["id", "subscription_id"],
      filters: {
        id: input.dunning_case_id,
      },
      options: {
        throwIfKeyNotFound: true,
      },
    }).config({
      name: "load-dunning-case-for-hook",
    })

    const subscriptionId = transform({ caseQuery }, function ({ caseQuery }) {
      return caseQuery.data[0]?.subscription_id
    })

    const subscriptionQuery = useQueryGraphStep({
      entity: "subscription",
      fields: ["id", "payment_context"],
      filters: {
        id: subscriptionId,
      },
      options: {
        throwIfKeyNotFound: true,
      },
    }).config({
      name: "load-subscription-for-hook",
    })

    const hookSubscription = transform(
      { subscriptionQuery },
      function ({ subscriptionQuery }) {
        return subscriptionQuery.data[0]
      }
    )

    const setPaymentSessionData = createHook(
      "setPaymentSessionData",
      {
        subscription: hookSubscription,
      },
      {
        resultValidator: setPaymentSessionDataResult,
      }
    )
    const paymentSessionData = setPaymentSessionData.getResult()

    const stepInput = transform(
      { input, paymentSessionData },
      function ({ input, paymentSessionData }) {
        return {
          ...input,
          payment_session_data: paymentSessionData,
        }
      }
    )

    const result = runDunningRetryStep(stepInput)

    when(
      "emit-dunning-attempt-failed",
      { result },
      function ({ result }) {
        return result.outcome === "retry_scheduled"
      }
    ).then(function () {
      emitEventStep({
        eventName: DunningEvents.ATTEMPT_FAILED,
        data: {
          subscription_id: result.subscription_id,
          dunning_case_id: result.dunning_case_id,
          attempt_no: result.attempt_no,
          error_code: result.error_code,
          next_retry_at: result.next_retry_at,
        },
      }).config({
        name: "emit-dunning-attempt-failed-event",
      })
    })

    // An already-terminal subscription keeps its previous status, and its customer has been told
    // once already.
    when(
      "emit-dunning-payment-failed",
      { result },
      function ({ result }) {
        return (
          result.outcome === "unrecovered" &&
          result.subscription_status === SubscriptionStatus.PAYMENT_FAILED
        )
      }
    ).then(function () {
      emitEventStep({
        eventName: DunningEvents.PAYMENT_FAILED,
        data: {
          subscription_id: result.subscription_id,
          dunning_case_id: result.dunning_case_id,
          recovery_reason: result.recovery_reason,
        },
      }).config({
        name: "emit-dunning-payment-failed-event",
      })
    })

    releaseLockStep({
      key: lockKey,
    })

    return new WorkflowResponse(result, {
      hooks: [setPaymentSessionData],
    })
  }
)

export default runDunningRetryWorkflow
