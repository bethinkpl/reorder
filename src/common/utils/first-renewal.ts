import type { FrequencyInterval } from "../types/frequency-interval"
import { advanceCadence } from "./advance-cadence"

function addUtcDays(date: Date, days: number) {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

export function calculateFirstRenewal(input: {
  started_at: Date
  frequency_interval: FrequencyInterval
  frequency_value: number
  trial_days: number
}) {
  const trialEndsAt =
    input.trial_days > 0 ? addUtcDays(input.started_at, input.trial_days) : null

  return {
    trial_ends_at: trialEndsAt,
    next_renewal_at:
      trialEndsAt ??
      advanceCadence(
        input.started_at,
        input.frequency_interval,
        input.frequency_value
      ),
  }
}
