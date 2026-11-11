import type {
  IOrderModuleService,
  MedusaContainer,
} from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import {
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../src/modules/renewal/types"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import { createPaymentSessionFixture } from "./payment-fixtures"
import {
  createRenewalAttemptSeed,
  createRenewalCycleSeed,
  createSubscriptionSeed,
} from "./renewal-fixtures"

export const AWAITING_ORDER_TOTAL = 100

type AwaitingRenewalSeedInput = {
  reference: string
  scheduled_for?: Date
  subscription_status?: SubscriptionStatus
  cycle_status?: RenewalCycleStatus
}

/**
 * Parks a renewal the way a `null` authorisation leaves it: the cycle holds the order and the
 * stored settlement inputs, the attempt is `processing` against the session, and the order is
 * unpaid until a test captures the session.
 */
export async function seedAwaitingRenewal(
  container: MedusaContainer,
  input: AwaitingRenewalSeedInput
) {
  const orderModule = container.resolve<IOrderModuleService>(Modules.ORDER)
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const link = container.resolve(ContainerRegistrationKeys.LINK)
  const scheduledFor = input.scheduled_for ?? new Date(Date.now() - 60 * 60 * 1000)

  const subscription = await createSubscriptionSeed(container, {
    reference: input.reference,
    status: input.subscription_status ?? SubscriptionStatus.ACTIVE,
    cart_id: `cart_${input.reference}`,
    next_renewal_at: scheduledFor,
  })
  const order = await orderModule.createOrders({
    currency_code: "pln",
    email: "customer@example.com",
    customer_id: subscription.customer_id,
    items: [
      {
        title: "Subscription Product",
        quantity: 1,
        unit_price: AWAITING_ORDER_TOTAL,
      },
    ],
  })

  await link.create({
    [SUBSCRIPTION_MODULE]: { subscription_id: subscription.id },
    [Modules.ORDER]: { order_id: order.id },
  })

  const cycle = await createRenewalCycleSeed(container, {
    subscription_id: subscription.id,
    scheduled_for: scheduledFor,
    status: input.cycle_status ?? RenewalCycleStatus.AWAITING_PAYMENT,
    generated_order_id: order.id,
    attempt_count: 1,
  })
  const { collection, session } = await createPaymentSessionFixture(container, {
    amount: AWAITING_ORDER_TOTAL,
    context: { renewal_cycle_id: cycle.id },
  })

  await link.create({
    [Modules.ORDER]: { order_id: order.id },
    [Modules.PAYMENT]: { payment_collection_id: collection.id },
  })

  const attempt = await createRenewalAttemptSeed(container, {
    renewal_cycle_id: cycle.id,
    attempt_no: 1,
    status: RenewalAttemptStatus.PROCESSING,
    payment_reference: session.id,
    order_id: order.id,
  })

  await renewalModule.updateRenewalCycles({
    id: cycle.id,
    settlement_inputs: {
      attempt_id: attempt.id,
      audit: {
        correlation_id: `renewal-scheduler-${input.reference}`,
        trigger_type: "scheduler",
        triggered_by: null,
        attempt_no: 1,
        operation_started_at: scheduledFor.getTime(),
        scheduled_for: scheduledFor.toISOString(),
        previous_state: {
          status: RenewalCycleStatus.SCHEDULED,
          attempt_count: 0,
          processed_at: null,
          generated_order_id: null,
          last_error: null,
        },
      },
      source_snapshot: null,
    },
  })

  return { subscription, order, cycle, attempt, session, scheduledFor }
}

export type SeededAwaitingRenewal = Awaited<ReturnType<typeof seedAwaitingRenewal>>
