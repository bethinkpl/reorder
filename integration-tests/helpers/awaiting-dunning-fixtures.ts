import type { MedusaContainer, PaymentSessionDTO } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { DUNNING_MODULE } from "../../src/modules/dunning"
import type DunningModuleService from "../../src/modules/dunning/service"
import { DunningAttemptStatus, DunningCaseStatus } from "../../src/modules/dunning/types"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import { RenewalCycleStatus } from "../../src/modules/renewal/types"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import {
  createDunningAttemptSeed,
  createDunningCaseSeed,
  createRenewalCycleSeed,
  createSubscriptionSeed,
} from "./dunning-fixtures"
import { SYSTEM_PAYMENT_PROVIDER_ID, createPaymentSessionFixture } from "./payment-fixtures"
import {
  RENEWAL_AMOUNT,
  type RenewalChargeMocks,
  createUnpaidOrder,
} from "./renewal-charge-fixtures"

const DAY_MS = 24 * 60 * 60 * 1000

type DunningCaseSeedOptions = {
  status?: DunningCaseStatus
  attempt_count?: number
  max_attempts?: number
  customer_id?: string
  attempts?: DunningAttemptStatus[]
}

export async function seedDunningCase(
  container: MedusaContainer,
  reference: string,
  options: DunningCaseSeedOptions = {}
) {
  const status = options.status ?? DunningCaseStatus.AWAITING_PAYMENT
  const attemptCount = options.attempt_count ?? 1
  const attemptStatuses = options.attempts ?? [DunningAttemptStatus.PROCESSING]
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const link = container.resolve(ContainerRegistrationKeys.LINK)
  const dueAt = new Date(Date.now() - 2 * DAY_MS)

  const subscription = await createSubscriptionSeed(container, {
    reference,
    status: SubscriptionStatus.PAST_DUE,
    customer_id: options.customer_id,
    next_renewal_at: dueAt,
    payment_context: {
      payment_provider_id: SYSTEM_PAYMENT_PROVIDER_ID,
      account_holder_id: `acch_${reference}`,
      payment_method_id: `pm_${reference}`,
    },
  })
  const order = await createUnpaidOrder(container, { subscription_id: subscription.id })
  const cycle = await createRenewalCycleSeed(container, {
    subscription_id: subscription.id,
    status: RenewalCycleStatus.FAILED,
    scheduled_for: dueAt,
    generated_order_id: order.id,
  })
  const dunningCase = await createDunningCaseSeed(container, {
    subscription_id: subscription.id,
    renewal_cycle_id: cycle.id,
    renewal_order_id: order.id,
    status,
    attempt_count: attemptCount,
    max_attempts: options.max_attempts,
    next_retry_at:
      status === DunningCaseStatus.RETRY_SCHEDULED ? new Date(Date.now() - 60_000) : null,
  })
  const attempts: {
    attempt: Awaited<ReturnType<typeof createDunningAttemptSeed>>
    session: PaymentSessionDTO
  }[] = []

  for (const [index, attemptStatus] of attemptStatuses.entries()) {
    const attempt = await createDunningAttemptSeed(container, {
      dunning_case_id: dunningCase.id,
      attempt_no: attemptCount - attemptStatuses.length + index + 1,
      status: attemptStatus,
      finished_at: attemptStatus === DunningAttemptStatus.PROCESSING ? null : new Date(),
    })
    const { collection, session } = await createPaymentSessionFixture(container, {
      amount: RENEWAL_AMOUNT,
      context: { dunning_case_id: dunningCase.id, dunning_attempt_id: attempt.id },
    })

    await dunningModule.updateDunningAttempts({ id: attempt.id, payment_reference: session.id })
    await link.create({
      [Modules.ORDER]: { order_id: order.id },
      [Modules.PAYMENT]: { payment_collection_id: collection.id },
    })
    attempts.push({ attempt, session })
  }

  return { subscription, order, cycle, dunningCase, attempts }
}

export type SeededDunningCase = Awaited<ReturnType<typeof seedDunningCase>>

export async function readDunningState(container: MedusaContainer, dunningCaseId: string) {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const dunningCase = await dunningModule.retrieveDunningCase(dunningCaseId)

  return {
    dunningCase,
    attempts: await dunningModule.listDunningAttempts(
      { dunning_case_id: dunningCaseId },
      { order: { attempt_no: "ASC" } }
    ),
    subscription: await container
      .resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
      .retrieveSubscription(dunningCase.subscription_id),
    cycle: await container
      .resolve<RenewalModuleService>(RENEWAL_MODULE)
      .retrieveRenewalCycle(dunningCase.renewal_cycle_id),
  }
}

export function createRetrySessionRouter(
  mocks: Pick<
    RenewalChargeMocks,
    "createOrUpdateOrderPaymentCollectionRun" | "createPaymentSessionsRun"
  >
) {
  return function routeRetrySessionsToFixture(container: MedusaContainer) {
    const sessions: PaymentSessionDTO[] = []

    mocks.createOrUpdateOrderPaymentCollectionRun.mockResolvedValue({
      result: [{ id: "paycol_retry" }],
    })
    mocks.createPaymentSessionsRun.mockImplementation(
      async ({ input }: { input: { context?: Record<string, unknown> } }) => {
        const { session } = await createPaymentSessionFixture(container, {
          amount: RENEWAL_AMOUNT,
          context: input.context,
        })

        sessions.push(session)

        // The system provider keeps no data on a session, which a retry reads as an indeterminate answer.
        return { result: { ...session, data: { reference: session.id } } }
      }
    )

    return sessions
  }
}
