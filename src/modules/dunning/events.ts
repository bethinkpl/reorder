/** Stable event names the dunning flow emits for the host app to notify on. */
export const DunningEvents = {
  STARTED: "subscription.dunning_started",
  ATTEMPT_FAILED: "subscription.dunning_attempt_failed",
  PAYMENT_FAILED: "subscription.payment_failed",
  PARKED: "subscription.dunning_parked",
  RECOVERED: "subscription.dunning_recovered",
} as const

export type DunningEventName = (typeof DunningEvents)[keyof typeof DunningEvents]
