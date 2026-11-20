/** Serialises a subscription's renewal runs, charge settlements and the state changes that race them. */
export function renewalSubscriptionLockKey(subscriptionId: string) {
  return `renewal:subscription:${subscriptionId}`
}
