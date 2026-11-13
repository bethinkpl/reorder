import type {
  IOrderModuleService,
  MedusaContainer,
} from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { DateTime } from "luxon"
import { ACTIVITY_LOG_MODULE } from "../../src/modules/activity-log"
import type ActivityLogModuleService from "../../src/modules/activity-log/service"
import { ActivityLogEventType } from "../../src/modules/activity-log/types"
import { DUNNING_MODULE } from "../../src/modules/dunning"
import type DunningModuleService from "../../src/modules/dunning/service"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import {
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../src/modules/renewal/types"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
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
  submitted_at?: Date
}

export type RenewalRefs = { subscription: { id: string }, cycle: { id: string } }

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
    started_at: input.submitted_at,
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

export async function readRenewalState(
  container: MedusaContainer,
  { subscription, cycle }: RenewalRefs
) {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const activityLog = container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)
  const logsOf = (event_type: ActivityLogEventType) =>
    activityLog.listSubscriptionLogs({ subscription_id: subscription.id, event_type })
  const cycles = await renewalModule.listRenewalCycles({ subscription_id: subscription.id })

  return {
    cycle: await renewalModule.retrieveRenewalCycle(cycle.id),
    cycles,
    otherCycles: cycles.filter(({ id }) => id !== cycle.id),
    attempts: await renewalModule.listRenewalAttempts({ renewal_cycle_id: cycle.id }),
    subscription: await container
      .resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
      .retrieveSubscription(subscription.id),
    cases: await container
      .resolve<DunningModuleService>(DUNNING_MODULE)
      .listDunningCases({ subscription_id: subscription.id }),
    failedLogs: await logsOf(ActivityLogEventType.RENEWAL_FAILED),
    succeededLogs: await logsOf(ActivityLogEventType.RENEWAL_SUCCEEDED),
    forceLogs: await logsOf(ActivityLogEventType.RENEWAL_FORCE_REQUESTED),
  }
}

export function oneMonthAfter(date: Date) {
  return DateTime.fromJSDate(date, { zone: "utc" }).plus({ months: 1 }).toJSDate()
}

export function renewalLockKey(subscriptionId: string) {
  return `renewal:subscription:${subscriptionId}`
}

export async function whileRenewalLockHeld<T>(
  container: MedusaContainer,
  subscriptionId: string,
  run: () => Promise<T>
) {
  const locking = container.resolve(Modules.LOCKING)
  const key = renewalLockKey(subscriptionId)
  const ownerId = `renewal-run-on-${subscriptionId}`

  await locking.acquire(key, { ownerId, expire: 60 })

  try {
    return await run()
  } finally {
    await locking.release(key, { ownerId })
  }
}

export function failRenewalLockReleaseOnce(
  container: MedusaContainer,
  subscriptionId: string,
  message: string
) {
  const locking = container.resolve(Modules.LOCKING)
  const release = locking.release.bind(locking)
  const key = renewalLockKey(subscriptionId)
  let failed = false

  jest.spyOn(locking, "release").mockImplementation(async (keys, args) => {
    if (!failed && (Array.isArray(keys) ? keys : [keys]).includes(key)) {
      failed = true
      throw new Error(message)
    }

    return release(keys, args)
  })
}
