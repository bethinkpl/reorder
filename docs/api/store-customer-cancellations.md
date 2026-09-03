# Store Customer Subscriptions

This document describes the current customer-facing Store API for subscription account actions.

## Endpoints

### `GET /store/customers/me/subscriptions`

Returns the authenticated customer's subscriptions with storefront summary data:
- `id`
- `reference`
- `status`
- `product_title`
- `variant_title`
- `next_renewal_at`
- `cancelled_at`
- `cancel_effective_at`
- `active_cancellation_case`

Authentication:
- customer auth required

Note that `active_cancellation_case` is only ever populated for cases left over from the removed operator-approval flow. Customer cancellations finalize immediately, so a cancelled subscription is recognised from `status` plus `cancel_effective_at`.

### `GET /store/customers/me/subscriptions/:id`

Returns storefront-safe subscription detail data:
- `id`
- `reference`
- `status`
- `product_title`
- `variant_title`
- `frequency_interval`
- `frequency_value`
- `next_renewal_at`
- `effective_next_renewal_at`
- `last_renewal_at`
- `cancelled_at`
- `cancel_effective_at`
- `shipping_address`
- `payment_status`
- `payment_provider_id`
- `payment_recovery`
- `scheduled_plan_change`
- `active_cancellation_case`

Authentication and ownership:
- customer auth required
- the subscription must belong to the authenticated customer

### `POST /store/customers/me/subscriptions/:id/pause`

Pauses the authenticated customer's subscription through the existing pause workflow.

Request body:

```json
{
  "reason": "Taking a short break",
  "effective_at": "2026-04-15T10:00:00.000Z"
}
```

Response:
- refreshed subscription detail payload
- payload includes `scheduled_plan_change` when a pending variant or cadence update exists
- payload includes both `next_renewal_at` and projected `effective_next_renewal_at`

### `POST /store/customers/me/subscriptions/:id/resume`

Resumes the authenticated customer's subscription through the existing resume workflow.

Request body:

```json
{
  "resume_at": "2026-04-20T10:00:00.000Z",
  "preserve_billing_anchor": true
}
```

Response:
- refreshed subscription detail payload

### `POST /store/customers/me/subscriptions/:id/change-frequency`

Schedules a cadence change for the authenticated customer's subscription.

Request body:

```json
{
  "frequency_interval": "month",
  "frequency_value": 2,
  "effective_at": "2026-05-01T10:00:00.000Z"
}
```

Notes:
- the current variant stays unchanged
- cadence is validated against active `Plans & Offers`

Response:
- refreshed subscription detail payload

### `POST /store/customers/me/subscriptions/:id/change-address`

Updates the subscription shipping address.

Request body:

```json
{
  "first_name": "Jane",
  "last_name": "Doe",
  "address_1": "Main Street 1",
  "city": "Copenhagen",
  "postal_code": "2100",
  "country_code": "dk"
}
```

Response:
- refreshed subscription detail payload

### `POST /store/customers/me/subscriptions/:id/skip-next-delivery`

Marks the next renewal cycle as skipped.

Request body:
- no request body

Response:
- refreshed subscription detail payload

### `POST /store/customers/me/subscriptions/:id/swap-product`

Schedules a product or variant swap for the subscription.

Request body:

```json
{
  "variant_id": "variant_123",
  "frequency_interval": "month",
  "frequency_value": 1,
  "effective_at": "2026-05-01T10:00:00.000Z"
}
```

Notes:
- uses the same plan-change workflow as admin
- target variant must belong to the subscription product and be allowed by active `Plans & Offers`

Response:
- refreshed subscription detail payload

### `POST /store/customers/me/subscriptions/:id/retry-payment`

Runs a manual payment retry for a retry-eligible subscription recovery case.

Request body:

```json
{
  "reason": "Customer requested immediate retry"
}
```

Response:
- refreshed subscription detail payload
- route returns `409` if there is no retry-eligible payment recovery case

### `POST /store/customers/me/subscriptions/:id/cancellation`

Cancels the authenticated customer's subscription. There is no approval step: the request opens a `CancellationCase` and finalizes it in the same workflow run.

Entry context:
- storefront customer request, recorded on the case as `origin: "customer_cancel_intent"` and on the activity log as `source: "storefront"`

Request body:

```json
{
  "reason": "Too expensive right now",
  "reason_category": "price",
  "notes": "Customer cancelled from storefront"
}
```

Cancellation timing:
- the subscription moves to `cancelled` immediately, and `cancel_effective_at` marks the end of the paid cycle
- `cancel_effective_at` is `next_renewal_at` whenever that anchor is still in the future, and the cancellation moment when it has already passed (a past-due subscription never paid for the new cycle). A paused subscription keeps its preserved anchor and is treated exactly like an active one, so pausing before cancelling never costs the customer paid time.
- no proration and no refund is issued
- access for the remaining paid window is enforced by the consuming application, which reads `cancel_effective_at`; the plugin only records and exposes it

Side effects:
- any open payment recovery case is closed as `unrecovered` with `recovery_reason: "subscription_cancelled_by_customer"`, so no further retries run
- the upcoming scheduled renewal cycle is removed; any historical `failed` cycle is left in place but can no longer execute, because renewal execution rejects a cancelled subscription

Authentication and ownership:
- customer auth required
- the subscription must belong to the authenticated customer

Response:
- refreshed subscription detail payload plus a `result` object (`cancelled`, `already_cancelled`, `cancel_effective_at`)
- cancelling an already-cancelled subscription returns `200` and leaves the original cancellation untouched
- route returns `409` if a payment retry is in flight, or if the subscription is otherwise not cancellable

## Auth Model

- all routes require `authenticate("customer", ["session", "bearer"])`
- ownership is validated against the authenticated customer's `actor_id`
