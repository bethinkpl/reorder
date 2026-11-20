/** Serialises a dunning case's retries, recoveries and closings. */
export function dunningCaseLockKey(dunningCaseId: string) {
  return `dunning:${dunningCaseId}`
}
