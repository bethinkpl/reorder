import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import type {
  IEventBusModuleService,
  IOrderModuleService,
  IPaymentModuleService,
  MedusaContainer,
  PaymentSessionDTO,
} from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
  PaymentActions,
  PaymentEvents,
  PaymentWebhookEvents,
} from "@medusajs/framework/utils"
import { DateTime } from "luxon"
import { FrequencyInterval } from "../../src/common/types/frequency-interval"
import processDunningRetriesJob from "../../src/jobs/process-dunning-retries"
import processRenewalCyclesJob from "../../src/jobs/process-renewal-cycles"
import { reconcileAwaitingRenewalCycles } from "../../src/jobs/reconcile-awaiting-renewal-cycles"
import { ACTIVITY_LOG_MODULE } from "../../src/modules/activity-log"
import type ActivityLogModuleService from "../../src/modules/activity-log/service"
import { ActivityLogEventType } from "../../src/modules/activity-log/types"
import { DUNNING_MODULE } from "../../src/modules/dunning"
import { DunningEvents } from "../../src/modules/dunning/events"
import type DunningModuleService from "../../src/modules/dunning/service"
import {
  DunningAttemptStatus,
  DunningCaseStatus,
} from "../../src/modules/dunning/types"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import {
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../src/modules/renewal/types"
import {
  AWAITING_PAYMENT_OVERDUE_EVENT,
  DEFAULT_AWAITING_PAYMENT_ALERT_HOURS,
} from "../../src/modules/renewal/utils/awaiting-payment-age"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import activateSubscriptionOnPaymentCapturedHandler from "../../src/subscribers/activate-subscription-on-payment-captured"
import cancelPendingSubscriptionOnPaymentFailureHandler, {
  cancelPendingSubscriptionOnPaymentFailure,
} from "../../src/subscribers/cancel-pending-subscription-on-payment-failure"
import {
  cancelSubscriptionWorkflow,
  ensureNextRenewalCycleWorkflow,
  forceRenewalCycleWorkflow,
  processRenewalCycleWorkflow,
  runDunningRetryWorkflow,
} from "../../src/workflows"
import { recordOrderCaptureTransactions } from "../../src/workflows/utils/record-order-capture-transactions"
import {
  createDunningAttemptSeed,
  createDunningCaseSeed,
  defaultRetrySchedule,
} from "../helpers/dunning-fixtures"
import { seedAwaitingRenewal } from "../helpers/awaiting-renewal-fixtures"
import {
  SYSTEM_PAYMENT_PROVIDER_ID,
  authorizeAndCapturePaymentSession,
  createPaymentSessionFixture,
} from "../helpers/payment-fixtures"
import {
  RENEWAL_AMOUNT,
  answerAuthorizationWithNull,
  createRenewalChargeStub,
} from "../helpers/renewal-charge-fixtures"
import {
  createRenewalAttemptSeed,
  createRenewalCycleSeed,
  createSubscriptionSeed,
} from "../helpers/renewal-fixtures"

const mockCreateOrderRun = jest.fn()
const mockCreateOrUpdateOrderPaymentCollectionRun = jest.fn()
const mockCreatePaymentSessionsRun = jest.fn()

jest.mock("@medusajs/medusa/core-flows", () => {
  const actual = jest.requireActual("@medusajs/medusa/core-flows")

  return {
    ...actual,
    createOrderWorkflow: () => ({
      run: mockCreateOrderRun,
    }),
    createOrUpdateOrderPaymentCollectionWorkflow: () => ({
      run: mockCreateOrUpdateOrderPaymentCollectionRun,
    }),
    createPaymentSessionsWorkflow: () => ({
      run: mockCreatePaymentSessionsRun,
    }),
  }
})

jest.setTimeout(120 * 1000)

const stubRenewalCharge = createRenewalChargeStub({
  createOrderRun: mockCreateOrderRun,
  createOrUpdateOrderPaymentCollectionRun:
    mockCreateOrUpdateOrderPaymentCollectionRun,
  createPaymentSessionsRun: mockCreatePaymentSessionsRun,
})

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const WRITE_FAILURE = "database connection lost"
const RELEASE_FAILURE = "lock store unavailable"

type LogEntry = Record<string, unknown> & { alertable?: boolean }

function oneMonthAfter(date: Date) {
  return DateTime.fromJSDate(date, { zone: "utc" }).plus({ months: 1 }).toJSDate()
}

const webhookEvent = {
  provider: "pp_test_provider",
  payload: { data: {}, rawData: Buffer.from("{}"), headers: {} },
}

/** Runs `interject` before the first call that matches, then hands every call to `original`. */
function interceptOnce<TArgs extends unknown[], TResult>(
  original: (...args: TArgs) => Promise<TResult>,
  matches: (...args: TArgs) => boolean,
  interject: () => Promise<unknown>
) {
  let intercepted = false

  return async (...args: TArgs): Promise<TResult> => {
    if (!intercepted && matches(...args)) {
      intercepted = true
      await interject()
    }

    return await original(...args)
  }
}

function failingOnce<TArgs extends unknown[], TResult>(
  original: (...args: TArgs) => Promise<TResult>,
  matches: (...args: TArgs) => boolean,
  message = WRITE_FAILURE
) {
  return interceptOnce(original, matches, async () => {
    throw new Error(message)
  })
}

function writesStatus(data: unknown, status: string) {
  return (
    typeof data === "object" &&
    data !== null &&
    "status" in data &&
    data.status === status
  )
}

function renewalLockKey(subscriptionId: string) {
  return `renewal:subscription:${subscriptionId}`
}

function dunningLockKey(dunningCaseId: string) {
  return `dunning:${dunningCaseId}`
}

/**
 * Resolves once the given number of `locking.execute` or `locking.acquire` calls have asked for the
 * key, so a test can hold a run at a chosen point until a concurrent handler is queued behind its
 * lock. A workflow's own lock step counts as one request.
 */
function watchLockRequests(container: MedusaContainer, key: string) {
  const locking = container.resolve(Modules.LOCKING)
  const execute = locking.execute.bind(locking)
  const acquire = locking.acquire.bind(locking)
  const waiters: { count: number, resolve: () => void }[] = []
  let requests = 0

  const count = (keys: string | string[]) => {
    const requested = Array.isArray(keys) ? keys : [keys]

    if (requested.includes(key)) {
      requests += 1

      for (const waiter of waiters.filter((entry) => entry.count <= requests)) {
        waiter.resolve()
      }
    }
  }

  jest.spyOn(locking, "execute").mockImplementation((keys, job, args) => {
    count(keys)

    return execute(keys, job, args)
  })
  jest.spyOn(locking, "acquire").mockImplementation((keys, args) => {
    count(keys)

    return acquire(keys, args)
  })

  return (count: number) =>
    new Promise<void>((resolve) => {
      if (requests >= count) {
        resolve()
      } else {
        waiters.push({ count, resolve })
      }
    })
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ getContainer }) => {
    let decoder: jest.SpyInstance
    let emit: jest.SpyInstance

    beforeEach(() => {
      const container = getContainer()

      jest.clearAllMocks()
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

    async function deliverFailure(
      sessionId: string,
      reason = "declined",
      action: string = PaymentActions.FAILED
    ) {
      decoder.mockResolvedValue({
        action,
        data: { session_id: sessionId, amount: RENEWAL_AMOUNT, reason },
      })

      await cancelPendingSubscriptionOnPaymentFailure(getContainer(), webhookEvent)
    }

    async function deliverCapture(paymentId: string) {
      await activateSubscriptionOnPaymentCapturedHandler({
        event: { name: PaymentEvents.CAPTURED, data: { id: paymentId } },
        container: getContainer(),
        pluginOptions: {},
      })
    }

    /** Captures the session in full and books it on the order, as a provider's webhook would. */
    async function captureOnOrder(sessionId: string, orderId: string) {
      const container = getContainer()
      const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
      const session = await paymentModule.retrievePaymentSession(sessionId)

      await container.resolve(ContainerRegistrationKeys.LINK).create({
        [Modules.ORDER]: { order_id: orderId },
        [Modules.PAYMENT]: { payment_collection_id: session.payment_collection_id },
      })

      const payment = await authorizeAndCapturePaymentSession(container, sessionId)

      await recordOrderCaptureTransactions(container, orderId, payment.id)

      return payment
    }

    function watchLogs() {
      const logger = getContainer().resolve(ContainerRegistrationKeys.LOGGER)
      const spies = (["info", "warn", "error"] as const).map((level) =>
        jest.spyOn(logger, level)
      )

      return () =>
        spies
          .flatMap((spy) => spy.mock.calls.map(([line]) => String(line)))
          .flatMap((line): LogEntry[] => {
            try {
              return [JSON.parse(line)]
            } catch {
              return []
            }
          })
    }

    function watchAlerts() {
      const logs = watchLogs()

      return (...mentions: string[]) =>
        logs().filter(
          (entry) =>
            entry.alertable === true &&
            mentions.every((mention) => JSON.stringify(entry).includes(mention))
        )
    }

    function failCycleWriteOnce(status: RenewalCycleStatus) {
      const renewalModule =
        getContainer().resolve<RenewalModuleService>(RENEWAL_MODULE)
      const update = failingOnce(
        renewalModule.updateRenewalCycles.bind(renewalModule),
        (data) => writesStatus(data, status)
      )

      jest.spyOn(renewalModule, "updateRenewalCycles").mockImplementation(update)
    }

    function failAttemptReferenceWriteOnce() {
      const renewalModule =
        getContainer().resolve<RenewalModuleService>(RENEWAL_MODULE)
      const update = failingOnce(
        renewalModule.updateRenewalAttempts.bind(renewalModule),
        (data) =>
          typeof data === "object" && data !== null && "payment_reference" in data
      )

      jest.spyOn(renewalModule, "updateRenewalAttempts").mockImplementation(update)
    }

    function failCaseWriteOnce(status: DunningCaseStatus) {
      const dunningModule =
        getContainer().resolve<DunningModuleService>(DUNNING_MODULE)
      const update = failingOnce(
        dunningModule.updateDunningCases.bind(dunningModule),
        (data) => writesStatus(data, status)
      )

      jest.spyOn(dunningModule, "updateDunningCases").mockImplementation(update)
    }

    function failLockReleaseOnce(key: string) {
      const locking = getContainer().resolve(Modules.LOCKING)
      const release = failingOnce(
        locking.release.bind(locking),
        (keys) => (Array.isArray(keys) ? keys : [keys]).includes(key),
        RELEASE_FAILURE
      )

      jest.spyOn(locking, "release").mockImplementation(release)
    }

    function emitted(name: string) {
      return emit.mock.calls
        .flatMap(([message]) => (Array.isArray(message) ? message : [message]))
        .filter((message) => message?.name === name)
    }

    async function readRenewalState(subscriptionId: string, cycleId: string) {
      const container = getContainer()
      const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
      const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)

      return {
        cycle: await renewalModule.retrieveRenewalCycle(cycleId),
        attempts: await renewalModule.listRenewalAttempts({
          renewal_cycle_id: cycleId,
        }),
        cases: await dunningModule.listDunningCases({
          subscription_id: subscriptionId,
        }),
      }
    }

    async function readDunningState(dunningCaseId: string) {
      const dunningModule = getContainer().resolve<DunningModuleService>(
        DUNNING_MODULE
      )

      return {
        dunningCase: await dunningModule.retrieveDunningCase(dunningCaseId),
        attempts: await dunningModule.listDunningAttempts({
          dunning_case_id: dunningCaseId,
        }),
      }
    }

    async function seedDueRenewal(reference: string) {
      const container = getContainer()
      const dueAt = new Date(Date.now() - HOUR_MS)
      const subscription = await createSubscriptionSeed(container, {
        reference,
        next_renewal_at: dueAt,
      })
      const cycle = await createRenewalCycleSeed(container, {
        subscription_id: subscription.id,
        scheduled_for: dueAt,
      })

      return { subscription, cycle, dueAt }
    }

    async function seedRetryScheduledCase(reference: string) {
      const container = getContainer()
      const orderModule = container.resolve<IOrderModuleService>(Modules.ORDER)
      const dueAt = new Date(Date.now() - 2 * DAY_MS)

      const subscription = await createSubscriptionSeed(container, {
        reference,
        status: SubscriptionStatus.PAST_DUE,
        next_renewal_at: dueAt,
        payment_context: {
          payment_provider_id: SYSTEM_PAYMENT_PROVIDER_ID,
          account_holder_id: `acch_${reference}`,
          payment_method_id: `pm_${reference}`,
        },
      })
      const order = await orderModule.createOrders({
        currency_code: "pln",
        email: "customer@example.com",
        metadata: { subscription_id: subscription.id },
        items: [
          { title: "Subscription renewal", quantity: 1, unit_price: RENEWAL_AMOUNT },
        ],
      })
      const cycle = await createRenewalCycleSeed(container, {
        subscription_id: subscription.id,
        status: RenewalCycleStatus.FAILED,
        scheduled_for: dueAt,
        generated_order_id: order.id,
      })
      const dunningCase = await createDunningCaseSeed(container, {
        subscription_id: subscription.id,
        renewal_cycle_id: cycle.id,
        renewal_order_id: order.id,
        status: DunningCaseStatus.RETRY_SCHEDULED,
        attempt_count: 0,
        retry_schedule: defaultRetrySchedule,
      })

      return { subscription, order, cycle, dunningCase }
    }

    /** A case whose first retry went to the provider and awaits its answer on a marked session. */
    async function seedAwaitingRetry(reference: string) {
      const container = getContainer()
      const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
      const scenario = await seedRetryScheduledCase(reference)

      await dunningModule.updateDunningCases({
        id: scenario.dunningCase.id,
        status: DunningCaseStatus.AWAITING_PAYMENT,
        attempt_count: 1,
        next_retry_at: null,
      })

      const attempt = await createDunningAttemptSeed(container, {
        dunning_case_id: scenario.dunningCase.id,
        attempt_no: 1,
        status: DunningAttemptStatus.PROCESSING,
      })
      const { session } = await createPaymentSessionFixture(container, {
        amount: RENEWAL_AMOUNT,
        context: {
          dunning_case_id: scenario.dunningCase.id,
          dunning_attempt_id: attempt.id,
        },
      })

      await dunningModule.updateDunningAttempts({
        id: attempt.id,
        payment_reference: session.id,
      })

      return { ...scenario, attempt, session }
    }

    function routeRetrySessionsToFixture(container: MedusaContainer) {
      const sessions: PaymentSessionDTO[] = []

      mockCreateOrUpdateOrderPaymentCollectionRun.mockResolvedValue({
        result: [{ id: "paycol_retry" }],
      })
      mockCreatePaymentSessionsRun.mockImplementation(async ({ input }) => {
        const { session } = await createPaymentSessionFixture(container, {
          amount: RENEWAL_AMOUNT,
          context: input.context,
        })

        sessions.push(session)

        return { result: { ...session, data: { reference: session.id } } }
      })

      return sessions
    }

    /**
     * Answers the authorisation with `null`, but only once the provider's failure for the session
     * has either been handled or been queued behind the lock the run took first.
     */
    function failBeforeTheRunParks(lockKey: string, reason: string) {
      const container = getContainer()
      const lockRequested = watchLockRequests(container, lockKey)
      const delivery: { done: Promise<void> } = { done: Promise.resolve() }

      jest
        .spyOn(container.resolve<IPaymentModuleService>(Modules.PAYMENT), "authorizePaymentSession")
        .mockImplementation(async (sessionId) => {
          delivery.done = deliverFailure(sessionId, reason)
          await Promise.race([delivery.done, lockRequested(2)])

          return null as never
        })

      return delivery
    }

    describe("a failure reported before the run has parked the charge", () => {
      it("fails the renewal cycle and opens dunning once the run releases its lock", async () => {
        const { subscription, cycle } = await seedDueRenewal("SUB-EARLY-RENEWAL-FAILURE")

        stubRenewalCharge(getContainer(), {
          subscription,
          order_id: "order_early_renewal_failure",
        })
        const delivery = failBeforeTheRunParks(
          renewalLockKey(subscription.id),
          "declined"
        )

        await processRenewalCycleWorkflow(getContainer()).run({
          input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" },
        })
        await delivery.done

        const state = await readRenewalState(subscription.id, cycle.id)

        expect(state.cycle.status).toEqual(RenewalCycleStatus.FAILED)
        expect(state.attempts).toEqual([
          expect.objectContaining({
            status: RenewalAttemptStatus.FAILED,
            error_code: "declined",
          }),
        ])
        expect(state.cases).toEqual([
          expect.objectContaining({
            renewal_cycle_id: cycle.id,
            status: DunningCaseStatus.RETRY_SCHEDULED,
          }),
        ])
        expect(emitted(DunningEvents.STARTED)).toHaveLength(1)
      })

      it("leaves the renewal cycle failed, and raises one alert, when the failure was handled after the run's lock lapsed", async () => {
        const container = getContainer()
        const locking = container.resolve(Modules.LOCKING)
        const { subscription, cycle } = await seedDueRenewal("SUB-FAILED-BEFORE-PARK")
        const { sessionIds } = stubRenewalCharge(container, {
          subscription,
          order_id: "order_failed_before_park",
        })

        jest
          .spyOn(container.resolve<IPaymentModuleService>(Modules.PAYMENT), "authorizePaymentSession")
          .mockImplementation(async (sessionId) => {
            await locking.release(renewalLockKey(subscription.id))
            await deliverFailure(sessionId)

            return null as never
          })
        const alerts = watchAlerts()

        const outcome = await processRenewalCycleWorkflow(container)
          .run({ input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" } })
          .then(({ result }) => result, (error: unknown) => error)
        const state = await readRenewalState(subscription.id, cycle.id)

        expect(outcome).toBeNull()
        expect(state.cycle.status).toEqual(RenewalCycleStatus.FAILED)
        expect(state.attempts).toEqual([
          expect.objectContaining({
            status: RenewalAttemptStatus.FAILED,
            error_code: "declined",
            payment_reference: sessionIds[0],
          }),
        ])
        expect(state.cases).toEqual([
          expect.objectContaining({
            renewal_cycle_id: cycle.id,
            status: DunningCaseStatus.RETRY_SCHEDULED,
          }),
        ])
        expect(emitted(DunningEvents.STARTED)).toHaveLength(1)
        expect(alerts(cycle.id, sessionIds[0])).toHaveLength(1)
      })

      it("reschedules the dunning case once the retry run releases its lock", async () => {
        const scenario = await seedRetryScheduledCase("SUB-EARLY-RETRY-FAILURE")
        const sessions = routeRetrySessionsToFixture(getContainer())
        const delivery = failBeforeTheRunParks(
          dunningLockKey(scenario.dunningCase.id),
          "insufficient_funds"
        )

        await runDunningRetryWorkflow(getContainer()).run({
          input: { dunning_case_id: scenario.dunningCase.id },
        })
        await delivery.done

        const state = await readDunningState(scenario.dunningCase.id)

        expect(state.dunningCase).toMatchObject({
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 1,
          last_payment_error_code: "insufficient_funds",
        })
        expect(state.dunningCase.next_retry_at).toBeTruthy()
        expect(state.attempts).toEqual([
          expect.objectContaining({
            status: DunningAttemptStatus.FAILED,
            error_code: "insufficient_funds",
            payment_reference: sessions[0].id,
          }),
        ])
        expect(emitted(DunningEvents.ATTEMPT_FAILED)).toHaveLength(1)
      })
    })

    describe("a submitted charge whose wait could not be recorded", () => {
      it("keeps the renewal cycle processing, never charges it again and settles it on the capture", async () => {
        const container = getContainer()
        const orderModule = container.resolve<IOrderModuleService>(Modules.ORDER)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const { subscription, cycle, dueAt } = await seedDueRenewal(
          "SUB-RENEWAL-PARK-WRITE-FAILURE"
        )
        const order = await orderModule.createOrders({
          currency_code: "pln",
          email: "customer@example.com",
          customer_id: subscription.customer_id,
          items: [
            { title: "Subscription renewal", quantity: 1, unit_price: RENEWAL_AMOUNT },
          ],
        })
        const { sessionIds } = stubRenewalCharge(container, {
          subscription,
          order_id: order.id,
        })
        const authorize = jest
          .spyOn(container.resolve<IPaymentModuleService>(Modules.PAYMENT), "authorizePaymentSession")
          .mockResolvedValue(null as never)
        failCycleWriteOnce(RenewalCycleStatus.AWAITING_PAYMENT)
        const alerts = watchAlerts()

        const outcome = await processRenewalCycleWorkflow(container)
          .run({ input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" } })
          .then(({ result }) => result, (error: unknown) => error)

        const inFlight = await readRenewalState(subscription.id, cycle.id)

        expect(inFlight.cycle.status).toEqual(RenewalCycleStatus.PROCESSING)
        expect(inFlight.attempts).toEqual([
          expect.objectContaining({
            status: RenewalAttemptStatus.PROCESSING,
            payment_reference: sessionIds[0],
          }),
        ])
        expect(inFlight.cases).toHaveLength(0)
        expect(outcome).toBeNull()
        expect(alerts(cycle.id, sessionIds[0])).toHaveLength(1)

        await processRenewalCyclesJob(container)

        expect(sessionIds).toHaveLength(1)
        expect(authorize).toHaveBeenCalledTimes(1)

        jest.restoreAllMocks()
        const payment = await captureOnOrder(sessionIds[0], order.id)
        await deliverCapture(payment.id)

        const settled = await readRenewalState(subscription.id, cycle.id)
        const subscriptionAfter = await subscriptionModule.retrieveSubscription(
          subscription.id
        )

        expect(settled.cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(settled.attempts).toEqual([
          expect.objectContaining({
            id: inFlight.attempts[0].id,
            status: RenewalAttemptStatus.SUCCEEDED,
          }),
        ])
        expect(subscriptionAfter.next_renewal_at).toEqual(oneMonthAfter(dueAt))
      })

      it("keeps the renewal cycle processing when a later step of the run fails as well", async () => {
        const container = getContainer()
        const { subscription, cycle } = await seedDueRenewal(
          "SUB-RENEWAL-PARK-AND-RELEASE-FAILURE"
        )
        const { sessionIds } = stubRenewalCharge(container, {
          subscription,
          order_id: "order_park_and_release_failure",
        })
        answerAuthorizationWithNull(container)
        failCycleWriteOnce(RenewalCycleStatus.AWAITING_PAYMENT)
        failLockReleaseOnce(renewalLockKey(subscription.id))

        await expect(
          processRenewalCycleWorkflow(container).run({
            input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" },
          })
        ).rejects.toMatchObject({ message: expect.stringContaining(RELEASE_FAILURE) })

        const state = await readRenewalState(subscription.id, cycle.id)

        expect(state.cycle.status).toEqual(RenewalCycleStatus.PROCESSING)
        expect(state.attempts).toEqual([
          expect.objectContaining({
            status: RenewalAttemptStatus.PROCESSING,
            payment_reference: sessionIds[0],
          }),
        ])
        expect(state.cases).toHaveLength(0)
      })

      it("keeps the dunning case retrying, never charges it again and recovers it on the capture", async () => {
        const container = getContainer()
        const scenario = await seedRetryScheduledCase("SUB-RETRY-PARK-WRITE-FAILURE")
        const sessions = routeRetrySessionsToFixture(container)
        const authorize = jest
          .spyOn(container.resolve<IPaymentModuleService>(Modules.PAYMENT), "authorizePaymentSession")
          .mockResolvedValue(null as never)
        failCaseWriteOnce(DunningCaseStatus.AWAITING_PAYMENT)
        const alerts = watchAlerts()

        const outcome = await runDunningRetryWorkflow(container)
          .run({ input: { dunning_case_id: scenario.dunningCase.id } })
          .then(({ result }) => result.outcome, (error: unknown) => error)

        const inFlight = await readDunningState(scenario.dunningCase.id)

        expect(inFlight.dunningCase).toMatchObject({
          status: DunningCaseStatus.RETRYING,
          attempt_count: 1,
          next_retry_at: null,
        })
        expect(inFlight.attempts).toEqual([
          expect.objectContaining({
            status: DunningAttemptStatus.PROCESSING,
            payment_reference: sessions[0].id,
          }),
        ])
        expect(outcome).toEqual("awaiting_payment")
        expect(alerts(scenario.dunningCase.id, sessions[0].id)).toHaveLength(1)

        await processDunningRetriesJob(container)

        expect(sessions).toHaveLength(1)
        expect(authorize).toHaveBeenCalledTimes(1)

        jest.restoreAllMocks()
        const payment = await captureOnOrder(sessions[0].id, scenario.order.id)
        await deliverCapture(payment.id)

        const recovered = await readDunningState(scenario.dunningCase.id)

        expect(recovered.dunningCase.status).toEqual(DunningCaseStatus.RECOVERED)
        expect(recovered.attempts).toEqual([
          expect.objectContaining({ status: DunningAttemptStatus.SUCCEEDED }),
        ])
      })
    })

    describe("a submitted charge whose attempt could not record its session", () => {
      async function runWithoutRecordedSession(reference: string, orderId?: string) {
        const container = getContainer()
        const { subscription, cycle, dueAt } = await seedDueRenewal(reference)
        const { sessionIds } = stubRenewalCharge(container, {
          subscription,
          order_id: orderId ?? `order_${reference.toLowerCase()}`,
        })
        answerAuthorizationWithNull(container)
        failAttemptReferenceWriteOnce()

        const outcome = await processRenewalCycleWorkflow(container)
          .run({ input: { renewal_cycle_id: cycle.id, trigger_type: "scheduler" } })
          .then(({ result }) => result, (error: unknown) => error)
        const inFlight = await readRenewalState(subscription.id, cycle.id)

        expect(outcome).toBeNull()
        expect(inFlight.cycle.status).toEqual(RenewalCycleStatus.PROCESSING)
        expect(inFlight.attempts).toEqual([
          expect.objectContaining({
            status: RenewalAttemptStatus.PROCESSING,
            payment_reference: null,
          }),
        ])

        return { subscription, cycle, dueAt, sessionIds, inFlight }
      }

      it("settles the renewal cycle on the capture of its session", async () => {
        const container = getContainer()
        const orderModule = container.resolve<IOrderModuleService>(Modules.ORDER)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const order = await orderModule.createOrders({
          currency_code: "pln",
          email: "customer@example.com",
          items: [
            { title: "Subscription renewal", quantity: 1, unit_price: RENEWAL_AMOUNT },
          ],
        })
        const run = await runWithoutRecordedSession(
          "SUB-SESSION-UNRECORDED-CAPTURED",
          order.id
        )

        jest.restoreAllMocks()
        const payment = await captureOnOrder(run.sessionIds[0], order.id)
        await deliverCapture(payment.id)

        const settled = await readRenewalState(run.subscription.id, run.cycle.id)

        expect(settled.cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(settled.attempts).toEqual([
          expect.objectContaining({
            id: run.inFlight.attempts[0].id,
            status: RenewalAttemptStatus.SUCCEEDED,
          }),
        ])
        expect(
          (await subscriptionModule.retrieveSubscription(run.subscription.id))
            .next_renewal_at
        ).toEqual(oneMonthAfter(run.dueAt))
      })

      it("fails the renewal cycle and opens dunning on the failure of its session", async () => {
        const run = await runWithoutRecordedSession("SUB-SESSION-UNRECORDED-DECLINED")

        await deliverFailure(run.sessionIds[0])

        const state = await readRenewalState(run.subscription.id, run.cycle.id)

        expect(state.cycle.status).toEqual(RenewalCycleStatus.FAILED)
        expect(state.attempts).toEqual([
          expect.objectContaining({
            id: run.inFlight.attempts[0].id,
            status: RenewalAttemptStatus.FAILED,
            error_code: "declined",
            payment_reference: run.sessionIds[0],
          }),
        ])
        expect(state.cases).toEqual([
          expect.objectContaining({
            renewal_cycle_id: run.cycle.id,
            status: DunningCaseStatus.RETRY_SCHEDULED,
          }),
        ])
        expect(emitted(DunningEvents.STARTED)).toHaveLength(1)
      })
    })

    describe("a signal for an earlier attempt's session while a newer attempt's charge is in flight", () => {
      async function seedNewerAttemptInFlight(reference: string) {
        const container = getContainer()
        const orderModule = container.resolve<IOrderModuleService>(Modules.ORDER)
        const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const { subscription, cycle } = await seedDueRenewal(reference)
        const order = await orderModule.createOrders({
          currency_code: "pln",
          email: "customer@example.com",
          customer_id: subscription.customer_id,
          items: [
            { title: "Subscription renewal", quantity: 1, unit_price: RENEWAL_AMOUNT },
          ],
        })

        await container.resolve(ContainerRegistrationKeys.LINK).create({
          [SUBSCRIPTION_MODULE]: { subscription_id: subscription.id },
          [Modules.ORDER]: { order_id: order.id },
        })
        await renewalModule.updateRenewalCycles({
          id: cycle.id,
          status: RenewalCycleStatus.PROCESSING,
          attempt_count: 2,
          generated_order_id: order.id,
        })

        const earlier = await createRenewalAttemptSeed(container, {
          renewal_cycle_id: cycle.id,
          attempt_no: 1,
          status: RenewalAttemptStatus.FAILED,
          error_code: "declined",
          order_id: order.id,
        })
        const { session } = await createPaymentSessionFixture(container, {
          amount: RENEWAL_AMOUNT,
          context: { renewal_cycle_id: cycle.id, renewal_attempt_id: earlier.id },
        })

        await renewalModule.updateRenewalAttempts({
          id: earlier.id,
          payment_reference: session.id,
        })

        const newer = await createRenewalAttemptSeed(container, {
          renewal_cycle_id: cycle.id,
          attempt_no: 2,
          status: RenewalAttemptStatus.PROCESSING,
          order_id: order.id,
        })

        return { subscription, cycle, order, session, newer }
      }

      function expectNewerAttemptStillInFlight(
        state: Awaited<ReturnType<typeof readRenewalState>>,
        newerAttemptId: string
      ) {
        expect(state.cycle.status).toEqual(RenewalCycleStatus.PROCESSING)
        expect(state.attempts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: newerAttemptId,
              status: RenewalAttemptStatus.PROCESSING,
              error_code: null,
            }),
          ])
        )
        expect(state.cases).toHaveLength(0)
      }

      it("ignores the failure of the earlier attempt's session", async () => {
        const scenario = await seedNewerAttemptInFlight("SUB-EARLIER-ATTEMPT-FAILED")

        await deliverFailure(scenario.session.id)

        expectNewerAttemptStillInFlight(
          await readRenewalState(scenario.subscription.id, scenario.cycle.id),
          scenario.newer.id
        )
        expect(emitted(DunningEvents.STARTED)).toHaveLength(0)
      })

      it("does not settle the cycle on the capture of the earlier attempt's session", async () => {
        const scenario = await seedNewerAttemptInFlight("SUB-EARLIER-ATTEMPT-CAPTURED")
        const payment = await captureOnOrder(scenario.session.id, scenario.order.id)

        await deliverCapture(payment.id)

        expectNewerAttemptStillInFlight(
          await readRenewalState(scenario.subscription.id, scenario.cycle.id),
          scenario.newer.id
        )
      })
    })

    describe("a failure that arrives while a run holds the renewal lock", () => {
      it("rejects after a non-alertable entry, so the bus delivers it again, and fails the cycle on a delivery after the lock is free", async () => {
        const container = getContainer()
        const locking = container.resolve(Modules.LOCKING)
        const seeded = await seedAwaitingRenewal(container, {
          reference: "SUB-FAILURE-WHILE-LOCKED",
        })
        const lockKey = renewalLockKey(seeded.subscription.id)
        const holder = "renewal-run-in-progress"
        const logs = watchLogs()
        const alerts = watchAlerts()
        const deliver = () =>
          cancelPendingSubscriptionOnPaymentFailureHandler({
            event: { name: PaymentWebhookEvents.WebhookReceived, data: webhookEvent },
            container,
            pluginOptions: {},
          })

        decoder.mockResolvedValue({
          action: PaymentActions.FAILED,
          data: { session_id: seeded.session.id, amount: RENEWAL_AMOUNT, reason: "declined" },
        })
        await locking.acquire(lockKey, { ownerId: holder, expire: 60 })

        try {
          await expect(deliver()).rejects.toThrow(/acquire lock/i)
        } finally {
          await locking.release(lockKey, { ownerId: holder })
        }

        expect(alerts(seeded.cycle.id, seeded.session.id)).toHaveLength(0)
        expect(
          logs().filter(
            (entry) =>
              entry.alertable === false &&
              entry.renewal_cycle_id === seeded.cycle.id &&
              entry.payment_session_id === seeded.session.id
          )
        ).toHaveLength(1)
        expect(
          (await readRenewalState(seeded.subscription.id, seeded.cycle.id)).cycle.status
        ).toEqual(RenewalCycleStatus.AWAITING_PAYMENT)

        await deliver()

        const state = await readRenewalState(seeded.subscription.id, seeded.cycle.id)

        expect(state.cycle.status).toEqual(RenewalCycleStatus.FAILED)
        expect(state.cases).toEqual([
          expect.objectContaining({
            renewal_cycle_id: seeded.cycle.id,
            status: DunningCaseStatus.RETRY_SCHEDULED,
          }),
        ])
      })
    })

    describe("a failure delivered again after a write failed half way", () => {
      it("fails the renewal cycle and opens one dunning case on the second delivery", async () => {
        const seeded = await seedAwaitingRenewal(getContainer(), {
          reference: "SUB-RENEWAL-FAILURE-REDELIVERY",
        })
        failCycleWriteOnce(RenewalCycleStatus.FAILED)
        const alerts = watchAlerts()

        await expect(deliverFailure(seeded.session.id)).rejects.toThrow(WRITE_FAILURE)

        expect(alerts(seeded.cycle.id, seeded.session.id)).toHaveLength(1)

        await deliverFailure(seeded.session.id)

        const state = await readRenewalState(seeded.subscription.id, seeded.cycle.id)

        expect(state.cycle.status).toEqual(RenewalCycleStatus.FAILED)
        expect(state.attempts).toEqual([
          expect.objectContaining({
            id: seeded.attempt.id,
            status: RenewalAttemptStatus.FAILED,
            error_code: "declined",
          }),
        ])
        expect(state.cases).toEqual([
          expect.objectContaining({
            renewal_cycle_id: seeded.cycle.id,
            status: DunningCaseStatus.RETRY_SCHEDULED,
          }),
        ])
        expect(emitted(DunningEvents.STARTED)).toHaveLength(1)
      })

      it("reschedules the dunning case once and counts its attempt once on the second delivery", async () => {
        const scenario = await seedAwaitingRetry("SUB-RETRY-FAILURE-REDELIVERY")
        failCaseWriteOnce(DunningCaseStatus.RETRY_SCHEDULED)
        const alerts = watchAlerts()

        await expect(
          deliverFailure(scenario.session.id, "insufficient_funds")
        ).rejects.toThrow(WRITE_FAILURE)

        expect(alerts(scenario.dunningCase.id, scenario.session.id)).toHaveLength(1)

        await deliverFailure(scenario.session.id, "insufficient_funds")

        const state = await readDunningState(scenario.dunningCase.id)

        expect(state.dunningCase).toMatchObject({
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 1,
          last_payment_error_code: "insufficient_funds",
        })
        expect(state.dunningCase.next_retry_at).toBeTruthy()
        expect(state.attempts).toEqual([
          expect.objectContaining({
            id: scenario.attempt.id,
            status: DunningAttemptStatus.FAILED,
            error_code: "insufficient_funds",
          }),
        ])
        expect(emitted(DunningEvents.ATTEMPT_FAILED)).toHaveLength(1)
      })
    })

    describe("a renewal cycle left processing", () => {
      async function seedProcessingCycle(
        reference: string,
        paymentReference: string | null
      ) {
        const container = getContainer()
        const { subscription, cycle } = await seedDueRenewal(reference)
        const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        await renewalModule.updateRenewalCycles({
          id: cycle.id,
          status: RenewalCycleStatus.PROCESSING,
          attempt_count: 1,
        })
        await createRenewalAttemptSeed(container, {
          renewal_cycle_id: cycle.id,
          status: RenewalAttemptStatus.PROCESSING,
          payment_reference: paymentReference,
        })

        return { subscription, cycle }
      }

      async function sweepAt(offsetMs: number) {
        const realNow = Date.now()
        const clock = jest.spyOn(Date, "now").mockReturnValue(realNow + offsetMs)

        try {
          return await reconcileAwaitingRenewalCycles(getContainer())
        } finally {
          clock.mockRestore()
        }
      }

      it("raises the overdue alert for the other processing cycles when reading one of them fails", async () => {
        const renewalModule =
          getContainer().resolve<RenewalModuleService>(RENEWAL_MODULE)
        const unreadable = await seedProcessingCycle(
          "SUB-PROCESSING-UNREADABLE",
          "payses_unreadable_charge"
        )
        const readable = await seedProcessingCycle(
          "SUB-PROCESSING-READABLE",
          "payses_readable_charge"
        )
        const retrieve = renewalModule.retrieveRenewalCycle.bind(renewalModule)

        jest
          .spyOn(renewalModule, "retrieveRenewalCycle")
          .mockImplementation(async (id, ...rest) => {
            if (id === unreadable.cycle.id) {
              throw new Error(WRITE_FAILURE)
            }

            return await retrieve(id, ...rest)
          })
        const alerts = watchAlerts()

        const result = await sweepAt((DEFAULT_AWAITING_PAYMENT_ALERT_HOURS + 1) * HOUR_MS)

        expect(
          alerts().filter((entry) => entry.event === AWAITING_PAYMENT_OVERDUE_EVENT)
        ).toEqual([expect.objectContaining({ renewal_cycle_id: readable.cycle.id })])
        expect(alerts(unreadable.cycle.id, WRITE_FAILURE)).toHaveLength(1)
        expect(result).toMatchObject({ processing_overdue: 1, failed: 1 })
      })

      it("raises the overdue alert once per cycle, only past the limit, with or without a recorded session, and changes no status", async () => {
        const renewalModule =
          getContainer().resolve<RenewalModuleService>(RENEWAL_MODULE)
        const submitted = await seedProcessingCycle(
          "SUB-PROCESSING-SUBMITTED-CHARGE",
          "payses_submitted_charge"
        )
        const unrecorded = await seedProcessingCycle(
          "SUB-PROCESSING-NO-SESSION",
          null
        )
        const alerts = watchAlerts()
        const overdueAlerts = () =>
          alerts().filter((entry) => entry.event === AWAITING_PAYMENT_OVERDUE_EVENT)

        await sweepAt((DEFAULT_AWAITING_PAYMENT_ALERT_HOURS - 1) * HOUR_MS)

        expect(overdueAlerts()).toHaveLength(0)

        await sweepAt((DEFAULT_AWAITING_PAYMENT_ALERT_HOURS + 1) * HOUR_MS)
        await sweepAt((DEFAULT_AWAITING_PAYMENT_ALERT_HOURS + 2) * HOUR_MS)

        expect(overdueAlerts()).toHaveLength(2)
        expect(overdueAlerts()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ renewal_cycle_id: submitted.cycle.id }),
            expect.objectContaining({ renewal_cycle_id: unrecorded.cycle.id }),
          ])
        )

        for (const { cycle } of [submitted, unrecorded]) {
          expect(await renewalModule.retrieveRenewalCycle(cycle.id)).toMatchObject({
            status: RenewalCycleStatus.PROCESSING,
          })
          expect(
            await renewalModule.listRenewalAttempts({ renewal_cycle_id: cycle.id })
          ).toEqual([
            expect.objectContaining({ status: RenewalAttemptStatus.PROCESSING }),
          ])
        }
      })
    })

    describe("other paths that meet a cycle awaiting its payment", () => {
      it("leaves the approval fields of an awaiting cycle as they are when the next cycle is ensured", async () => {
        const container = getContainer()
        const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const dueAt = new Date(Date.now() - HOUR_MS)
        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-AWAITING-WITH-PENDING-CHANGE",
          next_renewal_at: dueAt,
        })

        await subscriptionModule.updateSubscriptions({
          id: subscription.id,
          pending_update_data: {
            variant_id: "variant_pending_change",
            variant_title: "Pending Variant",
            sku: "PENDING-SKU",
            frequency_interval: FrequencyInterval.MONTH,
            frequency_value: 1,
            effective_at: null,
            requested_at: new Date().toISOString(),
            requested_by: null,
          },
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          scheduled_for: dueAt,
          status: RenewalCycleStatus.AWAITING_PAYMENT,
          generated_order_id: "order_awaiting_with_pending_change",
          attempt_count: 1,
        })

        await ensureNextRenewalCycleWorkflow(container).run({
          input: { subscription_id: subscription.id },
        })

        expect(await renewalModule.retrieveRenewalCycle(cycle.id)).toMatchObject({
          status: RenewalCycleStatus.AWAITING_PAYMENT,
          approval_required: false,
          approval_status: null,
        })
      })

      it("logs a forced run that parked as awaiting its payment, counting it neither succeeded nor failed", async () => {
        const container = getContainer()
        const { subscription, cycle } = await seedDueRenewal("SUB-FORCED-RUN-PARKED")

        stubRenewalCharge(container, {
          subscription,
          order_id: "order_forced_run_parked",
        })
        answerAuthorizationWithNull(container)
        const logs = watchLogs()

        await forceRenewalCycleWorkflow(container).run({
          input: { renewal_cycle_id: cycle.id, triggered_by: "user_forcing_the_run" },
        })

        const forceOutcomes = logs().filter(
          (entry) =>
            entry.event === "renewal.force" &&
            entry.renewal_cycle_id === cycle.id &&
            entry.outcome !== "started"
        )

        expect(forceOutcomes).toEqual([
          expect.objectContaining({
            outcome: "awaiting_payment",
            success_count: 0,
            failure_count: 0,
          }),
        ])
      })

      it("settles first and cancels afterwards, leaving the cancelled subscription without a renewal date, when an admin cancellation reaches a renewal its capture is settling", async () => {
        const container = getContainer()
        const subscriptionModule =
          container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
        const activityLogModule =
          container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)
        const seeded = await seedAwaitingRenewal(container, {
          reference: "SUB-CANCELLED-WHILE-CAPTURED",
        })
        const payment = await authorizeAndCapturePaymentSession(
          container,
          seeded.session.id
        )

        await recordOrderCaptureTransactions(container, seeded.order.id, payment.id)

        const lockRequested = watchLockRequests(
          container,
          renewalLockKey(seeded.subscription.id)
        )
        const cancellation: { done: Promise<unknown> } = { done: Promise.resolve() }
        const update = interceptOnce(
          subscriptionModule.updateSubscriptions.bind(subscriptionModule),
          (data) =>
            typeof data === "object" &&
            data !== null &&
            "next_renewal_at" in data &&
            data.next_renewal_at !== null,
          async () => {
            cancellation.done = cancelSubscriptionWorkflow(container).run({
              input: { id: seeded.subscription.id, reason: "customer left" },
            })
            await Promise.race([cancellation.done, lockRequested(2)])
          }
        )

        jest.spyOn(subscriptionModule, "updateSubscriptions").mockImplementation(update)

        await deliverCapture(payment.id)
        await cancellation.done

        const state = await readRenewalState(seeded.subscription.id, seeded.cycle.id)
        const subscription = await subscriptionModule.retrieveSubscription(
          seeded.subscription.id
        )
        const logsOf = async (eventType: ActivityLogEventType) =>
          await activityLogModule.listSubscriptionLogs({
            subscription_id: seeded.subscription.id,
            event_type: eventType,
          })

        expect(state.cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(state.attempts).toEqual([
          expect.objectContaining({
            id: seeded.attempt.id,
            status: RenewalAttemptStatus.SUCCEEDED,
          }),
        ])
        expect(await logsOf(ActivityLogEventType.RENEWAL_FAILED)).toHaveLength(0)
        expect(await logsOf(ActivityLogEventType.RENEWAL_SUCCEEDED)).toHaveLength(1)
        expect(subscription.status).toEqual(SubscriptionStatus.CANCELLED)
        expect(subscription.next_renewal_at).toBeNull()
      })
    })
  },
})
