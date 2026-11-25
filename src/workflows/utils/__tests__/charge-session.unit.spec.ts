import {
  ChargeSessionMarker,
  findChargeSession,
  isChargeUnderWay,
} from "../charge-session"

function containerWith(sessions: Record<string, unknown>[]) {
  return {
    resolve: (key: string) => {
      if (key !== "query") {
        throw new Error(`Unexpected resolve('${key}')`)
      }

      return {
        graph: async () => ({
          data: [
            {
              id: "order_1",
              payment_collections: [{ id: "paycol_1", payment_sessions: sessions }],
            },
          ],
        }),
      }
    },
  } as any
}

const attempt = { id: "att_1", payment_reference: null, order_id: "order_1" }

describe("findChargeSession", () => {
  const container = containerWith([
    { id: "payses_earlier", context: { renewal_attempt_id: "att_0" } },
    { id: "payses_renewal", context: { renewal_attempt_id: "att_1" } },
    { id: "payses_dunning", context: { dunning_attempt_id: "att_1" } },
    { id: "payses_ref", context: {} },
  ])

  it.each([
    ["the referenced session over a marked one", { payment_reference: "payses_ref" }, ChargeSessionMarker.RENEWAL, "payses_ref"],
    ["the session marked with the renewal attempt", {}, ChargeSessionMarker.RENEWAL, "payses_renewal"],
    ["the session marked with the dunning attempt", {}, ChargeSessionMarker.DUNNING, "payses_dunning"],
    ["nothing when only other attempts marked sessions", { id: "att_2" }, ChargeSessionMarker.RENEWAL, undefined],
    ["nothing when the attempt never reached an order", { order_id: null }, ChargeSessionMarker.RENEWAL, undefined],
  ] as const)("finds %s", async (_, overrides, marker, expected) => {
    const session = await findChargeSession(container, { ...attempt, ...overrides }, marker)

    expect(session?.id).toBe(expected)
  })
})

describe("isChargeUnderWay", () => {
  it.each([
    ["a declined session", "error", false],
    ["a session a throwing provider left pending", "pending", false],
    ["a session awaiting the provider", "pending_authorization", true],
    ["an authorized session", "authorized", true],
  ])("answers for %s", async (_, status, expected) => {
    const container = containerWith([
      { id: "payses_1", status, context: { renewal_attempt_id: "att_1" } },
    ])

    await expect(
      isChargeUnderWay(container, attempt, ChargeSessionMarker.RENEWAL)
    ).resolves.toBe(expected)
  })
})
