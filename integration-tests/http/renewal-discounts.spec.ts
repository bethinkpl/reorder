import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import {
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../src/modules/renewal/types"
import { processRenewalCycleWorkflow } from "../../src/workflows"
import { SUBSCRIPTION_CART_QUERY_FIELDS } from "../../src/workflows/steps/validate-subscription-cart"
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

// The hook handler itself is registered by the test app's own workflow loader
// (integration-tests/src/workflows/resolve-renewal-adjustments-test-hook.ts) —
// registering here would target a dead composition; see that file. Tests drive
// it through this delegate via the shared process global. Returning `undefined`
// from the delegate is the "no app adjustments" case.
const resolveAdjustmentsDelegate = jest.fn()
;(globalThis as Record<string, unknown>).__resolveRenewalAdjustmentsTestDelegate =
  resolveAdjustmentsDelegate

function mockRenewalQueries(
  query: { graph: (...args: unknown[]) => unknown },
  options: {
    cart_id: string | null
    customer_id: string
    variant_id: string
    order_id: string
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
            billing_address: null,
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

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ getContainer }) => {
    describe("renewal order discounts", () => {
      beforeEach(() => {
        jest.restoreAllMocks()
        jest.clearAllMocks()
        resolveAdjustmentsDelegate.mockReset()
      })

      it("recomputes the plan discount from pricing_snapshot as a code-less adjustment", async () => {
        const container = getContainer()
        const query = container.resolve<any>(ContainerRegistrationKeys.QUERY)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-DISC-PLAN-001",
          next_renewal_at: new Date("2026-05-01T10:00:00.000Z"),
          source_snapshot: {
            product_id: "prod_disc_plan",
            variant_id: "variant_disc_plan",
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
          },
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
          order_id: "ord_disc_plan_001",
        })
        mockCreateOrderRun.mockResolvedValue({ result: { id: "ord_disc_plan_001" } })

        await processRenewalCycleWorkflow(container).run({
          input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" },
        })

        const orderInput = mockCreateOrderRun.mock.calls[0][0].input
        const adjustments = orderInput.items[0].adjustments

        // Default seed pricing_snapshot is 10% — of the 5000 snapshot gross.
        expect(adjustments).toHaveLength(1)
        expect(adjustments[0]).toMatchObject({
          amount: 500,
          description: "Subscription discount",
          provider_id: "subscription_discount",
          is_tax_inclusive: true,
        })
        expect(adjustments[0]).not.toHaveProperty("code")

        // The item itself no longer replays stale snapshot data.
        expect(orderInput.items[0]).not.toHaveProperty("adjustments.code")
        expect(orderInput.items[0]).not.toHaveProperty("tax_lines")
      })

      it("merges hook adjustments after the plan discount and clamps the combined total to the line gross", async () => {
        const container = getContainer()
        const query = container.resolve<any>(ContainerRegistrationKeys.QUERY)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-DISC-MERGE-001",
          next_renewal_at: new Date("2026-05-01T10:00:00.000Z"),
          source_snapshot: {
            product_id: "prod_disc_merge",
            variant_id: "variant_disc_merge",
            title: "Merge Product",
            subtitle: null,
            quantity: 1,
            unit_price: 5000,
            sku: "MERGE-SKU",
            is_discountable: true,
            is_tax_inclusive: true,
            requires_shipping: false,
            tax_lines: [],
            adjustments: [],
          },
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
          order_id: "ord_disc_merge_001",
        })
        mockCreateOrderRun.mockResolvedValue({ result: { id: "ord_disc_merge_001" } })

        // Requests more than the line has left after the 10% plan discount.
        resolveAdjustmentsDelegate.mockReturnValue([
          {
            amount: 6000,
            description: "Discount (PROMO)",
            provider_id: "promotion_recurring",
            promotion_id: "promo_123",
          },
        ])

        await processRenewalCycleWorkflow(container).run({
          input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" },
        })

        expect(resolveAdjustmentsDelegate).toHaveBeenCalledWith(
          expect.objectContaining({
            renewal_cycle_id: cycle.id,
            currency_code: "pln",
            line_gross_total: 5000,
          })
        )

        const adjustments = mockCreateOrderRun.mock.calls[0][0].input.items[0].adjustments
        expect(adjustments).toHaveLength(2)
        expect(adjustments[0]).toMatchObject({
          amount: 500,
          provider_id: "subscription_discount",
        })
        expect(adjustments[1]).toMatchObject({
          amount: 4500,
          description: "Discount (PROMO)",
          provider_id: "promotion_recurring",
          promotion_id: "promo_123",
        })
      })

      it("applies only hook adjustments when no plan discount exists, and strips any smuggled code", async () => {
        const container = getContainer()
        const query = container.resolve<any>(ContainerRegistrationKeys.QUERY)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-DISC-HOOK-001",
          next_renewal_at: new Date("2026-05-01T10:00:00.000Z"),
          pricing_snapshot: null,
          source_snapshot: {
            product_id: "prod_disc_hook",
            variant_id: "variant_disc_hook",
            title: "Hook Product",
            subtitle: null,
            quantity: 1,
            unit_price: 5000,
            sku: "HOOK-SKU",
            is_discountable: true,
            is_tax_inclusive: true,
            requires_shipping: false,
            tax_lines: [],
            adjustments: [],
          },
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
          order_id: "ord_disc_hook_001",
        })
        mockCreateOrderRun.mockResolvedValue({ result: { id: "ord_disc_hook_001" } })

        resolveAdjustmentsDelegate.mockReturnValue([
          {
            amount: 1000,
            description: "Discount (PROMO)",
            provider_id: "promotion_recurring",
            promotion_id: "promo_456",
            // The hook contract has no `code` — the validator must strip it so
            // createOrderWorkflow's promotion refresh cannot delete the line.
            code: "PROMO",
          },
        ])

        await processRenewalCycleWorkflow(container).run({
          input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" },
        })

        const adjustments = mockCreateOrderRun.mock.calls[0][0].input.items[0].adjustments
        expect(adjustments).toHaveLength(1)
        expect(adjustments[0]).toMatchObject({
          amount: 1000,
          provider_id: "promotion_recurring",
          promotion_id: "promo_456",
        })
        expect(adjustments[0]).not.toHaveProperty("code")
      })

      it("marks the cycle and attempt failed instead of stranding PROCESSING when the hook handler throws", async () => {
        const container = getContainer()
        const query = container.resolve<any>(ContainerRegistrationKeys.QUERY)
        const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-DISC-THROW-001",
          next_renewal_at: new Date("2026-05-01T10:00:00.000Z"),
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
          order_id: "ord_disc_throw_001",
        })

        resolveAdjustmentsDelegate.mockImplementation(() => {
          throw new Error("terms lookup exploded")
        })

        // In this Medusa version `run()` resolves with the reverted transaction
        // rather than rejecting — the failure lives in `errors` and the flow state.
        const res: any = await processRenewalCycleWorkflow(container).run({
          input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" },
          throwOnError: false,
        } as any)

        expect(
          res.transaction?.getFlow?.()?.state ?? res.transaction?.flow?.state
        ).toBe("reverted")
        expect(
          (res.errors ?? []).map((e: any) => e?.error?.message ?? String(e))
        ).toContain("terms lookup exploded")

        const failedCycle = await renewalModule.retrieveRenewalCycle(cycle.id)
        expect(failedCycle.status).toBe(RenewalCycleStatus.FAILED)
        expect(failedCycle.last_error).toBe("Renewal workflow aborted before completing")

        const attempts = await renewalModule.listRenewalAttempts({
          renewal_cycle_id: cycle.id,
        })
        expect(attempts).toHaveLength(1)
        expect(attempts[0].status).toBe(RenewalAttemptStatus.FAILED)

        expect(mockCreateOrderRun).not.toHaveBeenCalled()
      })

      it("computes the plan discount on the tax-inclusive gross for tax-exclusive snapshots", async () => {
        const container = getContainer()
        const query = container.resolve<any>(ContainerRegistrationKeys.QUERY)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-DISC-TAXEX-001",
          next_renewal_at: new Date("2026-05-01T10:00:00.000Z"),
          source_snapshot: {
            product_id: "prod_disc_taxex",
            variant_id: "variant_disc_taxex",
            title: "Tax-exclusive Product",
            subtitle: null,
            quantity: 1,
            unit_price: 5000,
            sku: "TAXEX-SKU",
            is_discountable: true,
            is_tax_inclusive: false,
            requires_shipping: false,
            tax_lines: [{ code: "VAT23", rate: 23, description: null }],
            adjustments: [],
          },
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
          order_id: "ord_disc_taxex_001",
        })
        mockCreateOrderRun.mockResolvedValue({ result: { id: "ord_disc_taxex_001" } })

        await processRenewalCycleWorkflow(container).run({
          input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" },
        })

        const adjustments = mockCreateOrderRun.mock.calls[0][0].input.items[0].adjustments

        // Checkout discounts off `original_total` (tax-inclusive gross); the
        // renewal must match: 10% of 5000 * 1.23 = 615, not 10% of 5000 = 500.
        expect(adjustments).toHaveLength(1)
        expect(adjustments[0]).toMatchObject({
          amount: 615,
          provider_id: "subscription_discount",
        })
        expect(resolveAdjustmentsDelegate).toHaveBeenCalledWith(
          expect.objectContaining({ line_gross_total: 6150 })
        )
      })

      it("reuses the persisted order on retry after a mid-flight abort instead of creating a duplicate", async () => {
        const container = getContainer()
        const query = container.resolve<any>(ContainerRegistrationKeys.QUERY)
        const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-DISC-REUSE-001",
          next_renewal_at: new Date("2026-05-01T10:00:00.000Z"),
        })

        // A previous attempt created the order, then aborted before finalizing:
        // the cycle is FAILED with the order id persisted.
        const existingOrderId = "ord_disc_reuse_001"
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.FAILED,
          scheduled_for: new Date("2026-05-01T10:00:00.000Z"),
          generated_order_id: existingOrderId,
          attempt_count: 1,
        })

        mockRenewalQueries(query, {
          cart_id: subscription.cart_id,
          customer_id: subscription.customer_id,
          variant_id: subscription.variant_id,
          order_id: existingOrderId,
        })

        await processRenewalCycleWorkflow(container).run({
          input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" },
        })

        // No second order was created for the same billing period.
        expect(mockCreateOrderRun).not.toHaveBeenCalled()

        const updatedCycle = await renewalModule.retrieveRenewalCycle(cycle.id)
        expect(updatedCycle.status).toBe(RenewalCycleStatus.SUCCEEDED)
        expect(updatedCycle.generated_order_id).toBe(existingOrderId)
      })

      it("passes a null pricing payload to the hook and creates no order on skip_next_cycle", async () => {
        const container = getContainer()
        const query = container.resolve<any>(ContainerRegistrationKeys.QUERY)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-DISC-SKIP-001",
          next_renewal_at: new Date("2026-05-01T10:00:00.000Z"),
          skip_next_cycle: true,
        })

        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: new Date("2026-05-01T10:00:00.000Z"),
        })

        jest.spyOn(query, "graph").mockImplementation(async () => ({ data: [] }))

        await processRenewalCycleWorkflow(container).run({
          input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" },
        })

        expect(resolveAdjustmentsDelegate).toHaveBeenCalledWith(
          expect.objectContaining({
            items: null,
            line_gross_total: null,
            currency_code: null,
          })
        )
        expect(mockCreateOrderRun).not.toHaveBeenCalled()
      })
    })

    describe("subscription cart snapshot query", () => {
      beforeEach(() => {
        jest.restoreAllMocks()
      })

      it("returns line-item adjustments for a real cart, pinning the snapshot field list", async () => {
        const container = getContainer()
        const query = container.resolve<any>(ContainerRegistrationKeys.QUERY)
        const cartModule = container.resolve(Modules.CART)

        const cart = await cartModule.createCarts({ currency_code: "pln" })
        const [item] = await cartModule.addLineItems(cart.id, [
          { title: "Subscription plan", quantity: 1, unit_price: 100 },
        ] as any)

        await cartModule.setLineItemAdjustments(cart.id, [
          {
            item_id: item.id,
            amount: 10,
            code: "PROMO10",
            description: "Promo",
          } as any,
        ])

        const { data } = await query.graph({
          entity: "cart",
          fields: SUBSCRIPTION_CART_QUERY_FIELDS,
          filters: { id: [cart.id] },
        })

        const adjustments = data[0]?.items?.[0]?.adjustments
        expect(adjustments).toHaveLength(1)
        expect(adjustments[0]).toMatchObject({ code: "PROMO10", description: "Promo" })
        expect(Number(adjustments[0].amount)).toBe(10)
      })
    })
  },
})

jest.setTimeout(60 * 1000)
