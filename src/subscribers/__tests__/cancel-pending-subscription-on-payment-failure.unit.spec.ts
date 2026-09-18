import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules, PaymentActions } from "@medusajs/framework/utils"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import { SubscriptionStatus } from "../../modules/subscription/types"
import { cancelPendingSubscriptionOnPaymentFailure } from "../cancel-pending-subscription-on-payment-failure"

type Staged = Record<string, unknown[]>

type UpdateCall = Record<string, unknown>

const webhookEvent = {
  provider: "stripe-checkout-session",
  payload: { data: {}, rawData: Buffer.from("{}"), headers: {} },
}

function defaultStaged(): Staged {
  return {
    payment_session: [{ id: "payses_1", payment_collection_id: "paycol_1" }],
    cart_payment_collection: [{ cart_id: "cart_1" }],
    subscription: [
      {
        id: "sub_1",
        status: SubscriptionStatus.PENDING_PAYMENT,
        metadata: { source_order_id: "order_1" },
      },
    ],
  }
}

function buildContainer(options: {
  staged: Staged
  action: string
  sessionId?: string | null
  captured: UpdateCall[]
}) {
  const { staged, action, sessionId = "payses_1", captured } = options

  return {
    resolve(key: string) {
      if (key === ContainerRegistrationKeys.QUERY) {
        return {
          graph: async ({ entity }: { entity: string }) => ({ data: staged[entity] ?? [] }),
        }
      }

      if (key === Modules.PAYMENT) {
        return {
          getWebhookActionAndData: async () => ({
            action,
            data: sessionId ? { session_id: sessionId } : {},
          }),
        }
      }

      if (key === SUBSCRIPTION_MODULE) {
        return {
          updateSubscriptions: async (input: UpdateCall) => {
            captured.push(input)

            return input
          },
        }
      }

      if (key === "logger") {
        return { info: () => {}, warn: () => {} }
      }

      throw new Error(`Unexpected resolve('${key}')`)
    },
  } as unknown as MedusaContainer
}

const run = (options: Parameters<typeof buildContainer>[0]) =>
  cancelPendingSubscriptionOnPaymentFailure(buildContainer(options), webhookEvent as never)

describe("cancelPendingSubscriptionOnPaymentFailure", () => {
  it.each([PaymentActions.CANCELED, PaymentActions.FAILED])(
    "cancels the pending subscription when the provider reports '%s'",
    async (action) => {
      const captured: UpdateCall[] = []

      await run({ staged: defaultStaged(), action, captured })

      expect(captured).toHaveLength(1)
      expect(captured[0]).toMatchObject({
        id: "sub_1",
        status: SubscriptionStatus.CANCELLED,
        next_renewal_at: null,
      })
      expect(captured[0]!.metadata).toMatchObject({
        source_order_id: "order_1",
        cancellation_reason: "initial_payment_abandoned",
      })
    }
  )

  it.each([PaymentActions.SUCCESSFUL, PaymentActions.AUTHORIZED, PaymentActions.NOT_SUPPORTED])(
    "ignores the non-failure action '%s'",
    async (action) => {
      const captured: UpdateCall[] = []

      await run({ staged: defaultStaged(), action, captured })

      expect(captured).toEqual([])
    }
  )

  it("ignores an event that carries no payment session", async () => {
    const captured: UpdateCall[] = []

    await run({
      staged: defaultStaged(),
      action: PaymentActions.CANCELED,
      sessionId: null,
      captured,
    })

    expect(captured).toEqual([])
  })

  it.each([
    SubscriptionStatus.ACTIVE,
    SubscriptionStatus.PAST_DUE,
    SubscriptionStatus.CANCELLED,
    SubscriptionStatus.PAYMENT_FAILED,
  ])("leaves a subscription already past the pending stage alone (%s)", async (status) => {
    const captured: UpdateCall[] = []
    const staged = defaultStaged()
    ;(staged.subscription[0] as { status: SubscriptionStatus }).status = status

    await run({ staged, action: PaymentActions.CANCELED, captured })

    expect(captured).toEqual([])
  })

  it("does nothing when the session maps to no cart", async () => {
    const captured: UpdateCall[] = []
    const staged = defaultStaged()
    staged.cart_payment_collection = []

    await run({ staged, action: PaymentActions.CANCELED, captured })

    expect(captured).toEqual([])
  })

  it("does nothing when the cart maps to no subscription", async () => {
    const captured: UpdateCall[] = []
    const staged = defaultStaged()
    staged.subscription = []

    await run({ staged, action: PaymentActions.CANCELED, captured })

    expect(captured).toEqual([])
  })
})
