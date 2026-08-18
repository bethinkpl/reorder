import { recordOrderCaptureTransactions } from "../record-order-capture-transactions"

type PaymentStub = {
  id: string
  currency_code: string
  captures?: Array<{ id: string, amount?: unknown, raw_amount?: unknown }> | null
}

function buildContainer(
  payment: PaymentStub,
  existingTransactions: Array<Record<string, unknown>> = []
) {
  const retrievePayment = jest.fn().mockResolvedValue(payment)
  const listOrderTransactions = jest.fn().mockResolvedValue(existingTransactions)
  const addOrderTransactions = jest.fn().mockResolvedValue([])

  const container = {
    resolve: (key: string) => {
      if (key === "payment") {
        return { retrievePayment }
      }

      if (key === "order") {
        return { listOrderTransactions, addOrderTransactions }
      }

      throw new Error(`Unexpected resolve('${key}')`)
    },
  } as any

  return { container, retrievePayment, listOrderTransactions, addOrderTransactions }
}

describe("recordOrderCaptureTransactions", () => {
  it("records the capture under the same key capturePaymentWorkflow uses", async () => {
    const { container, addOrderTransactions } = buildContainer({
      id: "pay_1",
      currency_code: "pln",
      captures: [{ id: "capt_1", amount: 100, raw_amount: 100 }],
    })

    await recordOrderCaptureTransactions(container, "order_1", "pay_1")

    // reference/reference_id must match core's own capture transaction exactly -
    // that pairing is what lets the provider webhook dedupe instead of double
    // counting the same capture.
    expect(addOrderTransactions).toHaveBeenCalledWith([
      {
        order_id: "order_1",
        amount: 100,
        currency_code: "pln",
        reference: "capture",
        reference_id: "capt_1",
      },
    ])
  })

  it("asks the payment module for the raw capture amount", async () => {
    const { container, retrievePayment } = buildContainer({
      id: "pay_1",
      currency_code: "pln",
      captures: [{ id: "capt_1", raw_amount: 100 }],
    })

    await recordOrderCaptureTransactions(container, "order_1", "pay_1")

    expect(retrievePayment).toHaveBeenCalledWith(
      "pay_1",
      expect.objectContaining({ relations: ["captures.raw_amount"] })
    )
  })

  it("prefers the raw amount over the serialized one", async () => {
    const { container, addOrderTransactions } = buildContainer({
      id: "pay_1",
      currency_code: "pln",
      captures: [{ id: "capt_1", amount: 99.99, raw_amount: "99.99000000" }],
    })

    await recordOrderCaptureTransactions(container, "order_1", "pay_1")

    expect(addOrderTransactions).toHaveBeenCalledWith([
      expect.objectContaining({ amount: "99.99000000" }),
    ])
  })

  it("falls back to the serialized amount when no raw amount is present", async () => {
    const { container, addOrderTransactions } = buildContainer({
      id: "pay_1",
      currency_code: "pln",
      captures: [{ id: "capt_1", amount: 100 }],
    })

    await recordOrderCaptureTransactions(container, "order_1", "pay_1")

    expect(addOrderTransactions).toHaveBeenCalledWith([
      expect.objectContaining({ amount: 100 }),
    ])
  })

  it("writes nothing when the capture is already recorded", async () => {
    // The provider webhook replaying capturePaymentWorkflow must not be able to
    // double count what we already wrote, and vice versa.
    const { container, addOrderTransactions } = buildContainer(
      {
        id: "pay_1",
        currency_code: "pln",
        captures: [{ id: "capt_1", raw_amount: 100 }],
      },
      [
        {
          order_id: "order_1",
          reference: "capture",
          reference_id: "capt_1",
        },
      ]
    )

    await recordOrderCaptureTransactions(container, "order_1", "pay_1")

    expect(addOrderTransactions).not.toHaveBeenCalled()
  })

  it("records only the captures that are still missing", async () => {
    const { container, addOrderTransactions } = buildContainer(
      {
        id: "pay_1",
        currency_code: "pln",
        captures: [
          { id: "capt_1", raw_amount: 60 },
          { id: "capt_2", raw_amount: 40 },
        ],
      },
      [
        {
          order_id: "order_1",
          reference: "capture",
          reference_id: "capt_1",
        },
      ]
    )

    await recordOrderCaptureTransactions(container, "order_1", "pay_1")

    expect(addOrderTransactions).toHaveBeenCalledWith([
      expect.objectContaining({ reference_id: "capt_2", amount: 40 }),
    ])
  })

  it("writes nothing when the provider never captured", async () => {
    // Guards the failure path: recording runs even when the capture call threw,
    // so it must not invent a payment that never happened.
    const { container, addOrderTransactions, listOrderTransactions } =
      buildContainer({
        id: "pay_1",
        currency_code: "pln",
        captures: [],
      })

    await recordOrderCaptureTransactions(container, "order_1", "pay_1")

    expect(addOrderTransactions).not.toHaveBeenCalled()
    expect(listOrderTransactions).not.toHaveBeenCalled()
  })

  it("writes nothing when the payment has no captures relation at all", async () => {
    const { container, addOrderTransactions } = buildContainer({
      id: "pay_1",
      currency_code: "pln",
      captures: null,
    })

    await recordOrderCaptureTransactions(container, "order_1", "pay_1")

    expect(addOrderTransactions).not.toHaveBeenCalled()
  })
})
