import { MedusaError, serializeError } from "@medusajs/framework/utils"
import { isLockBusyError } from "../lock-busy-error"

describe("isLockBusyError", () => {
  it.each([
    "Failed to acquire lock for key \"renewal:subscription:sub_1\"",
    "Timed-out acquiring lock.",
    "\"renewal:subscription:sub_1\" is already locked.",
  ])("recognises the locking providers' answer %p, also as the plain object a workflow rethrows", (message) => {
    expect(isLockBusyError(new Error(message))).toBe(true)
    expect(isLockBusyError(serializeError(new Error(message)))).toBe(true)
  })

  it("recognises the Redis provider's timeout, which it raises as a conflict", () => {
    expect(
      isLockBusyError(new MedusaError(MedusaError.Types.CONFLICT, "Timed-out acquiring lock."))
    ).toBe(true)
  })

  it.each([
    "canceling statement due to statement timeout",
    "Query read timeout",
    "lock timeout",
    "Subscription 'sub_1' is locked",
    "Renewal failed: Timed-out acquiring lock.",
    "Timed-out acquiring lock. Retrying",
  ])("does not read %p as a busy lock", (message) => {
    expect(isLockBusyError(new Error(message))).toBe(false)
  })

  it.each([null, undefined, "Timed-out acquiring lock.", 42, {}])(
    "does not read %p as a busy lock",
    (value) => {
      expect(isLockBusyError(value)).toBe(false)
    }
  )
})
