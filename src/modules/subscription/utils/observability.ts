export const SubscriptionLogEvents = {
  PAYMENT_CAPTURED_ON_TERMINAL_SUBSCRIPTION: "payment_captured_on_terminal_subscription",
  DUNNING_RECOVERY_FROM_CAPTURE_FAILED: "dunning_recovery_from_capture_failed",
  RENEWAL_SETTLEMENT_FROM_CAPTURE_FAILED: "renewal_settlement_from_capture_failed",
  RENEWAL_PAYMENT_FAILURE_HANDLING_FAILED: "renewal_payment_failure_handling_failed",
  DUNNING_PAYMENT_FAILURE_HANDLING_FAILED: "dunning_payment_failure_handling_failed",
  TRACKED_CAPTURE_RECONCILIATION_FAILED: "tracked_capture_reconciliation_failed",
} as const
