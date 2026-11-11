jest.mock("../../workflows", () => ({
  processRenewalCycleWorkflow: jest.fn(),
}))

import { renewalErrors } from "../../modules/renewal/utils/errors"
import {
  classifyRenewalFailure,
  isAlertableRenewalFailure,
} from "../../modules/renewal/utils/observability"
import { isBlockedRenewalOutcome } from "../process-renewal-cycles"

describe("isBlockedRenewalOutcome", () => {
  it("counts a run the customer's own payment skipped as blocked, not failed", () => {
    const error = renewalErrors.customerPaymentInProgress("rc_1", "order_1")

    expect(isBlockedRenewalOutcome(classifyRenewalFailure(error))).toBe(true)
  })

  it("counts a run refused because the cycle awaits its payment as blocked and never alertable", () => {
    const kind = classifyRenewalFailure(renewalErrors.awaitingPayment("rc_1"))

    expect(isBlockedRenewalOutcome(kind)).toBe(true)
    expect(isAlertableRenewalFailure(kind)).toBe(false)
  })

  it.each([
    "already_processing",
    "duplicate_execution",
    "cycle_superseded",
  ] as const)("keeps counting '%s' as blocked", (kind) => {
    expect(isBlockedRenewalOutcome(kind)).toBe(true)
  })

  it.each(["order_creation_failed", "unexpected_error"] as const)(
    "still counts '%s' as a failure",
    (kind) => {
      expect(isBlockedRenewalOutcome(kind)).toBe(false)
    }
  )
})
