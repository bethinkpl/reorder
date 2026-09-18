/**
 * `createOrUpdateOrderPaymentCollectionWorkflow` answers with an array when it creates a collection
 * and with the bare record when it updates the one a failed charge left behind.
 */
export function resolvePaymentCollection<T extends { id: string }>(
  result: T | T[] | null | undefined
): T | null {
  if (Array.isArray(result)) {
    return result[0] ?? null
  }

  return result ?? null
}
