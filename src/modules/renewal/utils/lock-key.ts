export function renewalSubscriptionLockKey(subscriptionId: string) {
  return `renewal:subscription:${subscriptionId}`
}
