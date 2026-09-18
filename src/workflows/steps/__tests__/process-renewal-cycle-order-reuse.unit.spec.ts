jest.mock("@medusajs/medusa/core-flows", () => ({
  createOrderWorkflow: jest.fn(),
  createOrUpdateOrderPaymentCollectionWorkflow: jest.fn(),
  createPaymentSessionsWorkflow: jest.fn(),
  acquireLockStep: jest.fn(),
  releaseLockStep: jest.fn(),
}))

import {
  createOrderWorkflow,
  createOrUpdateOrderPaymentCollectionWorkflow,
} from "@medusajs/medusa/core-flows"
import { createRenewalOrder } from "../process-renewal-cycle"

const cart = {
  id: "cart_1",
  region_id: "reg_1",
  sales_channel_id: "sc_1",
  currency_code: "pln",
  email: "customer@example.com",
  customer_id: "cus_1",
  shipping_address: {},
  billing_address: null,
} as any

const subscription = {
  id: "sub_1",
  customer_id: "cus_1",
  customer_snapshot: { email: "customer@example.com" },
  shipping_address: {},
  payment_context: {
    payment_provider_id: "pp_stripe-checkout-session_stripe",
    payment_method_id: "pm_1",
  },
} as any

const items = [{ title: "Plan", quantity: 1 }] as any

function buildContainer(order: Record<string, unknown>) {
  const graph = jest.fn().mockResolvedValue({ data: [order] })
  const updateRenewalCycles = jest.fn().mockResolvedValue(undefined)

  const container = {
    resolve: (key: string) => {
      if (key === "query") {
        return { graph }
      }

      if (key === "renewal") {
        return { updateRenewalCycles }
      }

      if (key === "logger") {
        return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      }

      throw new Error(`Unexpected resolve('${key}')`)
    },
  } as any

  return { container, updateRenewalCycles }
}

describe("createRenewalOrder - reused order double-charge guard", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(
      createOrUpdateOrderPaymentCollectionWorkflow as unknown as jest.Mock
    ).mockReturnValue({
      run: jest.fn().mockResolvedValue({ result: [{ id: "paycol_1" }] }),
    })
    ;(createOrderWorkflow as unknown as jest.Mock).mockReturnValue({
      run: jest.fn().mockResolvedValue({ result: { id: "order_new" } }),
    })
  })

  it("does not collect anything when the reused order is already paid", async () => {
    // The previous attempt captured before aborting. Charging the total again
    // here is the double charge this guard exists to prevent.
    const { container } = buildContainer({
      id: "order_1",
      total: 100,
      summary: { pending_difference: 0 },
    })

    const result = await createRenewalOrder(
      container,
      { id: "cyc_1", generated_order_id: "order_1" },
      subscription,
      cart,
      items
    )

    expect(result.payment).toBeNull()
    expect(result.payment_collections).toBeNull()
    expect(createOrUpdateOrderPaymentCollectionWorkflow).not.toHaveBeenCalled()
  })

  it("reuses the persisted order instead of creating a duplicate", async () => {
    const { container } = buildContainer({
      id: "order_1",
      total: 100,
      summary: { pending_difference: 0 },
    })

    const result = await createRenewalOrder(
      container,
      { id: "cyc_1", generated_order_id: "order_1" },
      subscription,
      cart,
      items
    )

    expect(result.order.id).toBe("order_1")
    expect(createOrderWorkflow).not.toHaveBeenCalled()
  })

  it("collects only the outstanding amount on a partly paid order", async () => {
    const { container } = buildContainer({
      id: "order_1",
      total: 100,
      summary: { pending_difference: 40 },
    })

    await createRenewalOrder(
      container,
      { id: "cyc_1", generated_order_id: "order_1" },
      subscription,
      cart,
      items
    )

    const run = (
      createOrUpdateOrderPaymentCollectionWorkflow as unknown as jest.Mock
    ).mock.results[0].value.run

    expect(run).toHaveBeenCalledWith({
      input: { order_id: "order_1", amount: 40 },
    })
  })

  it("collects the full total on a fresh unpaid order", async () => {
    const { container } = buildContainer({
      id: "order_new",
      total: 100,
      summary: { pending_difference: 100 },
    })

    await createRenewalOrder(
      container,
      { id: "cyc_1", generated_order_id: null },
      subscription,
      cart,
      items
    )

    const run = (
      createOrUpdateOrderPaymentCollectionWorkflow as unknown as jest.Mock
    ).mock.results[0].value.run

    expect(run).toHaveBeenCalledWith({
      input: { order_id: "order_new", amount: 100 },
    })
  })

  it("persists the order id as soon as the order exists so a retry can reuse it", async () => {
    // Without this write an abort between order creation and the cycle update
    // would leave the next attempt creating a second live order.
    const { container, updateRenewalCycles } = buildContainer({
      id: "order_new",
      total: 100,
      summary: { pending_difference: 100 },
    })

    await createRenewalOrder(
      container,
      { id: "cyc_1", generated_order_id: null },
      subscription,
      cart,
      items
    )

    expect(updateRenewalCycles).toHaveBeenCalledWith({
      id: "cyc_1",
      generated_order_id: "order_new",
    })
  })
})
