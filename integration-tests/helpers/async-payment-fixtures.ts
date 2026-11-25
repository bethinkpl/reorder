import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { DateTime } from "luxon"
import { ACTIVITY_LOG_MODULE } from "../../src/modules/activity-log"
import type ActivityLogModuleService from "../../src/modules/activity-log/service"
import { ActivityLogEventType } from "../../src/modules/activity-log/types"
import { DUNNING_MODULE } from "../../src/modules/dunning"
import type DunningModuleService from "../../src/modules/dunning/service"
import { CHARGE_IN_FLIGHT_DUNNING_CASE_STATUSES, DunningCaseStatus } from "../../src/modules/dunning/types"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import { RenewalCycleStatus } from "../../src/modules/renewal/types"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import {
  SYSTEM_PAYMENT_PROVIDER_ID,
  answerAuthorizationWithNull,
  createOrderPaymentCollection,
  createSystemPaymentSession,
  createUnpaidOrder,
  routeChargesToFixtures,
  runRenewal,
} from "./charge-fixtures"
import { createDunningAttemptSeed, createDunningCaseSeed } from "./dunning-fixtures"
import { createRenewalCycleSeed, createSubscriptionSeed } from "./renewal-fixtures"

const HOUR_MS = 60 * 60 * 1000

export type RenewalRefs = { subscription: { id: string }, cycle: { id: string } }

type DueRenewalSeedInput = {
  reference: string
  due_at?: Date
  cycle_status?: RenewalCycleStatus
  attempt_count?: number
}

function seedSubscription(container: MedusaContainer, reference: string, dueAt: Date, status?: SubscriptionStatus) {
  return createSubscriptionSeed(container, {
    reference,
    status,
    customer_id: `cus_${reference}`,
    cart_id: `cart_${reference}`,
    next_renewal_at: dueAt,
    payment_context: {
      payment_provider_id: SYSTEM_PAYMENT_PROVIDER_ID,
      account_holder_id: `acch_${reference}`,
      payment_method_id: `pm_${reference}`,
    },
  })
}

export function oneMonthAfter(date: Date) {
  return DateTime.fromJSDate(date, { zone: "utc" }).plus({ months: 1 }).toJSDate()
}

export async function seedDueRenewal(container: MedusaContainer, input: DueRenewalSeedInput) {
  const dueAt = input.due_at ?? new Date(Date.now() - HOUR_MS)
  const subscription = await seedSubscription(container, input.reference, dueAt)
  const cycle = await createRenewalCycleSeed(container, {
    subscription_id: subscription.id,
    scheduled_for: dueAt,
    status: input.cycle_status,
    attempt_count: input.attempt_count,
  })

  return { subscription, cycle, dueAt }
}

export async function seedAwaitingRenewal(container: MedusaContainer, input: DueRenewalSeedInput) {
  const seeded = await seedDueRenewal(container, input)
  const charges = routeChargesToFixtures(container)
  const authorize = answerAuthorizationWithNull()

  await runRenewal(container, seeded.cycle.id)
  authorize.mockRestore()

  const renewals = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const [attempt] = await renewals.listRenewalAttempts({ renewal_cycle_id: seeded.cycle.id })

  return { ...seeded, charges, attempt, order_id: charges.orders[0], session: charges.sessions[0] }
}

export async function readRenewalState(container: MedusaContainer, { subscription, cycle }: RenewalRefs) {
  const renewals = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const activityLog = container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)
  const logsOf = (event_type: ActivityLogEventType) =>
    activityLog.listSubscriptionLogs({ subscription_id: subscription.id, event_type })
  const cycles = await renewals.listRenewalCycles({ subscription_id: subscription.id }, { order: { id: "ASC" } })

  return {
    cycle: await renewals.retrieveRenewalCycle(cycle.id),
    otherCycles: cycles.filter(({ id }) => id !== cycle.id),
    attempts: await renewals.listRenewalAttempts({ renewal_cycle_id: cycle.id }, { order: { attempt_no: "ASC" } }),
    subscription: await container
      .resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
      .retrieveSubscription(subscription.id),
    cases: await container
      .resolve<DunningModuleService>(DUNNING_MODULE)
      .listDunningCases({ subscription_id: subscription.id }, { order: { id: "ASC" } }),
    failedLogs: await logsOf(ActivityLogEventType.RENEWAL_FAILED),
    succeededLogs: await logsOf(ActivityLogEventType.RENEWAL_SUCCEEDED),
    forceLogs: await logsOf(ActivityLogEventType.RENEWAL_FORCE_REQUESTED),
  }
}

export async function seedDunningCase(
  container: MedusaContainer,
  input: { reference: string, status?: DunningCaseStatus, attempt_count?: number }
) {
  const status = input.status ?? DunningCaseStatus.AWAITING_PAYMENT
  const inFlight = CHARGE_IN_FLIGHT_DUNNING_CASE_STATUSES.includes(status)
  const attemptCount = input.attempt_count ?? (inFlight ? 1 : 0)
  const dueAt = new Date(Date.now() - 48 * HOUR_MS)
  const subscription = await seedSubscription(container, input.reference, dueAt, SubscriptionStatus.PAST_DUE)
  const order = await createUnpaidOrder(container)

  await container.resolve(ContainerRegistrationKeys.LINK).create({
    [SUBSCRIPTION_MODULE]: { subscription_id: subscription.id },
    [Modules.ORDER]: { order_id: order.id },
  })

  const cycle = await createRenewalCycleSeed(container, {
    subscription_id: subscription.id,
    status: RenewalCycleStatus.FAILED,
    scheduled_for: dueAt,
    generated_order_id: order.id,
    attempt_count: 1,
  })
  const dunningCase = await createDunningCaseSeed(container, {
    subscription_id: subscription.id,
    renewal_cycle_id: cycle.id,
    renewal_order_id: order.id,
    status,
    attempt_count: attemptCount,
    next_retry_at: status === DunningCaseStatus.RETRY_SCHEDULED ? new Date(Date.now() - 60_000) : null,
  })

  if (!inFlight) {
    return { subscription, order, cycle, dunningCase, attempt: null, session: null }
  }

  const attempt = await createDunningAttemptSeed(container, { dunning_case_id: dunningCase.id, attempt_no: attemptCount })
  const session = await createSystemPaymentSession(container, {
    payment_collection_id: (await createOrderPaymentCollection(container, order.id)).id,
    context: { dunning_case_id: dunningCase.id, dunning_attempt_id: attempt.id },
  })

  await container
    .resolve<DunningModuleService>(DUNNING_MODULE)
    .updateDunningAttempts({ id: attempt.id, payment_reference: session.id })

  return { subscription, order, cycle, dunningCase, attempt, session }
}

export async function readDunningState(container: MedusaContainer, dunningCaseId: string) {
  const dunning = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const dunningCase = await dunning.retrieveDunningCase(dunningCaseId)

  return {
    dunningCase,
    attempts: await dunning.listDunningAttempts({ dunning_case_id: dunningCaseId }, { order: { attempt_no: "ASC" } }),
    subscription: await container
      .resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
      .retrieveSubscription(dunningCase.subscription_id),
    cycle: await container
      .resolve<RenewalModuleService>(RENEWAL_MODULE)
      .retrieveRenewalCycle(dunningCase.renewal_cycle_id),
  }
}
