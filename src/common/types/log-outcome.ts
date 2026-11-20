/** The `outcome` of a renewal or dunning log line. */
export type OperationLogOutcome =
  | "started"
  | "succeeded"
  | "failed"
  | "blocked"
  | "completed"
  | "awaiting_payment"
