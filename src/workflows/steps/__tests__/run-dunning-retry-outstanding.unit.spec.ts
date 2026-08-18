jest.mock("@medusajs/medusa/core-flows", () => ({
  createOrUpdateOrderPaymentCollectionWorkflow: jest.fn(),
  createPaymentSessionsWorkflow: jest.fn(),
}))

import {
  createOrUpdateOrderPaymentCollectionWorkflow,
  createPaymentSessionsWorkflow,
} from "@medusajs/medusa/core-flows"
import { executePaymentRetry } from "../run-dunning-retry"

const subscription = {
  id: "sub_1",
  status: "past_due",
  customer_id: "cus_1",
  payment_context: {
    payment_provider_id: "pp_stripe-checkout-session_stripe",
    payment_method_id: "pm_1",
  },
} as any

function buildContainer(order: Record<string, unknown>) {
  const graph = jest.fn().mockResolvedValue({ data: [order] })
  const authorizePaymentSession = jest
    .fn()
    .mockResolvedValue({ id: "pay_1", amount: 40 })
  const capturePayment = jest.fn().mockResolvedValue(undefined)
  const retrievePayment = jest.fn().mockResolvedValue({
    id: "pay_1",
    currency_code: "pln",
    captures: [{ id: "capt_1", raw_amount: 40 }],
  })
  const addOrderTransactions = jest.fn().mockResolvedValue([])

  const container = {
    resolve: (key: string) => {
      if (key === "query") {
        return { graph }
      }

      if (key === "payment") {
        return {
          authorizePaymentSession,
          capturePayment,
          retrievePayment,
          // Only reached on the failure path, where the session status is
          // re-read to classify the error.
          listPaymentSessions: jest
            .fn()
            .mockResolvedValue([{ id: "payses_1", status: "pending" }]),
        }
      }

      if (key === "order") {
        return {
          listOrderTransactions: jest.fn().mockResolvedValue([]),
          addOrderTransactions,
        }
      }

      if (key === "logger") {
        return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      }

      throw new Error(`Unexpected resolve('${key}')`)
    },
  } as any

  return { container, authorizePaymentSession, capturePayment, addOrderTransactions }
}

describe("executePaymentRetry - outstanding amount guard", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(createPaymentSessionsWorkflow as unknown as jest.Mock).mockReturnValue({
      run: jest.fn().mockResolvedValue({
        result: { id: "payses_1", status: "pending", context: {} },
      }),
    })
    ;(
      createOrUpdateOrderPaymentCollectionWorkflow as unknown as jest.Mock
    ).mockReturnValue({
      run: jest.fn().mockResolvedValue({ result: [{ id: "paycol_1" }] }),
    })
  })

  it("does not charge again when the order is already settled", async () => {
    // The renewal that opened this dunning case captured before aborting, so the
    // order owes nothing. Charging its total here would take the money twice.
    const { container, authorizePaymentSession, capturePayment } = buildContainer({
      id: "order_1",
      total: 100,
      summary: { pending_difference: 0 },
    })

    const outcome = await executePaymentRetry(container, subscription, "order_1")

    expect(outcome).toEqual({
      kind: "recovery",
      payment_reference: null,
      error_code: null,
      error_message: null,
    })
    expect(createOrUpdateOrderPaymentCollectionWorkflow).not.toHaveBeenCalled()
    expect(authorizePaymentSession).not.toHaveBeenCalled()
    expect(capturePayment).not.toHaveBeenCalled()
  })

  it("collects only what is outstanding, not the gross total", async () => {
    const { container } = buildContainer({
      id: "order_1",
      total: 100,
      summary: { pending_difference: 40 },
    })

    await executePaymentRetry(container, subscription, "order_1")

    const run = (
      createOrUpdateOrderPaymentCollectionWorkflow as unknown as jest.Mock
    ).mock.results[0].value.run

    expect(run).toHaveBeenCalledWith({
      input: { order_id: "order_1", amount: 40 },
    })
  })

  it("records the capture so the next retry sees the order as settled", async () => {
    const { container, capturePayment, addOrderTransactions } = buildContainer({
      id: "order_1",
      total: 100,
      summary: { pending_difference: 100 },
    })

    const outcome = await executePaymentRetry(container, subscription, "order_1")

    expect(outcome.kind).toBe("recovery")
    expect(capturePayment).toHaveBeenCalled()
    expect(addOrderTransactions).toHaveBeenCalledWith([
      expect.objectContaining({
        order_id: "order_1",
        reference: "capture",
        reference_id: "capt_1",
      }),
    ])
  })

  it("still records the capture when the capture call itself fails", async () => {
    // The provider auto-captures at authorize, so the money is already gone by
    // the time this throws. Without the transaction the retry this failure
    // schedules would collect it a second time.
    const { container, capturePayment, addOrderTransactions } = buildContainer({
      id: "order_1",
      total: 100,
      summary: { pending_difference: 100 },
    })
    capturePayment.mockRejectedValue(new Error("capture blew up"))

    const outcome = await executePaymentRetry(container, subscription, "order_1")

    expect(outcome.kind).not.toBe("recovery")
    expect(addOrderTransactions).toHaveBeenCalledWith([
      expect.objectContaining({ reference_id: "capt_1" }),
    ])
  })

  it("treats a missing summary as nothing paid yet", async () => {
    const { container } = buildContainer({ id: "order_1", total: 100 })

    await executePaymentRetry(container, subscription, "order_1")

    const run = (
      createOrUpdateOrderPaymentCollectionWorkflow as unknown as jest.Mock
    ).mock.results[0].value.run

    expect(run).toHaveBeenCalledWith({
      input: { order_id: "order_1", amount: 100 },
    })
  })
})
