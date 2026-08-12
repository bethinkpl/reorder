import {
  computeSubscriptionDiscountAmount,
  roundCurrency,
} from "../subscription-discount"

describe("computeSubscriptionDiscountAmount", () => {
  it("computes a percentage discount off the line gross", () => {
    expect(
      computeSubscriptionDiscountAmount({
        discount_type: "percentage",
        discount_value: 20,
        line_gross_total: 100,
      })
    ).toBe(20)
  })

  it("rounds percentage results to currency precision", () => {
    expect(
      computeSubscriptionDiscountAmount({
        discount_type: "percentage",
        discount_value: 33,
        line_gross_total: 9.99,
      })
    ).toBe(3.3)
  })

  it("caps a fixed discount at the line gross", () => {
    expect(
      computeSubscriptionDiscountAmount({
        discount_type: "fixed",
        discount_value: 150,
        line_gross_total: 100,
      })
    ).toBe(100)
  })

  it("yields ground to discounts already applied by other actors", () => {
    expect(
      computeSubscriptionDiscountAmount({
        discount_type: "percentage",
        discount_value: 50,
        line_gross_total: 100,
        already_discounted_total: 80,
      })
    ).toBe(20)
  })

  it("returns 0 when the line is already fully discounted", () => {
    expect(
      computeSubscriptionDiscountAmount({
        discount_type: "fixed",
        discount_value: 10,
        line_gross_total: 100,
        already_discounted_total: 100,
      })
    ).toBe(0)
  })

  it("returns 0 for a non-positive line gross", () => {
    expect(
      computeSubscriptionDiscountAmount({
        discount_type: "percentage",
        discount_value: 10,
        line_gross_total: 0,
      })
    ).toBe(0)
  })
})

describe("roundCurrency", () => {
  it("rounds to two decimals", () => {
    expect(roundCurrency(1.239)).toBe(1.24)
    expect(roundCurrency(1.231)).toBe(1.23)
  })
})
