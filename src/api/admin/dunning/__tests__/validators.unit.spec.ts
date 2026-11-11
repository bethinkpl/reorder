import { GetAdminDunningCasesSchema } from "../validators"

describe("GetAdminDunningCasesSchema status filter", () => {
  it.each(["open", "retrying", "awaiting_payment"])(
    "accepts '%s' as a status filter",
    (status) => {
      const parsed = GetAdminDunningCasesSchema.safeParse({ status })

      expect(parsed.success).toBe(true)
      expect(parsed.data?.status).toEqual([status])
    }
  )

  it("rejects an unknown status", () => {
    expect(
      GetAdminDunningCasesSchema.safeParse({ status: "something_new" }).success
    ).toBe(false)
  })
})
