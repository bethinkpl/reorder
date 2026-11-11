import { RenewalCycleAdminStatus } from "../../../../admin/types/renewal"
import { RenewalCycleStatus } from "../../types"
import { mapCycleStatus } from "../admin-query"

describe("mapCycleStatus", () => {
  it.each(Object.values(RenewalCycleStatus))(
    "maps the module status '%s' to the admin status of the same name",
    (status) => {
      expect(mapCycleStatus(status)).toBe(
        status as unknown as RenewalCycleAdminStatus
      )
    }
  )

  it("still refuses a status it does not know", () => {
    expect(() => mapCycleStatus("something_new" as RenewalCycleStatus)).toThrow(
      /Unsupported renewal cycle status/
    )
  })
})
