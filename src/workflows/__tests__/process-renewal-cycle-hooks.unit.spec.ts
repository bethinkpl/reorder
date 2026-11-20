import { WorkflowManager } from "@medusajs/framework/orchestration"
import { processRenewalCycleWorkflow } from "../process-renewal-cycle"

function stepOrder(workflowId: string) {
  const workflow = WorkflowManager.getWorkflow(workflowId)

  expect(workflow).toBeDefined()

  return [...workflow!.handlers_.keys()]
}

describe("processRenewalCycleWorkflow hooks", () => {
  it("exposes applyRenewalCredits", () => {
    expect(typeof processRenewalCycleWorkflow.hooks.applyRenewalCredits).toBe(
      "function"
    )
  })

  it("runs applyRenewalCredits after the order exists and before it is sized for payment", () => {
    const steps = stepOrder("process-renewal-cycle")
    const position = (name: string) => {
      const index = steps.indexOf(name)

      expect(index).toBeGreaterThanOrEqual(0)

      return index
    }

    expect(position("create-renewal-order")).toBeLessThan(
      position("applyRenewalCredits")
    )
    expect(position("applyRenewalCredits")).toBeLessThan(
      position("create-renewal-payment-collection")
    )
    expect(position("create-renewal-payment-collection")).toBeLessThan(
      position("setPaymentSessionData")
    )
    expect(position("setPaymentSessionData")).toBeLessThan(
      position("authorize-renewal-payment")
    )
  })
})
