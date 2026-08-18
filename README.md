# `@bethinkpl/reorder`
Customized fork of [@reorder/reorderjs](https://github.com/reorder-js/reorder).
## Changes
### New features
- added day granularity for frequency intervals
### Improvements / Fixes
- prevents executing `POST /store/carts/{cartId}/complete` for carts containing subscription items
- behaviour of `POST /store/carts/{cartId}/subscribe` matches it's non-subscription counterpart more closely (dropped `subscription` field, supports query params and uses same defaults)
- shipping address is optional when item(s) in subscription cart don't require shipping (i.e.: `item.requires_shipping = false`)
- exposed `setPaymentSessionData` hook in `processRenewalCycleWorkflow` for provider-agnostic payment handling during renewals
- completing subscription cart no longer requires payment method to be already saved at that point of time, instead it's info is backfilled after payment is captured
- renewal orders recompute the subscription plan discount instead of billing full catalog price (frozen `pricing_snapshot` first, live plan config on plan change), with a combined-discount clamp applied on both checkout and renewals
- exposed `resolveRenewalAdjustments` hook in `processRenewalCycleWorkflow` so the host app can add its own (code-less) discounts to renewal orders, and `subscriptionCreated` hook in `createSubscriptionFromCartWorkflow` for reacting to genuine subscription creation
- `source_snapshot` now truthfully captures the initial order's adjustments and tax lines (audit-only — renewals deliberately no longer replay them)
- renewal cycles stranded in PROCESSING by an unhandled failure between steps are now marked FAILED via compensation, keeping them retryable
### QoL
- addition of eslint lint rules
- improved test setup

#
*Content of README.md WIP*