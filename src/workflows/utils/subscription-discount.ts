export type SubscriptionDiscountComputation = {
  discount_type: "percentage" | "fixed"
  discount_value: number
  line_gross_total: number
  /**
   * Sum of discounts already applied to the line by other actors (e.g. promotion
   * adjustments). The subscription discount yields ground to them so that the
   * combined discount can never exceed the line gross total.
   */
  already_discounted_total?: number
}

export function roundCurrency(amount: number) {
  return Math.round(amount * 100) / 100
}

export function computeSubscriptionDiscountAmount({
  discount_type,
  discount_value,
  line_gross_total,
  already_discounted_total = 0,
}: SubscriptionDiscountComputation): number {
  if (line_gross_total <= 0) {
    return 0
  }

  const requested =
    discount_type === "percentage"
      ? roundCurrency((line_gross_total * discount_value) / 100)
      : roundCurrency(Math.min(discount_value, line_gross_total))

  const remaining = roundCurrency(
    Math.max(0, line_gross_total - already_discounted_total)
  )

  return roundCurrency(Math.max(0, Math.min(requested, remaining)))
}
