import type { FrequencyInterval } from "../types/frequency-interval"

export function advanceCadence(
  date: Date,
  interval: FrequencyInterval,
  value: number
) {
  const next = new Date(date)

  switch (interval) {
    case "day":
      next.setUTCDate(next.getUTCDate() + value)
      return next
    case "week":
      next.setUTCDate(next.getUTCDate() + value * 7)
      return next
    case "month":
      next.setUTCMonth(next.getUTCMonth() + value)
      return next
    case "year":
      next.setUTCFullYear(next.getUTCFullYear() + value)
      return next
  }
}
