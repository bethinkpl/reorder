import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { SUBSCRIPTION_MODULE } from "../.."
import { SubscriptionStatus } from "../../types"
import {
  ABANDONED_CHECKOUT_REASON,
  DEFAULT_PENDING_PAYMENT_TTL_MINUTES,
  expirePendingPaymentSubscriptions,
  resolvePendingPaymentCutoff,
  resolvePendingPaymentTtlMinutes,
} from "../expire-pending-payment"

type UpdateCall = Record<string, unknown>

const now = new Date("2026-09-14T12:00:00.000Z")

function buildContainer(options: {
  pending: unknown[]
  captured: UpdateCall[]
  graphCalls?: unknown[]
}) {
  const { pending, captured, graphCalls = [] } = options

  const query = {
    graph: async (config: unknown) => {
      graphCalls.push(config)

      return { data: pending }
    },
  }
  const subscriptionModule = {
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

describe("expirePendingPaymentSubscriptions", () => {
  it("only scans pending subscriptions created before the cutoff", async () => {
    const graphCalls: unknown[] = []
    const container = buildContainer({ pending: [], captured: [], graphCalls })

    await expirePendingPaymentSubscriptions(container, { now, ttl_minutes: 60 })

    expect(graphCalls[0]).toMatchObject({
      entity: "subscription",
      filters: {
        status: SubscriptionStatus.PENDING_PAYMENT,
        created_at: { $lt: "2026-09-14T11:00:00.000Z" },
      },
    })
  })

  it("cancels each abandoned subscription immediately and stops its renewals", async () => {
    const captured: UpdateCall[] = []
    const container = buildContainer({
      pending: [
        { id: "sub_1", created_at: "2026-09-13T10:00:00.000Z", metadata: { source: "store_cart_subscribe" } },
        { id: "sub_2", created_at: "2026-09-13T11:00:00.000Z", metadata: null },
      ],
      captured,
    })

    const result = await expirePendingPaymentSubscriptions(container, { now, ttl_minutes: 60 })

    expect(result).toEqual({ scanned: 2, expired: ["sub_1", "sub_2"] })
    expect(captured).toHaveLength(2)
    expect(captured[0]).toMatchObject({
      id: "sub_1",
      status: SubscriptionStatus.CANCELLED,
      cancelled_at: now,
      cancel_effective_at: now,
      next_renewal_at: null,
    })
  })

  it("marks the cancellation as an abandoned checkout and keeps the existing metadata", async () => {
    const captured: UpdateCall[] = []
    const container = buildContainer({
      pending: [
        {
          id: "sub_1",
          created_at: "2026-09-13T10:00:00.000Z",
          metadata: { source_order_id: "order_1" },
        },
      ],
      captured,
    })

    await expirePendingPaymentSubscriptions(container, { now, ttl_minutes: 60 })

    expect(captured[0]!.metadata).toMatchObject({
      source_order_id: "order_1",
      cancellation_reason: ABANDONED_CHECKOUT_REASON,
      cancel_context: expect.objectContaining({ reason: ABANDONED_CHECKOUT_REASON }),
    })
  })

  it("writes nothing when nothing has expired", async () => {
    const captured: UpdateCall[] = []
    const container = buildContainer({ pending: [], captured })

    const result = await expirePendingPaymentSubscriptions(container, { now, ttl_minutes: 60 })

    expect(result).toEqual({ scanned: 0, expired: [] })
    expect(captured).toEqual([])
  })
})
