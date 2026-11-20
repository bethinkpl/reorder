import { RetentionOfferType } from "../types"
import { SubscriptionStatus } from "../../subscription/types"
import { ACTIVE_DUNNING_CASE_STATUSES, DunningCaseStatus } from "../../dunning/types"

type RetentionOfferPolicyInput = {
  subscription_status: SubscriptionStatus
  has_active_dunning: boolean
}

export function isActiveDunningCase(status: DunningCaseStatus) {
  return ACTIVE_DUNNING_CASE_STATUSES.includes(status)
}

export function getEligibleRetentionOfferTypes(
  input: RetentionOfferPolicyInput
) {
  if (input.subscription_status === SubscriptionStatus.PAUSED) {
    return [] as RetentionOfferType[]
  }

  if (
    input.subscription_status === SubscriptionStatus.PAST_DUE ||
    input.has_active_dunning
  ) {
    return [RetentionOfferType.PAUSE_OFFER, RetentionOfferType.BONUS_OFFER]
  }

  return [
    RetentionOfferType.PAUSE_OFFER,
    RetentionOfferType.DISCOUNT_OFFER,
    RetentionOfferType.BONUS_OFFER,
  ]
}
