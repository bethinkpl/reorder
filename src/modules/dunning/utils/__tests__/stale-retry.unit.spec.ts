import { isStaleRetry, STALE_RETRY_MINUTES } from "../stale-retry"

const NOW = new Date("2026-03-02T12:00:00.000Z")
const MARGIN_MS = STALE_RETRY_MINUTES * 60 * 1000

describe("isStaleRetry", () => {
  it.each([
    { age: "exactly the margin", ageMs: MARGIN_MS, stale: true },
    { age: "a millisecond under the margin", ageMs: MARGIN_MS - 1, stale: false },
  ])("treats a retry started $age ago as stale: $stale", ({ ageMs, stale }) => {
    expect(isStaleRetry(new Date(NOW.getTime() - ageMs), NOW)).toBe(stale)
  })
})
