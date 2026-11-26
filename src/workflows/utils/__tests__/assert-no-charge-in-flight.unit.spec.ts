import type { MedusaContainer } from "@medusajs/framework/types"
import { MedusaError, Modules } from "@medusajs/framework/utils"
import { DUNNING_MODULE } from "../../../modules/dunning"
import { RENEWAL_MODULE } from "../../../modules/renewal"
import { RENEWAL_PAYMENT_IN_PROGRESS, withNoChargeInFlight } from "../assert-no-charge-in-flight"

function buildContainer(options: { cycles?: object[], cases?: object[], busy?: boolean } = {}) {
  const acquire = jest.fn(async () => {
    if (options.busy) {
      throw new MedusaError(MedusaError.Types.CONFLICT, "Failed to acquire lock for key \"renewal:subscription:sub_1\"")
    }
  })
  const release = jest.fn(async () => undefined)
  const services: Record<string, object> = {
    [Modules.LOCKING]: { acquire, release },
    [RENEWAL_MODULE]: { listRenewalCycles: async () => options.cycles ?? [] },
    [DUNNING_MODULE]: { listDunningCases: async () => options.cases ?? [] },
  }

  return {
    acquire,
    release,
    container: { resolve: (key: string) => services[key] } as unknown as MedusaContainer,
  }
}

describe("withNoChargeInFlight", () => {
  it("writes under the subscription's renewal lock and releases it", async () => {
    const { container, acquire, release } = buildContainer()

    await expect(withNoChargeInFlight(container, "sub_1", async () => "written")).resolves.toBe("written")

    expect(acquire).toHaveBeenCalledWith("renewal:subscription:sub_1", expect.objectContaining({ expire: 120 }))
    expect(release).toHaveBeenCalledWith("renewal:subscription:sub_1", expect.anything())
  })

  it.each([
    ["a renewal cycle awaits its charge", { cycles: [{ id: "cyc_1" }] }],
    ["a dunning retry awaits its charge", { cases: [{ id: "dun_1" }] }],
    ["a renewal run holds the lock", { busy: true }],
  ])("refuses the write while %s, without waiting", async (_, options) => {
    const { container, acquire } = buildContainer(options)
    const write = jest.fn()

    await expect(withNoChargeInFlight(container, "sub_1", write)).rejects.toMatchObject({
      type: MedusaError.Types.CONFLICT,
      code: RENEWAL_PAYMENT_IN_PROGRESS,
    })
    expect(write).not.toHaveBeenCalled()
    expect(acquire).toHaveBeenCalledTimes(1)
  })

  it("lets the write's own error through", async () => {
    const { container } = buildContainer()
    const error = new MedusaError(MedusaError.Types.INVALID_DATA, "bad write")

    await expect(
      withNoChargeInFlight(container, "sub_1", async () => {
        throw error
      })
    ).rejects.toBe(error)
  })
})
