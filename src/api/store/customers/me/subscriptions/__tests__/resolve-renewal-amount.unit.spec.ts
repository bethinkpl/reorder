import { resolveRenewalAmount } from "../utils"

function buildSubscription(
  overrides: Partial<Parameters<typeof resolveRenewalAmount>[0]> = {}
): Parameters<typeof resolveRenewalAmount>[0] {
  return {
    id: "sub_1",
    reference: "SUB-1",
    status: "active",
    next_renewal_at: null,
    frequency_interval: "month",
    frequency_value: 1,
    skip_next_cycle: false,
    ...overrides,
  }
}

describe("resolveRenewalAmount", () => {
  it("returns null when the source snapshot carries no unit price", () => {
    expect(resolveRenewalAmount(buildSubscription())).toBeNull()
    expect(
      resolveRenewalAmount(
        buildSubscription({ source_snapshot: { unit_price: null } })
      )
    ).toBeNull()
  })

  it("returns the line gross total when there is no plan discount", () => {
    expect(
      resolveRenewalAmount(
        buildSubscription({ source_snapshot: { unit_price: 29 } })
      )
    ).toBe(29)
  })

  it("multiplies by the snapshot quantity", () => {
    expect(
      resolveRenewalAmount(
        buildSubscription({ source_snapshot: { unit_price: 29, quantity: 2 } })
      )
    ).toBe(58)
  })

  it("falls back to a quantity of one for a missing or nonsensical quantity", () => {
    expect(
      resolveRenewalAmount(
        buildSubscription({ source_snapshot: { unit_price: 29, quantity: 0 } })
      )
    ).toBe(29)
  })

  it("applies a percentage plan discount", () => {
    expect(
      resolveRenewalAmount(
        buildSubscription({
          source_snapshot: { unit_price: 100 },
          pricing_snapshot: { discount_type: "percentage", discount_value: 10 },
        })
      )
    ).toBe(90)
  })

  it("applies a fixed plan discount", () => {
    expect(
      resolveRenewalAmount(
        buildSubscription({
          source_snapshot: { unit_price: 100 },
          pricing_snapshot: { discount_type: "fixed", discount_value: 15 },
        })
      )
    ).toBe(85)
  })

  it("never lets a fixed discount push the amount below zero", () => {
    expect(
      resolveRenewalAmount(
        buildSubscription({
          source_snapshot: { unit_price: 10 },
          pricing_snapshot: { discount_type: "fixed", discount_value: 40 },
        })
      )
    ).toBe(0)
  })

  it("ignores a non-positive discount value", () => {
    expect(
      resolveRenewalAmount(
        buildSubscription({
          source_snapshot: { unit_price: 29 },
          pricing_snapshot: { discount_type: "percentage", discount_value: 0 },
        })
      )
    ).toBe(29)
  })

  it("rounds to currency precision", () => {
    expect(
      resolveRenewalAmount(
        buildSubscription({
          source_snapshot: { unit_price: 29.99 },
          pricing_snapshot: { discount_type: "percentage", discount_value: 33 },
        })
      )
    ).toBe(20.09)
  })
})
