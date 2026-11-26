import { WorkflowManager } from "@medusajs/framework/orchestration"
import { DunningEvents } from "../../modules/dunning/events"
import { markDunningUnrecoveredWorkflow } from "../mark-dunning-unrecovered"
import { recoverDunningFromCapturedPaymentWorkflow } from "../recover-dunning-from-captured-payment"
import { runDunningRetryWorkflow } from "../run-dunning-retry"
import { startDunningWorkflow } from "../start-dunning"
import { dunningRetryOutcomeEvents } from "../utils/dunning-retry-events"

function stepHandlers(workflowId: string) {
  const workflow = WorkflowManager.getWorkflow(workflowId)

  expect(workflow).toBeDefined()

  return workflow!.handlers_
}

describe("dunning lifecycle events", () => {
  it("keeps the event names stable", () => {
    expect(DunningEvents).toEqual({
      STARTED: "subscription.dunning_started",
      ATTEMPT_FAILED: "subscription.dunning_attempt_failed",
      PAYMENT_FAILED: "subscription.payment_failed",
      PARKED: "subscription.dunning_parked",
      RECOVERED: "subscription.dunning_recovered",
    })
  })

  it("composes every dunning workflow that emits", () => {
    expect(typeof startDunningWorkflow).toBe("function")
    expect(typeof runDunningRetryWorkflow).toBe("function")
    expect(typeof markDunningUnrecoveredWorkflow).toBe("function")
    expect(typeof recoverDunningFromCapturedPaymentWorkflow).toBe("function")
  })

  it("registers the retry's outcome emit", () => {
    expect(stepHandlers("run-dunning-retry").get("emit-dunning-retry-events")).toBeDefined()
  })

  describe("dunningRetryOutcomeEvents", () => {
    const result = {
      subscription_id: "sub_1",
      dunning_case_id: "dun_1",
      renewal_order_id: "order_1",
      attempt_no: 2,
      error_code: "insufficient_funds",
      next_retry_at: null,
      recovery_reason: null,
      park_reason: null,
      attempt_counted: false,
      recovered_now: false,
      settled_now: false,
    }

    it.each([
      ["a counted reschedule", { outcome: "retry_scheduled", attempt_counted: true }, [DunningEvents.ATTEMPT_FAILED]],
      ["a reschedule that charged nothing", { outcome: "retry_scheduled" }, []],
      ["the run that recovered the case", { outcome: "recovered", recovered_now: true }, [DunningEvents.RECOVERED]],
      ["a run finding the case already recovered", { outcome: "recovered" }, []],
      ["the run that settled the subscription", { outcome: "unrecovered", settled_now: true }, [DunningEvents.PAYMENT_FAILED]],
      ["a park", { outcome: "awaiting_manual_resolution" }, [DunningEvents.PARKED]],
      ["a charge awaiting payment", { outcome: "awaiting_payment" }, []],
    ])("emits for %s: %j", (_, overrides, expected) => {
      const events = dunningRetryOutcomeEvents({ ...result, ...overrides } as never)

      expect(events.map(({ eventName }) => eventName)).toEqual(expected)
    })
  })

  it("registers the started and admin emits", () => {
    expect(
      stepHandlers("start-dunning").get("emit-dunning-started-event")
    ).toBeDefined()
    expect(
      stepHandlers("mark-dunning-unrecovered").get(
        "emit-dunning-payment-failed-event"
      )
    ).toBeDefined()
  })

  it("registers the customer recovery emit", () => {
    expect(
      stepHandlers("recover-dunning-from-captured-payment").get(
        "emit-dunning-recovered-event"
      )
    ).toBeDefined()
  })

  it("keeps the setPaymentSessionData hook on the retry workflow", () => {
    expect(typeof runDunningRetryWorkflow.hooks.setPaymentSessionData).toBe(
      "function"
    )
  })
})
