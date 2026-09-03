import { resolveCancelEffectiveAt } from "../finalize-cancellation"
import { SubscriptionStatus } from "../../../modules/subscription/types"

const cancelledAt = new Date("2026-03-01T12:00:00.000Z")
const futureRenewal = new Date("2026-03-15T00:00:00.000Z")
const pastRenewal = new Date("2026-02-15T00:00:00.000Z")

describe("resolveCancelEffectiveAt", () => {
  it("returns the cancellation moment when cancelling immediately", () => {
    expect(
      resolveCancelEffectiveAt({
        status: SubscriptionStatus.ACTIVE,
        next_renewal_at: futureRenewal,
        effective_at: "immediately",
        cancelled_at: cancelledAt,
      })
    ).toEqual(cancelledAt)
  })

  it("defaults to the cancellation moment when no timing is given", () => {
    expect(
      resolveCancelEffectiveAt({
        status: SubscriptionStatus.ACTIVE,
        next_renewal_at: futureRenewal,
        cancelled_at: cancelledAt,
      })
    ).toEqual(cancelledAt)
  })

  it("honours a remaining paid window for an active subscription", () => {
    expect(
      resolveCancelEffectiveAt({
        status: SubscriptionStatus.ACTIVE,
        next_renewal_at: futureRenewal,
        effective_at: "end_of_cycle",
        cancelled_at: cancelledAt,
      })
    ).toEqual(futureRenewal)
  })

  it("accepts a serialized renewal anchor", () => {
    expect(
      resolveCancelEffectiveAt({
        status: SubscriptionStatus.ACTIVE,
        next_renewal_at: futureRenewal.toISOString(),
        effective_at: "end_of_cycle",
        cancelled_at: cancelledAt,
      })
    ).toEqual(futureRenewal)
  })

  it("cancels immediately when the renewal anchor is already in the past", () => {
    expect(
      resolveCancelEffectiveAt({
        status: SubscriptionStatus.PAST_DUE,
        next_renewal_at: pastRenewal,
        effective_at: "end_of_cycle",
        cancelled_at: cancelledAt,
      })
    ).toEqual(cancelledAt)
  })

  it("cancels immediately when the renewal anchor is the cancellation moment", () => {
    expect(
      resolveCancelEffectiveAt({
        status: SubscriptionStatus.ACTIVE,
        next_renewal_at: cancelledAt,
        effective_at: "end_of_cycle",
        cancelled_at: cancelledAt,
      })
    ).toEqual(cancelledAt)
  })

  it("cancels immediately when there is no renewal anchor", () => {
    expect(
      resolveCancelEffectiveAt({
        status: SubscriptionStatus.ACTIVE,
        next_renewal_at: null,
        effective_at: "end_of_cycle",
        cancelled_at: cancelledAt,
      })
    ).toEqual(cancelledAt)
  })

  it("cancels immediately when the renewal anchor is unparseable", () => {
    expect(
      resolveCancelEffectiveAt({
        status: SubscriptionStatus.ACTIVE,
        next_renewal_at: "not-a-date",
        effective_at: "end_of_cycle",
        cancelled_at: cancelledAt,
      })
    ).toEqual(cancelledAt)
  })

  it("cancels a paused subscription immediately even with a future anchor", () => {
    expect(
      resolveCancelEffectiveAt({
        status: SubscriptionStatus.PAUSED,
        next_renewal_at: futureRenewal,
        effective_at: "end_of_cycle",
        cancelled_at: cancelledAt,
      })
    ).toEqual(cancelledAt)
  })
})
