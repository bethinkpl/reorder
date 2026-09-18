import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { SUBSCRIPTION_MODULE } from "../.."
import { SubscriptionStatus } from "../../types"
import { ABANDONED_CHECKOUT_REASON } from "../cancel-abandoned-subscription"
import {
  DEFAULT_PENDING_PAYMENT_BATCH_SIZE,
  DEFAULT_PENDING_PAYMENT_MAX_DEFER_MINUTES,
  DEFAULT_PENDING_PAYMENT_TTL_MINUTES,
  reconcilePendingPaymentSubscriptions,
  resolvePendingPaymentBatchSize,
  resolvePendingPaymentCutoff,
  resolvePendingPaymentMaxDeferMinutes,
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

type PaymentStub = {
  captured_at: string | null
  canceled_at?: string | null
  amount?: number
  refunds?: { amount: number }[]
}

const now = new Date("2026-09-14T12:00:00.000Z")

function buildContainer(options: {
  pending: PendingRow[]
  payments?: Record<string, PaymentStub[]>
  captured: UpdateCall[]
  throwOnRetrieve?: string[]
  subscriptionPaginationCapture?: { value?: unknown }
}) {
  const {
    pending,
    payments = {},
    captured,
    throwOnRetrieve = [],
    subscriptionPaginationCapture,
  } = options

  const query = {
    graph: async ({
      entity,
      filters,
      pagination,
    }: {
      entity: string
      filters?: Record<string, unknown>
      pagination?: unknown
    }) => {
      if (entity === "subscription") {
        if (subscriptionPaginationCapture) {
          subscriptionPaginationCapture.value = pagination
        }

        return { data: pending }
      }

      if (entity === "cart_payment_collection") {
        const cartId = filters?.cart_id as string

        if (!(cartId in payments)) {
          return { data: [] }
        }

        return { data: [{ payment_collection_id: `paycol_${cartId}` }] }
      }

      if (entity === "payment") {
        const collectionIds = filters?.payment_collection_id as string[]
        const cartId = collectionIds[0]?.replace("paycol_", "")
        const stubs = payments[cartId ?? ""] ?? []

        return {
          data: stubs.map((stub, index) => ({
            id: `pay_${cartId}_${index}`,
            payment_collection_id: `paycol_${cartId}`,
            captured_at: stub.captured_at,
            canceled_at: stub.canceled_at ?? null,
            amount: stub.amount ?? 1000,
            refunds: stub.refunds ?? [],
          })),
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

describe("resolvePendingPaymentBatchSize", () => {
  it("falls back to 200 when unset", () => {
    expect(resolvePendingPaymentBatchSize(undefined)).toBe(DEFAULT_PENDING_PAYMENT_BATCH_SIZE)
  })

  it("falls back on a value that is not a positive integer", () => {
    expect(resolvePendingPaymentBatchSize("0")).toBe(DEFAULT_PENDING_PAYMENT_BATCH_SIZE)
    expect(resolvePendingPaymentBatchSize("-10")).toBe(DEFAULT_PENDING_PAYMENT_BATCH_SIZE)
    expect(resolvePendingPaymentBatchSize("many")).toBe(DEFAULT_PENDING_PAYMENT_BATCH_SIZE)
  })

  it("honours a positive override", () => {
    expect(resolvePendingPaymentBatchSize("50")).toBe(50)
  })
})

describe("resolvePendingPaymentMaxDeferMinutes", () => {
  it("falls back to 3 days when unset", () => {
    expect(resolvePendingPaymentMaxDeferMinutes(undefined)).toBe(
      DEFAULT_PENDING_PAYMENT_MAX_DEFER_MINUTES
    )
  })

  it("falls back on a value that is not a positive integer", () => {
    expect(resolvePendingPaymentMaxDeferMinutes("0")).toBe(DEFAULT_PENDING_PAYMENT_MAX_DEFER_MINUTES)
    expect(resolvePendingPaymentMaxDeferMinutes("-10")).toBe(DEFAULT_PENDING_PAYMENT_MAX_DEFER_MINUTES)
    expect(resolvePendingPaymentMaxDeferMinutes("forever")).toBe(
      DEFAULT_PENDING_PAYMENT_MAX_DEFER_MINUTES
    )
  })

  it("honours a positive override", () => {
    expect(resolvePendingPaymentMaxDeferMinutes("120")).toBe(120)
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
      payments: { cart_paid: [{ captured_at: "2026-09-14T09:00:00.000Z" }] },
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
      deferred: [],
      force_expired: [],
      failed: [],
    })
    expect(captured).toEqual([{ id: "sub_paid", status: SubscriptionStatus.ACTIVE }])
    expect(ensureNextRenewalCycleRun).toHaveBeenCalledTimes(1)
    expect(ensureNextRenewalCycleRun).toHaveBeenCalledWith({
      input: { subscription_id: "sub_paid" },
    })
  })

  it("cancels a stale row whose cart never received a payment, keeping its existing metadata", async () => {
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
      payments: { cart_stale: [] },
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
      deferred: [],
      force_expired: [],
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

  it("defers a stale row whose cart still carries a live authorization, instead of cancelling it", async () => {
    const captured: UpdateCall[] = []
    const container = buildContainer({
      pending: [
        {
          id: "sub_sepa",
          cart_id: "cart_sepa",
          created_at: "2026-09-13T10:00:00.000Z",
          metadata: null,
        },
      ],
      payments: { cart_sepa: [{ captured_at: null }] },
      captured,
    })

    const result = await reconcilePendingPaymentSubscriptions(container, {
      now,
      ttl_minutes: 60,
    })

    expect(result).toEqual({
      scanned: 1,
      activated: [],
      expired: [],
      deferred: ["sub_sepa"],
      force_expired: [],
      failed: [],
    })
    expect(captured).toEqual([])
    expect(ensureNextRenewalCycleRun).not.toHaveBeenCalled()
  })

  it("keeps deferring a row still inside the max-defer window", async () => {
    const captured: UpdateCall[] = []
    const container = buildContainer({
      pending: [
        {
          id: "sub_sepa_recent",
          cart_id: "cart_sepa_recent",
          created_at: "2026-09-13T10:00:00.000Z",
          metadata: null,
        },
      ],
      payments: { cart_sepa_recent: [{ captured_at: null }] },
      captured,
    })

    const result = await reconcilePendingPaymentSubscriptions(container, {
      now,
      ttl_minutes: 60,
      max_defer_minutes: 60 * 24 * 2,
    })

    expect(result).toEqual({
      scanned: 1,
      activated: [],
      expired: [],
      deferred: ["sub_sepa_recent"],
      force_expired: [],
      failed: [],
    })
    expect(captured).toEqual([])
  })

  it("force-expires a row deferred past the max-defer window, cancelling it and reporting it separately", async () => {
    const captured: UpdateCall[] = []
    const container = buildContainer({
      pending: [
        {
          id: "sub_sepa_stuck",
          cart_id: "cart_sepa_stuck",
          created_at: "2026-09-13T10:00:00.000Z",
          metadata: null,
        },
      ],
      payments: { cart_sepa_stuck: [{ captured_at: null }] },
      captured,
    })

    const result = await reconcilePendingPaymentSubscriptions(container, {
      now,
      ttl_minutes: 60,
      max_defer_minutes: 60,
    })

    expect(result).toEqual({
      scanned: 1,
      activated: [],
      expired: ["sub_sepa_stuck"],
      deferred: [],
      force_expired: ["sub_sepa_stuck"],
      failed: [],
    })
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      id: "sub_sepa_stuck",
      status: SubscriptionStatus.CANCELLED,
    })
  })

  it("still expires a stale row whose only payment was canceled", async () => {
    const captured: UpdateCall[] = []
    const container = buildContainer({
      pending: [
        {
          id: "sub_voided",
          cart_id: "cart_voided",
          created_at: "2026-09-13T10:00:00.000Z",
          metadata: null,
        },
      ],
      payments: {
        cart_voided: [{ captured_at: null, canceled_at: "2026-09-13T11:00:00.000Z" }],
      },
      captured,
    })

    const result = await reconcilePendingPaymentSubscriptions(container, {
      now,
      ttl_minutes: 60,
    })

    expect(result).toEqual({
      scanned: 1,
      activated: [],
      expired: ["sub_voided"],
      deferred: [],
      force_expired: [],
      failed: [],
    })
  })

  it("still expires a stale row whose only capture was refunded in full, since it is not a live authorization", async () => {
    const captured: UpdateCall[] = []
    const container = buildContainer({
      pending: [
        {
          id: "sub_refunded",
          cart_id: "cart_refunded",
          created_at: "2026-09-13T10:00:00.000Z",
          metadata: null,
        },
      ],
      payments: {
        cart_refunded: [
          {
            captured_at: "2026-09-13T11:00:00.000Z",
            amount: 1000,
            refunds: [{ amount: 1000 }],
          },
        ],
      },
      captured,
    })

    const result = await reconcilePendingPaymentSubscriptions(container, {
      now,
      ttl_minutes: 60,
    })

    expect(result).toEqual({
      scanned: 1,
      activated: [],
      expired: ["sub_refunded"],
      deferred: [],
      force_expired: [],
      failed: [],
    })
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({ id: "sub_refunded", status: SubscriptionStatus.CANCELLED })
  })

  it("leaves a fresh row without any payment alone", async () => {
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
      payments: { cart_fresh: [] },
      captured,
    })

    const result = await reconcilePendingPaymentSubscriptions(container, {
      now,
      ttl_minutes: 60,
    })

    expect(result).toEqual({
      scanned: 1,
      activated: [],
      expired: [],
      deferred: [],
      force_expired: [],
      failed: [],
    })
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
      deferred: [],
      force_expired: [],
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
      payments: { cart_paid: [{ captured_at: "2026-09-14T09:00:00.000Z" }] },
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
    expect(result.deferred).toEqual([])
    expect(result.force_expired).toEqual([])
    expect(result.failed).toEqual([{ id: "sub_throw", message: "boom: sub_throw" }])
    // The throw happens before the cutoff check, so the stale row is never cancelled either.
    expect(captured).toEqual([{ id: "sub_paid", status: SubscriptionStatus.ACTIVE }])
  })

  it("passes the configured batch size and oldest-first order to the subscription query", async () => {
    const subscriptionPaginationCapture: { value?: unknown } = {}
    const container = buildContainer({
      pending: [],
      captured: [],
      subscriptionPaginationCapture,
    })

    await reconcilePendingPaymentSubscriptions(container, { now, ttl_minutes: 60, batch_size: 50 })

    expect(subscriptionPaginationCapture.value).toEqual({
      take: 50,
      order: { created_at: "ASC" },
    })
  })

  it("defaults the batch size when none is given", async () => {
    const subscriptionPaginationCapture: { value?: unknown } = {}
    const container = buildContainer({
      pending: [],
      captured: [],
      subscriptionPaginationCapture,
    })

    await reconcilePendingPaymentSubscriptions(container, { now, ttl_minutes: 60 })

    expect(subscriptionPaginationCapture.value).toEqual({
      take: DEFAULT_PENDING_PAYMENT_BATCH_SIZE,
      order: { created_at: "ASC" },
    })
  })
})
