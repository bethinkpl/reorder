import { FrequencyInterval } from "../../../../common/types/frequency-interval"
import type { ProductSubscriptionConfig } from "../../types"
import { PlanOfferScope, PlanOfferStackingPolicy } from "../../types"
import {
  getDefaultFrequency,
  previewFirstRenewalAt,
  resolveTrialDays,
} from "../subscription-preview"

const startedAt = new Date("2026-01-31T12:00:00.000Z")

function buildConfig(
  overrides: Partial<ProductSubscriptionConfig> = {}
): ProductSubscriptionConfig {
  return {
    product_id: "prod_1",
    variant_id: "var_1",
    source_offer_id: "po_1",
    source_scope: PlanOfferScope.VARIANT,
    is_enabled: true,
    allowed_frequencies: [
      { interval: FrequencyInterval.MONTH, value: 1 },
      { interval: FrequencyInterval.MONTH, value: 3 },
    ],
    discount_per_frequency: [],
    rules: {
      minimum_cycles: null,
      trial_enabled: false,
      trial_days: null,
      stacking_policy: PlanOfferStackingPolicy.ALLOWED,
    },
    ...overrides,
  }
}

describe("resolveTrialDays", () => {
  it("counts trial days only when the trial is enabled", () => {
    const rules = buildConfig().rules!

    expect(resolveTrialDays({ ...rules, trial_enabled: true, trial_days: 14 })).toBe(14)
    expect(resolveTrialDays({ ...rules, trial_enabled: false, trial_days: 14 })).toBe(0)
    expect(resolveTrialDays(null)).toBe(0)
  })
})

describe("getDefaultFrequency", () => {
  it("sells the first allowed frequency", () => {
    expect(getDefaultFrequency(buildConfig())).toEqual({
      interval: FrequencyInterval.MONTH,
      value: 1,
    })
  })

  it("has none for an inactive offer or one without frequencies", () => {
    expect(getDefaultFrequency(buildConfig({ is_enabled: false }))).toBeNull()
    expect(getDefaultFrequency(buildConfig({ allowed_frequencies: [] }))).toBeNull()
  })
})

describe("previewFirstRenewalAt", () => {
  it("dates the first renewal the way subscription creation does", () => {
    expect(previewFirstRenewalAt(buildConfig(), startedAt)).toEqual(
      new Date("2026-03-03T12:00:00.000Z")
    )
  })

  it("renews when an enabled trial ends", () => {
    const config = buildConfig()

    expect(
      previewFirstRenewalAt(
        { ...config, rules: { ...config.rules!, trial_enabled: true, trial_days: 7 } },
        startedAt
      )
    ).toEqual(new Date("2026-02-07T12:00:00.000Z"))
  })

  it("has no date for an inactive offer", () => {
    expect(previewFirstRenewalAt(buildConfig({ is_enabled: false }), startedAt)).toBeNull()
  })
})
