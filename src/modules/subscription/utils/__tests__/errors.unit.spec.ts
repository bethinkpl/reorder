import { serializeError } from "@medusajs/framework/utils"
import { isRenewalPaymentInProgress, subscriptionErrors } from "../errors"

describe("isRenewalPaymentInProgress", () => {
  const refusal = subscriptionErrors.renewalPaymentInProgress(
    "sub_1",
    "be paused",
    "renewal 'rc_1' is awaiting its payment"
  )

  it("recognises the refusal, also as the plain object a workflow rethrows", () => {
    expect(isRenewalPaymentInProgress(refusal)).toBe(true)
    expect(isRenewalPaymentInProgress(serializeError(refusal))).toBe(true)
  })

  it("ignores another conflict", () => {
    expect(isRenewalPaymentInProgress(subscriptionErrors.conflict(refusal.message))).toBe(false)
  })
})
