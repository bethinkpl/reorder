jest.mock("../../steps/create-subscription-log-event", () => ({
  persistSubscriptionLogEvent: jest.fn(async () => undefined),
}))

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

import type { MedusaContainer } from "@medusajs/framework/types"
import { FrequencyInterval } from "../../../common/types/frequency-interval"
import {
  ActivityLogActorType,
  ActivityLogEventType,
} from "../../../modules/activity-log/types"
import {
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../../modules/renewal/types"
import { persistSubscriptionLogEvent } from "../../steps/create-subscription-log-event"
import { settleRenewalCycleSucceeded } from "../settle-renewal-cycle-succeeded"

const pendingChange = {
  variant_id: "var_new",
  variant_title: "Quarterly",
  sku: "SKU-NEW",
  frequency_interval: FrequencyInterval.MONTH,
  frequency_value: 3,
  effective_at: null,
}

const scheduledFor = new Date("2026-03-01T00:00:00.000Z")
const finishedAt = new Date("2026-03-02T12:00:00.000Z")

type BuildOptions = {
  cycleStatus?: RenewalCycleStatus
  appliedPendingUpdateData?: typeof pendingChange | null
  attempts?: { id: string, attempt_no: number }[]
  nextRenewalAt?: Date | null
}

function buildContainer(options: BuildOptions = {}) {
  const cycle = {
    id: "rc_1",
    subscription_id: "sub_1",
    scheduled_for: scheduledFor,
    processed_at: null,
    status: options.cycleStatus ?? RenewalCycleStatus.FAILED,
    generated_order_id: "order_1",
    applied_pending_update_data: options.appliedPendingUpdateData ?? null,
    attempt_count: 2,
    last_error: "card_declined",
  }

  const subscription = {
    id: "sub_1",
    reference: "SUB-1",
    customer_id: "cus_1",
    customer_snapshot: { full_name: "Ada Lovelace" },
    product_id: "prod_1",
    variant_id: "var_old",
    frequency_interval: FrequencyInterval.MONTH,
    frequency_value: 1,
    next_renewal_at:
      options.nextRenewalAt === undefined ? scheduledFor : options.nextRenewalAt,
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
  const createRenewalAttempts = jest.fn(
    async (payload: Record<string, unknown>) => ({ id: "rat_new", ...payload })
  )
  const linkCreate = jest.fn(async () => undefined)

  const container = {
    resolve: (key: string) => {
      if (key === "renewal") {
        return {
          retrieveRenewalCycle: jest.fn(async () => cycle),
          listRenewalAttempts: jest.fn(async () => options.attempts ?? []),
          updateRenewalCycles,
          updateRenewalAttempts,
          createRenewalAttempts,
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

      if (key === "logger") {
        return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      }

      throw new Error(`Unexpected resolve('${key}')`)
    },
  } as unknown as MedusaContainer

  return {
    container,
    updateSubscriptions,
    updateRenewalCycles,
    updateRenewalAttempts,
    createRenewalAttempts,
    linkCreate,
  }
}

const baseInput = {
  renewal_cycle_id: "rc_1",
  subscription_id: "sub_1",
  order_id: "order_1",
  finished_at: finishedAt,
}

/** Exactly what `finalizeRenewalCycleStep` hands the helper. */
const finalizeAudit = {
  correlation_id: "renewal-scheduler-1",
  trigger_type: "scheduler" as const,
  triggered_by: null,
  attempt_no: 3,
  operation_started_at: Date.now(),
  scheduled_for: scheduledFor.toISOString(),
  previous_state: {
    status: RenewalCycleStatus.SCHEDULED,
    attempt_count: 2,
    processed_at: null,
    generated_order_id: null,
    last_error: null,
  },
}

const loggedEvent = () =>
  (persistSubscriptionLogEvent as jest.Mock).mock.calls[0][1]

describe("settleRenewalCycleSucceeded", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("settles a failed cycle and advances the subscription's billing dates", async () => {
    const { container, updateSubscriptions, updateRenewalCycles } = buildContainer()

    const result = await settleRenewalCycleSucceeded(container, {
      ...baseInput,
      attempt_id: "rat_1",
    })

    expect(result).toMatchObject({ settled: true, reason: null })
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

    await settleRenewalCycleSucceeded(container, baseInput)

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

    await settleRenewalCycleSucceeded(container, baseInput)

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

  it("closes the caller's own attempt when it owns one", async () => {
    const { container, updateRenewalAttempts, createRenewalAttempts } =
      buildContainer()

    await settleRenewalCycleSucceeded(container, {
      ...baseInput,
      attempt_id: "rat_1",
    })

    expect(updateRenewalAttempts).toHaveBeenCalledWith({
      id: "rat_1",
      status: RenewalAttemptStatus.SUCCEEDED,
      finished_at: finishedAt,
      order_id: "order_1",
      error_code: null,
      error_message: null,
    })
    expect(createRenewalAttempts).not.toHaveBeenCalled()
  })

  it("records a fresh attempt for a recovery instead of rewriting the declined one", async () => {
    // The declined attempt's error code is the only record of why dunning opened.
    const { container, createRenewalAttempts, updateRenewalAttempts } = buildContainer({
      attempts: [
        { id: "rat_1", attempt_no: 1 },
        { id: "rat_2", attempt_no: 2 },
      ],
    })

    await settleRenewalCycleSucceeded(container, {
      ...baseInput,
      source: "customer_payment",
    })

    expect(updateRenewalAttempts).not.toHaveBeenCalled()
    expect(createRenewalAttempts).toHaveBeenCalledWith({
      renewal_cycle_id: "rc_1",
      attempt_no: 3,
      started_at: finishedAt,
      finished_at: finishedAt,
      status: RenewalAttemptStatus.SUCCEEDED,
      error_code: null,
      error_message: null,
      payment_reference: null,
      order_id: "order_1",
      metadata: { source: "customer_payment" },
    })
  })

  it("writes the audit entry the renewal workflow used to write itself", async () => {
    const { container } = buildContainer()

    await settleRenewalCycleSucceeded(container, {
      ...baseInput,
      attempt_id: "rat_1",
      source: "renewal",
      audit: finalizeAudit,
    })

    expect(persistSubscriptionLogEvent).toHaveBeenCalledTimes(1)
    expect(loggedEvent()).toMatchObject({
      subscription_id: "sub_1",
      customer_id: "cus_1",
      event_type: ActivityLogEventType.RENEWAL_SUCCEEDED,
      actor_type: ActivityLogActorType.SCHEDULER,
      actor_id: null,
      subscription_reference: "SUB-1",
      customer_name: "Ada Lovelace",
      product_title: "Plan",
      variant_title: "Monthly",
      previous_state: {
        status: RenewalCycleStatus.SCHEDULED,
        attempt_count: 2,
        generated_order_id: null,
      },
      new_state: {
        status: RenewalCycleStatus.SUCCEEDED,
        generated_order_id: "order_1",
      },
      metadata: expect.objectContaining({
        source: "scheduler",
        renewal_cycle_id: "rc_1",
        order_id: "order_1",
        trigger_type: "scheduler",
        scheduled_for: scheduledFor.toISOString(),
      }),
    })
    // The dedupe qualifier is the cycle's processed_at, as it always was.
    expect(loggedEvent().dedupe_key).toContain(finishedAt.toISOString())
  })

  it("names the settlement source on a recovery's audit entry", async () => {
    const { container } = buildContainer()

    await settleRenewalCycleSucceeded(container, {
      ...baseInput,
      source: "customer_payment",
    })

    expect(persistSubscriptionLogEvent).toHaveBeenCalledTimes(1)
    expect(loggedEvent()).toMatchObject({
      actor_type: ActivityLogActorType.SYSTEM,
      actor_id: null,
      metadata: expect.objectContaining({
        source: "customer_payment",
        trigger_type: null,
      }),
      // The state the recovery moved the cycle out of.
      previous_state: expect.objectContaining({
        status: RenewalCycleStatus.FAILED,
        last_error: "card_declined",
      }),
    })
  })

  it("writes nothing but the caller's attempt for a cycle that already succeeded", async () => {
    const {
      container,
      updateSubscriptions,
      updateRenewalCycles,
      updateRenewalAttempts,
      createRenewalAttempts,
      linkCreate,
    } = buildContainer({ cycleStatus: RenewalCycleStatus.SUCCEEDED })

    const result = await settleRenewalCycleSucceeded(container, {
      ...baseInput,
      attempt_id: "rat_1",
      audit: finalizeAudit,
    })

    expect(result).toMatchObject({ settled: false, reason: "already_succeeded" })
    // Left PROCESSING it would never be closed by anyone else.
    expect(updateRenewalAttempts).toHaveBeenCalledWith({
      id: "rat_1",
      status: RenewalAttemptStatus.SUCCEEDED,
      finished_at: finishedAt,
      order_id: "order_1",
      error_code: null,
      error_message: null,
    })
    expect(updateSubscriptions).not.toHaveBeenCalled()
    expect(updateRenewalCycles).not.toHaveBeenCalled()
    expect(createRenewalAttempts).not.toHaveBeenCalled()
    expect(linkCreate).not.toHaveBeenCalled()
    expect(persistSubscriptionLogEvent).not.toHaveBeenCalled()
  })

  it("touches nothing at all for an already succeeded cycle with no attempt of its own", async () => {
    const { container, updateRenewalAttempts } = buildContainer({
      cycleStatus: RenewalCycleStatus.SUCCEEDED,
    })

    const result = await settleRenewalCycleSucceeded(container, baseInput)

    expect(result).toMatchObject({ settled: false, reason: "already_succeeded" })
    expect(updateRenewalAttempts).not.toHaveBeenCalled()
  })

  it("refuses to rewind billing for a cycle later cycles have overtaken", async () => {
    const {
      container,
      updateSubscriptions,
      updateRenewalCycles,
      createRenewalAttempts,
      linkCreate,
    } = buildContainer({ nextRenewalAt: new Date("2026-04-01T00:00:00.000Z") })

    const result = await settleRenewalCycleSucceeded(container, baseInput)

    expect(result).toMatchObject({ settled: false, reason: "cycle_superseded" })
    expect(updateSubscriptions).not.toHaveBeenCalled()
    expect(updateRenewalCycles).not.toHaveBeenCalled()
    expect(createRenewalAttempts).not.toHaveBeenCalled()
    expect(linkCreate).not.toHaveBeenCalled()
    expect(persistSubscriptionLogEvent).not.toHaveBeenCalled()
  })

  it("settles the cycle the subscription is actually waiting on", async () => {
    const { container, updateRenewalCycles } = buildContainer({
      nextRenewalAt: scheduledFor,
    })

    const result = await settleRenewalCycleSucceeded(container, baseInput)

    expect(result.settled).toBe(true)
    expect(updateRenewalCycles).toHaveBeenCalled()
  })

  it("treats a churned subscription's missing renewal date as still owing this cycle", async () => {
    const { container, updateRenewalCycles } = buildContainer({ nextRenewalAt: null })

    const result = await settleRenewalCycleSucceeded(container, baseInput)

    expect(result.settled).toBe(true)
    expect(updateRenewalCycles).toHaveBeenCalled()
  })
})
