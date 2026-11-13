import { RenewalCycleAdminStatus } from "../../../../admin/types/renewal"
import { RenewalCycleStatus } from "../../types"
import { mapCycleStatus } from "../admin-query"

describe("mapCycleStatus", () => {
  it("shows a cycle awaiting its payment to the admin as awaiting_payment", () => {
    expect(mapCycleStatus(RenewalCycleStatus.AWAITING_PAYMENT)).toBe(
      RenewalCycleAdminStatus.AWAITING_PAYMENT
    )
  })
})
