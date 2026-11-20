/**
 * `error_code` written on a renewal or dunning attempt that is closed without a provider's
 * failure report for its charge.
 */
export enum PaymentAttemptErrorCode {
  CAPTURED_AFTER_CLOSE = "captured_after_close",
  NO_PAYMENT_SIGNAL = "no_payment_signal",
  RESOLVED_UNPAID = "resolved_unpaid",
  SUBSCRIPTION_CANCELLED = "subscription_cancelled",
}
