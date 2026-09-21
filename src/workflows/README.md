# Custom Workflows

A workflow is a series of queries and actions that complete a task.

The workflow is created in a TypeScript or JavaScript file under the `src/workflows` directory.

For example:

```ts
import {
  createStep,
  createWorkflow,
  WorkflowResponse,
  StepResponse,
} from "@medusajs/framework/workflows-sdk"

const step1 = createStep("step-1", async () => {
  return new StepResponse(`Hello from step one!`)
})

type WorkflowInput = {
  name: string
}

const step2 = createStep(
  "step-2",
  async ({ name }: WorkflowInput) => {
    return new StepResponse(`Hello ${name} from step two!`)
  }
)

type WorkflowOutput = {
  message1: string
  message2: string
}

const helloWorldWorkflow = createWorkflow(
  "hello-world",
  (input: WorkflowInput) => {
    const greeting1 = step1()
    const greeting2 = step2(input)
    
    return new WorkflowResponse({
      message1: greeting1,
      message2: greeting2
    })
  }
)

export default helloWorldWorkflow
```

## Execute Workflow

You can execute the workflow from other resources, such as API routes, scheduled jobs, or subscribers.

For example, to execute the workflow in an API route:

```ts
import type {
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework"
import myWorkflow from "../../../workflows/hello-world"

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
) {
  const { result } = await myWorkflow(req.scope)
    .run({
      input: {
        name: req.query.name as string,
      },
    })

  res.send(result)
}
```

## Extensibility Hooks

### `processRenewalCycleWorkflow` — `setPaymentSessionData`

`processRenewalCycleWorkflow` exposes a `setPaymentSessionData` hook that lets you control the
`data` passed to the payment session created for a renewal's payment collection. Register a
handler the same way you would consume any Medusa workflow hook:

```ts
import { processRenewalCycleWorkflow } from "@bethinkpl/reorder/workflows"
import { StepResponse } from "@medusajs/framework/workflows-sdk"

processRenewalCycleWorkflow.hooks.setPaymentSessionData(
  ({ payment_collections, subscription, order }) => {
    return new StepResponse({
      payment_method: subscription.payment_context?.payment_method_id,
      off_session: true,
      confirm: true,
      capture_method: "automatic",
      metadata: { renewal_order_id: order?.id },
    })
  }
)
```

- The handler receives the created `payment_collections`, the `subscription`, and the renewal
  `order`. It runs once per renewal cycle.
- The result is validated with zod and must be a record of string keys to arbitrary values
  (`Record<string, unknown>`). Return `undefined` to keep the built-in default payment session
  data (`payment_method`, `off_session`, `confirm`, `capture_method`).
- When a handler returns a value it **completely replaces** the default `data` — there is no
  merge, so include every field your payment provider needs.
- When the renewal is skipped or the order total is `0`, no payment session is created;
  `payment_collections` and `order` are `null` and the handler result is ignored.

### `processRenewalCycleWorkflow` — `resolveRenewalAdjustments`

Lets the host app contribute discounts to the renewal order's line item — e.g. replaying a
promotion the customer redeemed at signup on every billing period. It runs after the renewal
items are built and before the order is created:

```ts
import { processRenewalCycleWorkflow } from "@bethinkpl/reorder/workflows"
import { StepResponse } from "@medusajs/framework/workflows-sdk"

processRenewalCycleWorkflow.hooks.resolveRenewalAdjustments(
  async ({ subscription, renewal_cycle_id, currency_code, line_gross_total, items }, { container }) => {
    // look up app-side discount terms for subscription.id ...
    return new StepResponse([
      {
        amount: 500,
        description: "Discount (SPRING20)",
        provider_id: "promotion_recurring",
        promotion_id: "promo_123",
      },
    ])
  }
)
```

- The handler receives the `subscription`, `renewal_cycle_id`, the cart's `currency_code`, the
  pre-discount `line_gross_total`, and the built order `items`. `line_gross_total` is `null` on
  a skipped cycle and on one that applies a pending plan change (such cycles carry no
  discounts) — return `undefined` in that case.
- The result is validated with zod: an optional array of `{ amount, description?, provider_id?,
  promotion_id? }`. **There is deliberately no `code` field** — `createOrderWorkflow` refreshes
  promotions with REPLACE semantics and deletes every adjustment carrying a string code; the
  plugin only writes code-less adjustments so they survive. Unknown keys are stripped.
- Amounts are clamped by the plugin: the plan discount applies first, hook adjustments consume
  what remains of the line gross, and the combined total never exceeds it.
- Return `undefined` (or an empty array) for "no app discounts". A thrown error fails the
  renewal — the workflow reverts, and the cycle plus its attempt are marked FAILED (retryable)
  instead of the customer being charged an undiscounted amount.

### `processRenewalCycleWorkflow` — `resolveRenewalBillingAddress`

Lets the host app say which address a renewal order is billed to, instead of the one frozen on the
subscription's source cart at the first checkout. Use it where the buyer's billing identity lives in
the app rather than on the cart — a customer record they can edit — so every cycle bills to the
current details:

```ts
import { processRenewalCycleWorkflow } from "@bethinkpl/reorder/workflows"
import { StepResponse } from "@medusajs/framework/workflows-sdk"

processRenewalCycleWorkflow.hooks.resolveRenewalBillingAddress(
  async ({ subscription, renewal_cycle_id }, { container }) => {
    // look up the customer's current billing address for subscription.customer_id ...
    return new StepResponse({
      company: "ACME sp. z o.o.",
      address_1: "Nowa 2",
      city: "Poznan",
      postal_code: "60-688",
      country_code: "pl",
      metadata: { tax_id: "1234567890" },
    })
  }
)
```

- The handler receives the `subscription` and the `renewal_cycle_id`, and runs once per cycle —
  including a cycle that is skipped or that creates no order, where the result is simply ignored.
- The result is validated with zod: an optional object of `{ first_name?, last_name?, company?,
  address_1?, address_2?, city?, province?, postal_code?, country_code, phone?, metadata? }`.
  **`country_code` is required** — an order billed to an address without one is charged before
  anything discovers it cannot be invoiced. `metadata` is part of the contract because that is where
  a tax id travels; unknown keys are stripped.
- Return `undefined` for "I have no opinion": the order then bills to `cart.billing_address`, exactly
  as it did before this hook existed.
- Answering with a **partial** address is not the same thing. The validator runs `parse`, so an
  object missing `country_code` throws and the cycle fails (retryable) rather than quietly billing to
  the frozen address. A handler that cannot resolve a complete address should return `undefined`.
- The resolved address is also passed as `additional_data.billing_address` on `createOrderWorkflow`,
  so a host app pricing on the buyer's identity (`setPricingContext`) sees it. That only affects a
  cycle whose line is priced live — one applying a pending plan change; every other cycle prices from
  the frozen `source_snapshot`.
- **A retried cycle keeps the address it was created with.** Once the order exists it is reused
  rather than re-created (see the renewal-order reuse note), and nothing rewrites its address.
- A thrown error fails the renewal — the workflow reverts, and the cycle plus its attempt are marked
  FAILED (retryable). Prefer that to returning a half-known address: a wrong one is charged and
  invoiced before anyone notices.

### `createSubscriptionFromCartWorkflow` — `subscriptionCreated`

Fires after a subscription record, its commerce links, and its initial renewal cycle are
created in the subscribe flow — and only on genuine creation, never on the idempotent replay
path for a cart that already has a subscription. Use it to react to the new subscription, e.g.
capturing discount terms from the initial order.

This hook is registrable at runtime but absent from the workflow's hook types (it is declared
inside a conditional branch; including branch hooks in the typed hook surface corrupts the
composed flow — core's `completeCartWorkflow` has the same limitation with `orderCreated`).
Import the workflow via its deep path and cast:

```ts
import {
  createSubscriptionFromCartWorkflow,
  type SubscriptionCreatedHook,
} from "@bethinkpl/reorder/subscription-flows/create-subscription-from-cart"
import { StepResponse } from "@medusajs/framework/workflows-sdk"

const hooks = createSubscriptionFromCartWorkflow.hooks as unknown as {
  subscriptionCreated: SubscriptionCreatedHook
}

hooks.subscriptionCreated(async ({ subscription_id, order_id, cart_id, customer_id }, { container }) => {
  // capture discount terms, notify systems, ...
  return new StepResponse(undefined)
})
```

- The handler receives `{ subscription_id, order_id, cart_id, customer_id }` and its result is
  ignored (`z.void().optional()`).
- `createSubscriptionFromCartWorkflow` is intentionally not re-exported from
  `@bethinkpl/reorder/workflows`: its composition is order-sensitive, so it must only be
  composed once — by the app's resource loaders. Import the deep path shown above.
