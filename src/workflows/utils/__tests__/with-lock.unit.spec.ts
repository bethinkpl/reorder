import { MedusaError } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { isLockBusy, withLock } from "../with-lock"

type AcquireOptions = { expire: number, ownerId: string }

function buildContainer(acquire: (key: string, options: AcquireOptions) => Promise<void>) {
  const release = jest.fn(async () => undefined)
  const container = {
    resolve: () => ({ acquire, release }),
  } as unknown as MedusaContainer

  return { container, release }
}

const options = { wait_seconds: 10, ttl_seconds: 120 }

describe("withLock", () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("holds the key under a per-call owner and releases it with that owner", async () => {
    const owners: string[] = []
    const { container, release } = buildContainer(async (_key, { ownerId }) => {
      owners.push(ownerId)
    })

    await expect(withLock(container, "dunning:1", options, async () => "done")).resolves.toBe(
      "done"
    )
    await withLock(container, "dunning:1", options, async () => undefined)

    expect(owners[0]).not.toEqual(owners[1])
    expect(release.mock.calls).toEqual([
      ["dunning:1", { ownerId: owners[0] }],
      ["dunning:1", { ownerId: owners[1] }],
    ])
  })

  it("releases after the job fails and rethrows its error", async () => {
    const { container, release } = buildContainer(async () => undefined)

    await expect(
      withLock(container, "dunning:1", options, async () => {
        throw new Error("job failed")
      })
    ).rejects.toThrow("job failed")
    expect(release).toHaveBeenCalledTimes(1)
  })

  it("never releases a key it failed to acquire and rethrows the provider's error untouched", async () => {
    const busy = new MedusaError(MedusaError.Types.CONFLICT, "Failed to acquire lock for key \"k\"")
    const { container, release } = buildContainer(async () => {
      throw busy
    })
    const job = jest.fn()
    let now = 1_000_000
    jest.spyOn(Date, "now").mockImplementation(() => (now += 6_000))

    await expect(withLock(container, "dunning:1", options, job)).rejects.toBe(busy)

    expect(job).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })

  it("keeps retrying on any error until the pinned deadline, then stops", async () => {
    let now = 1_000_000
    jest.spyOn(Date, "now").mockImplementation(() => now)
    const acquire = jest.fn(async () => {
      now += 4_000
      throw new Error("provider down")
    })
    const { container } = buildContainer(acquire)

    await expect(withLock(container, "dunning:1", options, jest.fn())).rejects.toThrow(
      "provider down"
    )

    expect(acquire).toHaveBeenCalledTimes(3)
  })

  it("makes a single attempt when it may not wait", async () => {
    const acquire = jest.fn(async () => {
      throw new Error("busy")
    })
    const { container } = buildContainer(acquire)

    await expect(
      withLock(container, "dunning:1", { wait_seconds: 0, ttl_seconds: 120 }, jest.fn())
    ).rejects.toThrow("busy")
    expect(acquire).toHaveBeenCalledTimes(1)
  })
})

describe("isLockBusy", () => {
  it.each([
    [new MedusaError(MedusaError.Types.CONFLICT, "Failed to acquire lock for key \"k\""), true],
    [new Error("Failed to acquire lock for key \"k\""), true],
    [new MedusaError(MedusaError.Types.CONFLICT, "Timed-out acquiring lock."), true],
    [new Error("\"k\" is already locked."), true],
    [new MedusaError(MedusaError.Types.CONFLICT, "Renewal 'rc_1' is already processing"), false],
    [new MedusaError(MedusaError.Types.NOT_FOUND, "missing"), false],
    [new Error("connection reset"), false],
  ])("classifies %s as busy: %s", (error, busy) => {
    expect(isLockBusy(error)).toBe(busy)
  })
})
