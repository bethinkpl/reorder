/** Stable event names the subscription flows emit for the host app to act on. */
export const SubscriptionEvents = {
  LATE_PAYMENT_CAPTURED: "subscription.late_payment_captured",
} as const

export type SubscriptionEventName =
  (typeof SubscriptionEvents)[keyof typeof SubscriptionEvents]

export enum LatePaymentCapturedReason {
  SUBSCRIPTION_TERMINAL = "subscription_terminal",
  CYCLE_CLOSED = "cycle_closed",
  CASE_CLOSED = "case_closed",
  ORDER_OVERPAID = "order_overpaid",
}

export type LatePaymentCapturedEventData = {
  subscription_id: string
  payment_id: string
  order_id: string | null
  payment_collection_id: string
  renewal_cycle_id?: string
  dunning_case_id?: string
  dunning_attempt_id?: string
  reason: LatePaymentCapturedReason
  /**
   * What the host should refund, in the payment's currency as Medusa stores it: the payment's
   * captured amount less its refunds, or for `order_overpaid` only the order's surplus not already
   * claimed by another reported capture, never more than that.
   */
  refund_amount: number
  currency_code: string
}
