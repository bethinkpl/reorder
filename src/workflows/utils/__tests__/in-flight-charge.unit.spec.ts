import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { DUNNING_MODULE } from "../../../modules/dunning"
import { DunningAttemptStatus, DunningCaseStatus } from "../../../modules/dunning/types"
import { RENEWAL_MODULE } from "../../../modules/renewal"
import { RenewalAttemptStatus, RenewalCycleStatus } from "../../../modules/renewal/types"
import { SUBSCRIPTION_MODULE } from "../../../modules/subscription"
import { SubscriptionStatus } from "../../../modules/subscription/types"
import {
  type ChargeFacts,
  decideChargeActions,
  ranTenMinutesAgo,
  type RawChargeFacts,
  reconcileCharge,
  toChargeFacts,
} from "../in-flight-charge"
import { settleRenewalCycleSucceeded } from "../settle-renewal-cycle-succeeded"

jest.mock("../settle-renewal-cycle-succeeded", () => ({
  ...jest.requireActual("../settle-renewal-cycle-succeeded"),
  settleRenewalCycleSucceeded: jest.fn(async () => ({ reason: null })),
}))
jest.mock("../../ensure-next-renewal-cycle", () => ({
  ...jest.requireActual("../../ensure-next-renewal-cycle"),
  ensureNextRenewalCycleWorkflow: () => ({ run: async () => ({}) }),
}))
const mockRecovery = { recovered: true }
jest.mock("../../recover-dunning-from-captured-payment", () => ({
  ...jest.requireActual("../../recover-dunning-from-captured-payment"),
  recoverDunningFromCapturedPaymentWorkflow: () => ({ run: async () => ({ result: { ...mockRecovery } }) }),
}))

const NOW = new Date("2026-03-10T12:00:00.000Z")
const HOUR_MS = 60 * 60 * 1000

const raw: RawChargeFacts = {
  kind: "renewal",
  attempt: { id: "att_1", status: "processing", started_at: NOW, metadata: null },
  parent_status: RenewalCycleStatus.AWAITING_PAYMENT,
  newest_attempt_id: "att_1",
  subscription_status: SubscriptionStatus.ACTIVE,
  order_has_dunning_case: false,
  order_pending: 10,
  captured_payment_id: null,
  alert_hours: 6,
}

const startedAgo = (ms: number) => ({ ...raw.attempt, started_at: new Date(NOW.getTime() - ms) })

describe("toChargeFacts", () => {
  it.each([
    ["renewal awaiting payment, newest", {}, { parent: "in_flight", awaiting: true }],
    ["renewal processing, newest", { parent_status: RenewalCycleStatus.PROCESSING }, { parent: "in_flight", awaiting: false }],
    ["renewal succeeded", { parent_status: RenewalCycleStatus.SUCCEEDED }, { parent: "settled" }],
    ["renewal failed", { parent_status: RenewalCycleStatus.FAILED }, { parent: "closed" }],
    ["renewal awaiting payment, not newest", { newest_attempt_id: "att_2" }, { parent: "closed" }],
    ["dunning awaiting payment, newest", { kind: "dunning", parent_status: DunningCaseStatus.AWAITING_PAYMENT }, { parent: "in_flight", awaiting: true }],
    ["dunning retrying, newest", { kind: "dunning", parent_status: DunningCaseStatus.RETRYING }, { parent: "in_flight", awaiting: false }],
    ["dunning recovered", { kind: "dunning", parent_status: DunningCaseStatus.RECOVERED }, { parent: "settled" }],
    ["dunning unrecovered", { kind: "dunning", parent_status: DunningCaseStatus.UNRECOVERED }, { parent: "closed" }],
    ["dunning retry scheduled", { kind: "dunning", parent_status: DunningCaseStatus.RETRY_SCHEDULED }, { parent: "closed" }],
    ["cancelled", { subscription_status: SubscriptionStatus.CANCELLED }, { subscription: "terminal" }],
    ["payment failed with a case on the order", { subscription_status: SubscriptionStatus.PAYMENT_FAILED, order_has_dunning_case: true }, { subscription: "churned" }],
    ["payment failed without a case on the order", { subscription_status: SubscriptionStatus.PAYMENT_FAILED }, { subscription: "terminal" }],
    ["active", {}, { subscription: "active" }],
    ["past due", { subscription_status: SubscriptionStatus.PAST_DUE }, { subscription: "active" }],
    ["paused", { subscription_status: SubscriptionStatus.PAUSED }, { subscription: "active" }],
    ["pending -0.01", { order_pending: -0.01 }, { order: "overpaid" }],
    ["pending 0", { order_pending: 0 }, { order: "paid" }],
    ["pending 0.01", { order_pending: 0.01 }, { order: "unpaid" }],
    ["pending not a number", { order_pending: NaN }, { order: "unpaid" }],
    ["started exactly the alert hours ago", { attempt: startedAgo(6 * HOUR_MS) }, { overdue: true }],
    ["started 1 ms under the alert hours ago", { attempt: startedAgo(6 * HOUR_MS - 1) }, { overdue: false }],
    [
      "markers naming this payment",
      {
        captured_payment_id: "pay_1",
        attempt: { ...raw.attempt, metadata: { late_payment_captured: { payment_id: "pay_1" }, paid_twice_alerted: { payment_id: "pay_1" } } },
      },
      { captured: true, reported: true, twice_alerted: true },
    ],
    [
      "markers naming another payment",
      {
        captured_payment_id: "pay_2",
        attempt: { ...raw.attempt, metadata: { late_payment_captured: { payment_id: "pay_1" }, paid_twice_alerted: { payment_id: "pay_1" } } },
      },
      { captured: true, reported: false, twice_alerted: false },
    ],
  ] as const)("derives %s", (_, overrides, expected) => {
    expect(toChargeFacts({ ...raw, ...overrides }, NOW)).toMatchObject(expected)
  })
})

describe("ranTenMinutesAgo", () => {
  it.each([
    [10 * 60 * 1000, true],
    [10 * 60 * 1000 - 1, false],
  ])("answers %s ms after the start with %s", (ms, expected) => {
    expect(ranTenMinutesAgo(new Date(NOW.getTime() - ms), NOW)).toBe(expected)
  })
})

describe("decideChargeActions", () => {
  const facts: ChargeFacts = {
    parent: "in_flight",
    awaiting: true,
    subscription: "active",
    order: "unpaid",
    attempt: "processing",
    captured: false,
    reported: false,
    twice_alerted: false,
    overdue: false,
    alerted: false,
  }
  const capture = { captured: true }

  it.each([
    ["a reported capture whose parent is still in flight on a terminal subscription", "captured", { ...capture, reported: true, subscription: "terminal" }, ["end_parent"]],
    ["a sweep that found a reported capture on a churned subscription", "sweep", { ...capture, reported: true, subscription: "churned" }, ["end_parent"]],
    ["a reported capture, never reported twice", "captured", { ...capture, reported: true, parent: "closed", subscription: "terminal", attempt: "failed" }, []],
    ["a failure of a succeeded attempt", "failed", { attempt: "succeeded" }, []],
    ["a capture on a terminal subscription, before settling", "captured", { ...capture, subscription: "terminal", order: "paid" }, ["late_capture", "end_parent"]],
    ["a capture on a terminal subscription, unpaid", "captured", { ...capture, subscription: "terminal" }, ["late_capture", "end_parent"]],
    ["a failure on a churned subscription", "failed", { subscription: "churned" }, ["close_attempt_failed", "end_parent"]],
    ["a failure on a terminal subscription, before the paid row", "failed", { subscription: "terminal", order: "paid" }, ["close_attempt_failed", "end_parent"]],
    ["a sweep on a churned subscription", "sweep", { subscription: "churned" }, ["end_parent"]],
    ["a sweep on a terminal subscription, before settling", "sweep", { subscription: "terminal", order: "paid" }, ["end_parent"]],
    ["a capture after the parent closed on a terminal subscription", "captured", { ...capture, parent: "closed", subscription: "terminal", attempt: "failed" }, ["late_capture"]],
    ["a capture on a churned subscription", "captured", { ...capture, parent: "closed", subscription: "churned", attempt: "failed" }, ["mark_captured"]],
    ["a capture that pays the order", "captured", { ...capture, order: "paid" }, ["settle"]],
    ["a sweep that found the attempt's own capture", "sweep", { ...capture, order: "paid" }, ["settle"]],
    ["a capture that overpays the order", "captured", { ...capture, order: "overpaid" }, ["settle", "paid_twice"]],
    ["a failure on an order paid another way", "failed", { order: "paid" }, []],
    ["a failure in flight", "failed", {}, ["fail"]],
    ["a failure redelivered after its attempt failed, parent awaiting payment", "failed", { attempt: "failed" }, ["fail"]],
    ["a failure of a finished attempt whose parent is processing or retrying, never failing it", "failed", { attempt: "failed", awaiting: false }, []],
    ["a sweep of an order paid another way", "sweep", { order: "overpaid" }, ["settle_foreign"]],
    ["a sweep of a failed attempt on an order paid another way, settling first", "sweep", { attempt: "failed", order: "paid" }, ["settle_foreign"]],
    ["a sweep of a failed attempt whose parent still awaits payment", "sweep", { attempt: "failed" }, ["fail"]],
    ["a sweep of a finished attempt whose parent is processing or retrying, never failing it", "sweep", { attempt: "failed", awaiting: false }, []],
    ["an overdue sweep", "sweep", { overdue: true }, ["overdue_alert"]],
    ["a partial capture of an overdue charge", "captured", { ...capture, overdue: true }, ["overdue_alert"]],
    ["an overdue sweep already alerted, before closing stale", "sweep", { overdue: true, alerted: true }, []],
    ["a capture overpaying a settled parent", "captured", { ...capture, parent: "settled", order: "overpaid", attempt: "succeeded" }, ["paid_twice"]],
    ["a failure after the parent closed", "failed", { parent: "closed" }, ["close_attempt_failed"]],
    ["a capture of a settled parent's open attempt", "captured", { ...capture, parent: "settled", order: "paid" }, ["mark_applied"]],
    ["an overdue sweep of a closed parent's open attempt", "sweep", { parent: "closed", overdue: true }, ["close_attempt_failed"]],
    ["an overdue sweep of a settled parent, never settling", "sweep", { parent: "settled", order: "paid", overdue: true }, ["close_attempt_failed"]],
    ["a paid-twice capture already alerted", "captured", { ...capture, parent: "settled", order: "overpaid", attempt: "succeeded", twice_alerted: true }, []],
  ] as const)("decides %s", (_, signal, overrides, expected) => {
    expect(decideChargeActions({ ...facts, ...overrides }, signal)).toEqual(expected)
  })
})

describe("reconcileCharge of a renewal attempt without a charge context", () => {
  function setup(pending: number) {
    const rows = {
      attempt: { id: "att_1", renewal_cycle_id: "cyc_1", status: "processing", attempt_no: 1, started_at: NOW, order_id: "order_1", metadata: null },
      cycle: { id: "cyc_1", subscription_id: "sub_1", status: RenewalCycleStatus.AWAITING_PAYMENT, scheduled_for: NOW },
    }
    const services: Record<string, object> = {
      [RENEWAL_MODULE]: {
        retrieveRenewalAttempt: async () => ({ ...rows.attempt }),
        retrieveRenewalCycle: async () => ({ ...rows.cycle }),
        listRenewalAttempts: async () => [{ ...rows.attempt }],
        updateRenewalAttempts: async (data: object) => Object.assign(rows.attempt, data),
        updateRenewalCycles: async (data: object) => Object.assign(rows.cycle, data),
      },
      [SUBSCRIPTION_MODULE]: { retrieveSubscription: async () => ({ id: "sub_1", status: SubscriptionStatus.ACTIVE }) },
      [DUNNING_MODULE]: {},
      [Modules.PAYMENT]: { retrievePayment: async () => ({ id: "pay_1", captures: [{ amount: 10 }] }) },
      [Modules.LOCKING]: { acquire: async () => {}, release: async () => {} },
      [ContainerRegistrationKeys.QUERY]: {
        graph: async () => ({ data: [{ id: "order_1", total: 10, summary: { pending_difference: pending } }] }),
      },
    }

    return { rows, container: { resolve: (key: string) => services[key] } as unknown as MedusaContainer }
  }

  it("settles a capture as a recovery, without the run's audit", async () => {
    const { container } = setup(0)

    await expect(
      reconcileCharge(container, { kind: "renewal", attempt_id: "att_1", signal: "captured", payment_id: "pay_1" })
    ).resolves.toMatchObject({ actions: ["settle"] })
    expect(settleRenewalCycleSucceeded).toHaveBeenCalledWith(
      container,
      expect.objectContaining({ attempt_id: "att_1", audit: undefined })
    )
  })

  it("fails a reported failure into a failed cycle and attempt, as a run that never charged", async () => {
    const { container, rows } = setup(10)
    const failure = { session_id: "payses_1", code: "timeout", message: "The charge timed out" }

    await reconcileCharge(container, { kind: "renewal", attempt_id: "att_1", signal: "failed", failure })

    expect(rows).toMatchObject({
      attempt: { status: RenewalAttemptStatus.FAILED, error_code: "timeout" },
      cycle: { status: RenewalCycleStatus.FAILED, last_error: "The charge timed out" },
    })
  })
})

describe("reconcileCharge of a dunning retry whose capture pays the order", () => {
  it.each([
    [true, DunningAttemptStatus.SUCCEEDED],
    [false, DunningAttemptStatus.PROCESSING],
  ])("with a recovery answering recovered %s, leaves the attempt %s", async (recovered, status) => {
    mockRecovery.recovered = recovered
    const attempt = { id: "datt_1", dunning_case_id: "dc_1", status: DunningAttemptStatus.PROCESSING, attempt_no: 1, started_at: NOW, metadata: null }
    const services: Record<string, object> = {
      [DUNNING_MODULE]: {
        retrieveDunningAttempt: async () => ({ ...attempt }),
        retrieveDunningCase: async () => ({ id: "dc_1", subscription_id: "sub_1", status: DunningCaseStatus.AWAITING_PAYMENT, renewal_order_id: "order_1" }),
        listDunningAttempts: async () => [{ ...attempt }],
        updateDunningAttempts: async (data: object) => Object.assign(attempt, data),
      },
      [SUBSCRIPTION_MODULE]: { retrieveSubscription: async () => ({ id: "sub_1", status: SubscriptionStatus.PAST_DUE }) },
      [Modules.PAYMENT]: { retrievePayment: async () => ({ id: "pay_1", captures: [{ amount: 10 }] }) },
      [Modules.LOCKING]: { acquire: async () => {}, release: async () => {} },
      [ContainerRegistrationKeys.QUERY]: {
        graph: async () => ({ data: [{ id: "order_1", total: 10, summary: { pending_difference: 0 } }] }),
      },
    }
    const container = { resolve: (key: string) => services[key] } as unknown as MedusaContainer

    await reconcileCharge(container, { kind: "dunning", attempt_id: "datt_1", signal: "captured", payment_id: "pay_1" })

    expect(attempt.status).toEqual(status)
  })
})
