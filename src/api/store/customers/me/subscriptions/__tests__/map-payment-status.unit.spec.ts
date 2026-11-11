import { DunningCaseStatus } from "../../../../../../modules/dunning/types"
import { SubscriptionStatus } from "../../../../../../modules/subscription/types"
import { mapPaymentStatus } from "../utils"

function dunningCase(status: DunningCaseStatus) {
  return { status } as Parameters<typeof mapPaymentStatus>[1]
}

describe("store payment status", () => {
  it.each([
    [SubscriptionStatus.PENDING_PAYMENT, null, "awaiting_payment"],
    [SubscriptionStatus.PAYMENT_FAILED, null, "recovery_failed"],
    [SubscriptionStatus.ACTIVE, null, "ok"],
    [SubscriptionStatus.PAST_DUE, null, "recovery_failed"],
    [
      SubscriptionStatus.PAST_DUE,
      dunningCase(DunningCaseStatus.RETRYING),
      "recovery_required",
    ],
    [
      SubscriptionStatus.ACTIVE,
      dunningCase(DunningCaseStatus.RETRY_SCHEDULED),
      "recovery_required",
    ],
  ])("maps subscription %s with case %j to '%s'", (status, kase, expected) => {
    expect(mapPaymentStatus(status, kase)).toBe(expected)
  })

  it.each(Object.values(SubscriptionStatus))(
    "shows a case awaiting a payment result on a %s subscription as a retry in progress",
    (status) => {
      expect(
        mapPaymentStatus(status, dunningCase(DunningCaseStatus.AWAITING_PAYMENT))
      ).toBe(mapPaymentStatus(status, dunningCase(DunningCaseStatus.RETRYING)))
    }
  )

  it("never returns a status outside the existing vocabulary", () => {
    const vocabulary = [
      "ok",
      "awaiting_payment",
      "recovery_required",
      "recovery_failed",
    ]

    for (const status of Object.values(SubscriptionStatus)) {
      for (const caseStatus of [
        null,
        ...Object.values(DunningCaseStatus).map(dunningCase),
      ]) {
        expect(vocabulary).toContain(mapPaymentStatus(status, caseStatus))
      }
    }
  })
})
