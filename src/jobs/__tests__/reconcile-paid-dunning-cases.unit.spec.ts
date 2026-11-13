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
import {
  DUNNING_AWAITING_PAYMENT_OVERDUE_EVENT,
  reconcilePaidDunningCases,
} from "../reconcile-paid-dunning-cases"

const recoverRun = jest.fn(async () => ({ result: {} }))

type CaseStub = {
  id: string
  renewal_order_id: string | null
  status?: DunningCaseStatus
}

type CaseFilters = {
  status: DunningCaseStatus | DunningCaseStatus[]
  id?: { $gt: string }
}

const LONG_AGO = new Date("2020-01-01T00:00:00.000Z")

function buildContainer(options: {
  cases: CaseStub[]
  pendingByOrder?: Record<string, number>
}) {
  const { cases, pendingByOrder = {} } = options
  const listDunningCases = jest.fn(
    async (filters: CaseFilters, listOptions: { take: number }) => {
      if (Array.isArray(filters.status)) {
        return cases.slice(0, listOptions.take)
      }

      return cases
        .filter(
          (entry) =>
            entry.status === filters.status &&
            (!filters.id || entry.id > filters.id.$gt)
        )
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(0, listOptions.take)
    }
  )
  const retrieveDunningCase = async (id: string) => ({
    ...cases.find((entry) => entry.id === id),
    subscription_id: `sub_${id}`,
    renewal_cycle_id: `rc_${id}`,
    metadata: null,
    updated_at: LONG_AGO,
  })
  const listDunningAttempts = async (filters: { dunning_case_id: string }) => [
    {
      id: `datt_${filters.dunning_case_id}`,
      started_at: LONG_AGO,
      payment_reference: null,
    },
  ]
  const errorLogs: string[] = []
  const warnLogs: string[] = []

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
        return {
          listDunningCases,
          retrieveDunningCase,
          listDunningAttempts,
          updateDunningCases: async (data: unknown) => data,
        }
      }

      if (key === "query") {
        return { graph }
      }

      if (key === "locking") {
        return {
          execute: async (_key: string, job: () => Promise<unknown>) => await job(),
        }
      }

      if (key === "logger") {
        return {
          info: jest.fn(),
          warn: (message: string) => {
            warnLogs.push(message)
          },
          error: (message: string) => {
            errorLogs.push(message)
          },
        }
      }

      throw new Error(`Unexpected resolve('${key}')`)
    },
  } as unknown as MedusaContainer

  return { container, listDunningCases, errorLogs, warnLogs }
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

    const openStatuses = [
      DunningCaseStatus.OPEN,
      DunningCaseStatus.RETRY_SCHEDULED,
      DunningCaseStatus.AWAITING_PAYMENT,
      DunningCaseStatus.AWAITING_MANUAL_RESOLUTION,
    ]

    expect(listDunningCases).toHaveBeenCalledWith(
      { status: expect.arrayContaining(openStatuses) },
      { take: 200, order: { updated_at: "ASC" } }
    )
    expect(listDunningCases.mock.calls[0][0].status).toHaveLength(
      openStatuses.length
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

  it("raises the overdue alert for every unpaid awaiting case, past the first page as well", async () => {
    const cases = Array.from({ length: 201 }, (_, index) => ({
      id: `dun_${String(index).padStart(3, "0")}`,
      renewal_order_id: `order_${index}`,
      status: DunningCaseStatus.AWAITING_PAYMENT,
    }))
    const { container, warnLogs } = buildContainer({
      cases,
      pendingByOrder: Object.fromEntries(
        cases.map((entry) => [entry.renewal_order_id, 40])
      ),
    })

    await reconcilePaidDunningCases(container)

    const alerted = warnLogs
      .map((line) => JSON.parse(line))
      .filter(
        (entry) =>
          entry.event === DUNNING_AWAITING_PAYMENT_OVERDUE_EVENT &&
          entry.alertable === true
      )
      .map((entry) => entry.dunning_case_id)

    expect(alerted).toHaveLength(201)
    expect(alerted).toContain("dun_200")
  })
})
