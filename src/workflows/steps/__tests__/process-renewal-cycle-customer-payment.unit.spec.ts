jest.mock("@medusajs/medusa/core-flows", () => ({
  createOrderWorkflow: jest.fn(),
  createOrUpdateOrderPaymentCollectionWorkflow: jest.fn(),
  createPaymentSessionsWorkflow: jest.fn(),
  acquireLockStep: jest.fn(),
  releaseLockStep: jest.fn(),
}))

import {
  classifyRenewalFailure,
  isAlertableRenewalFailure,
} from "../../../modules/renewal/utils/observability"
import { assertNoCustomerPaymentInProgress } from "../process-renewal-cycle"

const MINUTE = 60 * 1000

type CollectionFixture = {
  id: string
  status?: string
  payment_sessions?: Record<string, unknown>[]
}

/** A session the host app's own checkout opened on the renewal order minutes ago. */
function customerSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "payses_customer",
    status: "pending",
    context: {},
    data: { id: "cs_live_1" },
    created_at: new Date(Date.now() - 5 * MINUTE),
    ...overrides,
  }
}

function buildContainer(paymentCollections: CollectionFixture[]) {
  const graph = jest.fn(async () => ({
    data: [{ id: "order_1", payment_collections: paymentCollections }],
  }))

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

describe("assertNoCustomerPaymentInProgress", () => {
  it("does not even look at a cycle that has no order yet", async () => {
    // A fresh order has no collections, so the common path pays for no query.
    const { container, graph } = buildContainer([])

    await expect(
      assertNoCustomerPaymentInProgress(container, { id: "rc_1" })
    ).resolves.toBeUndefined()
    expect(graph).not.toHaveBeenCalled()
  })

  it("refuses to reuse an order the customer is paying on", async () => {
    const { container } = buildContainer([
      {
        id: "paycol_1",
        status: "awaiting",
        payment_sessions: [customerSession()],
      },
    ])

    await expect(
      assertNoCustomerPaymentInProgress(container, {
        id: "rc_1",
        generated_order_id: "order_1",
      })
    ).rejects.toThrow(/the customer is paying order 'order_1'/)
  })

  it("reuses an order carrying nothing but our own renewal session", async () => {
    const { container } = buildContainer([
      {
        id: "paycol_1",
        status: "awaiting",
        payment_sessions: [
          customerSession({ context: { renewal_cycle_id: "rc_1" } }),
        ],
      },
    ])

    await expect(
      assertNoCustomerPaymentInProgress(container, {
        id: "rc_1",
        generated_order_id: "order_1",
      })
    ).resolves.toBeUndefined()
  })

  it("reuses an order a dunning retry left authorized", async () => {
    // Our own authorization is ours to capture or abandon; stepping aside for it would strand the
    // cycle for good.
    const { container } = buildContainer([
      {
        id: "paycol_1",
        status: "authorized",
        payment_sessions: [
          customerSession({
            status: "authorized",
            context: { dunning_case_id: "dun_1" },
          }),
        ],
      },
    ])

    await expect(
      assertNoCustomerPaymentInProgress(container, {
        id: "rc_1",
        generated_order_id: "order_1",
      })
    ).resolves.toBeUndefined()
  })

  it("reports the skip as a blocked run rather than a failure", async () => {
    const { container } = buildContainer([
      {
        id: "paycol_1",
        status: "awaiting",
        payment_sessions: [customerSession()],
      },
    ])

    const error = await assertNoCustomerPaymentInProgress(container, {
      id: "rc_1",
      generated_order_id: "order_1",
    }).catch((thrown) => thrown)

    expect(classifyRenewalFailure(error)).toBe("customer_payment_in_progress")
    expect(isAlertableRenewalFailure(classifyRenewalFailure(error))).toBe(false)
  })
})
