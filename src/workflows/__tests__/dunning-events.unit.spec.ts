import { WorkflowManager } from "@medusajs/framework/orchestration"
import { DunningEvents } from "../../modules/dunning/events"
import { markDunningUnrecoveredWorkflow } from "../mark-dunning-unrecovered"
import { recoverDunningFromCapturedPaymentWorkflow } from "../recover-dunning-from-captured-payment"
import { runDunningRetryWorkflow } from "../run-dunning-retry"
import { startDunningWorkflow } from "../start-dunning"

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

  it("registers all four retry emits under distinct step names", () => {
    const handlers = stepHandlers("run-dunning-retry")
    const emits = [
      "emit-dunning-attempt-failed-event",
      "emit-dunning-payment-failed-event",
      "emit-dunning-parked-event",
      "emit-dunning-retry-recovered-event",
    ].map((name) => handlers.get(name))

    expect(emits.every(Boolean)).toBe(true)
    expect(new Set(emits).size).toBe(emits.length)
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
