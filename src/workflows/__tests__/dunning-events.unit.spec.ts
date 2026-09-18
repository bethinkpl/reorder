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

  it("registers all three retry emits under distinct step names", () => {
    const handlers = stepHandlers("run-dunning-retry")
    const attemptFailed = handlers.get("emit-dunning-attempt-failed-event")
    const paymentFailed = handlers.get("emit-dunning-payment-failed-event")
    const parked = handlers.get("emit-dunning-parked-event")

    expect(attemptFailed).toBeDefined()
    expect(paymentFailed).toBeDefined()
    expect(parked).toBeDefined()
    expect(attemptFailed).not.toBe(paymentFailed)
    expect(paymentFailed).not.toBe(parked)
    expect(attemptFailed).not.toBe(parked)
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
