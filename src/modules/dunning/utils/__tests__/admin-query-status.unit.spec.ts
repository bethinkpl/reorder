import { DunningCaseAdminStatus } from "../../../../admin/types/dunning"
import { DunningCaseStatus } from "../../types"
import { mapCaseStatus } from "../admin-query"

describe("mapCaseStatus", () => {
  it.each(Object.values(DunningCaseStatus))(
    "maps the module status '%s' to the admin status of the same name",
    (status) => {
      expect(mapCaseStatus(status)).toBe(
        status as unknown as DunningCaseAdminStatus
      )
    }
  )

  it("still refuses a status it does not know", () => {
    expect(() => mapCaseStatus("something_new" as DunningCaseStatus)).toThrow(
      /Unsupported dunning case status/
    )
  })
})
