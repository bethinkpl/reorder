import {
  createHook,
  createWorkflow,
  transform,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import {
  acquireLockStep,
  releaseLockStep,
  useQueryGraphStep,
} from "@medusajs/medusa/core-flows"
import { DunningEvents } from "../modules/dunning/events"
import { setPaymentSessionDataResult } from "./process-renewal-cycle"
import { emitDunningEventStep } from "./steps/emit-dunning-event"
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
      emitDunningEventStep({
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

    // Only the run that actually closed the case may notify: a scheduled run that finds the case
    // already recovered (the customer paid the order themselves) reports the same outcome, and its
    // event went out when it was closed.
    when(
      "emit-dunning-recovered",
      { result },
      function ({ result }) {
        return result.outcome === "recovered" && result.recovered_now === true
      }
    ).then(function () {
      emitDunningEventStep({
        eventName: DunningEvents.RECOVERED,
        data: {
          subscription_id: result.subscription_id,
          dunning_case_id: result.dunning_case_id,
          renewal_order_id: result.renewal_order_id,
          recovery_reason: result.recovery_reason,
        },
      }).config({
        name: "emit-dunning-retry-recovered-event",
      })
    })

    // Only the run that actually moved the subscription may notify: an already-terminal
    // subscription keeps its previous status and its customer has been told once already.
    when(
      "emit-dunning-payment-failed",
      { result },
      function ({ result }) {
        return result.outcome === "unrecovered" && result.settled_now === true
      }
    ).then(function () {
      emitDunningEventStep({
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

    // A parked case is neither retried nor settled, so nothing else would ever tell the host app
    // that an operator has to step in.
    when(
      "emit-dunning-parked",
      { result },
      function ({ result }) {
        return result.outcome === "awaiting_manual_resolution"
      }
    ).then(function () {
      emitDunningEventStep({
        eventName: DunningEvents.PARKED,
        data: {
          subscription_id: result.subscription_id,
          dunning_case_id: result.dunning_case_id,
          attempt_no: result.attempt_no,
          park_reason: result.park_reason,
          error_code: result.error_code,
        },
      }).config({
        name: "emit-dunning-parked-event",
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
