import { calculateFirstRenewal } from "../../../common/utils/first-renewal"
import type {
  PlanOfferAllowedFrequency,
  PlanOfferRules,
  ProductSubscriptionConfig,
} from "../types"

export function resolveTrialDays(rules: PlanOfferRules | null) {
  return rules?.trial_enabled && rules.trial_days ? rules.trial_days : 0
}

export function getDefaultFrequency(
  config: ProductSubscriptionConfig
): PlanOfferAllowedFrequency | null {
  return config.is_enabled ? (config.allowed_frequencies[0] ?? null) : null
}

export function previewFirstRenewalAt(
  config: ProductSubscriptionConfig,
  startedAt: Date
): Date | null {
  const frequency = getDefaultFrequency(config)

  if (!frequency) {
    return null
  }

  return (
    calculateFirstRenewal({
      started_at: startedAt,
      frequency_interval: frequency.interval,
      frequency_value: frequency.value,
      trial_days: resolveTrialDays(config.rules),
    }).next_renewal_at ?? null
  )
}
