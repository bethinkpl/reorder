import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import { RenewalCycleStatus } from "../../src/modules/renewal/types"
import { processRenewalCycleWorkflow } from "../../src/workflows"
import {
  createRenewalCycleSeed,
  createSubscriptionSeed,
} from "../helpers/renewal-fixtures"

const mockCreateOrderRun = jest.fn()
const mockCreateOrUpdateOrderPaymentCollectionRun = jest.fn()
const mockCreatePaymentSessionsRun = jest.fn()

jest.mock("@medusajs/medusa/core-flows", () => {
  const actual = jest.requireActual("@medusajs/medusa/core-flows")

  return {
    ...actual,
    createOrderWorkflow: () => ({
      run: mockCreateOrderRun,
    }),
    createOrUpdateOrderPaymentCollectionWorkflow: () => ({
      run: mockCreateOrUpdateOrderPaymentCollectionRun,
    }),
    createPaymentSessionsWorkflow: () => ({
      run: mockCreatePaymentSessionsRun,
    }),
  }
})

// Registered by the test app's own loader, driven from here through the shared
// process global — see integration-tests/src/workflows/resolve-renewal-billing-address-test-hook.ts.
const resolveBillingAddressDelegate = jest.fn()
;(globalThis as Record<string, unknown>).__resolveRenewalBillingAddressTestDelegate =
  resolveBillingAddressDelegate

// What the first checkout froze onto the source cart.
const cartBillingAddress = {
  first_name: "Jan",
  last_name: "Kowalski",
  address_1: "Testowa 1",
  city: "Warszawa",
  postal_code: "00-001",
  country_code: "PL",
}

function mockRenewalQueries(
  query: { graph: (...args: unknown[]) => unknown },
  options: {
    cart_id: string | null
    customer_id: string
    variant_id: string
    order_id: string
    billing_address?: Record<string, unknown> | null
  }
) {
  jest.spyOn(query as any, "graph").mockImplementation(async (input: any) => {
    if (input.entity === "cart") {
      return {
        data: [
          {
            id: options.cart_id,
            region_id: "reg_test",
            sales_channel_id: "sc_test",
            currency_code: "pln",
            email: "customer@example.com",
            customer_id: options.customer_id,
            shipping_address: { first_name: "Jan", last_name: "Kowalski", country_code: "PL" },
            billing_address:
              options.billing_address === undefined
                ? cartBillingAddress
                : options.billing_address,
            items: [
              {
                title: "Cart Product",
                quantity: 1,
                unit_price: 9999,
                variant_id: options.variant_id,
                variant_title: "Cart Variant",
                variant_sku: "CART-SKU",
                requires_shipping: true,
                is_discountable: true,
              },
            ],
            shipping_methods: [],
          },
        ],
      }
    }

    if (input.entity === "order") {
      return {
        data: [{ id: options.order_id, total: 0 }],
      }
    }

    return { data: [] }
  })
}

function sourceSnapshot(suffix: string) {
  return {
    product_id: `prod_${suffix}`,
    variant_id: `variant_${suffix}`,
    title: "Plan Product",
    subtitle: null,
    quantity: 1,
    unit_price: 5000,
    sku: "PLAN-SKU",
    is_discountable: true,
    is_tax_inclusive: true,
    requires_shipping: false,
    tax_lines: [],
    adjustments: [],
  }
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ getContainer }) => {
    describe("renewal order billing address", () => {
      beforeEach(() => {
        jest.restoreAllMocks()
        jest.clearAllMocks()
        resolveBillingAddressDelegate.mockReset()
      })

      it("bills to the address the host app resolved, not the frozen cart one", async () => {
        const container = getContainer()
        const query = container.resolve<any>(ContainerRegistrationKeys.QUERY)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-BILL-HOOK-001",
          next_renewal_at: new Date("2026-05-01T10:00:00.000Z"),
          source_snapshot: sourceSnapshot("bill_hook"),
        })

        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: new Date("2026-05-01T10:00:00.000Z"),
        })

        mockRenewalQueries(query, {
          cart_id: subscription.cart_id,
          customer_id: subscription.customer_id,
          variant_id: subscription.variant_id,
          order_id: "ord_bill_hook_001",
        })
        mockCreateOrderRun.mockResolvedValue({ result: { id: "ord_bill_hook_001" } })

        const resolved = {
          company: "ACME sp. z o.o.",
          address_1: "Nowa 2",
          city: "Poznan",
          postal_code: "60-688",
          country_code: "pl",
          metadata: { tax_id: "1234567890" },
        }
        resolveBillingAddressDelegate.mockReturnValue(resolved)

        await processRenewalCycleWorkflow(container).run({
          input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" },
        })

        expect(resolveBillingAddressDelegate).toHaveBeenCalledWith(
          expect.objectContaining({ renewal_cycle_id: cycle.id })
        )

        const orderInput = mockCreateOrderRun.mock.calls[0][0].input
        expect(orderInput.billing_address).toMatchObject(resolved)
        // The tax id has to survive the zod validator, or B2B pricing and the
        // invoice both lose it.
        expect(orderInput.billing_address.metadata).toEqual({ tax_id: "1234567890" })
        expect(orderInput.additional_data).toEqual({ billing_address: orderInput.billing_address })
      })

      it("falls back to the source cart's address when the host app has no answer", async () => {
        const container = getContainer()
        const query = container.resolve<any>(ContainerRegistrationKeys.QUERY)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-BILL-FALLBACK-001",
          next_renewal_at: new Date("2026-05-01T10:00:00.000Z"),
          source_snapshot: sourceSnapshot("bill_fallback"),
        })

        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: new Date("2026-05-01T10:00:00.000Z"),
        })

        mockRenewalQueries(query, {
          cart_id: subscription.cart_id,
          customer_id: subscription.customer_id,
          variant_id: subscription.variant_id,
          order_id: "ord_bill_fallback_001",
        })
        mockCreateOrderRun.mockResolvedValue({ result: { id: "ord_bill_fallback_001" } })

        resolveBillingAddressDelegate.mockReturnValue(undefined)

        await processRenewalCycleWorkflow(container).run({
          input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" },
        })

        expect(mockCreateOrderRun.mock.calls[0][0].input.billing_address).toMatchObject(
          cartBillingAddress
        )
      })

      it("fails the cycle rather than bill to an address with no country", async () => {
        const container = getContainer()
        const query = container.resolve<any>(ContainerRegistrationKeys.QUERY)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-BILL-NOCOUNTRY-001",
          next_renewal_at: new Date("2026-05-01T10:00:00.000Z"),
          source_snapshot: sourceSnapshot("bill_nocountry"),
        })

        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: new Date("2026-05-01T10:00:00.000Z"),
        })

        mockRenewalQueries(query, {
          cart_id: subscription.cart_id,
          customer_id: subscription.customer_id,
          variant_id: subscription.variant_id,
          order_id: "ord_bill_nocountry_001",
        })
        mockCreateOrderRun.mockResolvedValue({ result: { id: "ord_bill_nocountry_001" } })

        resolveBillingAddressDelegate.mockReturnValue({ city: "Poznan", country_code: "" })

        // The result validator runs `parse`, so a half-resolved address is a
        // loud, retryable failure — not a silent fall back to stale details.
        // `run()` resolves with the reverted transaction rather than rejecting;
        // the failure lives in `errors` and the flow state.
        const res: any = await processRenewalCycleWorkflow(container).run({
          input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" },
          throwOnError: false,
        } as any)

        expect(
          res.transaction?.getFlow?.()?.state ?? res.transaction?.flow?.state
        ).toBe("reverted")

        const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const failedCycle = await renewalModule.retrieveRenewalCycle(cycle.id)
        expect(failedCycle.status).toBe(RenewalCycleStatus.FAILED)

        expect(mockCreateOrderRun).not.toHaveBeenCalled()
      })
    })
  },
})
