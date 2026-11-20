# Admin Dunning API

This document describes the implemented Admin API contract for the `Dunning` area of the `Reorder` plugin.

It is the current runtime source of truth for:
- request parameters
- request bodies
- response shapes
- common error scenarios

All routes described here are custom Admin routes exposed by the plugin and intended for authenticated Medusa Admin users.

## Base Path

All routes are under:

`/admin/dunning`

## Authentication

All routes are Admin-only routes.

In implementation terms:
- the routes use `AuthenticatedMedusaRequest`
- request validation is handled through Medusa middleware and Zod schemas
- all mutations are executed through workflows rather than mutating data directly in the route handler

## Shared DTOs

The API responses are based on the Admin DTOs defined in:

- `src/admin/types/dunning.ts`

Main response types:
- `DunningCaseAdminListResponse`
- `DunningCaseAdminDetailResponse`
- `DunningCaseAdminListItem`
- `DunningCaseAdminDetail`
- `DunningAttemptAdminRecord`
- `DunningRetryScheduleSummary`

## Shared Domain Values

### Case Status Values

Supported dunning case statuses:
- `open`
- `retry_scheduled`
- `retrying`
- `awaiting_manual_resolution`
- `recovered`
- `unrecovered`

Current runtime meaning:
- `retry_scheduled`: the last retry failed with a retryable payment error and a future `next_retry_at` is scheduled
- `unrecovered`: the case is terminal and closed, either because the payment failure is treated as permanent or because retries are exhausted

### Attempt Status Values

Supported dunning attempt statuses:
- `processing`
- `succeeded`
- `failed`

## 1. List Dunning Cases

### Endpoint

- Method: `GET`
- Path: `/admin/dunning`

### Purpose

Returns the paginated dunning queue used by the Admin dunning DataTable.

### Query Parameters

Pagination and search:
- `limit?: number`
- `offset?: number`
- `q?: string`

Sorting:
- `order?: string`
- `direction?: "asc" | "desc"`

Filters:
- `status?: string | string[]`
- `subscription_id?: string`
- `renewal_cycle_id?: string`
- `renewal_order_id?: string`
- `payment_provider_id?: string`
- `last_payment_error_code?: string`
- `attempt_count_min?: number`
- `attempt_count_max?: number`
- `next_retry_from?: string`
- `next_retry_to?: string`
- `last_attempt_status?: string | string[]`

### Supported Sort Fields

Database-backed:
- `updated_at`
- `status`
- `next_retry_at`
- `attempt_count`
- `max_attempts`
- `last_attempt_at`

In-memory:
- `last_attempt_status`
- `subscription_reference`
- `customer_name`
- `product_title`
- `order_display_id`

### Success Response

Status:
- `200 OK`

Shape:

```json
{
  "dunning_cases": [
    {
      "id": "dc_123",
      "status": "retry_scheduled",
      "subscription": {
        "subscription_id": "sub_123",
        "reference": "SUB-001",
        "status": "past_due",
        "customer_name": "Jane Doe",
        "product_title": "Coffee Subscription",
        "variant_title": "1 kg",
        "sku": "COFFEE-1KG",
        "payment_provider_id": "pp_stripe_stripe"
      },
      "renewal": {
        "renewal_cycle_id": "re_123",
        "status": "failed",
        "scheduled_for": "2026-04-15T10:00:00.000Z",
        "generated_order_id": "order_123"
      },
      "order": {
        "order_id": "order_123",
        "display_id": 1001,
        "status": "pending"
      },
      "attempt_count": 1,
      "max_attempts": 3,
      "next_retry_at": "2026-04-16T10:00:00.000Z",
      "last_attempt_at": "2026-04-15T10:02:00.000Z",
      "last_payment_error_code": "card_declined",
      "updated_at": "2026-04-15T10:02:00.000Z"
    }
  ],
  "count": 1,
  "limit": 20,
  "offset": 0
}
```

### Common Errors

- `400 invalid_data`
  Invalid query parameter shape or unsupported query value.
- `400 invalid_data`
  Unsupported sort field.

## 2. Get Dunning Case Details

### Endpoint

- Method: `GET`
- Path: `/admin/dunning/:id`

### Purpose

Returns the full Admin detail payload for a single dunning case.

### Path Parameters

- `id: string`

### Success Response

Status:
- `200 OK`

Shape:

```json
{
  "dunning_case": {
    "id": "dc_123",
    "status": "retry_scheduled",
    "subscription": {
      "subscription_id": "sub_123",
      "reference": "SUB-001",
      "status": "past_due",
      "customer_name": "Jane Doe",
      "product_title": "Coffee Subscription",
      "variant_title": "1 kg",
      "sku": "COFFEE-1KG",
      "payment_provider_id": "pp_stripe_stripe"
    },
    "renewal": {
      "renewal_cycle_id": "re_123",
      "status": "failed",
      "scheduled_for": "2026-04-15T10:00:00.000Z",
      "generated_order_id": "order_123"
    },
    "order": {
      "order_id": "order_123",
      "display_id": 1001,
      "status": "pending"
    },
    "attempt_count": 1,
    "max_attempts": 3,
    "retry_schedule": {
      "strategy": "fixed_intervals",
      "intervals": [1440, 4320, 10080],
      "timezone": "UTC",
      "source": "default_policy"
    },
    "next_retry_at": "2026-04-16T10:00:00.000Z",
    "last_payment_error_code": "card_declined",
    "last_payment_error_message": "Declined",
    "last_attempt_at": "2026-04-15T10:02:00.000Z",
    "recovered_at": null,
    "closed_at": null,
    "recovery_reason": null,
    "attempts": [
      {
        "id": "da_123",
        "attempt_no": 1,
        "status": "failed",
        "started_at": "2026-04-15T10:00:00.000Z",
        "finished_at": "2026-04-15T10:02:00.000Z",
        "error_code": "card_declined",
        "error_message": "Declined",
        "payment_reference": null,
        "metadata": null
      }
    ],
    "awaiting_payment": null,
    "metadata": {
      "origin": "renewal_payment_failure"
    },
    "created_at": "2026-04-15T10:00:00.000Z",
    "updated_at": "2026-04-15T10:02:00.000Z"
  }
}
```

Notes:
- `awaiting_payment` describes the retry charge still waiting for the payment provider's answer, and is `null` unless
  the case is `awaiting_payment` with its latest attempt still `processing`:

  ```json
  {
    "submitted_at": "2026-04-15T10:00:00.000Z",
    "can_fail_after": "2026-04-19T10:00:00.000Z"
  }
  ```

  `submitted_at` is when the latest attempt started; `can_fail_after` is `submitted_at` plus
  `RENEWAL_AWAITING_PAYMENT_RESOLVE_MIN_HOURS`, the moment after which an unpaid charge can be resolved as failed
  through `POST /admin/dunning/:id/resolve-awaiting-payment` (section 7)

### Common Errors

- `404 not_found`
  The dunning case does not exist.

## 3. Retry Now

### Endpoint

- Method: `POST`
- Path: `/admin/dunning/:id/retry-now`

### Purpose

Runs the shared dunning payment retry workflow immediately, ignoring `next_retry_at`.

Current runtime behavior:
- retryable payment failures keep the case in `retry_scheduled`
- permanent payment failures close the case as `unrecovered`

### Request Body

```json
{
  "reason": "manual retry from admin"
}
```

`reason` is optional.

### Success Response

Status:
- `200 OK`

Returns the refreshed `dunning_case` detail payload.

### Common Errors

- `400 invalid_data`
  The case has no renewal order or no retry schedule.
- `404 not_found`
  The case does not exist.
- `409 conflict`
  Retry is already processing, the case is terminal, or the transition is otherwise illegal.

## 4. Mark Recovered

### Endpoint

- Method: `POST`
- Path: `/admin/dunning/:id/mark-recovered`

### Purpose

Closes the case as recovered through a workflow-backed manual operator action. Runs under the case's `dunning:<id>` lock, so it can't interleave with a retry or a payment signal.

### Request Body

```json
{
  "reason": "paid outside normal retry flow"
}
```

`reason` is optional.

### Success Response

Status:
- `200 OK`

Returns the refreshed `dunning_case` detail payload.

### Common Errors

- `404 not_found`
  The case does not exist.
- `409 conflict`
  The case is already recovered, already unrecovered, or its retry charge is in flight (`retrying` or `awaiting_payment`). The response `message` says which.

## 5. Mark Unrecovered

### Endpoint

- Method: `POST`
- Path: `/admin/dunning/:id/mark-unrecovered`

### Purpose

Closes the case as unrecovered through a workflow-backed manual operator action. Runs under the case's `dunning:<id>` lock, so it can't interleave with a retry or a payment signal.

### Request Body

```json
{
  "reason": "customer refused to update payment method"
}
```

`reason` is required.

### Success Response

Status:
- `200 OK`

Returns the refreshed `dunning_case` detail payload.

### Common Errors

- `404 not_found`
  The case does not exist.
- `409 conflict`
  The case is already recovered, already unrecovered, or its retry charge is in flight (`retrying` or `awaiting_payment`). The response `message` says which.

## 6. Update Retry Schedule

### Endpoint

- Method: `POST`
- Path: `/admin/dunning/:id/retry-schedule`

### Purpose

Overrides the retry policy for one case and updates future automatic retries.

### Request Body

```json
{
  "reason": "short manual retry schedule",
  "intervals": [60, 120],
  "max_attempts": 2
}
```

Rules:
- `intervals` must contain positive integers
- `max_attempts` must be positive
- `max_attempts` must equal the number of retry intervals

### Success Response

Status:
- `200 OK`

Returns the refreshed `dunning_case` detail payload.

### Common Errors

- `400 invalid_data`
  Invalid payload shape or invalid schedule semantics.
- `404 not_found`
  The case does not exist.
- `409 conflict`
  The case is terminal, retry is in flight, or the override would create an illegal transition.

## 7. Resolve Awaiting Payment

### Endpoint

- Method: `POST`
- Path: `/admin/dunning/:id/resolve-awaiting-payment`

### Purpose

Operator escape hatch for a case whose retry charge was submitted but whose result never arrived (status `awaiting_payment`). Runs under the case's `dunning:<id>` lock:

- when the case's renewal order is already paid (`pending_difference <= 0`), the case is recovered exactly as a `payment.captured` for its in-flight attempt would recover it (the attempt closes as `succeeded` when the capture is on its session, and `subscription.dunning_recovered` is emitted)
- otherwise, once the in-flight attempt was submitted longer ago than the minimum age (`RENEWAL_AWAITING_PAYMENT_RESOLVE_MIN_HOURS`, default `96`; see the renewals API), the attempt is failed exactly as a failure webhook would fail it (error code `resolved_unpaid`): the case is rescheduled, or closed as `unrecovered` on its last attempt, with the same events
- otherwise the request is refused, because the payment may still arrive

### Request Body

```json
{
  "reason": "bank confirmed no transfer"
}
```

`reason` is optional; when given it is added to the failed attempt's error message.

### Success Response

Status:
- `200 OK`

Returns the refreshed `dunning_case` detail payload plus `resolution`: `recovered` or `failed`.

### Common Errors

- `400 invalid_data`
  Invalid payload shape.
- `404 not_found`
  The case does not exist.
- `409 conflict`
  The case isn't awaiting its retry's payment, its unpaid charge is younger than the minimum age, or another holder has the case's lock.

## 8. Error Mapping

The admin dunning route layer answers a domain error with its own message and a status taken from its
`MedusaError` type, also when a workflow run rethrows it as a plain object:

- `404`
  for `not_found`
- `400`
  for `invalid_data` (for example a retry of a case without a renewal order)
- `409`
  for `conflict` and `not_allowed` (domain conflicts and illegal transitions), and for a payment the provider refused
- `500`
  for any other `MedusaError` type

An error without a `MedusaError` type (for example a lock held by another run) is mapped from its message: `404`
when it reports something not found, `400` for invalid or missing input, `409` otherwise. The renewal and
cancellation admin routes apply the same rules (`src/api/route-errors.ts`).

This keeps the API aligned with the workflow-driven Medusa pattern used by the rest of the plugin.
