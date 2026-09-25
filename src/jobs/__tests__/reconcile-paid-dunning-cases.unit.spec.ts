jest.mock("@medusajs/medusa/core-flows", () => ({
  createOrUpdateOrderPaymentCollectionWorkflow: jest.fn(),
  createPaymentSessionsWorkflow: jest.fn(),
  acquireLockStep: jest.fn(),
  releaseLockStep: jest.fn(),
  useQueryGraphStep: jest.fn(),
}))

jest.mock("../../workflows/recover-dunning-from-captured-payment", () => ({
  recoverDunningFromCapturedPaymentWorkflow: jest.fn(() => ({
    run: recoverRun,
  })),
}))

import type { MedusaContainer } from "@medusajs/framework/types"
import { DunningCaseStatus } from "../../modules/dunning/types"
import { reconcilePaidDunningCases } from "../reconcile-paid-dunning-cases"

const recoverRun = jest.fn(async () => ({ result: {} }))

type CaseStub = { id: string, renewal_order_id: string | null }

function buildContainer(options: {
  cases: CaseStub[]
  pendingByOrder?: Record<string, number>
}) {
  const { cases, pendingByOrder = {} } = options
  const listDunningCases = jest.fn(async () => cases)
  const errorLogs: string[] = []

  const graph = jest.fn(async ({ filters }: { filters: { id: string[] } }) => {
    const orderId = filters.id[0]

    return {
      data: [
        {
          id: orderId,
          total: 100,
          summary: { pending_difference: pendingByOrder[orderId] ?? 0 },
        },
      ],
    }
  })

  const container = {
    resolve: (key: string) => {
      if (key === "dunning") {
        return { listDunningCases }
      }

      if (key === "query") {
        return { graph }
      }

      if (key === "logger") {
        return {
          info: jest.fn(),
          warn: jest.fn(),
          error: (message: string) => {
            errorLogs.push(message)
          },
        }
      }

      throw new Error(`Unexpected resolve('${key}')`)
    },
  } as unknown as MedusaContainer

  return { container, listDunningCases, errorLogs }
}

describe("reconcilePaidDunningCases", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("recovers a case whose renewal order is already settled", async () => {
    const { container } = buildContainer({
      cases: [{ id: "dun_1", renewal_order_id: "order_1" }],
    })

    const result = await reconcilePaidDunningCases(container)

    expect(recoverRun).toHaveBeenCalledWith({
      input: { dunning_case_id: "dun_1", payment_id: null },
    })
    expect(result).toEqual({ scanned: 1, recovered: 1, unpaid: 0, failed: 0 })
  })

  it("leaves a case whose order still owes money alone", async () => {
    const { container } = buildContainer({
      cases: [{ id: "dun_1", renewal_order_id: "order_1" }],
      pendingByOrder: { order_1: 40 },
    })

    const result = await reconcilePaidDunningCases(container)

    expect(recoverRun).not.toHaveBeenCalled()
    expect(result).toEqual({ scanned: 1, recovered: 0, unpaid: 1, failed: 0 })
  })

  it("scans the oldest open cases only", async () => {
    const { container, listDunningCases } = buildContainer({ cases: [] })

    await reconcilePaidDunningCases(container)

    expect(listDunningCases).toHaveBeenCalledWith(
      {
        status: [
          DunningCaseStatus.OPEN,
          DunningCaseStatus.RETRY_SCHEDULED,
          DunningCaseStatus.AWAITING_MANUAL_RESOLUTION,
        ],
      },
      { take: 200, order: { updated_at: "ASC" } }
    )
  })

  it("keeps sweeping after a case fails and reports it", async () => {
    const { container, errorLogs } = buildContainer({
      cases: [
        { id: "dun_1", renewal_order_id: "order_1" },
        { id: "dun_2", renewal_order_id: "order_2" },
      ],
    })
    recoverRun.mockRejectedValueOnce(new Error("lock timeout"))

    const result = await reconcilePaidDunningCases(container)

    expect(result).toEqual({ scanned: 2, recovered: 1, unpaid: 0, failed: 1 })
    expect(JSON.parse(errorLogs[0])).toMatchObject({
      dunning_case_id: "dun_1",
      alertable: true,
      message: "lock timeout",
    })
  })

  it("skips a case that never got a renewal order", async () => {
    const { container } = buildContainer({
      cases: [{ id: "dun_1", renewal_order_id: null }],
    })

    const result = await reconcilePaidDunningCases(container)

    expect(recoverRun).not.toHaveBeenCalled()
    expect(result).toEqual({ scanned: 1, recovered: 0, unpaid: 0, failed: 0 })
  })
})
