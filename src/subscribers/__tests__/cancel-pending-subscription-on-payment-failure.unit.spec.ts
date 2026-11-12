jest.mock("../../workflows/utils/fail-awaiting-renewal-cycle", () => ({
  failAwaitingRenewalCycle: jest.fn(),
}))

jest.mock("../../workflows/utils/fail-awaiting-dunning-attempt", () => ({
  failAwaitingDunningAttempt: jest.fn(),
}))

import type { MedusaContainer } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
  PaymentActions,
} from "@medusajs/framework/utils"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import { SubscriptionStatus } from "../../modules/subscription/types"
import { failAwaitingRenewalCycle } from "../../workflows/utils/fail-awaiting-renewal-cycle"
import { cancelPendingSubscriptionOnPaymentFailure } from "../cancel-pending-subscription-on-payment-failure"

type Staged = Record<string, unknown[]>

type UpdateCall = Record<string, unknown>

type LogEntry = { level: string, entry: Record<string, unknown> }

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
  reason?: string
  captured: UpdateCall[]
  logs?: LogEntry[]
}) {
  const {
    staged,
    action,
    sessionId = "payses_1",
    reason,
    captured,
    logs = [],
  } = options
  const record = (level: string) => (line: string) => {
    logs.push({ level, entry: JSON.parse(line) })
  }

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
            data: sessionId ? { session_id: sessionId, reason } : {},
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
        return { info: () => {}, warn: record("warn"), error: record("error") }
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

  describe("a renewal failure whose handling throws", () => {
    const failRenewal = jest.mocked(failAwaitingRenewalCycle)

    function renewalStaged(): Staged {
      return {
        payment_session: [
          {
            id: "payses_1",
            payment_collection_id: "paycol_1",
            context: { renewal_cycle_id: "rc_1", renewal_attempt_id: "ra_1" },
          },
        ],
      }
    }

    async function deliverWhileHandlingThrows(error: unknown) {
      const logs: LogEntry[] = []

      failRenewal.mockReset()
      failRenewal.mockRejectedValueOnce(error)

      const outcome = await run({
        staged: renewalStaged(),
        action: PaymentActions.FAILED,
        captured: [],
        logs,
      }).then(
        () => "resolved",
        (rejection: unknown) => (rejection === error ? "rejected" : rejection)
      )

      return { outcome, logs }
    }

    it("logs a record that no longer exists once, as a warning, and does not reject", async () => {
      const { outcome, logs } = await deliverWhileHandlingThrows(
        new MedusaError(
          MedusaError.Types.NOT_FOUND,
          "Subscription with id: sub_1 was not found"
        )
      )

      expect(outcome).toEqual("resolved")
      expect(logs).toEqual([
        {
          level: "warn",
          entry: expect.objectContaining({
            renewal_cycle_id: "rc_1",
            payment_session_id: "payses_1",
            alertable: false,
          }),
        },
      ])
    })

    it.each([
      new Error("Failed to acquire lock for key \"renewal:subscription:sub_1\""),
      new MedusaError(
        MedusaError.Types.CONFLICT,
        "Failed to acquire lock for key \"renewal:subscription:sub_1\""
      ),
      new Error("\"renewal:subscription:sub_1\" is already locked."),
      new Error("Timed-out acquiring lock."),
    ])("rejects after a non-alertable entry when the lock stays taken: '$message'", async (error) => {
      const { outcome, logs } = await deliverWhileHandlingThrows(error)

      expect(outcome).toEqual("rejected")
      expect(logs).toEqual([
        {
          level: "warn",
          entry: expect.objectContaining({
            renewal_cycle_id: "rc_1",
            alertable: false,
          }),
        },
      ])
    })

    it.each([
      new Error("database connection lost"),
      new Error("payment provider timeout"),
      new Error("Subscription 'sub_1' was not found"),
      new MedusaError(MedusaError.Types.CONFLICT, "Subscription 'sub_1' is locked"),
    ])("rejects after an alertable entry for anything else: '$message'", async (error) => {
      const { outcome, logs } = await deliverWhileHandlingThrows(error)

      expect(outcome).toEqual("rejected")
      expect(logs).toEqual([
        {
          level: "error",
          entry: expect.objectContaining({
            renewal_cycle_id: "rc_1",
            alertable: true,
            message: error.message,
          }),
        },
      ])
    })
  })
})
