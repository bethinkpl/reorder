import { DunningCaseStatus } from "../../../../../../modules/dunning/types"
import { SubscriptionStatus } from "../../../../../../modules/subscription/types"
import { mapPaymentStatus } from "../utils"

function dunningCase(status: DunningCaseStatus) {
  return { status } as Parameters<typeof mapPaymentStatus>[1]
}

describe("store payment status", () => {
  it.each([
    [SubscriptionStatus.ACTIVE, null, "ok"],
    [SubscriptionStatus.ACTIVE, dunningCase(DunningCaseStatus.RETRYING), "recovery_required"],
    [SubscriptionStatus.ACTIVE, dunningCase(DunningCaseStatus.AWAITING_PAYMENT), "recovery_required"],
    [SubscriptionStatus.PAYMENT_FAILED, dunningCase(DunningCaseStatus.AWAITING_PAYMENT), "recovery_failed"],
  ])("maps subscription %s with case %j to '%s'", (status, kase, expected) => {
    expect(mapPaymentStatus(status, kase)).toBe(expected)
  })
})
