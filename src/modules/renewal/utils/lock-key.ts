/** The lock a renewal run holds while it charges, and that every write racing it takes too. */
export function renewalSubscriptionLockKey(subscriptionId: string) {
  return `renewal:subscription:${subscriptionId}`
}
