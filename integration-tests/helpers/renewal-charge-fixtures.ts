import type {
  IOrderModuleService,
  IPaymentModuleService,
  MedusaContainer,
} from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { SubscriptionSourceSnapshot } from "../../src/modules/subscription/types"
import { processRenewalCycleWorkflow } from "../../src/workflows"
import { createPaymentSessionFixture } from "./payment-fixtures"
import type { createSubscriptionSeed } from "./renewal-fixtures"

export const RENEWAL_AMOUNT = 129

export type RenewalChargeMocks = {
  createOrderRun: jest.Mock
  createOrUpdateOrderPaymentCollectionRun: jest.Mock
  createPaymentSessionsRun: jest.Mock
}

type GraphInput = {
  entity: string
  fields: string[]
  filters?: { id?: string | string[] }
}

type GraphQuery = {
  graph: (input: GraphInput) => Promise<{ data: unknown[] }>
}

type SubscriptionSeed = Awaited<ReturnType<typeof createSubscriptionSeed>>

type RenewalChargeStub = {
  subscription: SubscriptionSeed
  order_id: string
  order_item?: SubscriptionSourceSnapshot
}

function targetsOrder(input: GraphInput, orderId: string) {
  const id = input.filters?.id

  return Array.isArray(id) ? id.includes(orderId) : id === orderId
}

export function createRenewalChargeStub(mocks: RenewalChargeMocks) {
  return function stubRenewalCharge(
    container: MedusaContainer,
    stub: RenewalChargeStub
  ) {
    const query = container.resolve<GraphQuery>(ContainerRegistrationKeys.QUERY)
    const originalGraph = query.graph.bind(query)
    const sessionIds: string[] = []

    jest.spyOn(query, "graph").mockImplementation(async (input) => {
      if (input.entity === "cart") {
        return {
          data: [
            {
              id: stub.subscription.cart_id,
              region_id: "reg_test",
              sales_channel_id: "sc_test",
              currency_code: "pln",
              email: "customer@example.com",
              customer_id: stub.subscription.customer_id,
              shipping_address: {
                first_name: "Jan",
                last_name: "Kowalski",
                country_code: "PL",
              },
              billing_address: null,
              items: [
                {
                  title: "Cart Item",
                  quantity: 1,
                  unit_price: 9999,
                  variant_id: stub.subscription.variant_id,
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

      if (input.entity === "order" && targetsOrder(input, stub.order_id)) {
        if (input.fields.includes("items.unit_price")) {
          return {
            data: [
              {
                id: stub.order_id,
                items: stub.order_item
                  ? [{ ...stub.order_item, variant_sku: stub.order_item.sku }]
                  : [],
              },
            ],
          }
        }

        return {
          data: [
            {
              id: stub.order_id,
              total: RENEWAL_AMOUNT,
              summary: { pending_difference: RENEWAL_AMOUNT },
            },
          ],
        }
      }

      return originalGraph(input)
    })

    mocks.createOrderRun.mockResolvedValue({ result: { id: stub.order_id } })
    mocks.createOrUpdateOrderPaymentCollectionRun.mockResolvedValue({
      result: [{ id: `paycol_${stub.order_id}` }],
    })
    mocks.createPaymentSessionsRun.mockImplementation(
      async ({ input }: { input: { context?: Record<string, unknown> } }) => {
        const { session } = await createPaymentSessionFixture(container, {
          amount: RENEWAL_AMOUNT,
          context: input.context,
        })

        sessionIds.push(session.id)

        return { result: session }
      }
    )

    return { sessionIds }
  }
}

export function answerAuthorizationWithNull(container: MedusaContainer) {
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)

  jest
    .spyOn(paymentModule, "authorizePaymentSession")
    .mockResolvedValue(null as never)
}

export async function runRenewal(
  container: MedusaContainer,
  renewalCycleId: string,
  correlationId?: string
) {
  const { result } = await processRenewalCycleWorkflow(container).run({
    input: {
      renewal_cycle_id: renewalCycleId,
      trigger_type: "scheduler",
      correlation_id: correlationId,
    },
  })

  return result
}

export async function createUnpaidOrder(
  container: MedusaContainer,
  metadata?: Record<string, unknown>
) {
  return await container.resolve<IOrderModuleService>(Modules.ORDER).createOrders({
    currency_code: "pln",
    email: "customer@example.com",
    metadata,
    items: [{ title: "Subscription renewal", quantity: 1, unit_price: RENEWAL_AMOUNT }],
  })
}
