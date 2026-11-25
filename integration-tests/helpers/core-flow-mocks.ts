export const chargeMocks = {
  createOrderRun: jest.fn(),
  createOrUpdateOrderPaymentCollectionRun: jest.fn(),
  createPaymentSessionsRun: jest.fn(),
}

export function coreFlowsMock() {
  return {
    ...jest.requireActual("@medusajs/medusa/core-flows"),
    createOrderWorkflow: () => ({ run: chargeMocks.createOrderRun }),
    createOrUpdateOrderPaymentCollectionWorkflow: () => ({
      run: chargeMocks.createOrUpdateOrderPaymentCollectionRun,
    }),
    createPaymentSessionsWorkflow: () => ({ run: chargeMocks.createPaymentSessionsRun }),
  }
}
