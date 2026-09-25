import { resolvePaymentCollection } from "../resolve-payment-collection"

describe("resolvePaymentCollection", () => {
  it("takes the first record when the workflow created a collection", () => {
    expect(resolvePaymentCollection([{ id: "pay_col_1" }, { id: "pay_col_2" }])).toEqual({
      id: "pay_col_1",
    })
  })

  it("takes the bare record when the workflow updated an existing collection", () => {
    expect(resolvePaymentCollection({ id: "pay_col_1" })).toEqual({ id: "pay_col_1" })
  })

  it("answers null when there is nothing to charge against", () => {
    expect(resolvePaymentCollection([])).toBeNull()
    expect(resolvePaymentCollection(null)).toBeNull()
    expect(resolvePaymentCollection(undefined)).toBeNull()
  })
})
