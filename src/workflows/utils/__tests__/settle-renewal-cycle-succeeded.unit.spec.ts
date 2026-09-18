import type { MedusaContainer } from "@medusajs/framework/types"
import { FrequencyInterval } from "../../../common/types/frequency-interval"
import {
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../../modules/renewal/types"
import { settleRenewalCycleSucceeded } from "../settle-renewal-cycle-succeeded"

jest.mock("../../../modules/plan-offer/utils/effective-config", () => ({
  resolveProductSubscriptionConfig: jest.fn(async () => ({
    is_enabled: true,
    discount_per_frequency: [
      {
        interval: "month",
        value: 3,
        discount_type: "percentage",
        discount_value: 10,
      },
    ],
  })),
}))

const pendingChange = {
  variant_id: "var_new",
  variant_title: "Quarterly",
  sku: "SKU-NEW",
  frequency_interval: FrequencyInterval.MONTH,
  frequency_value: 3,
  effective_at: null,
}

type BuildOptions = {
  cycleStatus?: RenewalCycleStatus
  appliedPendingUpdateData?: typeof pendingChange | null
  attempts?: { id: string, attempt_no: number }[]
}

function buildContainer(options: BuildOptions = {}) {
  const cycle = {
    id: "rc_1",
    subscription_id: "sub_1",
    scheduled_for: new Date("2026-03-01T00:00:00.000Z"),
    processed_at: null,
    status: options.cycleStatus ?? RenewalCycleStatus.FAILED,
    generated_order_id: "order_1",
    applied_pending_update_data: options.appliedPendingUpdateData ?? null,
    attempt_count: 2,
    last_error: "card_declined",
  }

  const subscription = {
    id: "sub_1",
    product_id: "prod_1",
    variant_id: "var_old",
    frequency_interval: FrequencyInterval.MONTH,
    frequency_value: 1,
    product_snapshot: {
      product_id: "prod_1",
      product_title: "Plan",
      variant_id: "var_old",
      variant_title: "Monthly",
      sku: "SKU-OLD",
    },
    pricing_snapshot: { discount_type: "percentage", discount_value: 5, label: "5% off" },
    pending_update_data: { variant_id: "var_new" },
  }

  const updateSubscriptions = jest.fn(async () => undefined)
  const updateRenewalCycles = jest.fn(async (payload: Record<string, unknown>) => ({
    ...cycle,
    ...payload,
  }))
  const updateRenewalAttempts = jest.fn(async () => undefined)
  const linkCreate = jest.fn(async () => undefined)

  const container = {
    resolve: (key: string) => {
      if (key === "renewal") {
        return {
          retrieveRenewalCycle: jest.fn(async () => cycle),
          listRenewalAttempts: jest.fn(async () => options.attempts ?? []),
          updateRenewalCycles,
          updateRenewalAttempts,
        }
      }

      if (key === "subscription") {
        return {
          retrieveSubscription: jest.fn(async () => subscription),
          updateSubscriptions,
        }
      }

      if (key === "link") {
        return { create: linkCreate }
      }

      throw new Error(`Unexpected resolve('${key}')`)
    },
  } as unknown as MedusaContainer

  return {
    container,
    updateSubscriptions,
    updateRenewalCycles,
    updateRenewalAttempts,
    linkCreate,
  }
}

const finishedAt = new Date("2026-03-02T12:00:00.000Z")

describe("settleRenewalCycleSucceeded", () => {
  it("settles a failed cycle and advances the subscription's billing dates", async () => {
    const { container, updateSubscriptions, updateRenewalCycles } = buildContainer()

    const result = await settleRenewalCycleSucceeded(container, {
      renewal_cycle_id: "rc_1",
      subscription_id: "sub_1",
      order_id: "order_1",
      finished_at: finishedAt,
      attempt_id: "rat_1",
    })

    expect(result.settled).toBe(true)
    expect(updateSubscriptions).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "sub_1",
        // The anchor is the cycle's scheduled date, not the day the money arrived.
        next_renewal_at: new Date("2026-04-01T00:00:00.000Z"),
        last_renewal_at: finishedAt,
        skip_next_cycle: false,
      })
    )
    expect(updateRenewalCycles).toHaveBeenCalledWith({
      id: "rc_1",
      status: RenewalCycleStatus.SUCCEEDED,
      processed_at: finishedAt,
      generated_order_id: "order_1",
      last_error: null,
    })
  })

  it("links the order to both the cycle and the subscription", async () => {
    const { container, linkCreate } = buildContainer()

    await settleRenewalCycleSucceeded(container, {
      renewal_cycle_id: "rc_1",
      subscription_id: "sub_1",
      order_id: "order_1",
      finished_at: finishedAt,
    })

    expect(linkCreate).toHaveBeenCalledWith({
      renewal: { renewal_cycle_id: "rc_1" },
      order: { order_id: "order_1" },
    })
    expect(linkCreate).toHaveBeenCalledWith({
      subscription: { subscription_id: "sub_1" },
      order: { order_id: "order_1" },
    })
  })

  it("applies the plan change the cycle carried", async () => {
    const { container, updateSubscriptions } = buildContainer({
      appliedPendingUpdateData: pendingChange,
    })

    await settleRenewalCycleSucceeded(container, {
      renewal_cycle_id: "rc_1",
      subscription_id: "sub_1",
      order_id: "order_1",
      finished_at: finishedAt,
    })

    expect(updateSubscriptions).toHaveBeenCalledWith(
      expect.objectContaining({
        variant_id: "var_new",
        frequency_interval: FrequencyInterval.MONTH,
        frequency_value: 3,
        next_renewal_at: new Date("2026-06-01T00:00:00.000Z"),
        pending_update_data: null,
        pricing_snapshot: {
          discount_type: "percentage",
          discount_value: 10,
          label: "10% off",
        },
        product_snapshot: expect.objectContaining({
          variant_id: "var_new",
          variant_title: "Quarterly",
          sku: "SKU-NEW",
        }),
      })
    )
  })

  it("settles the cycle's newest attempt when the caller owns none", async () => {
    const { container, updateRenewalAttempts } = buildContainer({
      attempts: [
        { id: "rat_1", attempt_no: 1 },
        { id: "rat_2", attempt_no: 2 },
      ],
    })

    await settleRenewalCycleSucceeded(container, {
      renewal_cycle_id: "rc_1",
      subscription_id: "sub_1",
      order_id: "order_1",
      finished_at: finishedAt,
    })

    expect(updateRenewalAttempts).toHaveBeenCalledWith({
      id: "rat_2",
      status: RenewalAttemptStatus.SUCCEEDED,
      finished_at: finishedAt,
      order_id: "order_1",
      error_code: null,
      error_message: null,
    })
  })

  it("writes nothing for a cycle that already succeeded", async () => {
    const {
      container,
      updateSubscriptions,
      updateRenewalCycles,
      updateRenewalAttempts,
      linkCreate,
    } = buildContainer({ cycleStatus: RenewalCycleStatus.SUCCEEDED })

    const result = await settleRenewalCycleSucceeded(container, {
      renewal_cycle_id: "rc_1",
      subscription_id: "sub_1",
      order_id: "order_1",
      finished_at: finishedAt,
    })

    expect(result.settled).toBe(false)
    expect(updateSubscriptions).not.toHaveBeenCalled()
    expect(updateRenewalCycles).not.toHaveBeenCalled()
    expect(updateRenewalAttempts).not.toHaveBeenCalled()
    expect(linkCreate).not.toHaveBeenCalled()
  })
})
