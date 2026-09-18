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
- exposed the same `setPaymentSessionData` hook in `runDunningRetryWorkflow` (input: `{ subscription: { id, payment_context } }`) so dunning retries use the host app's payment session payload, falling back to the stock Stripe payload when no handler is registered
- dunning now emits five lifecycle events (names exported as `DunningEvents` from `@bethinkpl/reorder/modules/dunning`) for the host app to notify customers on: `subscription.dunning_started` (`{ subscription_id, dunning_case_id, renewal_cycle_id, attempt_count, next_retry_at }`, fired only when a case is created — a repeated failure on the same renewal cycle re-enters the existing case and stays silent), `subscription.dunning_attempt_failed` (`{ subscription_id, dunning_case_id, attempt_no, error_code, next_retry_at }`, fired when a retry failed and another one is scheduled), `subscription.payment_failed` (`{ subscription_id, dunning_case_id, recovery_reason }`, fired only by the run that actually moves the subscription to `payment_failed`, from either the exhausted retry loop or the admin "mark unrecovered" action — a later settlement of an already-`payment_failed` subscription stays silent), `subscription.dunning_parked` (`{ subscription_id, dunning_case_id, attempt_no, park_reason, error_code }`, fired when a retry is handed to an operator instead of being settled or rescheduled; `park_reason` is one of `setup_failure`, `requires_action`, `unreached_provider` or `indeterminate_provider_response`) and `subscription.dunning_recovered` (`{ subscription_id, dunning_case_id, renewal_order_id, recovery_reason }`, fired when a case closes as recovered — `recovery_reason` is `payment_recovered` when a scheduled retry collected it and `customer_payment` when the customer paid the renewal order themselves through the host app, which also settles the renewal cycle, advances the billing dates and hands the subscription back to `active`). Delivery is at-most-once and immediate: each event is dispatched as soon as its emitting step runs, once the module writes that triggered it have committed, so a later step failing in the same workflow (e.g. the lock release) cannot retract an event that already went out, and a rejecting bus is never retried. Emitting never fails the workflow either — an event bus that rejects is logged as an `alertable` dunning error and the case keeps its state
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