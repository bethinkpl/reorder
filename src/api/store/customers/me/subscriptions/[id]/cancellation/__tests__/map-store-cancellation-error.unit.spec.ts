import { MedusaError } from "@medusajs/framework/utils"
import { mapStoreCancellationError } from "../route"
import { cancellationErrors } from "../../../../../../../../modules/cancellation/utils/errors"
import { dunningErrors } from "../../../../../../../../modules/dunning/utils/errors"
import { subscriptionErrors } from "../../../../../../../../modules/subscription/utils/errors"

describe("mapStoreCancellationError", () => {
  it("maps an invalid subscription state to a conflict without leaking the status detail", () => {
    const mapped = mapStoreCancellationError(
      subscriptionErrors.invalidState(
        "sub_123",
        "enter cancellation handling",
        "cancelled"
      )
    )

    expect(mapped.status).toEqual(409)
    expect(mapped.type).toEqual(MedusaError.Types.CONFLICT)
    expect(mapped.message).not.toContain("sub_123")
  })

  it("explains an in-flight payment retry", () => {
    const mapped = mapStoreCancellationError(
      dunningErrors.retryInFlightTransitionBlocked(
        "dc_123",
        "be closed for subscription cancellation"
      )
    )

    expect(mapped.status).toEqual(409)
    expect(mapped.message).toContain("payment recovery")
    expect(mapped.message).not.toContain("dc_123")
  })

  it("keeps a not-found as a 404", () => {
    const mapped = mapStoreCancellationError(
      cancellationErrors.notFound("CancellationCase", "cc_123")
    )

    expect(mapped.status).toEqual(404)
    expect(mapped.type).toEqual(MedusaError.Types.NOT_FOUND)
  })

  it("keeps invalid data as a 400", () => {
    const mapped = mapStoreCancellationError(
      cancellationErrors.missingCancellationReason("cc_123")
    )

    expect(mapped.status).toEqual(400)
    expect(mapped.type).toEqual(MedusaError.Types.INVALID_DATA)
  })

  it("unwraps a medusa error carried as a cause", () => {
    const wrapped = new Error("workflow failed")
    ;(wrapped as Error & { cause?: unknown }).cause =
      cancellationErrors.notFound("CancellationCase", "cc_123")

    expect(mapStoreCancellationError(wrapped).status).toEqual(404)
  })

  it("treats a lock acquisition failure as a retryable conflict", () => {
    const mapped = mapStoreCancellationError(
      new Error("Failed to acquire lock for key \"subscription:sub_123\"")
    )

    expect(mapped.status).toEqual(409)
    expect(mapped.type).toEqual(MedusaError.Types.CONFLICT)
    expect(mapped.message).not.toContain("sub_123")
  })

  it("treats a lock acquisition timeout as a retryable conflict", () => {
    const mapped = mapStoreCancellationError(
      new Error("Timed-out acquiring lock.")
    )

    expect(mapped.status).toEqual(409)
    expect(mapped.type).toEqual(MedusaError.Types.CONFLICT)
  })

  it("falls back to a generic failure for an unrecognised error", () => {
    const mapped = mapStoreCancellationError(new Error("kaboom"))

    expect(mapped.status).toEqual(500)
    expect(mapped.message).not.toContain("kaboom")
  })
})
