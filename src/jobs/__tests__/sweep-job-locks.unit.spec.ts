jest.mock("@medusajs/medusa/core-flows", () => ({
  createOrUpdateOrderPaymentCollectionWorkflow: jest.fn(),
  createPaymentSessionsWorkflow: jest.fn(),
  acquireLockStep: jest.fn(),
  releaseLockStep: jest.fn(),
  useQueryGraphStep: jest.fn(),
}))

import type { MedusaContainer } from "@medusajs/framework/types"
import reconcileAwaitingRenewalCyclesJob from "../reconcile-awaiting-renewal-cycles"
import reconcilePaidDunningCasesJob from "../reconcile-paid-dunning-cases"

const SWEEP_UPPER_BOUND_SECONDS = 25 * 60

function buildContainer() {
  const acquire = jest.fn(async () => undefined)
  const release = jest.fn(async () => true)
  const none = async () => []
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const services: Record<string, unknown> = {
    locking: { acquire, release },
    logger,
    dunning: { listDunningCases: none, listDunningAttempts: none },
    renewal: { listRenewalCycles: none, listRenewalAttempts: none },
  }
  const container = {
    resolve: (key: string) => {
      if (!(key in services)) {
        throw new Error(`Unexpected resolve('${key}')`)
      }

      return services[key]
    },
  } as unknown as MedusaContainer

  return { container, acquire, release, logger }
}

describe.each([
  { job: reconcileAwaitingRenewalCyclesJob, key: "jobs:reconcile-awaiting-renewal-cycles" },
  { job: reconcilePaidDunningCasesJob, key: "jobs:reconcile-paid-dunning-cases" },
])("the $key sweep", ({ job, key }) => {
  it("holds its job lock for as long as a sweep can run, and releases it as its owner", async () => {
    const { container, acquire, release, logger } = buildContainer()

    await job(container)

    expect(acquire).toHaveBeenCalledWith(key, {
      ownerId: expect.any(String),
      expire: SWEEP_UPPER_BOUND_SECONDS,
    })

    const [[, { ownerId }]] = acquire.mock.calls as unknown as [string, { ownerId: string }][]

    expect(release).toHaveBeenCalledWith(key, { ownerId })
    expect(logger.error).not.toHaveBeenCalled()
  })
})
