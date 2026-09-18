import { DunningCaseStatus } from "../../types"
import { SubscriptionStatus } from "../../../subscription/types"
import {
  RetryBlockedReason,
  resolveRetryEligibility,
  toRetryBlockedError,
} from "../retry-eligibility"

const retrySchedule = {
  strategy: "fixed_intervals",
  intervals: [1440, 4320],
  timezone: "UTC",
  source: "default_policy",
}

const paymentContext = {
  payment_provider_id: "pp_stripe_stripe",
  account_holder_id: "acch_1",
  payment_method_id: "pm_1",
}

function buildInput(overrides: {
  dunningCase?: Record<string, unknown> | null
  subscriptionStatus?: SubscriptionStatus
  paymentContext?: Record<string, unknown> | null
} = {}) {
  const baseCase = {
    status: DunningCaseStatus.RETRY_SCHEDULED,
    attempt_count: 1,
    max_attempts: 3,
    renewal_order_id: "order_1",
    retry_schedule: retrySchedule,
  }

  return {
    dunningCase:
      overrides.dunningCase === null
        ? null
        : ({ ...baseCase, ...(overrides.dunningCase ?? {}) } as never),
    subscriptionStatus: overrides.subscriptionStatus ?? SubscriptionStatus.PAST_DUE,
    paymentContext: (overrides.paymentContext === null
      ? null
      : { ...paymentContext, ...(overrides.paymentContext ?? {}) }) as never,
  }
}

describe("resolveRetryEligibility", () => {
  it("allows a retry on a scheduled case with a saved payment method", () => {
    expect(resolveRetryEligibility(buildInput())).toEqual({
      eligible: true,
      blocked_reason: null,
    })
  })

  it("allows a manual retry on an open case", () => {
    expect(
      resolveRetryEligibility(buildInput({ dunningCase: { status: DunningCaseStatus.OPEN } }))
    ).toEqual({ eligible: true, blocked_reason: null })
  })

  it("allows a retry once a manually-parked case's subscription is active again", () => {
    expect(
      resolveRetryEligibility(
        buildInput({
          dunningCase: { status: DunningCaseStatus.AWAITING_MANUAL_RESOLUTION },
          subscriptionStatus: SubscriptionStatus.ACTIVE,
        })
      )
    ).toEqual({ eligible: true, blocked_reason: null })
  })

  it("blocks when there is no active case", () => {
    expect(resolveRetryEligibility(buildInput({ dunningCase: null }))).toEqual({
      eligible: false,
      blocked_reason: RetryBlockedReason.NO_ACTIVE_CASE,
    })
  })

  it("blocks while a retry is already running", () => {
    expect(
      resolveRetryEligibility(buildInput({ dunningCase: { status: DunningCaseStatus.RETRYING } }))
    ).toEqual({ eligible: false, blocked_reason: RetryBlockedReason.RETRY_IN_PROGRESS })
  })

  it.each([DunningCaseStatus.RECOVERED, DunningCaseStatus.UNRECOVERED])(
    "blocks a closed case (%s)",
    (status) => {
      expect(resolveRetryEligibility(buildInput({ dunningCase: { status } }))).toEqual({
        eligible: false,
        blocked_reason: RetryBlockedReason.CASE_CLOSED,
      })
    }
  )

  it.each([
    SubscriptionStatus.PAUSED,
    SubscriptionStatus.CANCELLED,
    SubscriptionStatus.PENDING_PAYMENT,
    SubscriptionStatus.PAYMENT_FAILED,
  ])("blocks a subscription the workflow would refuse (%s)", (subscriptionStatus) => {
    expect(
      resolveRetryEligibility(
        buildInput({
          dunningCase: { status: DunningCaseStatus.AWAITING_MANUAL_RESOLUTION },
          subscriptionStatus,
        })
      )
    ).toEqual({
      eligible: false,
      blocked_reason: RetryBlockedReason.SUBSCRIPTION_NOT_RETRYABLE,
    })
  })

  it("blocks when no payment method is stored", () => {
    expect(
      resolveRetryEligibility(buildInput({ paymentContext: { payment_method_id: null } }))
    ).toEqual({ eligible: false, blocked_reason: RetryBlockedReason.NO_PAYMENT_METHOD })
  })

  it("blocks when the whole payment context is missing", () => {
    expect(resolveRetryEligibility(buildInput({ paymentContext: null }))).toEqual({
      eligible: false,
      blocked_reason: RetryBlockedReason.NO_PAYMENT_METHOD,
    })
  })

  it("blocks once the attempts are used up", () => {
    expect(
      resolveRetryEligibility(buildInput({ dunningCase: { attempt_count: 3, max_attempts: 3 } }))
    ).toEqual({ eligible: false, blocked_reason: RetryBlockedReason.MAX_ATTEMPTS_REACHED })
  })

  it("blocks when an admin lowered max_attempts below the attempts already made", () => {
    expect(
      resolveRetryEligibility(buildInput({ dunningCase: { attempt_count: 4, max_attempts: 2 } }))
    ).toEqual({ eligible: false, blocked_reason: RetryBlockedReason.MAX_ATTEMPTS_REACHED })
  })

  it("blocks a case with no renewal order to charge", () => {
    expect(
      resolveRetryEligibility(buildInput({ dunningCase: { renewal_order_id: null } }))
    ).toEqual({ eligible: false, blocked_reason: RetryBlockedReason.MISSING_RENEWAL_ORDER })
  })

  it("ignores the schedule when no clock is given, which is how a manual retry asks", () => {
    expect(
      resolveRetryEligibility(buildInput({ dunningCase: { next_retry_at: null } }))
    ).toEqual({ eligible: true, blocked_reason: null })
  })

  it("blocks a scheduled run before the case is due", () => {
    expect(
      resolveRetryEligibility({
        ...buildInput({ dunningCase: { next_retry_at: "2026-09-20T10:00:00.000Z" } }),
        now: new Date("2026-09-19T10:00:00.000Z"),
      })
    ).toEqual({ eligible: false, blocked_reason: RetryBlockedReason.RETRY_NOT_DUE })
  })

  it("blocks a scheduled run with no next_retry_at at all", () => {
    expect(
      resolveRetryEligibility({
        ...buildInput({ dunningCase: { next_retry_at: null } }),
        now: new Date("2026-09-19T10:00:00.000Z"),
      })
    ).toEqual({ eligible: false, blocked_reason: RetryBlockedReason.RETRY_NOT_DUE })
  })

  it("allows a scheduled run once the case is due", () => {
    expect(
      resolveRetryEligibility({
        ...buildInput({ dunningCase: { next_retry_at: "2026-09-19T09:00:00.000Z" } }),
        now: new Date("2026-09-19T10:00:00.000Z"),
      })
    ).toEqual({ eligible: true, blocked_reason: null })
  })

  it("blocks a case with no retry schedule", () => {
    expect(resolveRetryEligibility(buildInput({ dunningCase: { retry_schedule: null } }))).toEqual({
      eligible: false,
      blocked_reason: RetryBlockedReason.MISSING_RETRY_SCHEDULE,
    })
  })
})

describe("resolveRetryEligibility - parked cases", () => {
  const parkedCase = {
    status: DunningCaseStatus.AWAITING_MANUAL_RESOLUTION,
    metadata: { park_reason: "setup_failure" },
  }

  it("blocks a gated caller on a case the retry engine parked", () => {
    expect(
      resolveRetryEligibility({
        ...buildInput({ dunningCase: parkedCase }),
        block_parked: true,
      })
    ).toEqual({
      eligible: false,
      blocked_reason: RetryBlockedReason.MANUAL_RESOLUTION_REQUIRED,
    })
  })

  it("leaves the same case retryable for an ungated caller", () => {
    expect(
      resolveRetryEligibility(buildInput({ dunningCase: parkedCase }))
    ).toEqual({ eligible: true, blocked_reason: null })
  })

  it("does not gate a case parked for a missing payment method", () => {
    expect(
      resolveRetryEligibility({
        ...buildInput({
          dunningCase: {
            status: DunningCaseStatus.AWAITING_MANUAL_RESOLUTION,
            metadata: null,
          },
        }),
        block_parked: true,
      })
    ).toEqual({ eligible: true, blocked_reason: null })
  })
})

describe("toRetryBlockedError", () => {
  const caseFor = (status: DunningCaseStatus) => ({ id: "dun_1", status })

  it("tells a recovered case apart from an unrecovered one", () => {
    expect(
      toRetryBlockedError(
        RetryBlockedReason.CASE_CLOSED,
        caseFor(DunningCaseStatus.RECOVERED)
      ).message
    ).toMatch(/recovered/i)

    expect(
      toRetryBlockedError(
        RetryBlockedReason.CASE_CLOSED,
        caseFor(DunningCaseStatus.UNRECOVERED)
      ).message
    ).toMatch(/unrecovered/i)
  })

  it.each([
    RetryBlockedReason.RETRY_IN_PROGRESS,
    RetryBlockedReason.MAX_ATTEMPTS_REACHED,
    RetryBlockedReason.RETRY_NOT_DUE,
    RetryBlockedReason.MISSING_RENEWAL_ORDER,
    RetryBlockedReason.MISSING_RETRY_SCHEDULE,
    RetryBlockedReason.NO_PAYMENT_METHOD,
    RetryBlockedReason.NO_ACTIVE_CASE,
    RetryBlockedReason.MANUAL_RESOLUTION_REQUIRED,
  ])("names the case in its error for '%s'", (reason) => {
    const error = toRetryBlockedError(reason, caseFor(DunningCaseStatus.RETRY_SCHEDULED))

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain("dun_1")
  })
})
