import { MedusaError, serializeError } from "@medusajs/framework/utils"
import { mapCancellationAdminRouteError } from "../cancellations/utils"
import { mapDunningAdminRouteError } from "../dunning/utils"
import { mapRenewalAdminRouteError } from "../renewals/utils"
import { mapSubscriptionSettingsAdminRouteError } from "../subscription-settings/utils"
import { mapMedusaErrorByType } from "../../route-errors"

const asWorkflowError = (error: Error) => serializeError(error)

describe("mapMedusaErrorByType", () => {
  it.each([
    [MedusaError.Types.NOT_FOUND, 404],
    [MedusaError.Types.INVALID_DATA, 400],
    [MedusaError.Types.CONFLICT, 409],
    [MedusaError.Types.NOT_ALLOWED, 409],
    [MedusaError.Types.PAYMENT_AUTHORIZATION_ERROR, 409],
    [MedusaError.Types.UNEXPECTED_STATE, 500],
    [MedusaError.Types.DB_ERROR, 500],
  ])("answers a workflow error of type %s with %d and the given message", (type, status) => {
    const error = new MedusaError(type, "Session 'payses_1' was not found by the provider")

    expect(mapMedusaErrorByType(asWorkflowError(error), "shown")).toEqual({ status, type, message: "shown" })
  })

  it("reads the type of a MedusaError itself and of one another error carries as its cause", () => {
    const invalidData = new MedusaError(MedusaError.Types.INVALID_DATA, "Source cart 'cart_1' is missing 'region_id'")
    const wrapped = Object.assign(new Error("Step failed"), { cause: invalidData })

    expect(mapMedusaErrorByType(invalidData, "shown")).toMatchObject({ status: 400 })
    expect(mapMedusaErrorByType(asWorkflowError(wrapped), "shown")).toMatchObject({
      status: 400,
      type: MedusaError.Types.INVALID_DATA,
    })
  })

  it("answers nothing for an error without a MedusaError type", () => {
    expect(mapMedusaErrorByType({ type: "card_error", message: "Your card was declined" }, "shown")).toBeNull()
  })
})

const MAPPERS = [
  {
    name: "mapDunningAdminRouteError",
    map: mapDunningAdminRouteError,
    busyLockMessage:
      "This dunning case is being updated by a retry or a payment right now; try again in a moment",
  },
  {
    name: "mapRenewalAdminRouteError",
    map: mapRenewalAdminRouteError,
    busyLockMessage:
      "This renewal's subscription is being updated by a renewal run or a payment right now; try again in a moment",
  },
  {
    name: "mapCancellationAdminRouteError",
    map: mapCancellationAdminRouteError,
    busyLockMessage:
      "The subscription is being updated by a renewal or a payment right now; try again in a moment",
  },
]

describe.each(MAPPERS)("$name", ({ map, busyLockMessage }) => {
  it.each([
    ["the error itself", (error: Error) => error],
    ["the plain object a workflow run rethrows", asWorkflowError],
  ])("answers %s by its type with its own message before reading the message", (_shape, shape) => {
    const error = new MedusaError(MedusaError.Types.NOT_ALLOWED, "Session 'payses_1' was not found by the provider")

    expect(map(shape(error))).toEqual({
      status: 409,
      type: MedusaError.Types.NOT_ALLOWED,
      message: error.message,
    })
  })

  it("answers a busy lock as a conflict, also when the provider raises it as a MedusaError", () => {
    for (const lockFailure of [
      new Error("Timed-out acquiring lock."),
      new MedusaError(MedusaError.Types.CONFLICT, "Timed-out acquiring lock."),
    ]) {
      expect(map(asWorkflowError(lockFailure))).toEqual({
        status: 409,
        type: MedusaError.Types.CONFLICT,
        message: busyLockMessage,
      })
    }
  })

  it("answers an error without a MedusaError type from its message", () => {
    expect(map({ message: "Order 'ord_1' was not found" })).toMatchObject({
      status: 404,
      type: MedusaError.Types.NOT_FOUND,
    })
    expect(map({ type: "card_error", message: "Your card was declined" })).toMatchObject({
      status: 409,
      message: "Your card was declined",
    })
  })
})

describe("mapSubscriptionSettingsAdminRouteError", () => {
  it.each([
    [MedusaError.Types.CONFLICT, "SubscriptionSettings version conflict: expected 0, current 1", 409],
    [MedusaError.Types.INVALID_DATA, "'max_dunning_attempts' must match the number of 'dunning_retry_intervals'", 400],
    [MedusaError.Types.NOT_FOUND, "SubscriptionSettings 'global' was not found", 404],
  ])("answers a %s error the settings workflow rethrew as a plain object by its type, with its own message", (type, message, status) => {
    expect(
      mapSubscriptionSettingsAdminRouteError(asWorkflowError(new MedusaError(type, message)))
    ).toEqual({ status, type, message })
  })
})
