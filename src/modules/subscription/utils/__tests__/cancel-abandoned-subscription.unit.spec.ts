import type { MedusaContainer } from "@medusajs/framework/types"
import { SUBSCRIPTION_MODULE } from "../.."
import { SubscriptionStatus } from "../../types"
import {
  ABANDONED_CHECKOUT_REASON,
  cancelAbandonedSubscription,
} from "../cancel-abandoned-subscription"

type UpdateCall = Record<string, unknown>

const now = new Date("2026-09-15T12:00:00.000Z")

function buildContainer(captured: UpdateCall[]) {
  return {
    resolve(key: string) {
      if (key === SUBSCRIPTION_MODULE) {
        return {
          updateSubscriptions: async (input: UpdateCall) => {
            captured.push(input)

            return input
          },
        }
      }

      throw new Error(`Unexpected resolve('${key}')`)
    },
  } as unknown as MedusaContainer
}

describe("cancelAbandonedSubscription", () => {
  it("cancels immediately and stops any future renewal", async () => {
    const captured: UpdateCall[] = []

    await cancelAbandonedSubscription(
      buildContainer(captured),
      { id: "sub_1", metadata: null },
      now
    )

    expect(captured[0]).toMatchObject({
      id: "sub_1",
      status: SubscriptionStatus.CANCELLED,
      cancelled_at: now,
      cancel_effective_at: now,
      next_renewal_at: null,
    })
  })

  it("marks the cancellation as an abandoned checkout and keeps the existing metadata", async () => {
    const captured: UpdateCall[] = []

    await cancelAbandonedSubscription(
      buildContainer(captured),
      { id: "sub_1", metadata: { source_order_id: "order_1" } },
      now
    )

    expect(captured[0]!.metadata).toMatchObject({
      source_order_id: "order_1",
      cancellation_reason: ABANDONED_CHECKOUT_REASON,
      cancel_context: expect.objectContaining({
        reason: ABANDONED_CHECKOUT_REASON,
        effective_at: "immediately",
      }),
    })
  })
})
