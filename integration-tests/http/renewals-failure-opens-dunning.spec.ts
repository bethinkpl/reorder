import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import type {
  IEventBusModuleService,
  IPaymentModuleService,
  MedusaContainer,
} from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
  PaymentActions,
} from "@medusajs/framework/utils"
import { ACTIVITY_LOG_MODULE } from "../../src/modules/activity-log"
import type ActivityLogModuleService from "../../src/modules/activity-log/service"
import { ActivityLogEventType } from "../../src/modules/activity-log/types"
import { DUNNING_MODULE } from "../../src/modules/dunning"
import { DunningEvents } from "../../src/modules/dunning/events"
import type DunningModuleService from "../../src/modules/dunning/service"
import { DunningCaseStatus } from "../../src/modules/dunning/types"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import {
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../src/modules/renewal/types"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import { cancelPendingSubscriptionOnPaymentFailure } from "../../src/subscribers/cancel-pending-subscription-on-payment-failure"
import { createPaymentSessionFixture } from "../helpers/payment-fixtures"
import {
  createRenewalAttemptSeed,
  createRenewalCycleSeed,
  createSubscriptionSeed,
} from "../helpers/renewal-fixtures"

jest.setTimeout(60 * 1000)

const FIRST_INTERVAL_MINUTES = 1440
const ORDER_ID = "order_awaiting_001"

const webhookEvent = {
  provider: "pp_test_provider",
  payload: { data: {}, rawData: Buffer.from("{}"), headers: {} },
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ getContainer }) => {
    describe("failure events for awaiting renewal cycles", () => {
      let decoder: jest.SpyInstance
      let emit: jest.SpyInstance

      beforeEach(() => {
        const container = getContainer()

        decoder = jest.spyOn(
          container.resolve<IPaymentModuleService>(Modules.PAYMENT),
          "getWebhookActionAndData"
        )
        emit = jest.spyOn(
          container.resolve<IEventBusModuleService>(Modules.EVENT_BUS),
          "emit"
        )
      })

      afterEach(() => {
        jest.restoreAllMocks()
      })

      function decodeAs(
        action: string,
        sessionId: string,
        reason?: string
      ) {
        decoder.mockResolvedValue({
          action,
          data: { session_id: sessionId, amount: 100, ...(reason ? { reason } : {}) },
        })
      }

      async function deliver(container: MedusaContainer) {
        await cancelPendingSubscriptionOnPaymentFailure(
          container,
          webhookEvent
        )
      }

      async function seedAwaitingCycle(
        container: MedusaContainer,
        input: {
          reference: string
          subscriptionStatus?: SubscriptionStatus
          cycleStatus?: RenewalCycleStatus
          marker?: boolean
        }
      ) {
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const subscription = await createSubscriptionSeed(container, {
          reference: input.reference,
          status: input.subscriptionStatus ?? SubscriptionStatus.ACTIVE,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: input.cycleStatus ?? RenewalCycleStatus.AWAITING_PAYMENT,
          generated_order_id: ORDER_ID,
          attempt_count: 1,
        })
        const { session } = await createPaymentSessionFixture(container, {
          context:
            input.marker === false ? {} : { renewal_cycle_id: cycle.id },
        })
        const attempt = await createRenewalAttemptSeed(container, {
          renewal_cycle_id: cycle.id,
          status: RenewalAttemptStatus.PROCESSING,
          payment_reference: session.id,
          order_id: ORDER_ID,
        })

        await renewalModule.updateRenewalCycles({
          id: cycle.id,
          settlement_inputs: {
            attempt_id: attempt.id,
            audit: { provider: "pp_test_provider", session_id: session.id },
            source_snapshot: null,
          },
        })

        return { subscription, cycle, attempt, session }
      }

      async function readState(
        container: MedusaContainer,
        seeded: { subscription: { id: string }, cycle: { id: string }, attempt: { id: string } }
      ) {
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

        return {
          cycle: await renewalModule.retrieveRenewalCycle(seeded.cycle.id),
          attempt: await renewalModule.retrieveRenewalAttempt(
            seeded.attempt.id
          ),
          subscription: await subscriptionModule.retrieveSubscription(
            seeded.subscription.id
          ),
          cases: await dunningModule.listDunningCases({
            subscription_id: seeded.subscription.id,
          } as never),
        }
      }

      function dunningStartedEmissions() {
        return emit.mock.calls.filter(
          ([message]) => message?.name === DunningEvents.STARTED
        )
      }

      it.each([
        { action: PaymentActions.FAILED, reason: "declined" as string | undefined },
        { action: PaymentActions.FAILED, reason: undefined },
        { action: PaymentActions.CANCELED, reason: "expired" as string | undefined },
        { action: PaymentActions.CANCELED, reason: undefined },
      ])(
        "fails the awaiting cycle and opens dunning on '$action' with reason $reason",
        async ({ action, reason }) => {
          const container = getContainer()
          const activityLogModule =
            container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)
          const seeded = await seedAwaitingCycle(container, {
            reference: `SUB-FAIL-${action}-${reason ?? "none"}`,
          })

          decodeAs(action, seeded.session.id, reason)

          const before = Date.now()
          await deliver(container)
          const after = Date.now()

          const state = await readState(container, seeded)

          expect(state.cycle.status).toEqual(RenewalCycleStatus.FAILED)
          expect(state.cycle.generated_order_id).toEqual(ORDER_ID)
          expect(state.cycle.last_error).toBeTruthy()
          expect(state.attempt.status).toEqual(RenewalAttemptStatus.FAILED)
          expect(state.attempt.error_code).toEqual(reason ?? action)
          expect(state.attempt.finished_at).toBeTruthy()
          expect(state.subscription.status).toEqual(SubscriptionStatus.PAST_DUE)

          expect(state.cases).toHaveLength(1)
          expect(state.cases[0]).toMatchObject({
            renewal_cycle_id: seeded.cycle.id,
            renewal_order_id: ORDER_ID,
            status: DunningCaseStatus.RETRY_SCHEDULED,
            last_payment_error_code: reason ?? action,
          })
          const nextRetryAt = new Date(state.cases[0].next_retry_at!).getTime()
          expect(nextRetryAt).toBeGreaterThanOrEqual(
            before + FIRST_INTERVAL_MINUTES * 60_000
          )
          expect(nextRetryAt).toBeLessThanOrEqual(
            after + FIRST_INTERVAL_MINUTES * 60_000
          )

          expect(dunningStartedEmissions()).toHaveLength(1)
          expect(dunningStartedEmissions()[0][0].data).toMatchObject({
            subscription_id: seeded.subscription.id,
            dunning_case_id: state.cases[0].id,
            renewal_cycle_id: seeded.cycle.id,
          })

          const logs = await activityLogModule.listSubscriptionLogs({
            subscription_id: seeded.subscription.id,
            event_type: ActivityLogEventType.RENEWAL_FAILED,
          } as never)
          expect(logs).toHaveLength(1)
        }
      )

      it("changes nothing when the same event is delivered again", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingCycle(container, {
          reference: "SUB-FAIL-REPLAY",
        })

        decodeAs(PaymentActions.FAILED, seeded.session.id, "declined")

        await deliver(container)
        const afterFirst = await readState(container, seeded)
        expect(afterFirst.cases).toHaveLength(1)

        await deliver(container)
        const afterSecond = await readState(container, seeded)

        expect(afterSecond.cases).toHaveLength(1)
        expect(afterSecond.cases[0]).toEqual(afterFirst.cases[0])
        expect(afterSecond.cycle).toEqual(afterFirst.cycle)
        expect(afterSecond.attempt).toEqual(afterFirst.attempt)
        expect(afterSecond.subscription.status).toEqual(
          SubscriptionStatus.PAST_DUE
        )
        expect(dunningStartedEmissions()).toHaveLength(1)
      })

      it("ignores a marked session whose cycle is not awaiting payment", async () => {
        const container = getContainer()

        for (const cycleStatus of [
          RenewalCycleStatus.SUCCEEDED,
          RenewalCycleStatus.FAILED,
        ]) {
          const seeded = await seedAwaitingCycle(container, {
            reference: `SUB-FAIL-OTHER-${cycleStatus}`,
            cycleStatus,
          })
          const before = await readState(container, seeded)

          decodeAs(PaymentActions.FAILED, seeded.session.id, "declined")
          await deliver(container)

          const after = await readState(container, seeded)

          expect(after.cycle).toEqual(before.cycle)
          expect(after.attempt).toEqual(before.attempt)
          expect(after.subscription.status).toEqual(SubscriptionStatus.ACTIVE)
          expect(after.cases).toHaveLength(0)
        }

        expect(dunningStartedEmissions()).toHaveLength(0)
      })

      it("ignores a session without a renewal marker", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingCycle(container, {
          reference: "SUB-FAIL-NOMARKER",
          marker: false,
        })
        const before = await readState(container, seeded)

        decodeAs(PaymentActions.FAILED, seeded.session.id, "declined")
        await deliver(container)

        const after = await readState(container, seeded)

        expect(after.cycle).toEqual(before.cycle)
        expect(after.cycle.status).toEqual(RenewalCycleStatus.AWAITING_PAYMENT)
        expect(after.attempt).toEqual(before.attempt)
        expect(after.subscription.status).toEqual(SubscriptionStatus.ACTIVE)
        expect(after.cases).toHaveLength(0)
        expect(dunningStartedEmissions()).toHaveLength(0)
      })

      it("fails the cycle but opens no dunning case when the subscription is paused", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingCycle(container, {
          reference: "SUB-FAIL-PAUSED",
          subscriptionStatus: SubscriptionStatus.PAUSED,
        })

        decodeAs(PaymentActions.FAILED, seeded.session.id, "declined")
        await deliver(container)

        const state = await readState(container, seeded)

        expect(state.cycle.status).toEqual(RenewalCycleStatus.FAILED)
        expect(state.cycle.generated_order_id).toEqual(ORDER_ID)
        expect(state.attempt.status).toEqual(RenewalAttemptStatus.FAILED)
        expect(state.attempt.error_code).toEqual("declined")
        expect(state.subscription.status).toEqual(SubscriptionStatus.PAUSED)
        expect(state.cases).toHaveLength(0)
        expect(dunningStartedEmissions()).toHaveLength(0)
      })

      it("still cancels a pending_payment subscription on a failed first payment and decodes once", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const link = container.resolve(ContainerRegistrationKeys.LINK)

        const cartId = "cart_pending_001"
        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-FAIL-PENDING",
          status: SubscriptionStatus.PENDING_PAYMENT,
          cart_id: cartId,
        })
        const { collection, session } = await createPaymentSessionFixture(
          container
        )

        await link.create({
          [Modules.CART]: { cart_id: cartId },
          [Modules.PAYMENT]: { payment_collection_id: collection.id },
        })

        decodeAs(PaymentActions.FAILED, session.id, "declined")
        await deliver(container)

        const stored = await subscriptionModule.retrieveSubscription(
          subscription.id
        )

        expect(stored.status).toEqual(SubscriptionStatus.CANCELLED)
        expect(decoder).toHaveBeenCalledTimes(1)
      })
    })
  },
})
