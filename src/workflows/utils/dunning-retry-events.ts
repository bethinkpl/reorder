import { DunningEvents } from "../../modules/dunning/events"
import type { EmitDunningEventStepInput } from "../steps/emit-dunning-event"
import type { RunDunningRetryStepOutput } from "../steps/run-dunning-retry"

/**
 * The lifecycle events a finished retry owes the host app. Shared by the retry workflow and by a
 * failure reported for a retry whose charge the provider confirmed later.
 */
export function dunningRetryOutcomeEvents(result: RunDunningRetryStepOutput): EmitDunningEventStepInput[] {
  const { subscription_id, dunning_case_id } = result
  const events: [boolean, EmitDunningEventStepInput][] = [
    // A reschedule that charged nothing handed its attempt back, so telling the customer their
    // payment failed would be a lie - and the loudest possible one while they are mid-checkout.
    [
      result.outcome === "retry_scheduled" && result.attempt_counted,
      {
        eventName: DunningEvents.ATTEMPT_FAILED,
        data: {
          subscription_id,
          dunning_case_id,
          attempt_no: result.attempt_no,
          error_code: result.error_code,
          next_retry_at: result.next_retry_at,
        },
      },
    ],
    // Only the run that actually closed the case may notify: a run that finds the case already
    // recovered (the customer paid the order themselves) reports the same outcome.
    [
      result.outcome === "recovered" && result.recovered_now,
      {
        eventName: DunningEvents.RECOVERED,
        data: {
          subscription_id,
          dunning_case_id,
          renewal_order_id: result.renewal_order_id,
          recovery_reason: result.recovery_reason,
        },
      },
    ],
    // Only the run that actually moved the subscription may notify: an already-terminal
    // subscription keeps its previous status and its customer has been told once already.
    [
      result.outcome === "unrecovered" && result.settled_now,
      {
        eventName: DunningEvents.PAYMENT_FAILED,
        data: { subscription_id, dunning_case_id, recovery_reason: result.recovery_reason },
      },
    ],
    // A parked case is neither retried nor settled, so nothing else would ever tell the host app
    // that an operator has to step in.
    [
      result.outcome === "awaiting_manual_resolution",
      {
        eventName: DunningEvents.PARKED,
        data: {
          subscription_id,
          dunning_case_id,
          attempt_no: result.attempt_no,
          park_reason: result.park_reason,
          error_code: result.error_code,
        },
      },
    ],
  ]

  return events.filter(([due]) => due).map(([, event]) => event)
}
