import {
  RenewalApprovalStatus,
  RenewalCycleStatus,
} from "../types"

// Row shape produced by RenewalModuleService.listDueRenewalCyclesForWindow
// (raw SQL): the pg driver returns timestamptz columns as Date objects.
export type DueRenewalCycleRecord = {
  id: string
  subscription_id: string
  scheduled_for: Date
  status: RenewalCycleStatus
  approval_required: boolean
  approval_status: RenewalApprovalStatus | null
}

export function isApprovalEligible(record: DueRenewalCycleRecord) {
  if (!record.approval_required) {
    return true
  }

  return record.approval_status === RenewalApprovalStatus.APPROVED
}
