import { MedusaError, serializeError } from "@medusajs/framework/utils"
import { mapCancellationAdminRouteError } from "../cancellations/utils"
import { mapDunningAdminRouteError } from "../dunning/utils"
import { mapRenewalAdminRouteError } from "../renewals/utils"
import { cancellationErrors } from "../../../modules/cancellation/utils/errors"
import { dunningErrors } from "../../../modules/dunning/utils/errors"
import { renewalErrors } from "../../../modules/renewal/utils/errors"

/** What a workflow run rethrows in place of the error its step raised. */
const asWorkflowError = (error: Error) => serializeError(error)

const MAPPERS = [
  {
    name: "mapDunningAdminRouteError",
    map: mapDunningAdminRouteError,
    notFound: dunningErrors.notFound("DunningCase", "dc_missing"),
    invalidData: dunningErrors.invalidData("DunningCase 'dc_1' is missing renewal_order_id"),
    conflict: dunningErrors.conflict("DunningCase 'dc_1' can't update retry schedule while its charge awaits"),
  },
  {
    name: "mapRenewalAdminRouteError",
    map: mapRenewalAdminRouteError,
    notFound: renewalErrors.notFound("RenewalCycle", "re_missing"),
    invalidData: renewalErrors.invalidData("Source cart 'cart_1' is missing 'region_id'"),
    conflict: renewalErrors.conflict("Renewal 're_1' is unpaid, but its payment may still arrive"),
  },
  {
    name: "mapCancellationAdminRouteError",
    map: mapCancellationAdminRouteError,
    notFound: cancellationErrors.notFound("CancellationCase", "cc_missing"),
    invalidData: cancellationErrors.invalidData("Cancellation reason update requires a non-empty reason"),
    conflict: cancellationErrors.conflict("CancellationCase 'cc_1' has an invalid final state"),
  },
]

describe.each(MAPPERS)("$name", ({ map, notFound, invalidData, conflict }) => {
  it.each([
    ["the error itself", (error: Error) => error],
    ["the plain object a workflow run rethrows", asWorkflowError],
  ])("answers %s by its type with its own message", (_shape, shape) => {
    expect(map(shape(notFound))).toEqual({
      status: 404,
      type: MedusaError.Types.NOT_FOUND,
      message: notFound.message,
    })
    expect(map(shape(invalidData))).toEqual({
      status: 400,
      type: MedusaError.Types.INVALID_DATA,
      message: invalidData.message,
    })
    expect(map(shape(conflict))).toEqual({
      status: 409,
      type: MedusaError.Types.CONFLICT,
      message: conflict.message,
    })
  })

  it.each([
    [MedusaError.Types.NOT_ALLOWED, 409],
    [MedusaError.Types.PAYMENT_AUTHORIZATION_ERROR, 409],
    [MedusaError.Types.UNEXPECTED_STATE, 500],
    [MedusaError.Types.DB_ERROR, 500],
  ])("answers a workflow error of type %s with %d", (type, status) => {
    const error = new MedusaError(type, "Session 'payses_1' was not found by the provider")

    expect(map(asWorkflowError(error))).toEqual({ status, type, message: error.message })
  })

  it("reads the type of a MedusaError another error carries as its cause", () => {
    const wrapped = Object.assign(new Error("Step failed"), { cause: invalidData })

    expect(map(asWorkflowError(wrapped))).toMatchObject({
      status: 400,
      type: MedusaError.Types.INVALID_DATA,
    })
  })

  it("answers an error without a MedusaError type from its message, a lock failure being a conflict", () => {
    const lockFailure = new Error("Timed-out acquiring lock.")

    expect(map(asWorkflowError(lockFailure))).toEqual({
      status: 409,
      type: MedusaError.Types.CONFLICT,
      message: lockFailure.message,
    })
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
