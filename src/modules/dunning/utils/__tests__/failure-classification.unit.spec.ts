import { dunningErrors } from "../errors"
import {
  classifyDunningFailure,
  isAlertableDunningFailure,
} from "../observability"
import { RetryBlockedReason, toRetryBlockedError } from "../retry-eligibility"

describe("no_payment_method failure classification", () => {
  it("classifies the settlement error raised by the retry workflow", () => {
    const error = dunningErrors.noPaymentMethod("dun_1", "sub_1")

    expect(classifyDunningFailure(error)).toBe("no_payment_method")
  })

  it("classifies the blocked-reason error the same way", () => {
    const error = toRetryBlockedError(RetryBlockedReason.NO_PAYMENT_METHOD, {
      id: "dun_1",
    } as any)

    expect(classifyDunningFailure(error)).toBe("no_payment_method")
  })

  it("is not alertable, so the scheduler reports it as blocked rather than failed", () => {
    expect(isAlertableDunningFailure("no_payment_method")).toBe(false)
  })

  it("keeps a genuine fault alertable", () => {
    expect(isAlertableDunningFailure("unexpected_error")).toBe(true)
  })
})
