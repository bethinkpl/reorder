import {
  hasCustomerPaymentInProgress,
  isCustomerLiveSession,
  loadOrderPaymentCollections,
  type PaymentCollectionRecord,
  type PaymentSessionRecord,
} from "../customer-payment-in-progress"

const MINUTE = 60 * 1000
const now = new Date("2026-03-01T12:00:00.000Z")

/** A session the host app's own checkout opened: no marker of ours, opened minutes ago. */
function customerSession(
  overrides: Partial<PaymentSessionRecord> = {}
): PaymentSessionRecord {
  return {
    id: "payses_customer",
    status: "pending",
    context: {},
    data: { id: "cs_live_1" },
    created_at: new Date(now.getTime() - 5 * MINUTE),
    ...overrides,
  }
}

function collection(
  overrides: Partial<PaymentCollectionRecord> = {}
): PaymentCollectionRecord {
  return {
    id: "paycol_1",
    status: "awaiting",
    payment_sessions: [],
    ...overrides,
  }
}

describe("isCustomerLiveSession", () => {
  it.each(["pending", "pending_authorization", "requires_more"])(
    "counts a '%s' session as one the customer may be on",
    (status) => {
      expect(isCustomerLiveSession(customerSession({ status }), now)).toBe(true)
    }
  )

  it.each(["error", "canceled", "captured", "authorized", "", null])(
    "does not count a '%s' session",
    (status) => {
      expect(isCustomerLiveSession(customerSession({ status }), now)).toBe(false)
    }
  )

  it("stops counting a session nobody could still be looking at", () => {
    expect(
      isCustomerLiveSession(
        customerSession({ created_at: new Date(now.getTime() - 59 * MINUTE) }),
        now
      )
    ).toBe(true)
    expect(
      isCustomerLiveSession(
        customerSession({ created_at: new Date(now.getTime() - 60 * MINUTE) }),
        now
      )
    ).toBe(false)
  })

  it("does not count a session whose age can't be read", () => {
    // Never live rather than always live: the callers don't escalate, so a session that can never
    // age out would block the order for good.
    expect(isCustomerLiveSession(customerSession({ created_at: null }), now)).toBe(
      false
    )
    expect(
      isCustomerLiveSession(customerSession({ created_at: "not a date" }), now)
    ).toBe(false)
  })

  it("honours the provider's own expiry, in unix seconds", () => {
    const expired = customerSession({
      data: { expiresAt: Math.floor((now.getTime() - MINUTE) / 1000) },
    })
    const pending = customerSession({
      data: { expiresAt: Math.floor((now.getTime() + MINUTE) / 1000) },
    })

    expect(isCustomerLiveSession(expired, now)).toBe(false)
    expect(isCustomerLiveSession(pending, now)).toBe(true)
  })

  it("does not count a session we opened ourselves", () => {
    expect(
      isCustomerLiveSession(
        customerSession({ context: { dunning_case_id: "dun_1" } }),
        now
      )
    ).toBe(false)
  })

  it("counts a session the host app says the customer started", () => {
    expect(
      isCustomerLiveSession(
        customerSession({
          context: { dunning_case_id: "dun_1", initiated_by: "customer" },
        }),
        now
      )
    ).toBe(true)
  })
})

describe("hasCustomerPaymentInProgress", () => {
  it("is false for an order nothing is happening on", () => {
    expect(hasCustomerPaymentInProgress([], now)).toBe(false)
    expect(
      hasCustomerPaymentInProgress([collection({ status: "not_paid" })], now)
    ).toBe(false)
  })

  it("finds a live session on any collection of the order", () => {
    expect(
      hasCustomerPaymentInProgress(
        [
          collection({ id: "paycol_1", status: "not_paid" }),
          collection({ id: "paycol_2", payment_sessions: [customerSession()] }),
        ],
        now
      )
    ).toBe(true)
  })

  it.each(["authorized", "partially_authorized"])(
    "steps aside for somebody else's '%s' collection",
    (status) => {
      // Core cancels and recreates either one, throwing away what it holds.
      expect(
        hasCustomerPaymentInProgress(
          [collection({ status, payment_sessions: [customerSession({ status: "authorized" })] })],
          now
        )
      ).toBe(true)
    }
  )

  it.each(["authorized", "partially_authorized"])(
    "does not step aside for our own '%s' collection",
    (status) => {
      // An authorization of ours outlives the run that took it - a capture that failed leaves one
      // behind - so treating it as somebody else's payment would deadlock the order for good.
      expect(
        hasCustomerPaymentInProgress(
          [
            collection({
              status,
              payment_sessions: [
                {
                  id: "payses_1",
                  status: "authorized",
                  context: { dunning_case_id: "dun_1", dunning_attempt_id: "dunatt_1" },
                  created_at: new Date(now.getTime() - 5 * MINUTE),
                },
              ],
            }),
          ],
          now
        )
      ).toBe(false)
    }
  )
})

describe("loadOrderPaymentCollections", () => {
  function buildContainer(data: unknown[]) {
    const graph = jest.fn(async () => ({ data }))

    return {
      graph,
      container: {
        resolve: (key: string) => {
          if (key === "query") {
            return { graph }
          }

          throw new Error(`Unexpected resolve('${key}')`)
        },
      } as any,
    }
  }

  it("asks for every session on every collection of the order", async () => {
    const { container, graph } = buildContainer([
      { id: "order_1", payment_collections: [collection()] },
    ])

    await expect(
      loadOrderPaymentCollections(container, "order_1")
    ).resolves.toEqual([collection()])
    expect(graph).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "order",
        filters: { id: ["order_1"] },
        fields: expect.arrayContaining([
          "payment_collections.status",
          "payment_collections.payment_sessions.status",
          "payment_collections.payment_sessions.context",
          "payment_collections.payment_sessions.data",
          "payment_collections.payment_sessions.created_at",
        ]),
      })
    )
  })

  it("reads an order without collections as an empty list", async () => {
    const { container } = buildContainer([{ id: "order_1" }])

    await expect(
      loadOrderPaymentCollections(container, "order_1")
    ).resolves.toEqual([])

    const { container: missing } = buildContainer([])

    await expect(
      loadOrderPaymentCollections(missing, "order_1")
    ).resolves.toEqual([])
  })
})
