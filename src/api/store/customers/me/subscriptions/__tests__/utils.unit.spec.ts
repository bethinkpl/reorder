import type { MedusaResponse } from "@medusajs/framework/http"
import { respondChargeInFlight } from "../utils"

describe("respondChargeInFlight", () => {
  const buildRes = () => {
    const res = { status: jest.fn(), json: jest.fn() }
    res.status.mockReturnValue(res)
    return res
  }

  it("rethrows any other error", () => {
    const res = buildRes()
    const error = { code: "other", message: "boom" }

    let thrown: unknown
    try {
      respondChargeInFlight(res as unknown as MedusaResponse, error)
    } catch (caught) {
      thrown = caught
    }

    expect(thrown).toBe(error)
    expect(res.status).not.toHaveBeenCalled()
  })
})
