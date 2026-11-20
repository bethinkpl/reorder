import { randomUUID } from "crypto"
import type { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { DUNNING_MODULE } from "../../modules/dunning"
import type DunningModuleService from "../../modules/dunning/service"
import {
  ACTIVE_DUNNING_CASE_STATUSES,
  CHARGE_IN_FLIGHT_DUNNING_CASE_STATUSES,
} from "../../modules/dunning/types"
import { dunningCaseLockKey } from "../../modules/dunning/utils/lock-key"
import { RENEWAL_MODULE } from "../../modules/renewal"
import type RenewalModuleService from "../../modules/renewal/service"
import {
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../modules/renewal/types"
import { subscriptionErrors } from "../../modules/subscription/utils/errors"
import { acquireLock } from "../utils/run-under-lock"

const DUNNING_CASE_LOCK = { wait_seconds: 5, hold_seconds: 120 }

export type AssertNoRenewalPaymentInProgressStepInput = {
  subscription_id: string
  action: string
}

/** Released by the workflow once its change is written, as `releaseLockStep({ key, ownerId })`. */
export type DunningCaseLocks = {
  keys: string[]
  owner_id: string
}

/**
 * A cycle left processing with its attempt still open counts: its charge may have been submitted
 * before the run could record that it was waiting.
 */
async function describeRenewalPaymentInProgress(
  container: MedusaContainer,
  subscriptionId: string
): Promise<string | null> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const cycles = await renewalModule.listRenewalCycles({
    subscription_id: subscriptionId,
    status: [RenewalCycleStatus.AWAITING_PAYMENT, RenewalCycleStatus.PROCESSING],
  })

  for (const cycle of cycles) {
    if (cycle.status === RenewalCycleStatus.AWAITING_PAYMENT) {
      return `renewal '${cycle.id}' is awaiting its payment`
    }

    const [latest] = await renewalModule.listRenewalAttempts(
      { renewal_cycle_id: cycle.id },
      { order: { attempt_no: "DESC" }, take: 1 }
    )

    if (latest?.status === RenewalAttemptStatus.PROCESSING) {
      return `renewal '${cycle.id}' has a charge in progress`
    }
  }

  const [dunningCase] = await container
    .resolve<DunningModuleService>(DUNNING_MODULE)
    .listDunningCases(
      {
        subscription_id: subscriptionId,
        status: [...CHARGE_IN_FLIGHT_DUNNING_CASE_STATUSES],
      },
      { select: ["id"], take: 1 }
    )

  return dunningCase
    ? `dunning case '${dunningCase.id}' has a retry charge in progress`
    : null
}

async function lockActiveDunningCases(
  container: MedusaContainer,
  subscriptionId: string
): Promise<DunningCaseLocks> {
  const cases = await container
    .resolve<DunningModuleService>(DUNNING_MODULE)
    .listDunningCases(
      { subscription_id: subscriptionId, status: [...ACTIVE_DUNNING_CASE_STATUSES] },
      { select: ["id"] }
    )
  const locks = { keys: cases.map(({ id }) => dunningCaseLockKey(id)), owner_id: randomUUID() }

  if (locks.keys.length) {
    await acquireLock(container, locks.keys, locks.owner_id, DUNNING_CASE_LOCK)
  }

  return locks
}

async function releaseDunningCaseLocks(container: MedusaContainer, locks: DunningCaseLocks) {
  if (locks.keys.length) {
    await container.resolve(Modules.LOCKING).release(locks.keys, { ownerId: locks.owner_id })
  }
}

/**
 * Run under the `renewal:subscription:<id>` lock, so no renewal run can submit a charge between the
 * check and the change. A dunning retry runs under its case's lock alone, so the step also takes
 * the lock of every active case and hands it to the workflow to release after its change.
 */
export const assertNoRenewalPaymentInProgressStep = createStep(
  "assert-no-renewal-payment-in-progress",
  async function (
    input: AssertNoRenewalPaymentInProgressStepInput,
    { container }
  ) {
    const locks = await lockActiveDunningCases(container, input.subscription_id)

    try {
      const charge = await describeRenewalPaymentInProgress(
        container,
        input.subscription_id
      )

      if (charge) {
        throw subscriptionErrors.renewalPaymentInProgress(
          input.subscription_id,
          input.action,
          charge
        )
      }
    } catch (error) {
      await releaseDunningCaseLocks(container, locks)

      throw error
    }

    return new StepResponse<DunningCaseLocks, DunningCaseLocks>(locks, locks)
  },
  async function (locks: DunningCaseLocks | undefined, { container }) {
    if (locks) {
      await releaseDunningCaseLocks(container, locks)
    }
  }
)
