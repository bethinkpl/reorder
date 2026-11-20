import { MedusaError, serializeError } from "@medusajs/framework/utils"
import { DunningCaseStatus } from "../../../../../../modules/dunning/types"
import { dunningErrors } from "../../../../../../modules/dunning/utils/errors"
import { dunningCaseLockKey } from "../../../../../../modules/dunning/utils/lock-key"
import {
  RetryBlockedReason,
  toRetryBlockedError,
} from "../../../../../../modules/dunning/utils/retry-eligibility"
import { mapStoreRetryError } from "../utils"

const retryBlocked = (reason: RetryBlockedReason) =>
  serializeError(toRetryBlockedError(reason, { id: "dc_1", status: DunningCaseStatus.RETRYING }))

describe("mapStoreRetryError", () => {
  it.each([
    ["a retry whose charge awaits the provider", retryBlocked(RetryBlockedReason.PAYMENT_IN_PROGRESS)],
    ["a retry already running", retryBlocked(RetryBlockedReason.RETRY_IN_PROGRESS)],
    ["a case lock another run holds", serializeError(new Error("Timed-out acquiring lock."))],
    ["a case lock another owner inserted first", serializeError(new Error(`"${dunningCaseLockKey("dc_1")}" is already locked.`))],
  ])("answers %s as a retry in progress, in the storefront's vocabulary", (_name, error) => {
    const mapped = mapStoreRetryError("sub_1", error)

    expect(mapped).toEqual({
      status: 409,
      type: MedusaError.Types.CONFLICT,
      message: "Subscription 'sub_1' is not eligible for payment retry (retry_in_progress).",
      blocked_reason: RetryBlockedReason.RETRY_IN_PROGRESS,
    })
    expect(JSON.stringify(mapped)).not.toContain(RetryBlockedReason.PAYMENT_IN_PROGRESS)
    expect(JSON.stringify(mapped)).not.toContain("dc_1")
  })

  it("answers another blocked reason the workflow found with that reason, as the eligibility check does", () => {
    expect(mapStoreRetryError("sub_1", retryBlocked(RetryBlockedReason.MAX_ATTEMPTS_REACHED))).toEqual({
      status: 409,
      type: MedusaError.Types.CONFLICT,
      message: "Subscription 'sub_1' is not eligible for payment retry (max_attempts_reached).",
      blocked_reason: RetryBlockedReason.MAX_ATTEMPTS_REACHED,
    })
  })

  it.each([
    [dunningErrors.notFound("DunningCase", "dc_1"), 404, MedusaError.Types.NOT_FOUND],
    [dunningErrors.invalidData("Dunning retry 'now' must be a valid date"), 400, MedusaError.Types.INVALID_DATA],
    [dunningErrors.noPaymentMethod("dc_1", "sub_1"), 409, MedusaError.Types.CONFLICT],
    [new MedusaError(MedusaError.Types.UNEXPECTED_STATE, "Order state is broken"), 500, MedusaError.Types.UNEXPECTED_STATE],
  ])("answers a workflow error by its type with its own message: %p", (error, status, type) => {
    expect(mapStoreRetryError("sub_1", serializeError(error))).toEqual({
      status,
      type,
      message: error.message,
    })
  })
})
