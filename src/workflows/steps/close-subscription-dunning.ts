import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { Modules } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { isActiveDunningCase } from "../../modules/cancellation/utils/retention-offer-policy"
import { DUNNING_MODULE } from "../../modules/dunning"
import type DunningModuleService from "../../modules/dunning/service"
import { DunningCaseStatus } from "../../modules/dunning/types"
import { dunningErrors } from "../../modules/dunning/utils/errors"

export const SUBSCRIPTION_CANCELLED_RECOVERY_REASON =
  "subscription_cancelled_by_customer"

const DUNNING_CASE_LOCK_TIMEOUT_SECONDS = 10

type DunningCaseRecord = {
  id: string
  status: DunningCaseStatus
  next_retry_at: Date | null
  closed_at: Date | null
  recovery_reason: string | null
  metadata: Record<string, unknown> | null
}

export type CloseSubscriptionDunningStepInput = {
  subscription_id: string
  triggered_by?: string | null
  reason?: string | null
}

type CloseSubscriptionDunningStepOutput = {
  subscription_id: string
  closed_dunning_case_ids: string[]
}

type CloseSubscriptionDunningCompensation = {
  previous_cases: DunningCaseRecord[]
}

function appendAuditMetadata(
  metadata: Record<string, unknown> | null,
  input: CloseSubscriptionDunningStepInput,
  at: string
) {
  const existing = Array.isArray(metadata?.manual_actions)
    ? [...(metadata?.manual_actions as Record<string, unknown>[])]
    : []

  existing.push({
    action: "close_for_subscription_cancellation",
    who: input.triggered_by ?? null,
    when: at,
    reason: input.reason ?? null,
  })

  return {
    ...(metadata ?? {}),
    manual_actions: existing,
    last_manual_action: existing[existing.length - 1],
  }
}

export const closeSubscriptionDunningStep = createStep(
  "close-subscription-dunning",
  async function (
    input: CloseSubscriptionDunningStepInput,
    { container }
  ) {
    const dunningModule =
      container.resolve<DunningModuleService>(DUNNING_MODULE)
    const locking = (container as MedusaContainer).resolve(Modules.LOCKING)

    const dunningCases = (await dunningModule.listDunningCases({
      subscription_id: input.subscription_id,
    } as any)) as DunningCaseRecord[]

    const candidateCases = dunningCases.filter((dunningCase) =>
      isActiveDunningCase(dunningCase.status)
    )

    const closedAt = new Date()
    const closedCases: DunningCaseRecord[] = []

    for (const candidateCase of candidateCases) {
      await locking.execute(
        `dunning:${candidateCase.id}`,
        async () => {
          const currentCase = (await dunningModule.retrieveDunningCase(
            candidateCase.id
          )) as DunningCaseRecord

          if (!isActiveDunningCase(currentCase.status)) {
            return
          }

          if (currentCase.status === DunningCaseStatus.RETRYING) {
            throw dunningErrors.retryInFlightTransitionBlocked(
              currentCase.id,
              "be closed for subscription cancellation"
            )
          }

          await dunningModule.updateDunningCases({
            id: currentCase.id,
            status: DunningCaseStatus.UNRECOVERED,
            next_retry_at: null,
            closed_at: closedAt,
            recovery_reason: SUBSCRIPTION_CANCELLED_RECOVERY_REASON,
            metadata: appendAuditMetadata(
              currentCase.metadata,
              input,
              closedAt.toISOString()
            ),
          } as any)

          closedCases.push(currentCase)
        },
        {
          timeout: DUNNING_CASE_LOCK_TIMEOUT_SECONDS,
        }
      )
    }

    if (!closedCases.length) {
      return new StepResponse<
        CloseSubscriptionDunningStepOutput,
        CloseSubscriptionDunningCompensation
      >({
        subscription_id: input.subscription_id,
        closed_dunning_case_ids: [],
      })
    }

    return new StepResponse<
      CloseSubscriptionDunningStepOutput,
      CloseSubscriptionDunningCompensation
    >(
      {
        subscription_id: input.subscription_id,
        closed_dunning_case_ids: closedCases.map(
          (dunningCase) => dunningCase.id
        ),
      },
      {
        previous_cases: closedCases,
      }
    )
  },
  async function (
    compensation: CloseSubscriptionDunningCompensation | undefined,
    { container }
  ) {
    if (!compensation?.previous_cases?.length) {
      return
    }

    const dunningModule =
      container.resolve<DunningModuleService>(DUNNING_MODULE)

    for (const dunningCase of compensation.previous_cases) {
      await dunningModule.updateDunningCases(dunningCase as any)
    }
  }
)
