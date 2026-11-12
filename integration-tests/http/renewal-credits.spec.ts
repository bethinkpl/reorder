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

const applyCreditsDelegate = jest.fn()
;(globalThis as Record<string, unknown>).__applyRenewalCreditsTestDelegate =
  applyCreditsDelegate

function mockRenewalQueries(
  query: { graph: (...args: unknown[]) => unknown },
  options: {
    cart_id: string | null
    customer_id: string
    variant_id: string
    order_id: string
    order_amounts: () => { total: number, pending_difference: number }
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
            shipping_address: { country_code: "PL" },
            billing_address: null,
            items: [{ variant_id: options.variant_id, quantity: 1, unit_price: 5000 }],
            shipping_methods: [],
          },
        ],
      }
    }

    if (input.entity === "order") {
      const { total, pending_difference } = options.order_amounts()

      return {
        data: [{ id: options.order_id, total, summary: { pending_difference } }],
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
    describe("renewal credits hook", () => {
      beforeEach(() => {
        jest.restoreAllMocks()
        jest.clearAllMocks()
        applyCreditsDelegate.mockReset()
      })

      it("hands the new order to the hook and charges nothing once credits cover it", async () => {
        const container = getContainer()
        const query = container.resolve<any>(ContainerRegistrationKeys.QUERY)
        const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-CREDIT-FULL-001",
          next_renewal_at: new Date("2026-05-01T10:00:00.000Z"),
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: new Date("2026-05-01T10:00:00.000Z"),
        })

        let credited = false
        mockRenewalQueries(query, {
          cart_id: subscription.cart_id,
          customer_id: subscription.customer_id,
          variant_id: subscription.variant_id,
          order_id: "ord_credit_full_001",
          order_amounts: () =>
            credited
              ? { total: 0, pending_difference: 0 }
              : { total: 4500, pending_difference: 4500 },
        })
        mockCreateOrderRun.mockResolvedValue({ result: { id: "ord_credit_full_001" } })
        applyCreditsDelegate.mockImplementation(() => {
          credited = true
        })

        await processRenewalCycleWorkflow(container).run({
          input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" },
        })

        expect(applyCreditsDelegate).toHaveBeenCalledTimes(1)
        expect(applyCreditsDelegate).toHaveBeenCalledWith(
          expect.objectContaining({
            order_id: "ord_credit_full_001",
            renewal_cycle_id: cycle.id,
            subscription: expect.objectContaining({ id: subscription.id }),
          })
        )
        expect(mockCreateOrUpdateOrderPaymentCollectionRun).not.toHaveBeenCalled()
        expect(mockCreatePaymentSessionsRun).not.toHaveBeenCalled()

        const updatedCycle = await renewalModule.retrieveRenewalCycle(cycle.id)
        expect(updatedCycle.status).toBe(RenewalCycleStatus.SUCCEEDED)
        expect(updatedCycle.generated_order_id).toBe("ord_credit_full_001")
      })

      it("sizes the payment collection from what the credits left", async () => {
        const container = getContainer()
        const query = container.resolve<any>(ContainerRegistrationKeys.QUERY)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-CREDIT-PART-001",
          next_renewal_at: new Date("2026-05-01T10:00:00.000Z"),
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.SCHEDULED,
          scheduled_for: new Date("2026-05-01T10:00:00.000Z"),
        })

        let credited = false
        mockRenewalQueries(query, {
          cart_id: subscription.cart_id,
          customer_id: subscription.customer_id,
          variant_id: subscription.variant_id,
          order_id: "ord_credit_part_001",
          order_amounts: () =>
            credited
              ? { total: 1500, pending_difference: 1500 }
              : { total: 4500, pending_difference: 4500 },
        })
        mockCreateOrderRun.mockResolvedValue({ result: { id: "ord_credit_part_001" } })
        mockCreateOrUpdateOrderPaymentCollectionRun.mockRejectedValue(
          new Error("collection refused for the test")
        )
        applyCreditsDelegate.mockImplementation(() => {
          credited = true
        })

        await processRenewalCycleWorkflow(container).run({
          input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" },
          throwOnError: false,
        } as any)

        expect(mockCreateOrUpdateOrderPaymentCollectionRun).toHaveBeenCalledWith({
          input: { order_id: "ord_credit_part_001", amount: 1500 },
        })
      })

      it("runs the hook again when a retry reuses the order", async () => {
        const container = getContainer()
        const query = container.resolve<any>(ContainerRegistrationKeys.QUERY)
        const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-CREDIT-REUSE-001",
          next_renewal_at: new Date("2026-05-01T10:00:00.000Z"),
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.FAILED,
          scheduled_for: new Date("2026-05-01T10:00:00.000Z"),
          generated_order_id: "ord_credit_reuse_001",
          attempt_count: 1,
        })

        mockRenewalQueries(query, {
          cart_id: subscription.cart_id,
          customer_id: subscription.customer_id,
          variant_id: subscription.variant_id,
          order_id: "ord_credit_reuse_001",
          order_amounts: () => ({ total: 0, pending_difference: 0 }),
        })

        await processRenewalCycleWorkflow(container).run({
          input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" },
        })

        expect(mockCreateOrderRun).not.toHaveBeenCalled()
        expect(applyCreditsDelegate).toHaveBeenCalledWith(
          expect.objectContaining({ order_id: "ord_credit_reuse_001" })
        )

        const updatedCycle = await renewalModule.retrieveRenewalCycle(cycle.id)
        expect(updatedCycle.status).toBe(RenewalCycleStatus.SUCCEEDED)
      })

      it("fails the cycle without charging when the hook throws, keeping the order for the retry", async () => {
        const container = getContainer()
        const query = container.resolve<any>(ContainerRegistrationKeys.QUERY)
        const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-CREDIT-THROW-001",
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
          order_id: "ord_credit_throw_001",
          order_amounts: () => ({ total: 4500, pending_difference: 4500 }),
        })
        mockCreateOrderRun.mockResolvedValue({ result: { id: "ord_credit_throw_001" } })
        applyCreditsDelegate.mockImplementation(() => {
          throw new Error("gift cards unavailable")
        })

        const res: any = await processRenewalCycleWorkflow(container).run({
          input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" },
          throwOnError: false,
        } as any)

        expect(
          (res.errors ?? []).map((e: any) => e?.error?.message ?? String(e))
        ).toContain("gift cards unavailable")
        expect(mockCreateOrUpdateOrderPaymentCollectionRun).not.toHaveBeenCalled()

        const failedCycle = await renewalModule.retrieveRenewalCycle(cycle.id)
        expect(failedCycle.status).toBe(RenewalCycleStatus.FAILED)
        expect(failedCycle.generated_order_id).toBe("ord_credit_throw_001")
      })

      it("keeps today's behaviour when the hook does nothing", async () => {
        const container = getContainer()
        const query = container.resolve<any>(ContainerRegistrationKeys.QUERY)

        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-CREDIT-NONE-001",
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
          order_id: "ord_credit_none_001",
          order_amounts: () => ({ total: 4500, pending_difference: 4500 }),
        })
        mockCreateOrderRun.mockResolvedValue({ result: { id: "ord_credit_none_001" } })
        mockCreateOrUpdateOrderPaymentCollectionRun.mockRejectedValue(
          new Error("collection refused for the test")
        )

        await processRenewalCycleWorkflow(container).run({
          input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" },
          throwOnError: false,
        } as any)

        expect(mockCreateOrUpdateOrderPaymentCollectionRun).toHaveBeenCalledWith({
          input: { order_id: "ord_credit_none_001", amount: 4500 },
        })
      })
    })
  },
})

jest.setTimeout(60 * 1000)
