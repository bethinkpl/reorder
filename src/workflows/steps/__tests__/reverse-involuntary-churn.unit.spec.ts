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

  it("leaves a cancellation case that isn't the involuntary churn row", async () => {
    const { container, updateSubscriptions, updateCancellationCases } =
      buildContainer({
        cancellationCases: [
          {
            id: "cancase_2",
            subscription_id: "sub_1",
            reason: "Too expensive",
            final_outcome: CancellationFinalOutcome.CANCELED,
            metadata: { dunning_case_id: "dun_1" },
          },
        ],
      })

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
