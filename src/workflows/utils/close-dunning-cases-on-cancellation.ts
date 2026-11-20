import type { MedusaContainer } from "@medusajs/framework/types"
import { isActiveDunningCase } from "../../modules/cancellation/utils/retention-offer-policy"
import { DUNNING_MODULE } from "../../modules/dunning"
import type DunningModuleService from "../../modules/dunning/service"
import { DunningCaseStatus, DunningRecoveryReason } from "../../modules/dunning/types"
import { dunningCaseLockKey } from "../../modules/dunning/utils/lock-key"
import { runUnderLock } from "./run-under-lock"

const DUNNING_CASE_LOCK = { wait_seconds: 10, hold_seconds: 120 }

export type ClosedDunningCase = {
  id: string
  status: DunningCaseStatus
  next_retry_at: Date | string | null
  closed_at: Date | string | null
  recovery_reason: string | null
  metadata: Record<string, unknown> | null
}

export type CloseDunningCasesOnCancellationInput = {
  subscription_id: string
  triggered_by?: string | null
  reason?: string | null
  recovery_reason?: DunningRecoveryReason
}

function appendAuditMetadata(
  metadata: Record<string, unknown> | null,
  input: CloseDunningCasesOnCancellationInput,
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

/**
 * Closes the subscription's active dunning cases as unrecovered, each under its own
 * `dunning:<case_id>` lock. A retry run holds that lock until it writes its outcome, so a case
 * still `retrying` here belongs to a run that died or failed to park it, and is closed too. An
 * attempt with a charge in flight is left processing, so its late signal still finds it. A throw
 * restores the cases closed before it.
 */
export async function closeDunningCasesOnCancellation(
  container: MedusaContainer,
  input: CloseDunningCasesOnCancellationInput
): Promise<ClosedDunningCase[]> {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const candidates = (await dunningModule.listDunningCases({
    subscription_id: input.subscription_id,
  })) as ClosedDunningCase[]
  const closedAt = new Date()
  const closed: ClosedDunningCase[] = []

  try {
    for (const candidate of candidates.filter(({ status }) => isActiveDunningCase(status))) {
      await runUnderLock(
        container,
        dunningCaseLockKey(candidate.id),
        async () => {
          const current = (await dunningModule.retrieveDunningCase(
            candidate.id
          )) as ClosedDunningCase

          if (!isActiveDunningCase(current.status)) {
            return
          }

          closed.push(current)

          await dunningModule.updateDunningCases({
            id: current.id,
            status: DunningCaseStatus.UNRECOVERED,
            next_retry_at: null,
            closed_at: closedAt,
            recovery_reason:
              input.recovery_reason ?? DunningRecoveryReason.SUBSCRIPTION_CANCELLED_BY_CUSTOMER,
            metadata: appendAuditMetadata(current.metadata, input, closedAt.toISOString()),
          })
        },
        DUNNING_CASE_LOCK
      )
    }
  } catch (error) {
    await restoreClosedDunningCases(container, closed)

    throw error
  }

  return closed
}

export async function restoreClosedDunningCases(
  container: MedusaContainer,
  closed: ClosedDunningCase[]
): Promise<void> {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)

  for (const dunningCase of closed) {
    // The module merges a JSON column into its stored value, so restoring the old metadata over
    // the closing write would keep the audit entries it appended.
    await dunningModule.updateDunningCases({ id: dunningCase.id, metadata: null })
    await dunningModule.updateDunningCases({
      id: dunningCase.id,
      status: dunningCase.status,
      next_retry_at: dunningCase.next_retry_at ? new Date(dunningCase.next_retry_at) : null,
      closed_at: dunningCase.closed_at ? new Date(dunningCase.closed_at) : null,
      recovery_reason: dunningCase.recovery_reason,
      metadata: dunningCase.metadata,
    })
  }
}
