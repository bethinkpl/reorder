import {
  createHook,
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import {
  acquireLockStep,
  releaseLockStep,
  useQueryGraphStep,
} from "@medusajs/medusa/core-flows"
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

    releaseLockStep({
      key: lockKey,
    })

    return new WorkflowResponse(result, {
      hooks: [setPaymentSessionData],
    })
  }
)

export default runDunningRetryWorkflow
