import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import type { Logger, MedusaContainer } from "@medusajs/framework/types"
import { MedusaError, PaymentSessionStatus } from "@medusajs/framework/utils"
import { ACTIVITY_LOG_MODULE } from "../../src/modules/activity-log"
import type ActivityLogModuleService from "../../src/modules/activity-log/service"
import { ActivityLogEventType } from "../../src/modules/activity-log/types"
import { DunningCaseStatus } from "../../src/modules/dunning/types"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import type RenewalModuleService from "../../src/modules/renewal/service"
import {
  RenewalAttemptStatus,
  RenewalCycleStatus,
} from "../../src/modules/renewal/types"
import { renewalErrors } from "../../src/modules/renewal/utils/errors"
import {
  classifyRenewalFailure,
  isAlertableRenewalFailure,
} from "../../src/modules/renewal/utils/observability"
import processRenewalCyclesJob, {
  isBlockedRenewalOutcome,
} from "../../src/jobs/process-renewal-cycles"
import {
  forceRenewalCycleWorkflow,
  processRenewalCycleWorkflow,
} from "../../src/workflows"
import { createDunningCaseSeed } from "../helpers/dunning-fixtures"
import { createPaymentSessionFixture } from "../helpers/payment-fixtures"
import {
  answerAuthorizationWithNull,
  createRenewalChargeStub,
  RENEWAL_AMOUNT,
} from "../helpers/renewal-charge-fixtures"
import {
  createRenewalAttemptSeed,
  createRenewalCycleSeed,
  createSubscriptionSeed,
} from "../helpers/renewal-fixtures"

const ACTIVE_CASE_STATUSES = [
  DunningCaseStatus.OPEN,
  DunningCaseStatus.RETRY_SCHEDULED,
  DunningCaseStatus.RETRYING,
  DunningCaseStatus.AWAITING_PAYMENT,
  DunningCaseStatus.AWAITING_MANUAL_RESOLUTION,
]

const CLOSED_CASE_STATUSES = [
  DunningCaseStatus.RECOVERED,
  DunningCaseStatus.UNRECOVERED,
]

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

const stubRenewalCharge = createRenewalChargeStub({
  createOrderRun: mockCreateOrderRun,
  createOrUpdateOrderPaymentCollectionRun:
    mockCreateOrUpdateOrderPaymentCollectionRun,
  createPaymentSessionsRun: mockCreatePaymentSessionsRun,
})

function spyOnJobCycleLog(container: MedusaContainer) {
  const logger = container.resolve<Logger>("logger")
  const spies = [
    jest.spyOn(logger, "info"),
    jest.spyOn(logger, "warn"),
    jest.spyOn(logger, "error"),
  ]

  return function entries(event: string) {
    return spies
      .flatMap((spy) => spy.mock.calls.map(([line]) => String(line)))
      .flatMap((line) => {
        try {
          const entry = JSON.parse(line)

          return entry?.event === event ? [entry] : []
        } catch {
          return []
        }
      })
  }
}

async function seedFailedCycle(
  container: MedusaContainer,
  reference: string,
  dueAt: Date
) {
  const subscription = await createSubscriptionSeed(container, {
    reference,
    next_renewal_at: dueAt,
  })
  const cycle = await createRenewalCycleSeed(container, {
    subscription_id: subscription.id,
    scheduled_for: dueAt,
    status: RenewalCycleStatus.FAILED,
    attempt_count: 1,
    last_error: "card declined",
  })

  return { subscription, cycle }
}

async function seedCase(
  container: MedusaContainer,
  input: {
    subscription_id: string
    renewal_cycle_id: string
    status: DunningCaseStatus
  }
) {
  return await createDunningCaseSeed(container, {
    ...input,
    renewal_order_id: "ord_dunning_owns_001",
  })
}

function runScheduled(container: MedusaContainer, renewalCycleId: string) {
  return processRenewalCycleWorkflow(container)
    .run({
      input: {
        renewal_cycle_id: renewalCycleId,
        trigger_type: "scheduler",
      },
    })
    .catch((error: unknown) => error)
}

function expectBlockedRefusal(error: unknown, expectedMessage: string) {
  expect(error).toMatchObject({ type: MedusaError.Types.CONFLICT })

  const kind = classifyRenewalFailure(error)

  expect(isBlockedRenewalOutcome(kind)).toBe(true)
  expect(isAlertableRenewalFailure(kind)).toBe(false)
  expect(error).toMatchObject({ message: expectedMessage })
}

async function expectUntouched(
  container: MedusaContainer,
  renewalCycleId: string
) {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const cycle = await renewalModule.retrieveRenewalCycle(renewalCycleId)
  const attempts = await renewalModule.listRenewalAttempts({
    renewal_cycle_id: renewalCycleId,
  })

  expect(cycle).toMatchObject({
    status: RenewalCycleStatus.FAILED,
    attempt_count: 1,
  })
  expect(attempts).toHaveLength(1)
}

function expectNothingCreated() {
  expect(mockCreateOrderRun).not.toHaveBeenCalled()
  expect(mockCreatePaymentSessionsRun).not.toHaveBeenCalled()
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ getContainer }) => {
    describe("failed renewal cycles owned by dunning or by their own pending payment", () => {
      beforeEach(() => {
        jest.restoreAllMocks()
        jest.clearAllMocks()
      })

      it("counts and logs a run that parks a cycle as awaiting, not as a success or a failure", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const dueAt = new Date(Date.now() - 60 * 60 * 1000)
        const subscription = await createSubscriptionSeed(container, {
          reference: "SUB-RC5-JOB-PARK-001",
          next_renewal_at: dueAt,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          scheduled_for: dueAt,
        })

        stubRenewalCharge(container, {
          subscription,
          order_id: "ord_rc5_job_park_001",
        })
        answerAuthorizationWithNull(container)
        const entries = spyOnJobCycleLog(container)

        await processRenewalCyclesJob(container)

        const parked = await renewalModule.retrieveRenewalCycle(cycle.id)
        const cycleEntries = entries("renewal.job.cycle").filter(
          (entry) => entry.renewal_cycle_id === cycle.id
        )
        const summaries = entries("renewal.job").filter(
          (entry) => entry.outcome === "completed"
        )

        expect(parked.status).toEqual(RenewalCycleStatus.AWAITING_PAYMENT)
        expect(cycleEntries).toHaveLength(1)
        expect(cycleEntries[0]).toMatchObject({
          outcome: "awaiting_payment",
          success_count: 0,
          failure_count: 0,
        })
        expect(summaries).toHaveLength(1)
        expect(summaries[0]).toMatchObject({
          success_count: 0,
          failure_count: 0,
          blocked_count: 0,
          awaiting_count: 1,
        })
      })

      it("reports a failed cycle owned by dunning as blocked in the job, not as a failure", async () => {
        const container = getContainer()
        const dueAt = new Date(Date.now() - 60 * 60 * 1000)
        const { subscription, cycle } = await seedFailedCycle(
          container,
          "SUB-RC5-JOB-BLOCK-001",
          dueAt
        )
        await createRenewalAttemptSeed(container, {
          renewal_cycle_id: cycle.id,
          status: RenewalAttemptStatus.FAILED,
        })
        await seedCase(container, {
          subscription_id: subscription.id,
          renewal_cycle_id: cycle.id,
          status: DunningCaseStatus.RETRY_SCHEDULED,
        })

        stubRenewalCharge(container, {
          subscription,
          order_id: "ord_rc5_job_block_001",
        })
        const entries = spyOnJobCycleLog(container)

        await processRenewalCyclesJob(container)

        const cycleEntries = entries("renewal.job.cycle").filter(
          (entry) => entry.renewal_cycle_id === cycle.id
        )
        const summaries = entries("renewal.job").filter(
          (entry) => entry.outcome === "completed"
        )

        expect(cycleEntries).toHaveLength(1)
        expect(cycleEntries[0]).toMatchObject({
          outcome: "blocked",
          alertable: false,
        })
        expect(summaries[0]).toMatchObject({
          success_count: 0,
          failure_count: 0,
          blocked_count: 1,
        })
        await expectUntouched(container, cycle.id)
        expectNothingCreated()
      })

      it("skips a failed cycle for every active dunning case status without a new attempt, order or payment session", async () => {
        const container = getContainer()
        for (const status of ACTIVE_CASE_STATUSES) {
          jest.restoreAllMocks()
          jest.clearAllMocks()

          const { subscription, cycle } = await seedFailedCycle(
            container,
            `SUB-RC5-ACTIVE-${status}`,
            new Date("2026-06-01T10:00:00.000Z")
          )
          await createRenewalAttemptSeed(container, {
            renewal_cycle_id: cycle.id,
            status: RenewalAttemptStatus.FAILED,
          })
          await seedCase(container, {
            subscription_id: subscription.id,
            renewal_cycle_id: cycle.id,
            status,
          })
          stubRenewalCharge(container, {
            subscription,
            order_id: `ord_rc5_active_${status}`,
          })

          const error = await runScheduled(container, cycle.id)

          expectBlockedRefusal(
            error,
            renewalErrors.dunningOwnsCycle(cycle.id).message
          )
          await expectUntouched(container, cycle.id)
          expectNothingCreated()
        }
      })

      it("re-runs a failed cycle whose dunning case is closed", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        for (const status of CLOSED_CASE_STATUSES) {
          jest.restoreAllMocks()
          jest.clearAllMocks()

          const dueAt = new Date("2026-06-02T10:00:00.000Z")
          const { subscription, cycle } = await seedFailedCycle(
            container,
            `SUB-RC5-CLOSED-${status}`,
            dueAt
          )
          await createRenewalAttemptSeed(container, {
            renewal_cycle_id: cycle.id,
            status: RenewalAttemptStatus.FAILED,
          })
          await seedCase(container, {
            subscription_id: subscription.id,
            renewal_cycle_id: cycle.id,
            status,
          })
          stubRenewalCharge(container, {
            subscription,
            order_id: `ord_rc5_closed_${status}`,
          })

          const result = await runScheduled(container, cycle.id)

          const after = await renewalModule.retrieveRenewalCycle(cycle.id)
          const attempts = await renewalModule.listRenewalAttempts({
            renewal_cycle_id: cycle.id,
          })

          expect(result).not.toBeInstanceOf(Error)
          expect(after.status).toEqual(RenewalCycleStatus.SUCCEEDED)
          expect(attempts).toHaveLength(2)
        }
      })

      it("re-runs a failed cycle that has no dunning case", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const { subscription, cycle } = await seedFailedCycle(
          container,
          "SUB-RC5-NOCASE-001",
          new Date("2026-06-03T10:00:00.000Z")
        )
        await createRenewalAttemptSeed(container, {
          renewal_cycle_id: cycle.id,
          status: RenewalAttemptStatus.FAILED,
        })
        stubRenewalCharge(container, {
          subscription,
          order_id: "ord_rc5_nocase_001",
        })

        const result = await runScheduled(container, cycle.id)

        const after = await renewalModule.retrieveRenewalCycle(cycle.id)
        const attempts = await renewalModule.listRenewalAttempts({
          renewal_cycle_id: cycle.id,
        })

        expect(result).not.toBeInstanceOf(Error)
        expect(after.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(attempts).toHaveLength(2)
      })

      it("re-runs a failed cycle with no dunning case while its latest attempt's payment session is still pending", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)

        const { subscription, cycle } = await seedFailedCycle(
          container,
          "SUB-RC5-PENDING-001",
          new Date("2026-06-04T10:00:00.000Z")
        )
        const { session } = await createPaymentSessionFixture(container, {
          amount: RENEWAL_AMOUNT,
          context: { renewal_cycle_id: cycle.id },
        })
        await createRenewalAttemptSeed(container, {
          renewal_cycle_id: cycle.id,
          status: RenewalAttemptStatus.FAILED,
          payment_reference: session.id,
        })
        stubRenewalCharge(container, {
          subscription,
          order_id: "ord_rc5_pending_001",
        })

        const result = await runScheduled(container, cycle.id)

        const after = await renewalModule.retrieveRenewalCycle(cycle.id)
        const attempts = await renewalModule.listRenewalAttempts({
          renewal_cycle_id: cycle.id,
        })

        expect(session.status).toEqual(PaymentSessionStatus.PENDING)
        expect(result).not.toBeInstanceOf(Error)
        expect(after.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(attempts).toHaveLength(2)
      })

      it("refuses forced and manual runs of a failed cycle owned by dunning", async () => {
        const container = getContainer()
        const { subscription, cycle } = await seedFailedCycle(
          container,
          "SUB-RC5-FORCE-001",
          new Date("2026-06-05T10:00:00.000Z")
        )
        await createRenewalAttemptSeed(container, {
          renewal_cycle_id: cycle.id,
          status: RenewalAttemptStatus.FAILED,
        })
        await seedCase(container, {
          subscription_id: subscription.id,
          renewal_cycle_id: cycle.id,
          status: DunningCaseStatus.AWAITING_PAYMENT,
        })
        stubRenewalCharge(container, {
          subscription,
          order_id: "ord_rc5_force_001",
        })
        const entries = spyOnJobCycleLog(container)

        const forceError = await forceRenewalCycleWorkflow(container)
          .run({
            input: { renewal_cycle_id: cycle.id, triggered_by: "admin_rc5" },
          })
          .catch((error: unknown) => error)
        const manualError = await processRenewalCycleWorkflow(container)
          .run({
            input: {
              renewal_cycle_id: cycle.id,
              trigger_type: "manual",
              triggered_by: "admin_rc5",
            },
          })
          .catch((error: unknown) => error)

        const expectedMessage = renewalErrors.dunningOwnsCycle(cycle.id).message

        expectBlockedRefusal(forceError, expectedMessage)
        expectBlockedRefusal(manualError, expectedMessage)
        await expectUntouched(container, cycle.id)
        expectNothingCreated()

        const activityLogModule =
          container.resolve<ActivityLogModuleService>(ACTIVITY_LOG_MODULE)
        const forceEntries = await activityLogModule.listSubscriptionLogs({
          subscription_id: subscription.id,
          event_type: ActivityLogEventType.RENEWAL_FORCE_REQUESTED,
        })
        const forceOutcomes = entries("renewal.force").filter(
          (entry) => entry.outcome !== "started"
        )

        expect(forceEntries).toHaveLength(0)
        expect(forceOutcomes).toHaveLength(1)
        expect(forceOutcomes[0]).toMatchObject({
          outcome: "blocked",
          failure_kind: "dunning_owns_cycle",
          alertable: false,
        })
      })
    })
  },
})

jest.setTimeout(120 * 1000)
