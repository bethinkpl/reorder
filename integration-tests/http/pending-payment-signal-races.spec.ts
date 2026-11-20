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
import { reconcilePaidDunningCases } from "../../src/jobs/reconcile-paid-dunning-cases"
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
import { dunningCaseLockKey } from "../../src/modules/dunning/utils/lock-key"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import {
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../src/modules/renewal/types"
import { renewalSubscriptionLockKey } from "../../src/modules/renewal/utils/lock-key"
import {
  AWAITING_PAYMENT_OVERDUE_EVENT,
  DEFAULT_AWAITING_PAYMENT_ALERT_HOURS,
} from "../../src/modules/renewal/utils/awaiting-payment-age"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import {
  LatePaymentCapturedReason,
  SubscriptionEvents,
} from "../../src/modules/subscription/events"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import {
  cancelSubscriptionWorkflow,
  ensureNextRenewalCycleWorkflow,
  forceRenewalCycleWorkflow,
  RenewalRunOutcome,
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
  RENEWAL_AMOUNT,
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
        const delivery = failBeforeTheRunParks(renewalSubscriptionLockKey(seeded.subscription.id), "declined")

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
            await locking().release(renewalSubscriptionLockKey(seeded.subscription.id))
            await deliverFailure(container, sessionId, { reason: "declined" })

            return null as never
          })
        const alerts = watchAlerts(container)

        await expect(runRenewal(container, seeded.cycle.id)).resolves.toMatchObject({
          outcome: RenewalRunOutcome.FAILED,
          renewal_cycle: { status: RenewalCycleStatus.FAILED },
        })

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
        const delivery = failBeforeTheRunParks(dunningCaseLockKey(dunningCase.id), "insufficient_funds")

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

          await expect(runRenewal(container, seeded.cycle.id)).resolves.toMatchObject({
            outcome: RenewalRunOutcome.PARK_FAILED,
            renewal_cycle: null,
          })

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

      it.each([
        {
          name: "the cycle's wait",
          failWrite: () => failCycleWriteOnce(RenewalCycleStatus.AWAITING_PAYMENT),
        },
        {
          name: "the attempt's session",
          failWrite: failAttemptSessionWriteOnce,
        },
      ])(
        "settles on the sweep a renewal cycle left processing whose capture never arrived, when $name could not be recorded",
        async ({ failWrite }) => {
          const container = getContainer()
          const order = await createUnpaidOrder(container)
          const seeded = await seedDueCharge("SUB-RENEWAL-PARK-FAILURE-LOST-CAPTURE", order.id)

          answerAuthorizationWithNull(container)
          failWrite()

          await runRenewal(container, seeded.cycle.id)

          const inFlight = await readRenewalState(container, seeded)

          jest.restoreAllMocks()
          await captureOnOrder(container, order.id, seeded.sessionIds[0], { linkCollection: true })

          const sweepAfter = (minutes: number) =>
            atTime(new Date(inFlight.attempts[0].started_at).getTime() + minutes * 60 * 1000, () =>
              reconcileAwaitingRenewalCycles(container)
            )

          expect(await sweepAfter(5)).toMatchObject({ processing_settled: 0, failed: 0 })
          expect(await sweepAfter(11)).toMatchObject({ processing_settled: 1, failed: 0 })
          expect(await sweepAfter(12)).toMatchObject({ processing_settled: 0, failed: 0 })

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

    describe("a failure that arrives while another holder keeps the lock", () => {
      it("records a renewal failure on its attempt with a non-alertable entry, however often it is delivered, and the sweep fails the cycle into dunning once the lock is free", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, { reference: "SUB-FAILURE-WHILE-LOCKED" })
        const logs = watchLogs(container)
        const alerts = watchAlerts(container)

        await whileRenewalLockHeld(container, seeded.subscription.id, async () => {
          await deliverFailure(container, seeded.session.id, { reason: "declined" })
          await deliverFailure(container, seeded.session.id, { reason: "declined" })
        })

        expect(alerts(seeded.cycle.id)).toHaveLength(0)
        expect(
          logs({ event: "renewal.payment_failure_recorded", alertable: false, renewal_cycle_id: seeded.cycle.id })
        ).toHaveLength(2)

        const recorded = await readRenewalState(container, seeded)

        expect(recorded.cycle.status).toEqual(RenewalCycleStatus.AWAITING_PAYMENT)
        expect(recorded.attempts).toEqual([
          expect.objectContaining({
            id: seeded.attempt.id,
            status: RenewalAttemptStatus.PROCESSING,
            reported_payment_failure: expect.objectContaining({
              session_id: seeded.session.id,
              action: "failed",
              reason: "declined",
            }),
          }),
        ])
        expect(emitted(DunningEvents.STARTED)).toHaveLength(0)

        expect(await reconcileAwaitingRenewalCycles(container)).toMatchObject({
          recorded_failures_applied: 1,
          failed: 0,
        })
        expect(await reconcileAwaitingRenewalCycles(container)).toMatchObject({
          recorded_failures_applied: 0,
        })

        await expectFailedIntoDunning(seeded, {
          id: seeded.attempt.id,
          reported_payment_failure: null,
        })
      })

      it("records the failure of a charge a cancellation left in flight, and the sweep closes only its attempt as failed", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, {
          reference: "SUB-CLOSED-CYCLE-FAILURE-WHILE-LOCKED",
        })

        await cancelSubscriptionWorkflow(container).run({ input: { id: seeded.subscription.id } })
        await whileRenewalLockHeld(container, seeded.subscription.id, async () => {
          await deliverFailure(container, seeded.session.id, { reason: "declined" })
        })

        expect((await readRenewalState(container, seeded)).attempts).toEqual([
          expect.objectContaining({
            status: RenewalAttemptStatus.PROCESSING,
            reported_payment_failure: expect.objectContaining({ session_id: seeded.session.id }),
          }),
        ])

        expect(await reconcileAwaitingRenewalCycles(container)).toMatchObject({
          recorded_failures_applied: 1,
          failed: 0,
        })

        expect(await readRenewalState(container, seeded)).toMatchObject({
          attempts: [
            {
              status: RenewalAttemptStatus.FAILED,
              error_code: "declined",
              reported_payment_failure: null,
            },
          ],
          cases: [],
        })
        expect(emitted(DunningEvents.STARTED)).toHaveLength(0)
      })

      it("drops a recorded renewal failure once the renewal order has been paid, settling the cycle instead", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, {
          reference: "SUB-RECORDED-FAILURE-THEN-PAID",
        })

        await whileRenewalLockHeld(container, seeded.subscription.id, async () => {
          await deliverFailure(container, seeded.session.id, { reason: "declined" })
        })
        await captureOnOrder(container, seeded.order.id, seeded.session.id)

        expect(await reconcileAwaitingRenewalCycles(container)).toMatchObject({
          recorded_failures_applied: 0,
          settled: 1,
          failed: 0,
        })

        expect(await readRenewalState(container, seeded)).toMatchObject({
          cycle: { status: RenewalCycleStatus.SUCCEEDED },
          attempts: [
            { id: seeded.attempt.id, status: RenewalAttemptStatus.SUCCEEDED, reported_payment_failure: null },
          ],
          cases: [],
        })
      })

      it("records a retry failure on its attempt and the dunning sweep reschedules the case once when the lock is free", async () => {
        const container = getContainer()
        const { dunningCase } = await seedDunningCase(
          container,
          "SUB-RETRY-FAILURE-WHILE-LOCKED",
          DUE_FOR_RETRY
        )
        const sessions = routeRetrySessionsToFixture(container)

        answerAuthorizationWithNull(container)
        await runRetry(container, dunningCase.id)

        const logs = watchLogs(container)
        const alerts = watchAlerts(container)
        const ownerId = "dunning-holder"

        await locking().acquire(dunningCaseLockKey(dunningCase.id), { ownerId, expire: 60 })

        try {
          await deliverFailure(container, sessions[0].id, { reason: "insufficient_funds" })
          await deliverFailure(container, sessions[0].id, { reason: "insufficient_funds" })
        } finally {
          await locking().release(dunningCaseLockKey(dunningCase.id), { ownerId })
        }

        expect(alerts(dunningCase.id)).toHaveLength(0)
        expect(
          logs({ event: "dunning.payment_failure_recorded", alertable: false, dunning_case_id: dunningCase.id })
        ).toHaveLength(2)
        expect(await readDunningState(container, dunningCase.id)).toMatchObject({
          dunningCase: { status: DunningCaseStatus.AWAITING_PAYMENT },
          attempts: [
            {
              status: DunningAttemptStatus.PROCESSING,
              reported_payment_failure: expect.objectContaining({ session_id: sessions[0].id }),
            },
          ],
        })

        expect(await reconcilePaidDunningCases(container)).toMatchObject({
          recorded_failures_applied: 1,
          failed: 0,
        })
        expect(await reconcilePaidDunningCases(container)).toMatchObject({
          recorded_failures_applied: 0,
        })

        await expectRetryRescheduledOnce(dunningCase.id, sessions[0].id)
        expect(
          (await readDunningState(container, dunningCase.id)).attempts[0].reported_payment_failure
        ).toBeNull()
      })
    })

    describe("a capture that arrives while another holder has the renewal lock", () => {
      async function seedCapturedBehindLock(reference: string, cycleStatus: RenewalCycleStatus) {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, { reference, cycle_status: cycleStatus })
        const payment = await captureOnOrder(container, seeded.order.id, seeded.session.id)
        const lockKey = renewalSubscriptionLockKey(seeded.subscription.id)

        await locking().acquire(lockKey, { ownerId: reference, expire: 60 })
        releaseOnFirstRequest(container, lockKey, reference)

        return { ...seeded, payment }
      }

      it("leaves a processing renewal cycle to the holder without waiting for the lock or raising an alert, and the sweep settles it once its charge is ten minutes old", async () => {
        const container = getContainer()
        const seeded = await seedCapturedBehindLock(
          "SUB-PROCESSING-CAPTURE-WHILE-LOCKED",
          RenewalCycleStatus.PROCESSING
        )
        const before = await readRenewalState(container, seeded)
        const logs = watchLogs(container)
        const alerts = watchAlerts(container)
        const sweepAfter = (minutes: number) =>
          atTime(new Date(seeded.attempt.started_at).getTime() + minutes * 60 * 1000, () =>
            reconcileAwaitingRenewalCycles(container)
          )

        await deliverCapture(container, seeded.payment.id)

        expect(await readRenewalState(container, seeded)).toEqual(before)
        expect(before.cases).toHaveLength(0)
        expect(alerts(seeded.cycle.id)).toHaveLength(0)
        expect(
          logs({
            event: "renewal.awaiting_payment_settlement",
            alertable: false,
            renewal_cycle_id: seeded.cycle.id,
          })
        ).toEqual([expect.objectContaining({ message: expect.stringContaining("deferred to the awaiting-payment sweep") })])

        expect(await sweepAfter(5)).toMatchObject({ processing_settled: 0, failed: 0 })
        expect((await readRenewalState(container, seeded)).cycle.status).toEqual(
          RenewalCycleStatus.PROCESSING
        )

        expect(await sweepAfter(11)).toMatchObject({ processing_settled: 1, failed: 0 })

        await expectSettled(seeded, seeded.attempt.id)
        expect(alerts(seeded.cycle.id)).toHaveLength(0)
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
      const queued = nthLockRequest(container, renewalSubscriptionLockKey(seeded.subscription.id), 2)
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

    it("raises the overdue alert for a renewal cycle left processing once, only past the limit, and keeps sweeping when one cycle cannot be read under its lock", async () => {
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

      const readTimeout = "Query read timeout"
      let unrecordedReads = 0
      const unreadable = jest
        .spyOn(module, "retrieveRenewalCycle")
        .mockImplementation(async (id, ...rest) => {
          if (id === unrecorded.cycle.id && ++unrecordedReads === 2) {
            throw new Error(readTimeout)
          }

          return await retrieve(id, ...rest)
        })

      expect(await sweepAt(DEFAULT_AWAITING_PAYMENT_ALERT_HOURS + 1)).toMatchObject({
        processing_overdue: 1,
        failed: 1,
      })
      expect(overdueCycleIds()).toEqual([submitted.cycle.id])
      expect(alerts(unrecorded.cycle.id, readTimeout)).toHaveLength(1)

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

    it.each([
      {
        name: "parked",
        failWrite: () => undefined,
        leftAs: RenewalCycleStatus.AWAITING_PAYMENT,
        outcome: RenewalRunOutcome.AWAITING_PAYMENT,
      },
      {
        name: "could not record its wait",
        failWrite: () => failCycleWriteOnce(RenewalCycleStatus.AWAITING_PAYMENT),
        leftAs: RenewalCycleStatus.PROCESSING,
        outcome: RenewalRunOutcome.PARK_FAILED,
      },
    ])("logs a forced run that $name as $outcome, counting it neither succeeded nor failed", async ({ failWrite, leftAs, outcome }) => {
      const container = getContainer()
      const { cycle } = await seedDueCharge("SUB-FORCED-RUN-PARKED")

      answerAuthorizationWithNull(container)
      failWrite()
      const logs = watchLogs(container)

      await forceRenewalCycleWorkflow(container).run({
        input: { renewal_cycle_id: cycle.id, triggered_by: "user_forcing_the_run" },
      })

      expect((await renewalModule().retrieveRenewalCycle(cycle.id)).status).toEqual(leftAs)
      expect(
        logs().filter(
          (entry) =>
            entry.event === "renewal.force" &&
            entry.renewal_cycle_id === cycle.id &&
            entry.outcome !== "started"
        )
      ).toEqual([
        expect.objectContaining({ outcome, success_count: 0, failure_count: 0 }),
      ])
    })

    it("counts a scheduled run that could not record its wait as awaiting in the job, logging it as park_failed", async () => {
      const container = getContainer()
      const { cycle } = await seedDueCharge("SUB-JOB-RUN-PARK-FAILED")

      answerAuthorizationWithNull(container)
      failCycleWriteOnce(RenewalCycleStatus.AWAITING_PAYMENT)
      const logs = watchLogs(container)

      await processRenewalCyclesJob(container)

      expect(logs({ event: "renewal.job.cycle", renewal_cycle_id: cycle.id })).toEqual([
        expect.objectContaining({
          outcome: RenewalRunOutcome.PARK_FAILED,
          success_count: 0,
          failure_count: 0,
        }),
      ])
      expect(logs({ event: "renewal.job", outcome: "completed" })).toEqual([
        expect.objectContaining({ success_count: 0, failure_count: 0, awaiting_count: 1 }),
      ])
    })

    describe("a renewal order paid more than once", () => {
      it("settles the cycle and reports the renewal charge once as over-payment when the customer paid the order while the charge was in flight", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, { reference: "SUB-OVERPAID-RENEWAL" })
        const customer = await createPaymentSessionFixture(container, { amount: AWAITING_ORDER_TOTAL })
        const customerPayment = await captureOnOrder(container, seeded.order.id, customer.session.id, {
          linkCollection: true,
        })

        await deliverCapture(container, customerPayment.id)

        const renewalPayment = await captureOnOrder(container, seeded.order.id, seeded.session.id)
        const emitted = watchEvents(container)

        await deliverCapture(container, renewalPayment.id)
        await deliverCapture(container, renewalPayment.id)

        const state = await readRenewalState(container, seeded)

        expect(state.cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(state.attempts).toEqual([
          expect.objectContaining({ id: seeded.attempt.id, status: RenewalAttemptStatus.SUCCEEDED }),
        ])
        expect(emitted(SubscriptionEvents.LATE_PAYMENT_CAPTURED).map((message) => message.data)).toEqual([
          {
            subscription_id: seeded.subscription.id,
            payment_id: renewalPayment.id,
            order_id: seeded.order.id,
            payment_collection_id: seeded.session.payment_collection_id,
            renewal_cycle_id: seeded.cycle.id,
            reason: LatePaymentCapturedReason.ORDER_OVERPAID,
            refund_amount: AWAITING_ORDER_TOTAL,
            currency_code: "pln",
          },
        ])
      })

      it("asks for a cancelled subscription's capture less what was already refunded on it", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, { reference: "SUB-LATE-CAPTURE-PART-REFUNDED" })

        await cancelSubscriptionWorkflow(container).run({ input: { id: seeded.subscription.id } })

        const payment = await captureOnOrder(container, seeded.order.id, seeded.session.id)

        await paymentModule().refundPayment({ payment_id: payment.id, amount: 30 })

        const emitted = watchEvents(container)

        await deliverCapture(container, payment.id)

        expect(emitted(SubscriptionEvents.LATE_PAYMENT_CAPTURED).map((message) => message.data)).toEqual([
          expect.objectContaining({
            payment_id: payment.id,
            reason: LatePaymentCapturedReason.SUBSCRIPTION_TERMINAL,
            refund_amount: AWAITING_ORDER_TOTAL - 30,
            currency_code: "pln",
          }),
        ])
      })

      it("never asks for more of an over-paying capture than is left unrefunded on it", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, { reference: "SUB-OVERPAID-MOSTLY-REFUNDED" })
        const customer = await createPaymentSessionFixture(container, { amount: AWAITING_ORDER_TOTAL })
        const customerPayment = await captureOnOrder(container, seeded.order.id, customer.session.id, {
          linkCollection: true,
        })

        await deliverCapture(container, customerPayment.id)

        const renewalPayment = await captureOnOrder(container, seeded.order.id, seeded.session.id)

        await paymentModule().refundPayment({ payment_id: renewalPayment.id, amount: 80 })

        const emitted = watchEvents(container)

        await deliverCapture(container, renewalPayment.id)

        expect(emitted(SubscriptionEvents.LATE_PAYMENT_CAPTURED).map((message) => message.data)).toEqual([
          expect.objectContaining({
            payment_id: renewalPayment.id,
            reason: LatePaymentCapturedReason.ORDER_OVERPAID,
            refund_amount: AWAITING_ORDER_TOTAL - 80,
            currency_code: "pln",
          }),
        ])
      })

      it("asks for only the surplus of a capture that over-pays the order, and still reports a later capture that surplus leaves unclaimed", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, { reference: "SUB-OVERPAID-PARTLY" })
        const customer = await createPaymentSessionFixture(container, { amount: 40 })
        const customerPayment = await captureOnOrder(container, seeded.order.id, customer.session.id, {
          linkCollection: true,
        })

        await deliverCapture(container, customerPayment.id)

        const renewalPayment = await captureOnOrder(container, seeded.order.id, seeded.session.id)
        const emitted = watchEvents(container)

        await deliverCapture(container, renewalPayment.id)

        const late = await createPaymentSessionFixture(container, {
          amount: 25,
          context: { renewal_cycle_id: seeded.cycle.id },
        })

        await createRenewalAttemptSeed(container, {
          renewal_cycle_id: seeded.cycle.id,
          attempt_no: 2,
          status: RenewalAttemptStatus.FAILED,
          error_code: "declined",
          payment_reference: late.session.id,
          order_id: seeded.order.id,
        })

        const latePayment = await captureOnOrder(container, seeded.order.id, late.session.id, {
          linkCollection: true,
        })

        await deliverCapture(container, latePayment.id)
        await deliverCapture(container, latePayment.id)

        expect((await readRenewalState(container, seeded)).cycle.status).toEqual(
          RenewalCycleStatus.SUCCEEDED
        )
        expect(emitted(SubscriptionEvents.LATE_PAYMENT_CAPTURED).map((message) => message.data)).toEqual([
          expect.objectContaining({
            payment_id: renewalPayment.id,
            reason: LatePaymentCapturedReason.ORDER_OVERPAID,
            refund_amount: 40,
            currency_code: "pln",
          }),
          expect.objectContaining({
            payment_id: latePayment.id,
            reason: LatePaymentCapturedReason.CYCLE_CLOSED,
            refund_amount: 25,
            currency_code: "pln",
          }),
        ])
      })

      it("never reports a capture of a failed renewal attempt that its dunning case applied, even when it is delivered again after the subscription was cancelled", async () => {
        const container = getContainer()
        const seeded = await seedDunningCase(container, "SUB-APPLIED-THEN-CANCELLED")
        const renewalSession = await createPaymentSessionFixture(container, {
          amount: RENEWAL_AMOUNT,
          context: { renewal_cycle_id: seeded.cycle.id },
        })

        await createRenewalAttemptSeed(container, {
          renewal_cycle_id: seeded.cycle.id,
          status: RenewalAttemptStatus.FAILED,
          error_code: "resolved_unpaid",
          payment_reference: renewalSession.session.id,
          order_id: seeded.order.id,
        })

        const payment = await captureOnOrder(container, seeded.order.id, renewalSession.session.id, {
          linkCollection: true,
        })
        const emitted = watchEvents(container)

        await deliverCapture(container, payment.id)

        expect((await readDunningState(container, seeded.dunningCase.id)).dunningCase).toMatchObject({
          status: DunningCaseStatus.RECOVERED,
          recovery_reason: "customer_payment",
        })

        await cancelSubscriptionWorkflow(container).run({ input: { id: seeded.subscription.id } })
        await deliverCapture(container, payment.id)

        expect(emitted(SubscriptionEvents.LATE_PAYMENT_CAPTURED)).toHaveLength(0)
      })

      it("reports one of two tracked captures landing together on one order as the surplus, never both", async () => {
        const container = getContainer()
        const seeded = await seedDunningCase(container, "SUB-OVERPAID-TWICE-TRACKED")
        const renewalSession = await createPaymentSessionFixture(container, {
          amount: RENEWAL_AMOUNT,
          context: { renewal_cycle_id: seeded.cycle.id },
        })

        await createRenewalAttemptSeed(container, {
          renewal_cycle_id: seeded.cycle.id,
          status: RenewalAttemptStatus.FAILED,
          error_code: "resolved_unpaid",
          payment_reference: renewalSession.session.id,
          order_id: seeded.order.id,
        })

        const retryPayment = await captureOnOrder(container, seeded.order.id, seeded.attempts[0].session.id)
        const renewalPayment = await captureOnOrder(container, seeded.order.id, renewalSession.session.id, {
          linkCollection: true,
        })
        const emitted = watchEvents(container)
        const deliverBoth = () =>
          Promise.all([deliverCapture(container, retryPayment.id), deliverCapture(container, renewalPayment.id)])

        await deliverBoth()
        await deliverBoth()

        const reported = emitted(SubscriptionEvents.LATE_PAYMENT_CAPTURED).map((message) => message.data)

        expect(reported).toEqual([
          expect.objectContaining({
            subscription_id: seeded.subscription.id,
            order_id: seeded.order.id,
            payment_id: expect.stringMatching(new RegExp(`^(${retryPayment.id}|${renewalPayment.id})$`)),
            refund_amount: RENEWAL_AMOUNT,
            currency_code: "pln",
          }),
        ])
        expect((await readDunningState(container, seeded.dunningCase.id)).dunningCase.status).toEqual(
          DunningCaseStatus.RECOVERED
        )
      })
    })
  },
})
