import { SubscriptionAdminStatus } from "../../../../admin/types/subscription"
import { SubscriptionStatus } from "../../types"
import { mapSubscriptionStatus } from "../admin-query"

describe("mapSubscriptionStatus", () => {
  it.each(Object.values(SubscriptionStatus))(
    "maps the module status '%s' to its own admin status",
    (status) => {
      expect(mapSubscriptionStatus(status)).toBe(status as unknown as SubscriptionAdminStatus)
    }
  )

  it.each([null, undefined, "", "something_new"])(
    "falls back to past due for an unrecognised status (%s)",
    (status) => {
      expect(mapSubscriptionStatus(status as string | null | undefined)).toBe(
        SubscriptionAdminStatus.PAST_DUE
      )
    }
  )
})
