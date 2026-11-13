import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import type {
  IPaymentModuleService,
  MedusaContainer,
} from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
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
import {
  cancelSubscriptionWorkflow,
  ensureNextRenewalCycleWorkflow,
  forceRenewalCycleWorkflow,
  runDunningRetryWorkflow,
} from "../../src/workflows"
import {
  createRetrySessionRouter,
  readDunningState,
  seedDunningCase,
} from "../helpers/awaiting-dunning-fixtures"
import {
  AWAITING_ORDER_TOTAL,
  type RenewalRefs,
  failRenewalLockReleaseOnce,
  oneMonthAfter,
  readRenewalState,
  renewalLockKey,
  seedAwaitingRenewal,
  whileRenewalLockHeld,
} from "../helpers/awaiting-renewal-fixtures"
import {
  captureOnOrder,
  createPaymentSessionFixture,
  deliverCapture,
  deliverFailure,
} from "../helpers/payment-fixtures"
import {
  answerAuthorizationWithNull,
  createRenewalChargeStub,
  createUnpaidOrder,
  runRenewal,
} from "../helpers/renewal-charge-fixtures"
import {
  createRenewalAttemptSeed,
  createRenewalCycleSeed,
  createSubscriptionSeed,
} from "../helpers/renewal-fixtures"
import { atTime, watchEvents, watchLogs } from "../helpers/spy-fixtures"

const mockCreateOrderRun = jest.fn()
const mockCreateOrUpdateOrderPaymentCollectionRun = jest.fn()
const mockCreatePaymentSessionsRun = jest.fn()

jest.mock("@medusajs/medusa/core-flows", () => ({
  ...jest.requireActual("@medusajs/medusa/core-flows"),
  createOrderWorkflow: () => ({ run: mockCreateOrderRun }),
  createOrUpdateOrderPaymentCollectionWorkflow: () => ({
    run: mockCreateOrUpdateOrderPaymentCollectionRun,
  }),
  createPaymentSessionsWorkflow: () => ({ run: mockCreatePaymentSessionsRun }),
}))

jest.setTimeout(120 * 1000)

const chargeMocks = {
  createOrderRun: mockCreateOrderRun,
  createOrUpdateOrderPaymentCollectionRun: mockCreateOrUpdateOrderPaymentCollectionRun,
  createPaymentSessionsRun: mockCreatePaymentSessionsRun,
}

const stubRenewalCharge = createRenewalChargeStub(chargeMocks)
const routeRetrySessionsToFixture = createRetrySessionRouter(chargeMocks)

const HOUR_MS = 60 * 60 * 1000
const WRITE_FAILURE = "database connection lost"
const RELEASE_FAILURE = "lock store unavailable"
const DUE_FOR_RETRY = {
  status: DunningCaseStatus.RETRY_SCHEDULED,
  attempt_count: 0,
  attempts: [],
}

const dunningLockKey = (dunningCaseId: string) => `dunning:${dunningCaseId}`

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
  matches: (...args: TArgs) => boolean
) {
  return interceptOnce(original, matches, async () => {
    throw new Error(WRITE_FAILURE)
  })
}

function writes(data: unknown, field: string, value?: unknown) {
  return Object.entries(Object(data)).some(
    ([key, written]) => key === field && (value === undefined || written === value)
  )
}

function names(keys: string | string[], key: string) {
  return (Array.isArray(keys) ? keys : [keys]).includes(key)
}

function nthLockRequest(container: MedusaContainer, key: string, nth: number) {
  const locking = container.resolve(Modules.LOCKING)
  const execute = locking.execute.bind(locking)
  const acquire = locking.acquire.bind(locking)
  let requests = 0

  return new Promise<void>((resolve) => {
    const count = (keys: string | string[]) => {
      if (names(keys, key) && ++requests === nth) {
        resolve()
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
  })
}

/**
 * Frees `holder`'s lock on the key as soon as anything else asks for it: a request that waits for
 * the lock then gets it, a request that does not wait has already been refused.
 */
function releaseOnFirstRequest(container: MedusaContainer, key: string, holder: string) {
  const locking = container.resolve(Modules.LOCKING)
  const execute = locking.execute.bind(locking)
  const acquire = locking.acquire.bind(locking)
  let released = false

  const releaseHolder = async (keys: string | string[]) => {
    if (!released && names(keys, key)) {
      released = true
      await locking.release(key, { ownerId: holder })
    }
  }

  jest.spyOn(locking, "execute").mockImplementation((keys, job, args) => {
    const result = execute(keys, job, args)

    void releaseHolder(keys)

    return result
  })
  jest.spyOn(locking, "acquire").mockImplementation(async (keys, args) => {
    try {
      return await acquire(keys, args)
    } finally {
      await releaseHolder(keys)
    }
  })
}

function watchAlerts(container: MedusaContainer) {
  const logs = watchLogs(container)

  return (...mentions: string[]) =>
    logs().filter(
      (entry) =>
        entry.alertable === true &&
        mentions.every((mention) => JSON.stringify(entry).includes(mention))
    )
}

async function runRetry(container: MedusaContainer, dunningCaseId: string) {
  const { result } = await runDunningRetryWorkflow(container).run({
    input: { dunning_case_id: dunningCaseId },
  })

  return result
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: { JWT_SECRET: "supersecret", COOKIE_SECRET: "supersecret" },
  testSuite: ({ getContainer }) => {
    let emitted: ReturnType<typeof watchEvents>

    const renewalModule = () => getContainer().resolve<RenewalModuleService>(RENEWAL_MODULE)
    const dunningModule = () => getContainer().resolve<DunningModuleService>(DUNNING_MODULE)
    const subscriptionModule = () =>
      getContainer().resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
    const paymentModule = () => getContainer().resolve<IPaymentModuleService>(Modules.PAYMENT)
    const locking = () => getContainer().resolve(Modules.LOCKING)

    beforeEach(() => {
      jest.clearAllMocks()
      emitted = watchEvents(getContainer())
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    function failCycleWriteOnce(status: RenewalCycleStatus) {
      const module = renewalModule()
      const update = failingOnce(module.updateRenewalCycles.bind(module), (data) =>
        writes(data, "status", status)
      )

      jest.spyOn(module, "updateRenewalCycles").mockImplementation(update)
    }

    function failAttemptSessionWriteOnce() {
      const module = renewalModule()
      const update = failingOnce(module.updateRenewalAttempts.bind(module), (data) =>
        writes(data, "payment_reference")
      )

      jest.spyOn(module, "updateRenewalAttempts").mockImplementation(update)
    }

    function failCaseWriteOnce(status: DunningCaseStatus) {
      const module = dunningModule()
      const update = failingOnce(module.updateDunningCases.bind(module), (data) =>
        writes(data, "status", status)
      )

      jest.spyOn(module, "updateDunningCases").mockImplementation(update)
    }

    async function expectFailedIntoDunning(seeded: RenewalRefs, attempt: Record<string, unknown>) {
      expect(await readRenewalState(getContainer(), seeded)).toMatchObject({
        cycle: { status: RenewalCycleStatus.FAILED },
        attempts: [{ status: RenewalAttemptStatus.FAILED, error_code: "declined", ...attempt }],
        cases: [{ renewal_cycle_id: seeded.cycle.id, status: DunningCaseStatus.RETRY_SCHEDULED }],
      })
      expect(emitted(DunningEvents.STARTED)).toHaveLength(1)
    }

    async function expectRetryRescheduledOnce(dunningCaseId: string, paymentReference: string) {
      const state = await readDunningState(getContainer(), dunningCaseId)
      const error = { status: DunningAttemptStatus.FAILED, error_code: "insufficient_funds" }

      expect(state).toMatchObject({
        dunningCase: {
          status: DunningCaseStatus.RETRY_SCHEDULED,
          attempt_count: 1,
          last_payment_error_code: error.error_code,
        },
        attempts: [{ ...error, payment_reference: paymentReference }],
      })
      expect(state.dunningCase.next_retry_at).toBeTruthy()
      expect(emitted(DunningEvents.ATTEMPT_FAILED)).toHaveLength(1)
    }

    async function expectSettled(seeded: RenewalRefs, attemptId: string) {
      expect(await readRenewalState(getContainer(), seeded)).toMatchObject({
        cycle: { status: RenewalCycleStatus.SUCCEEDED },
        attempts: [{ id: attemptId, status: RenewalAttemptStatus.SUCCEEDED }],
      })
    }

    async function seedDueCharge(reference: string, orderId = `order_${reference}`) {
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
      const { sessionIds } = stubRenewalCharge(container, { subscription, order_id: orderId })

      return { subscription, cycle, dueAt, sessionIds }
    }

    function failBeforeTheRunParks(lockKey: string, reason: string) {
      const container = getContainer()
      const queued = nthLockRequest(container, lockKey, 2)
      const delivery: { done: Promise<void> } = { done: Promise.resolve() }

      jest
        .spyOn(paymentModule(), "authorizePaymentSession")
        .mockImplementation(async (sessionId) => {
          delivery.done = deliverFailure(container, sessionId, { reason })
          await Promise.race([delivery.done, queued])

          return null as never
        })

      return delivery
    }

    describe("a failure reported before the run has parked the charge", () => {
      it("fails the renewal cycle and opens dunning once the run releases its lock", async () => {
        const seeded = await seedDueCharge("SUB-EARLY-RENEWAL-FAILURE")
        const delivery = failBeforeTheRunParks(renewalLockKey(seeded.subscription.id), "declined")

        await runRenewal(getContainer(), seeded.cycle.id)
        await delivery.done

        await expectFailedIntoDunning(seeded, {})
      })

      it("leaves the renewal cycle failed, and raises one alert, when the failure was handled after the run's lock lapsed", async () => {
        const container = getContainer()
        const seeded = await seedDueCharge("SUB-FAILED-BEFORE-PARK")

        jest
          .spyOn(paymentModule(), "authorizePaymentSession")
          .mockImplementation(async (sessionId) => {
            await locking().release(renewalLockKey(seeded.subscription.id))
            await deliverFailure(container, sessionId, { reason: "declined" })

            return null as never
          })
        const alerts = watchAlerts(container)

        await expect(runRenewal(container, seeded.cycle.id)).resolves.toBeNull()

        await expectFailedIntoDunning(seeded, { payment_reference: seeded.sessionIds[0] })
        expect(alerts(seeded.cycle.id, seeded.sessionIds[0])).toHaveLength(1)
      })

      it("reschedules the dunning case once the retry run releases its lock", async () => {
        const container = getContainer()
        const { dunningCase } = await seedDunningCase(
          container,
          "SUB-EARLY-RETRY-FAILURE",
          DUE_FOR_RETRY
        )
        const sessions = routeRetrySessionsToFixture(container)
        const delivery = failBeforeTheRunParks(dunningLockKey(dunningCase.id), "insufficient_funds")

        await runRetry(container, dunningCase.id)
        await delivery.done

        await expectRetryRescheduledOnce(dunningCase.id, sessions[0].id)
      })
    })

    describe("a submitted charge whose wait or session could not be recorded", () => {
      it.each([
        {
          name: "the cycle's wait",
          failWrite: () => failCycleWriteOnce(RenewalCycleStatus.AWAITING_PAYMENT),
          sessionRecorded: true,
        },
        {
          name: "the attempt's session",
          failWrite: failAttemptSessionWriteOnce,
          sessionRecorded: false,
        },
      ])(
        "keeps the renewal cycle processing, raises one alert, never charges it again and settles it on the capture when $name could not be recorded",
        async ({ failWrite, sessionRecorded }) => {
          const container = getContainer()
          const order = await createUnpaidOrder(container)
          const seeded = await seedDueCharge("SUB-RENEWAL-PARK-WRITE-FAILURE", order.id)
          const authorize = jest
            .spyOn(paymentModule(), "authorizePaymentSession")
            .mockResolvedValue(null as never)
          failWrite()
          const alerts = watchAlerts(container)

          await expect(runRenewal(container, seeded.cycle.id)).resolves.toBeNull()

          const [sessionId] = seeded.sessionIds
          const inFlight = await readRenewalState(container, seeded)

          expect(inFlight).toMatchObject({
            cycle: { status: RenewalCycleStatus.PROCESSING },
            attempts: [
              {
                status: RenewalAttemptStatus.PROCESSING,
                payment_reference: sessionRecorded ? sessionId : null,
              },
            ],
            cases: [],
          })
          expect(alerts(seeded.cycle.id, sessionId)).toHaveLength(1)

          await processRenewalCyclesJob(container)

          expect(seeded.sessionIds).toHaveLength(1)
          expect(authorize).toHaveBeenCalledTimes(1)

          jest.restoreAllMocks()
          await deliverCapture(
            container,
            (await captureOnOrder(container, order.id, sessionId, { linkCollection: true })).id
          )

          await expectSettled(seeded, inFlight.attempts[0].id)
          expect(
            (await subscriptionModule().retrieveSubscription(seeded.subscription.id)).next_renewal_at
          ).toEqual(oneMonthAfter(seeded.dueAt))
        }
      )

      it("keeps the renewal cycle processing when a later step of the run fails as well", async () => {
        const container = getContainer()
        const seeded = await seedDueCharge("SUB-RENEWAL-PARK-AND-RELEASE-FAILURE")

        answerAuthorizationWithNull(container)
        failCycleWriteOnce(RenewalCycleStatus.AWAITING_PAYMENT)
        failRenewalLockReleaseOnce(container, seeded.subscription.id, RELEASE_FAILURE)

        await expect(runRenewal(container, seeded.cycle.id)).rejects.toMatchObject({
          message: expect.stringContaining(RELEASE_FAILURE),
        })

        expect(await readRenewalState(container, seeded)).toMatchObject({
          cycle: { status: RenewalCycleStatus.PROCESSING },
          attempts: [
            { status: RenewalAttemptStatus.PROCESSING, payment_reference: seeded.sessionIds[0] },
          ],
          cases: [],
        })
      })

      it("keeps the dunning case retrying, never charges it again and recovers it on the capture", async () => {
        const container = getContainer()
        const { dunningCase, order } = await seedDunningCase(
          container,
          "SUB-RETRY-PARK-WRITE-FAILURE",
          DUE_FOR_RETRY
        )
        const sessions = routeRetrySessionsToFixture(container)
        const authorize = jest
          .spyOn(paymentModule(), "authorizePaymentSession")
          .mockResolvedValue(null as never)
        failCaseWriteOnce(DunningCaseStatus.AWAITING_PAYMENT)
        const alerts = watchAlerts(container)

        await expect(runRetry(container, dunningCase.id)).resolves.toMatchObject({
          outcome: "awaiting_payment",
        })

        expect(await readDunningState(container, dunningCase.id)).toMatchObject({
          dunningCase: { status: DunningCaseStatus.RETRYING, attempt_count: 1, next_retry_at: null },
          attempts: [
            { status: DunningAttemptStatus.PROCESSING, payment_reference: sessions[0].id },
          ],
        })
        expect(alerts(dunningCase.id, sessions[0].id)).toHaveLength(1)

        await processDunningRetriesJob(container)

        expect(sessions).toHaveLength(1)
        expect(authorize).toHaveBeenCalledTimes(1)

        jest.restoreAllMocks()
        await deliverCapture(
          container,
          (await captureOnOrder(container, order.id, sessions[0].id, { linkCollection: true })).id
        )

        expect(await readDunningState(container, dunningCase.id)).toMatchObject({
          dunningCase: { status: DunningCaseStatus.RECOVERED },
          attempts: [{ status: DunningAttemptStatus.SUCCEEDED }],
        })
      })
    })

    it("ignores the failure and the capture of an earlier attempt's session while a newer attempt's charge is in flight", async () => {
      const container = getContainer()
      const seeded = await seedAwaitingRenewal(container, {
        reference: "SUB-EARLIER-ATTEMPT-SIGNALS",
        cycle_status: RenewalCycleStatus.PROCESSING,
      })
      const { session } = await createPaymentSessionFixture(container, {
        amount: AWAITING_ORDER_TOTAL,
        context: { renewal_cycle_id: seeded.cycle.id, renewal_attempt_id: seeded.attempt.id },
      })

      await renewalModule().updateRenewalAttempts({
        id: seeded.attempt.id,
        status: RenewalAttemptStatus.FAILED,
        error_code: "declined",
        payment_reference: session.id,
      })
      await renewalModule().updateRenewalCycles({ id: seeded.cycle.id, attempt_count: 2 })

      const newer = await createRenewalAttemptSeed(container, {
        renewal_cycle_id: seeded.cycle.id,
        attempt_no: 2,
        order_id: seeded.order.id,
      })
      const expectNewerAttemptStillInFlight = async () => {
        const state = await readRenewalState(container, seeded)

        expect(state.cycle.status).toEqual(RenewalCycleStatus.PROCESSING)
        expect(state.attempts).toContainEqual(
          expect.objectContaining({
            id: newer.id,
            status: RenewalAttemptStatus.PROCESSING,
            error_code: null,
          })
        )
        expect(state.cases).toHaveLength(0)
      }

      await deliverFailure(container, session.id, { reason: "declined" })

      await expectNewerAttemptStillInFlight()
      expect(emitted(DunningEvents.STARTED)).toHaveLength(0)

      const payment = await captureOnOrder(container, seeded.order.id, session.id, {
        linkCollection: true,
      })
      await deliverCapture(container, payment.id)

      await expectNewerAttemptStillInFlight()
    })

    it("rejects a failure that arrives while a run holds the renewal lock after a non-alertable entry, so the bus delivers it again, and fails the cycle on a delivery after the lock is free", async () => {
      const container = getContainer()
      const seeded = await seedAwaitingRenewal(container, { reference: "SUB-FAILURE-WHILE-LOCKED" })
      const logs = watchLogs(container)
      const alerts = watchAlerts(container)

      await whileRenewalLockHeld(container, seeded.subscription.id, async () => {
        await expect(
          deliverFailure(container, seeded.session.id, { reason: "declined" })
        ).rejects.toThrow(/acquire lock/i)
      })

      expect(alerts(seeded.cycle.id, seeded.session.id)).toHaveLength(0)
      expect(
        logs().filter(
          (entry) =>
            entry.alertable === false &&
            entry.renewal_cycle_id === seeded.cycle.id &&
            entry.payment_session_id === seeded.session.id
        )
      ).toHaveLength(1)
      expect((await readRenewalState(container, seeded)).cycle.status).toEqual(
        RenewalCycleStatus.AWAITING_PAYMENT
      )

      await deliverFailure(container, seeded.session.id, { reason: "declined" })

      await expectFailedIntoDunning(seeded, { id: seeded.attempt.id })
    })

    describe("a capture that arrives while another holder has the renewal lock", () => {
      async function seedCapturedBehindLock(reference: string, cycleStatus: RenewalCycleStatus) {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, { reference, cycle_status: cycleStatus })
        const payment = await captureOnOrder(container, seeded.order.id, seeded.session.id)
        const lockKey = renewalLockKey(seeded.subscription.id)

        await locking().acquire(lockKey, { ownerId: reference, expire: 60 })
        releaseOnFirstRequest(container, lockKey, reference)

        return { ...seeded, payment }
      }

      it("leaves a processing renewal cycle to the holder without waiting for the lock or raising an alert, and settles it on a delivery after the lock is free", async () => {
        const container = getContainer()
        const seeded = await seedCapturedBehindLock(
          "SUB-PROCESSING-CAPTURE-WHILE-LOCKED",
          RenewalCycleStatus.PROCESSING
        )
        const before = await readRenewalState(container, seeded)
        const alerts = watchAlerts(container)

        await deliverCapture(container, seeded.payment.id)

        expect(await readRenewalState(container, seeded)).toEqual(before)
        expect(before.cases).toHaveLength(0)
        expect(alerts(seeded.cycle.id)).toHaveLength(0)

        await deliverCapture(container, seeded.payment.id)

        await expectSettled(seeded, seeded.attempt.id)
      })

      it("waits for the lock and settles a renewal cycle awaiting its payment once the holder lets go", async () => {
        const container = getContainer()
        const seeded = await seedCapturedBehindLock(
          "SUB-AWAITING-CAPTURE-WHILE-LOCKED",
          RenewalCycleStatus.AWAITING_PAYMENT
        )
        const alerts = watchAlerts(container)

        await deliverCapture(container, seeded.payment.id)

        await expectSettled(seeded, seeded.attempt.id)
        expect(alerts(seeded.cycle.id)).toHaveLength(0)
      })
    })

    describe("a failure delivered again after a write failed half way", () => {
      it("fails the renewal cycle and opens one dunning case on the second delivery", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, {
          reference: "SUB-RENEWAL-FAILURE-REDELIVERY",
        })
        failCycleWriteOnce(RenewalCycleStatus.FAILED)
        const alerts = watchAlerts(container)

        await expect(deliverFailure(container, seeded.session.id, { reason: "declined" })).rejects.toThrow(WRITE_FAILURE)

        expect(alerts(seeded.cycle.id, seeded.session.id)).toHaveLength(1)

        await deliverFailure(container, seeded.session.id, { reason: "declined" })

        await expectFailedIntoDunning(seeded, { id: seeded.attempt.id })
      })

      it("reschedules the dunning case once and counts its attempt once on the second delivery", async () => {
        const container = getContainer()
        const { dunningCase } = await seedDunningCase(
          container,
          "SUB-RETRY-FAILURE-REDELIVERY",
          DUE_FOR_RETRY
        )
        const sessions = routeRetrySessionsToFixture(container)
        const deliver = () => deliverFailure(container, sessions[0].id, { reason: "insufficient_funds" })

        answerAuthorizationWithNull(container)
        await runRetry(container, dunningCase.id)
        failCaseWriteOnce(DunningCaseStatus.RETRY_SCHEDULED)
        const alerts = watchAlerts(container)

        await expect(deliver()).rejects.toThrow(WRITE_FAILURE)

        expect(alerts(dunningCase.id, sessions[0].id)).toHaveLength(1)

        await deliver()

        await expectRetryRescheduledOnce(dunningCase.id, sessions[0].id)
      })
    })

    it("settles first and cancels afterwards, leaving the cancelled subscription without a renewal date, when an admin cancellation reaches a renewal its capture is settling", async () => {
      const container = getContainer()
      const subscriptions = subscriptionModule()
      const seeded = await seedAwaitingRenewal(container, {
        reference: "SUB-CANCELLED-WHILE-CAPTURED",
      })
      const payment = await captureOnOrder(container, seeded.order.id, seeded.session.id)
      const queued = nthLockRequest(container, renewalLockKey(seeded.subscription.id), 2)
      const cancellation: { done: Promise<unknown> } = { done: Promise.resolve() }
      const update = interceptOnce(
        subscriptions.updateSubscriptions.bind(subscriptions),
        (data) =>
          typeof data === "object" &&
          data !== null &&
          "next_renewal_at" in data &&
          data.next_renewal_at !== null,
        async () => {
          cancellation.done = cancelSubscriptionWorkflow(container).run({
            input: { id: seeded.subscription.id, reason: "customer left" },
          })
          await Promise.race([cancellation.done, queued])
        }
      )

      jest.spyOn(subscriptions, "updateSubscriptions").mockImplementation(update)

      await deliverCapture(container, payment.id)
      await cancellation.done

      const logsOf = async (eventType: ActivityLogEventType) =>
        await container
          .resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)
          .listSubscriptionLogs({ subscription_id: seeded.subscription.id, event_type: eventType })

      await expectSettled(seeded, seeded.attempt.id)
      expect(await logsOf(ActivityLogEventType.RENEWAL_FAILED)).toHaveLength(0)
      expect(await logsOf(ActivityLogEventType.RENEWAL_SUCCEEDED)).toHaveLength(1)
      expect(await subscriptions.retrieveSubscription(seeded.subscription.id)).toMatchObject({
        status: SubscriptionStatus.CANCELLED,
        next_renewal_at: null,
      })
    })

    it("raises the overdue alert for a renewal cycle left processing once, only past the limit, and keeps sweeping when one cycle cannot be read", async () => {
      const container = getContainer()
      const module = renewalModule()
      const seedProcessingCycle = async (reference: string, paymentReference: string | null) => {
        const subscription = await createSubscriptionSeed(container, { reference })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.PROCESSING,
          attempt_count: 1,
        })

        await createRenewalAttemptSeed(container, {
          renewal_cycle_id: cycle.id,
          payment_reference: paymentReference,
        })

        return { subscription, cycle }
      }
      const submitted = await seedProcessingCycle("SUB-PROCESSING-SUBMITTED", "payses_submitted")
      const unrecorded = await seedProcessingCycle("SUB-PROCESSING-NO-SESSION", null)
      const seededAt = Date.now()
      const sweepAt = (hoursAfterSubmission: number) =>
        atTime(seededAt + hoursAfterSubmission * HOUR_MS, () =>
          reconcileAwaitingRenewalCycles(container)
        )
      const retrieve = module.retrieveRenewalCycle.bind(module)
      const alerts = watchAlerts(container)
      const overdueCycleIds = () =>
        alerts()
          .filter((entry) => entry.event === AWAITING_PAYMENT_OVERDUE_EVENT)
          .map((entry) => entry.renewal_cycle_id)

      await sweepAt(DEFAULT_AWAITING_PAYMENT_ALERT_HOURS - 1)

      expect(overdueCycleIds()).toHaveLength(0)

      const unreadable = jest
        .spyOn(module, "retrieveRenewalCycle")
        .mockImplementation(async (id, ...rest) => {
          if (id === unrecorded.cycle.id) {
            throw new Error(WRITE_FAILURE)
          }

          return await retrieve(id, ...rest)
        })

      expect(await sweepAt(DEFAULT_AWAITING_PAYMENT_ALERT_HOURS + 1)).toMatchObject({
        processing_overdue: 1,
        failed: 1,
      })
      expect(overdueCycleIds()).toEqual([submitted.cycle.id])
      expect(alerts(unrecorded.cycle.id, WRITE_FAILURE)).toHaveLength(1)

      unreadable.mockRestore()
      await sweepAt(DEFAULT_AWAITING_PAYMENT_ALERT_HOURS + 2)

      expect(overdueCycleIds()).toEqual([submitted.cycle.id, unrecorded.cycle.id])

      for (const seeded of [submitted, unrecorded]) {
        expect(await readRenewalState(container, seeded)).toMatchObject({
          cycle: { status: RenewalCycleStatus.PROCESSING },
          attempts: [{ status: RenewalAttemptStatus.PROCESSING }],
        })
      }
    })

    it("leaves the approval fields of an awaiting cycle as they are when the next cycle is ensured", async () => {
      const container = getContainer()
      const seeded = await seedAwaitingRenewal(container, {
        reference: "SUB-AWAITING-WITH-PENDING-CHANGE",
      })

      await subscriptionModule().updateSubscriptions({
        id: seeded.subscription.id,
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
      await ensureNextRenewalCycleWorkflow(container).run({
        input: { subscription_id: seeded.subscription.id },
      })

      expect(await renewalModule().retrieveRenewalCycle(seeded.cycle.id)).toMatchObject({
        status: RenewalCycleStatus.AWAITING_PAYMENT,
        approval_required: false,
        approval_status: null,
      })
    })

    it("logs a forced run that parked as awaiting its payment, counting it neither succeeded nor failed", async () => {
      const container = getContainer()
      const { cycle } = await seedDueCharge("SUB-FORCED-RUN-PARKED")

      answerAuthorizationWithNull(container)
      const logs = watchLogs(container)

      await forceRenewalCycleWorkflow(container).run({
        input: { renewal_cycle_id: cycle.id, triggered_by: "user_forcing_the_run" },
      })

      expect(
        logs().filter(
          (entry) =>
            entry.event === "renewal.force" &&
            entry.renewal_cycle_id === cycle.id &&
            entry.outcome !== "started"
        )
      ).toEqual([
        expect.objectContaining({ outcome: "awaiting_payment", success_count: 0, failure_count: 0 }),
      ])
    })
  },
})
