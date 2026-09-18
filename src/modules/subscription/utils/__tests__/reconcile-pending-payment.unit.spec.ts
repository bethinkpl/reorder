import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { SUBSCRIPTION_MODULE } from "../.."
import { SubscriptionStatus } from "../../types"
import { ABANDONED_CHECKOUT_REASON } from "../cancel-abandoned-subscription"
import {
  DEFAULT_PENDING_PAYMENT_TTL_MINUTES,
  reconcilePendingPaymentSubscriptions,
  resolvePendingPaymentCutoff,
  resolvePendingPaymentTtlMinutes,
} from "../reconcile-pending-payment"

const ensureNextRenewalCycleRun = jest.fn(
  async (_input: { input: { subscription_id: string } }) => ({ result: {} })
)

jest.mock("../../../../workflows/ensure-next-renewal-cycle", () => ({
  ensureNextRenewalCycleWorkflow: () => ({
    run: (input: { input: { subscription_id: string } }) =>
      ensureNextRenewalCycleRun(input),
  }),
}))

type UpdateCall = Record<string, unknown>

type PendingRow = {
  id: string
  cart_id: string | null
  created_at: string
  metadata: Record<string, unknown> | null
}

const now = new Date("2026-09-14T12:00:00.000Z")

function buildContainer(options: {
  pending: PendingRow[]
  captures?: Record<string, string | null>
  captured: UpdateCall[]
  throwOnRetrieve?: string[]
}) {
  const { pending, captures = {}, captured, throwOnRetrieve = [] } = options

  const query = {
    graph: async ({
      entity,
      filters,
    }: {
      entity: string
      filters?: Record<string, unknown>
    }) => {
      if (entity === "subscription") {
        return { data: pending }
      }

      if (entity === "cart_payment_collection") {
        const cartId = filters?.cart_id as string

        if (!(cartId in captures)) {
          return { data: [] }
        }

        return { data: [{ payment_collection_id: `paycol_${cartId}` }] }
      }

      if (entity === "payment") {
        const collectionIds = filters?.payment_collection_id as string[]
        const cartId = collectionIds[0]?.replace("paycol_", "")

        return {
          data: [
            {
              id: `pay_${cartId}`,
              payment_collection_id: `paycol_${cartId}`,
              captured_at: captures[cartId ?? ""] ?? null,
            },
          ],
        }
      }

      return { data: [] }
    },
  }
  const paymentModule = { listPaymentMethods: async () => [] }
  const subscriptionModule = {
    retrieveSubscription: async (id: string) => {
      if (throwOnRetrieve.includes(id)) {
        throw new Error(`boom: ${id}`)
      }

      return {
        id,
        customer_id: "cus_x",
        status: SubscriptionStatus.PENDING_PAYMENT,
        payment_context: null,
      }
    },
    updateSubscriptions: async (input: UpdateCall) => {
      captured.push(input)

      return input
    },
  }

  // Medusa's container is an awilix instance; this test-only stub is cast at the boundary.
  return {
    resolve(key: string) {
      if (key === ContainerRegistrationKeys.QUERY) {
        return query
      }

      if (key === Modules.PAYMENT) {
        return paymentModule
      }

      if (key === SUBSCRIPTION_MODULE) {
        return subscriptionModule
      }

      throw new Error(`Unexpected resolve('${key}')`)
    },
  } as unknown as MedusaContainer
}

describe("resolvePendingPaymentTtlMinutes", () => {
  it("falls back to a day when unset", () => {
    expect(resolvePendingPaymentTtlMinutes(undefined)).toBe(DEFAULT_PENDING_PAYMENT_TTL_MINUTES)
  })

  it("falls back on a value that is not a positive integer", () => {
    expect(resolvePendingPaymentTtlMinutes("0")).toBe(DEFAULT_PENDING_PAYMENT_TTL_MINUTES)
    expect(resolvePendingPaymentTtlMinutes("-30")).toBe(DEFAULT_PENDING_PAYMENT_TTL_MINUTES)
    expect(resolvePendingPaymentTtlMinutes("soon")).toBe(DEFAULT_PENDING_PAYMENT_TTL_MINUTES)
  })

  it("honours a positive override", () => {
    expect(resolvePendingPaymentTtlMinutes("90")).toBe(90)
  })
})

describe("resolvePendingPaymentCutoff", () => {
  it("walks back the TTL from the given moment", () => {
    expect(resolvePendingPaymentCutoff(now, 60).toISOString()).toBe("2026-09-14T11:00:00.000Z")
  })
})

describe("reconcilePendingPaymentSubscriptions", () => {
  beforeEach(() => {
    ensureNextRenewalCycleRun.mockClear()
  })

  it("activates a subscription whose payment already captured and starts its renewal cycle, without cancelling it", async () => {
    const captured: UpdateCall[] = []
    const container = buildContainer({
      pending: [
        {
          id: "sub_paid",
          cart_id: "cart_paid",
          created_at: "2026-09-13T10:00:00.000Z",
          metadata: null,
        },
      ],
      captures: { cart_paid: "2026-09-14T09:00:00.000Z" },
      captured,
    })

    const result = await reconcilePendingPaymentSubscriptions(container, {
      now,
      ttl_minutes: 60,
    })

    expect(result).toEqual({
      scanned: 1,
      activated: ["sub_paid"],
      expired: [],
      failed: [],
    })
    expect(captured).toEqual([{ id: "sub_paid", status: SubscriptionStatus.ACTIVE }])
    expect(ensureNextRenewalCycleRun).toHaveBeenCalledTimes(1)
    expect(ensureNextRenewalCycleRun).toHaveBeenCalledWith({
      input: { subscription_id: "sub_paid" },
    })
  })

  it("cancels a stale row whose payment never captured, keeping its existing metadata", async () => {
    const captured: UpdateCall[] = []
    const container = buildContainer({
      pending: [
        {
          id: "sub_stale",
          cart_id: "cart_stale",
          created_at: "2026-09-13T10:00:00.000Z",
          metadata: { source_order_id: "order_1" },
        },
      ],
      captures: { cart_stale: null },
      captured,
    })

    const result = await reconcilePendingPaymentSubscriptions(container, {
      now,
      ttl_minutes: 60,
    })

    expect(result).toEqual({
      scanned: 1,
      activated: [],
      expired: ["sub_stale"],
      failed: [],
    })
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      id: "sub_stale",
      status: SubscriptionStatus.CANCELLED,
      cancelled_at: now,
      cancel_effective_at: now,
      next_renewal_at: null,
      metadata: {
        source_order_id: "order_1",
        cancellation_reason: ABANDONED_CHECKOUT_REASON,
      },
    })
    expect(ensureNextRenewalCycleRun).not.toHaveBeenCalled()
  })

  it("leaves a fresh row without a captured payment alone", async () => {
    const captured: UpdateCall[] = []
    const container = buildContainer({
      pending: [
        {
          id: "sub_fresh",
          cart_id: "cart_fresh",
          created_at: "2026-09-14T11:30:00.000Z",
          metadata: null,
        },
      ],
      captures: { cart_fresh: null },
      captured,
    })

    const result = await reconcilePendingPaymentSubscriptions(container, {
      now,
      ttl_minutes: 60,
    })

    expect(result).toEqual({ scanned: 1, activated: [], expired: [], failed: [] })
    expect(captured).toEqual([])
    expect(ensureNextRenewalCycleRun).not.toHaveBeenCalled()
  })

  it("only ever expires a row with no cart_id, never attempting activation", async () => {
    const captured: UpdateCall[] = []
    const container = buildContainer({
      pending: [
        {
          id: "sub_no_cart_stale",
          cart_id: null,
          created_at: "2026-09-13T10:00:00.000Z",
          metadata: null,
        },
        {
          id: "sub_no_cart_fresh",
          cart_id: null,
          created_at: "2026-09-14T11:30:00.000Z",
          metadata: null,
        },
      ],
      captured,
    })

    const result = await reconcilePendingPaymentSubscriptions(container, {
      now,
      ttl_minutes: 60,
    })

    expect(result).toEqual({
      scanned: 2,
      activated: [],
      expired: ["sub_no_cart_stale"],
      failed: [],
    })
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({ id: "sub_no_cart_stale", status: SubscriptionStatus.CANCELLED })
  })

  it("reports a throwing row in failed and keeps reconciling the rest", async () => {
    const captured: UpdateCall[] = []
    const container = buildContainer({
      pending: [
        {
          id: "sub_throw",
          cart_id: "cart_throw",
          created_at: "2026-09-13T10:00:00.000Z",
          metadata: null,
        },
        {
          id: "sub_paid",
          cart_id: "cart_paid",
          created_at: "2026-09-13T10:00:00.000Z",
          metadata: null,
        },
      ],
      captures: { cart_paid: "2026-09-14T09:00:00.000Z" },
      captured,
      throwOnRetrieve: ["sub_throw"],
    })

    const result = await reconcilePendingPaymentSubscriptions(container, {
      now,
      ttl_minutes: 60,
    })

    expect(result.scanned).toBe(2)
    expect(result.activated).toEqual(["sub_paid"])
    expect(result.expired).toEqual([])
    expect(result.failed).toEqual([{ id: "sub_throw", message: "boom: sub_throw" }])
    // The throw happens before the cutoff check, so the stale row is never cancelled either.
    expect(captured).toEqual([{ id: "sub_paid", status: SubscriptionStatus.ACTIVE }])
  })
})
