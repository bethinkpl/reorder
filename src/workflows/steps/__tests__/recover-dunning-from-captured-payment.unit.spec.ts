jest.mock("@medusajs/medusa/core-flows", () => ({
  createOrUpdateOrderPaymentCollectionWorkflow: jest.fn(),
  createPaymentSessionsWorkflow: jest.fn(),
}))

jest.mock("../../ensure-next-renewal-cycle", () => ({
  ensureNextRenewalCycleWorkflow: jest.fn(() => ({
    run: ensureNextRenewalCycleRun,
  })),
}))

jest.mock("../../utils/settle-renewal-cycle-succeeded", () => ({
  settleRenewalCycleSucceeded: jest.fn(async () => ({
    settled: true,
    reason: null,
  })),
}))

import type { MedusaContainer } from "@medusajs/framework/types"
import { DunningCaseStatus } from "../../../modules/dunning/types"
import { SubscriptionStatus } from "../../../modules/subscription/types"
import { settleRenewalCycleSucceeded } from "../../utils/settle-renewal-cycle-succeeded"
import { recoverDunningFromCapturedPayment } from "../recover-dunning-from-captured-payment"

const ensureNextRenewalCycleRun = jest.fn(async () => ({ result: {} }))

const now = new Date("2026-04-02T10:00:00.000Z")

type BuildOptions = {
  caseStatus?: DunningCaseStatus
  subscriptionStatus?: SubscriptionStatus
  pendingDifference?: number
  renewalOrderId?: string | null
}

function buildContainer(options: BuildOptions = {}) {
  const dunningCase = {
    id: "dun_1",
    subscription_id: "sub_1",
    renewal_cycle_id: "rc_1",
    renewal_order_id:
      options.renewalOrderId === undefined ? "order_1" : options.renewalOrderId,
    status: options.caseStatus ?? DunningCaseStatus.OPEN,
    metadata: { park_reason: "requires_action", setup_failure_streak: 1 },
    created_at: new Date("2026-04-01T00:00:00.000Z"),
  }

  const subscription = {
    id: "sub_1",
    status: options.subscriptionStatus ?? SubscriptionStatus.PAST_DUE,
  }

  const updateDunningCases = jest.fn(async (payload: Record<string, unknown>) => ({
    ...dunningCase,
    ...payload,
  }))
  const updateSubscriptions = jest.fn(async () => undefined)
  const errorLogs: string[] = []

  const container = {
    resolve: (key: string) => {
      switch (key) {
        case "logger":
          return {
            info: jest.fn(),
            warn: jest.fn(),
            error: (message: string) => {
              errorLogs.push(message)
            },
          }
        case "dunning":
          return {
            retrieveDunningCase: jest.fn(async () => dunningCase),
            updateDunningCases,
          }
        case "subscription":
          return {
            retrieveSubscription: jest.fn(async () => subscription),
            updateSubscriptions,
          }
        case "query":
          return {
            graph: jest.fn(async () => ({
              data: [
                {
                  id: "order_1",
                  total: 100,
                  summary: { pending_difference: options.pendingDifference ?? 0 },
                },
              ],
            })),
          }
      }

      throw new Error(`Unexpected resolve('${key}')`)
    },
  } as unknown as MedusaContainer

  return { container, updateDunningCases, updateSubscriptions, errorLogs }
}

const run = (container: MedusaContainer) =>
  recoverDunningFromCapturedPayment(
    container,
    { dunning_case_id: "dun_1", payment_id: "pay_1" },
    now
  )

describe("recoverDunningFromCapturedPayment", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it.each([
    ["an open", DunningCaseStatus.OPEN],
    ["a parked", DunningCaseStatus.AWAITING_MANUAL_RESOLUTION],
    ["a scheduled", DunningCaseStatus.RETRY_SCHEDULED],
  ])("recovers %s case the customer paid themselves", async (_label, status) => {
    const { container, updateDunningCases, updateSubscriptions } = buildContainer({
      caseStatus: status,
    })

    const response = await run(container)

    expect(response.output).toEqual({
      recovered: true,
      subscription_id: "sub_1",
      dunning_case_id: "dun_1",
      renewal_order_id: "order_1",
      recovery_reason: "customer_payment",
      reason: null,
    })
    expect(updateDunningCases).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "dun_1",
        status: DunningCaseStatus.RECOVERED,
        recovery_reason: "customer_payment",
        recovered_at: now,
        closed_at: now,
        next_retry_at: null,
        metadata: expect.objectContaining({
          park_reason: null,
          recovery_payment_reference: "pay_1",
        }),
      })
    )
    expect(updateSubscriptions).toHaveBeenCalledWith({
      id: "sub_1",
      status: SubscriptionStatus.ACTIVE,
    })
  })

  it("settles the renewal cycle and schedules the next one, in that order", async () => {
    const { container } = buildContainer()

    await run(container)

    expect(settleRenewalCycleSucceeded).toHaveBeenCalledWith(container, {
      renewal_cycle_id: "rc_1",
      subscription_id: "sub_1",
      order_id: "order_1",
      finished_at: now,
      source: "customer_payment",
    })
    expect(ensureNextRenewalCycleRun).toHaveBeenCalledWith({
      input: { subscription_id: "sub_1" },
    })
    expect(
      (settleRenewalCycleSucceeded as jest.Mock).mock.invocationCallOrder[0]
    ).toBeLessThan(ensureNextRenewalCycleRun.mock.invocationCallOrder[0])
  })

  it("leaves a partly paid order's case open", async () => {
    const { container, updateDunningCases, updateSubscriptions } = buildContainer({
      pendingDifference: 40,
    })

    const response = await run(container)

    expect(response.output).toMatchObject({
      recovered: false,
      reason: "order_not_fully_paid",
    })
    expect(updateDunningCases).not.toHaveBeenCalled()
    expect(updateSubscriptions).not.toHaveBeenCalled()
    expect(settleRenewalCycleSucceeded).not.toHaveBeenCalled()
  })

  it("heals the renewal cycle of a case that was recovered without one", async () => {
    const { container, updateDunningCases } = buildContainer({
      caseStatus: DunningCaseStatus.RECOVERED,
      subscriptionStatus: SubscriptionStatus.ACTIVE,
    })

    const response = await run(container)

    expect(response.output).toMatchObject({
      recovered: false,
      reason: "already_recovered",
    })
    expect(updateDunningCases).not.toHaveBeenCalled()
    expect(settleRenewalCycleSucceeded).toHaveBeenCalled()
    expect(ensureNextRenewalCycleRun).toHaveBeenCalled()
  })

  it("only raises an alert when the payment lands on a settled case", async () => {
    const {
      container,
      updateDunningCases,
      updateSubscriptions,
      errorLogs,
    } = buildContainer({
      caseStatus: DunningCaseStatus.UNRECOVERED,
      subscriptionStatus: SubscriptionStatus.PAYMENT_FAILED,
    })

    const response = await run(container)

    expect(response.output).toMatchObject({
      recovered: false,
      reason: "case_settled_unrecovered",
    })
    expect(updateDunningCases).not.toHaveBeenCalled()
    expect(updateSubscriptions).not.toHaveBeenCalled()
    expect(settleRenewalCycleSucceeded).not.toHaveBeenCalled()
    expect(errorLogs).toHaveLength(1)
    expect(errorLogs[0]).toMatch(/reverseInvoluntaryChurnWorkflow/)
    expect(JSON.parse(errorLogs[0]).alertable).toBe(true)
  })

  it("still reports the recovery when settling the renewal cycle throws", async () => {
    // The case and the subscription are already committed, and nothing revisits a closed case,
    // so the caller must still be told to emit its event.
    const { container, updateDunningCases, errorLogs } = buildContainer()
    ;(settleRenewalCycleSucceeded as jest.Mock).mockRejectedValueOnce(
      new Error("renewal module is down")
    )

    const response = await run(container)

    expect(response.output).toMatchObject({ recovered: true, reason: null })
    expect(updateDunningCases).toHaveBeenCalled()
    expect(ensureNextRenewalCycleRun).not.toHaveBeenCalled()
    expect(errorLogs).toHaveLength(1)
    expect(JSON.parse(errorLogs[0])).toMatchObject({
      alertable: true,
      dunning_case_id: "dun_1",
    })
  })

  it("leaves the upcoming cycle alone when billing has moved past this one", async () => {
    const { container } = buildContainer()
    ;(settleRenewalCycleSucceeded as jest.Mock).mockResolvedValueOnce({
      settled: false,
      reason: "cycle_superseded",
    })

    const response = await run(container)

    expect(response.output).toMatchObject({ recovered: true })
    expect(ensureNextRenewalCycleRun).not.toHaveBeenCalled()
  })

  it("names the customer as the settlement source", async () => {
    const { container } = buildContainer()

    await run(container)

    expect(settleRenewalCycleSucceeded).toHaveBeenCalledWith(
      container,
      expect.objectContaining({ source: "customer_payment" })
    )
  })

  it("recovers a case the reconciler found paid without a payment of its own", async () => {
    const { container, updateDunningCases } = buildContainer()

    const response = await recoverDunningFromCapturedPayment(
      container,
      { dunning_case_id: "dun_1", payment_id: null },
      now
    )

    expect(response.output).toMatchObject({ recovered: true })
    expect(updateDunningCases).toHaveBeenCalledWith(
      expect.objectContaining({ status: DunningCaseStatus.RECOVERED })
    )
  })

  it("does nothing for a case that never got a renewal order", async () => {
    const { container, updateDunningCases } = buildContainer({
      renewalOrderId: null,
    })

    const response = await run(container)

    expect(response.output).toMatchObject({
      recovered: false,
      reason: "missing_renewal_order",
    })
    expect(updateDunningCases).not.toHaveBeenCalled()
  })
})
