import { MedusaError, serializeError } from "@medusajs/framework/utils"
import { mapStoreCancellationError } from "../route"
import { cancellationErrors } from "../../../../../../../../modules/cancellation/utils/errors"
import { dunningErrors } from "../../../../../../../../modules/dunning/utils/errors"
import { renewalSubscriptionLockKey } from "../../../../../../../../modules/renewal/utils/lock-key"
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

  it.each([
    {
      name: "an in-flight retry",
      error: {
        __isMedusaError: true,
        type: MedusaError.Types.CONFLICT,
        message: "DunningCase 'dc_123' can't be closed for subscription cancellation while retry is in flight",
      },
      message: /payment recovery/,
    },
    {
      name: "a lock acquisition failure",
      error: { name: "Error", message: `Failed to acquire lock for key "${renewalSubscriptionLockKey("sub_123")}"` },
      message: /already being updated/,
    },
    {
      name: "a lock another owner inserted first",
      error: { name: "Error", message: `"${renewalSubscriptionLockKey("sub_123")}" is already locked.` },
      message: /already being updated/,
    },
    {
      name: "a lock timeout the provider raised as a conflict",
      error: serializeError(new MedusaError(MedusaError.Types.CONFLICT, "Timed-out acquiring lock.")),
      message: /already being updated/,
    },
    {
      name: "a transition the workflow does not allow",
      error: serializeError(new MedusaError(MedusaError.Types.NOT_ALLOWED, "Subscription 'sub_123' can't be cancelled")),
      message: /can't be cancelled right now/,
    },
  ])("reads $name that a workflow rethrew as a serialised plain object", ({ error, message }) => {
    const mapped = mapStoreCancellationError(error)

    expect(mapped.status).toEqual(409)
    expect(mapped.type).toEqual(MedusaError.Types.CONFLICT)
    expect(mapped.message).toMatch(message)
  })

  it("falls back to a generic failure for an unrecognised error", () => {
    const mapped = mapStoreCancellationError(new Error("kaboom"))

    expect(mapped.status).toEqual(500)
    expect(mapped.message).not.toContain("kaboom")
  })
})
