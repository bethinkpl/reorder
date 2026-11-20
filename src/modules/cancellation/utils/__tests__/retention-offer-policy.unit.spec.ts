import { DunningCaseStatus } from "../../../dunning/types"
import { isActiveDunningCase } from "../retention-offer-policy"

describe("isActiveDunningCase", () => {
  it.each([
    [DunningCaseStatus.OPEN, true],
    [DunningCaseStatus.RETRY_SCHEDULED, true],
    [DunningCaseStatus.RETRYING, true],
    [DunningCaseStatus.AWAITING_PAYMENT, true],
    [DunningCaseStatus.AWAITING_MANUAL_RESOLUTION, true],
    [DunningCaseStatus.RECOVERED, false],
    [DunningCaseStatus.UNRECOVERED, false],
  ])("treats a '%s' case as active: %s", (status, expected) => {
    expect(isActiveDunningCase(status)).toBe(expected)
  })
})
