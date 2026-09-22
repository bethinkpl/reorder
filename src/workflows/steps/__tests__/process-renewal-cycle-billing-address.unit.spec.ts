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

const cartBillingAddress = {
  first_name: "Jan",
  last_name: "Kowalski",
  address_1: "Testowa 1",
  city: "Warszawa",
  postal_code: "00-001",
  country_code: "pl",
  metadata: { tax_id: null },
}

const cart = {
  id: "cart_1",
  region_id: "reg_1",
  sales_channel_id: "sc_1",
  currency_code: "pln",
  email: "customer@example.com",
  customer_id: "cus_1",
  shipping_address: {},
  billing_address: cartBillingAddress,
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

const resolvedBillingAddress = {
  first_name: null,
  last_name: null,
  company: "ACME sp. z o.o.",
  address_1: "Nowa 2",
  city: "Poznan",
  postal_code: "60-688",
  country_code: "pl",
  metadata: { tax_id: "1234567890" },
}

function buildContainer() {
  const container = {
    resolve: (key: string) => {
      if (key === "query") {
        return {
          graph: jest.fn().mockResolvedValue({
            data: [{ id: "order_new", total: 100, summary: { pending_difference: 100 } }],
          }),
        }
      }

      if (key === "renewal") {
        return { updateRenewalCycles: jest.fn().mockResolvedValue(undefined) }
      }

      if (key === "logger") {
        return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      }

      throw new Error(`Unexpected resolve('${key}')`)
    },
  } as any

  return { container }
}

function createdOrderInput() {
  return (createOrderWorkflow as unknown as jest.Mock).mock.results[0].value.run.mock
    .calls[0][0].input
}

describe("createRenewalOrder - billing address resolution", () => {
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

  it("bills to the address the hook resolved, not the frozen cart one", async () => {
    const { container } = buildContainer()

    await createRenewalOrder(
      container,
      { id: "cyc_1", generated_order_id: null },
      subscription,
      cart,
      items,
      resolvedBillingAddress
    )

    expect(createdOrderInput().billing_address).toEqual(resolvedBillingAddress)
  })

  it("carries the resolved tax id through to the pricing context", async () => {
    const { container } = buildContainer()

    await createRenewalOrder(
      container,
      { id: "cyc_1", generated_order_id: null },
      subscription,
      cart,
      items,
      resolvedBillingAddress
    )

    expect(createdOrderInput().additional_data).toEqual({
      billing_address: resolvedBillingAddress,
    })
  })

  it("falls back to the cart's address when no handler answered", async () => {
    const { container } = buildContainer()

    await createRenewalOrder(
      container,
      { id: "cyc_1", generated_order_id: null },
      subscription,
      cart,
      items,
      undefined
    )

    expect(createdOrderInput().billing_address).toBe(cartBillingAddress)
    expect(createdOrderInput().additional_data).toEqual({
      billing_address: cartBillingAddress,
    })
  })

  it("falls back when the handler's result is a wrapper rather than an address", async () => {
    const { container } = buildContainer()

    await createRenewalOrder(
      container,
      { id: "cyc_1", generated_order_id: null },
      subscription,
      cart,
      items,
      { __type: "StepResponse", output: undefined } as any
    )

    expect(createdOrderInput().billing_address).toBe(cartBillingAddress)
  })

  it("falls back rather than billing to an address with no country", async () => {
    const { container } = buildContainer()

    await createRenewalOrder(
      container,
      { id: "cyc_1", generated_order_id: null },
      subscription,
      cart,
      items,
      { ...resolvedBillingAddress, country_code: "" } as any
    )

    expect(createdOrderInput().billing_address).toBe(cartBillingAddress)
  })

  it("leaves the billing address undefined when neither side has one", async () => {
    const { container } = buildContainer()

    await createRenewalOrder(
      container,
      { id: "cyc_1", generated_order_id: null },
      subscription,
      { ...cart, billing_address: null },
      items,
      undefined
    )

    expect(createdOrderInput().billing_address).toBeUndefined()
  })

  it("does not re-create the order on a retry, whatever the hook resolved", async () => {
    const { container } = buildContainer()

    const result = await createRenewalOrder(
      container,
      { id: "cyc_1", generated_order_id: "order_1" },
      subscription,
      cart,
      items,
      resolvedBillingAddress
    )

    expect(result.order.id).toBe("order_1")
    expect(createOrderWorkflow).not.toHaveBeenCalled()
  })
})
