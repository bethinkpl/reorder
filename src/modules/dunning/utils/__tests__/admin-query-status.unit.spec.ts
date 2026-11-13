import { DunningCaseAdminStatus } from "../../../../admin/types/dunning"
import { DunningCaseStatus } from "../../types"
import { mapCaseStatus } from "../admin-query"

describe("mapCaseStatus", () => {
  it("shows a case awaiting its payment to the admin as awaiting_payment", () => {
    expect(mapCaseStatus(DunningCaseStatus.AWAITING_PAYMENT)).toBe(
      DunningCaseAdminStatus.AWAITING_PAYMENT
    )
  })
})
