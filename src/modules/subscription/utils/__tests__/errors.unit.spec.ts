import { serializeError } from "@medusajs/framework/utils"
import {
  isLockAcquisitionFailure,
  isRenewalPaymentInProgress,
  subscriptionErrors,
} from "../errors"

describe("isLockAcquisitionFailure", () => {
  it.each([
    "Failed to acquire lock for key \"renewal:subscription:sub_1\"",
    "Timed-out acquiring lock.",
    "\"renewal:subscription:sub_1\" is already locked.",
  ])("recognises the locking providers' answer %p, also as the plain object a workflow rethrows", (message) => {
    expect(isLockAcquisitionFailure(new Error(message))).toBe(true)
    expect(isLockAcquisitionFailure(serializeError(new Error(message)))).toBe(true)
  })

  it("ignores any other error", () => {
    expect(isLockAcquisitionFailure(new Error("Subscription 'sub_1' was not found"))).toBe(false)
    expect(isLockAcquisitionFailure(null)).toBe(false)
  })
})

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
