jest.mock("../../ensure-next-renewal-cycle", () => ({
  ensureNextRenewalCycleWorkflow: jest.fn(),
}))

import { FrequencyInterval } from "../../../common/types/frequency-interval"
import { CancellationFinalOutcome } from "../../../modules/cancellation/types"
import { DunningCaseStatus } from "../../../modules/dunning/types"
import { SubscriptionStatus } from "../../../modules/subscription/types"
import { ensureNextRenewalCycleWorkflow } from "../../ensure-next-renewal-cycle"
import { INVOLUNTARY_CHURN_REASON } from "../../utils/settle-subscription-payment-failure"
import {
  reverseInvoluntaryChurn,
  revertInvoluntaryChurnReversal,
} from "../reverse-involuntary-churn"

const now = new Date("2026-09-18T10:00:00.000Z")
const ensureRun = jest.fn()

type BuildContainerOptions = {
  caseStatus?: DunningCaseStatus
  subscriptionStatus?: SubscriptionStatus
  cancellationCases?: Record<string, unknown>[]
  subscription?: Record<string, unknown>
}

function buildContainer(options: BuildContainerOptions = {}) {
  const dunningCase = {
    id: "dun_1",
    subscription_id: "sub_1",
    status: options.caseStatus ?? DunningCaseStatus.UNRECOVERED,
    next_retry_at: null,
    recovered_at: null,
    closed_at: new Date("2026-07-20T10:00:00.000Z"),
    recovery_reason: "max_attempts_exhausted",
    metadata: { park_reason: null },
  }

  const subscription = {
    id: "sub_1",
    status: options.subscriptionStatus ?? SubscriptionStatus.PAYMENT_FAILED,
    frequency_interval: FrequencyInterval.MONTH,
    frequency_value: 1,
    started_at: new Date("2026-01-18T10:00:00.000Z"),
    trial_ends_at: null,
    // Three cadence periods back: settlement happened on the 2026-07-18 renewal.
    last_renewal_at: new Date("2026-06-18T10:00:00.000Z"),
    next_renewal_at: null,
    metadata: {
      payment_failure_context: {
        dunning_case_id: "dun_1",
        recovery_reason: "max_attempts_exhausted",
        settled_at: "2026-07-20T10:00:00.000Z",
      },
    },
    ...(options.subscription ?? {}),
  }

  const involuntaryCancellationCase = {
    id: "cancase_1",
    subscription_id: "sub_1",
    reason: INVOLUNTARY_CHURN_REASON,
    final_outcome: CancellationFinalOutcome.CANCELED,
    metadata: {
      involuntary: true,
      dunning_case_id: "dun_1",
      recovery_reason: "max_attempts_exhausted",
    },
  }

  const updateDunningCases = jest.fn(async (payload: Record<string, unknown>) => ({
    ...dunningCase,
    ...payload,
  }))
  const updateSubscriptions = jest.fn(
    async (payload: Record<string, unknown>) => payload
  )
  const updateCancellationCases = jest.fn(
    async (payload: Record<string, unknown>) => payload
  )
  const listCancellationCases = jest.fn(
    async () => options.cancellationCases ?? [involuntaryCancellationCase]
  )

  const dunningModule = {
    retrieveDunningCase: jest.fn(async () => dunningCase),
    updateDunningCases,
  }

  const subscriptionModule = {
    retrieveSubscription: jest.fn(async () => subscription),
    updateSubscriptions,
  }

  const cancellationModule = {
    listCancellationCases,
    updateCancellationCases,
  }

  const container = {
    resolve: (key: string) => {
      switch (key) {
        case "dunning":
          return dunningModule
        case "subscription":
          return subscriptionModule
        case "cancellation":
          return cancellationModule
      }

      throw new Error(`Unexpected resolve('${key}')`)
    },
  } as any

  return {
    container,
    dunningCase,
    subscription,
    involuntaryCancellationCase,
    updateDunningCases,
    updateSubscriptions,
    updateCancellationCases,
    listCancellationCases,
  }
}

describe("reverseInvoluntaryChurn", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(ensureNextRenewalCycleWorkflow as unknown as jest.Mock).mockReturnValue({
      run: ensureRun,
    })
  })

  it("rejects a dunning case that isn't unrecovered", async () => {
    const { container, updateSubscriptions } = buildContainer({
      caseStatus: DunningCaseStatus.RECOVERED,
    })

    await expect(
      reverseInvoluntaryChurn(container, {
        dunning_case_id: "dun_1",
        reason: "support ticket 42",
      }, now)
    ).rejects.toThrow(
      "DunningCase 'dun_1' in status 'recovered' targets a subscription in status 'payment_failed' and can't be reversed"
    )

    expect(updateSubscriptions).not.toHaveBeenCalled()
    expect(ensureRun).not.toHaveBeenCalled()
  })

  it("rejects a subscription that isn't payment_failed", async () => {
    const { container, updateDunningCases } = buildContainer({
      subscriptionStatus: SubscriptionStatus.CANCELLED,
    })

    await expect(
      reverseInvoluntaryChurn(container, {
        dunning_case_id: "dun_1",
        reason: "support ticket 42",
      }, now)
    ).rejects.toThrow(
      "DunningCase 'dun_1' in status 'unrecovered' targets a subscription in status 'cancelled' and can't be reversed"
    )

    expect(updateDunningCases).not.toHaveBeenCalled()
    expect(ensureRun).not.toHaveBeenCalled()
  })

  it("reactivates the subscription on the first cadence date after now", async () => {
    const {
      container,
      updateSubscriptions,
      updateDunningCases,
      updateCancellationCases,
    } = buildContainer()

    const response = await reverseInvoluntaryChurn(container, {
      dunning_case_id: "dun_1",
      triggered_by: "user_admin",
      reason: "chargeback reversed",
    }, now)

    expect(updateSubscriptions).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "sub_1",
        status: SubscriptionStatus.ACTIVE,
        // 07-18, 08-18 and 09-18 are all <= now, so the first strictly future
        // cadence date is 10-18 - the missed period is forgiven.
        next_renewal_at: new Date("2026-10-18T10:00:00.000Z"),
      })
    )

    const subscriptionPayload = updateSubscriptions.mock.calls[0][0] as any
    expect(subscriptionPayload.metadata.payment_failure_context).toBeDefined()
    expect(subscriptionPayload.metadata.reversal_context).toEqual({
      dunning_case_id: "dun_1",
      reversed_at: now.toISOString(),
      triggered_by: "user_admin",
      reason: "chargeback reversed",
      cancellation_case_reversed: true,
    })

    expect(updateDunningCases).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "dun_1",
        status: DunningCaseStatus.RECOVERED,
        next_retry_at: null,
        recovered_at: now,
        closed_at: now,
        recovery_reason: "reversed_by_admin",
      })
    )

    const casePayload = updateDunningCases.mock.calls[0][0] as any
    expect(casePayload.metadata.last_manual_action).toEqual({
      action: "reverse_involuntary_churn",
      who: "user_admin",
      when: now.toISOString(),
      reason: "chargeback reversed",
    })

    expect(updateCancellationCases).toHaveBeenCalledWith({
      id: "cancase_1",
      metadata: expect.objectContaining({
        involuntary: true,
        reversed: true,
        reversed_at: now.toISOString(),
        reversed_by: "user_admin",
      }),
    })

    expect(ensureRun).toHaveBeenCalledTimes(1)
    expect(ensureRun).toHaveBeenCalledWith({
      input: { subscription_id: "sub_1" },
    })

    expect(response.output).toMatchObject({
      id: "dun_1",
      status: DunningCaseStatus.RECOVERED,
    })
  })

  it("refuses to resurrect a customer-initiated cancellation settlement converted", async () => {
    const {
      container,
      updateSubscriptions,
      updateDunningCases,
      updateCancellationCases,
    } = buildContainer({
      cancellationCases: [
        {
          id: "cancase_2",
          subscription_id: "sub_1",
          // The customer's own reason survived settlement's in-place conversion.
          reason: "Too expensive",
          final_outcome: CancellationFinalOutcome.CANCELED,
          metadata: { involuntary: true, dunning_case_id: "dun_1" },
        },
      ],
    })

    let message = ""

    try {
      await reverseInvoluntaryChurn(container, {
        dunning_case_id: "dun_1",
        triggered_by: "user_admin",
        reason: "chargeback reversed",
      }, now)
    } catch (error) {
      message = (error as Error).message
    }

    expect(message).toBe(
      "DunningCase 'dun_1' can't be reversed: cancellation case 'cancase_2' records a customer-initiated cancellation that still stands"
    )
    // The admin route maps anything but these phrasings to 409.
    expect(message).not.toMatch(/was not found|invalid|missing/i)

    expect(updateSubscriptions).not.toHaveBeenCalled()
    expect(updateDunningCases).not.toHaveBeenCalled()
    expect(updateCancellationCases).not.toHaveBeenCalled()
    expect(ensureRun).not.toHaveBeenCalled()
  })

  it("flags the involuntary row matched by dunning_case_id alone", async () => {
    const { container, updateSubscriptions, updateCancellationCases } =
      buildContainer({
        cancellationCases: [
          {
            id: "cancase_3",
            subscription_id: "sub_1",
            reason: INVOLUNTARY_CHURN_REASON,
            final_outcome: CancellationFinalOutcome.CANCELED,
            metadata: { dunning_case_id: "dun_1" },
          },
        ],
      })

    await reverseInvoluntaryChurn(container, {
      dunning_case_id: "dun_1",
      triggered_by: "user_admin",
      reason: "chargeback reversed",
    }, now)

    expect(updateCancellationCases).toHaveBeenCalledWith({
      id: "cancase_3",
      metadata: expect.objectContaining({
        dunning_case_id: "dun_1",
        reversed: true,
        reversed_at: now.toISOString(),
        reversed_by: "user_admin",
      }),
    })

    const subscriptionPayload = updateSubscriptions.mock.calls[0][0] as any
    expect(
      subscriptionPayload.metadata.reversal_context.cancellation_case_reversed
    ).toBe(true)
  })

  it("reverses without a cancellation row when settlement left none", async () => {
    const { container, updateSubscriptions, updateCancellationCases } =
      buildContainer({ cancellationCases: [] })

    const response = await reverseInvoluntaryChurn(container, {
      dunning_case_id: "dun_1",
      triggered_by: "user_admin",
      reason: "chargeback reversed",
    }, now)

    expect(updateCancellationCases).not.toHaveBeenCalled()

    const subscriptionPayload = updateSubscriptions.mock.calls[0][0] as any
    expect(
      subscriptionPayload.metadata.reversal_context.cancellation_case_reversed
    ).toBe(false)
    expect(response.compensateInput.previous_cancellation_case).toBeNull()
  })

  it("anchors the cadence on the trial end when the subscription never renewed", async () => {
    const { container, updateSubscriptions } = buildContainer({
      subscription: {
        last_renewal_at: null,
        trial_ends_at: new Date("2026-09-05T10:00:00.000Z"),
      },
    })

    await reverseInvoluntaryChurn(container, {
      dunning_case_id: "dun_1",
      reason: "trial billing incident",
    }, now)

    expect(updateSubscriptions).toHaveBeenCalledWith(
      expect.objectContaining({
        // Anchored on trial_ends_at; started_at would have landed on 10-18.
        next_renewal_at: new Date("2026-10-05T10:00:00.000Z"),
      })
    )
  })

  it("restores the subscription, the case and the cancellation metadata on compensation", async () => {
    const {
      container,
      dunningCase,
      subscription,
      involuntaryCancellationCase,
      updateSubscriptions,
      updateDunningCases,
      updateCancellationCases,
    } = buildContainer()

    const response = await reverseInvoluntaryChurn(container, {
      dunning_case_id: "dun_1",
      triggered_by: "user_admin",
      reason: "chargeback reversed",
    }, now)

    updateSubscriptions.mockClear()
    updateDunningCases.mockClear()
    updateCancellationCases.mockClear()

    await revertInvoluntaryChurnReversal(container, response.compensateInput)

    expect(updateSubscriptions).toHaveBeenCalledWith({
      id: "sub_1",
      status: SubscriptionStatus.PAYMENT_FAILED,
      next_renewal_at: null,
      metadata: subscription.metadata,
    })
    expect(updateDunningCases).toHaveBeenCalledWith(dunningCase)
    expect(updateCancellationCases).toHaveBeenCalledWith({
      id: "cancase_1",
      metadata: involuntaryCancellationCase.metadata,
    })
  })
})
