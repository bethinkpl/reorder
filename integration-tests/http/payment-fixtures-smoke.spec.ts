import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import type { IPaymentModuleService } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { DUNNING_MODULE } from "../../src/modules/dunning"
import DunningModuleService from "../../src/modules/dunning/service"
import { DunningCaseStatus } from "../../src/modules/dunning/types"
import { RENEWAL_MODULE } from "../../src/modules/renewal"
import RenewalModuleService from "../../src/modules/renewal/service"
import { RenewalCycleStatus } from "../../src/modules/renewal/types"
import {
  SYSTEM_PAYMENT_PROVIDER_ID,
  authorizeAndCapturePaymentSession,
  createPaymentSessionFixture,
} from "../helpers/payment-fixtures"

jest.setTimeout(60 * 1000)

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ getContainer }) => {
    describe("awaiting payment state", () => {
      it("persists the awaiting_payment status and settlement inputs through the real migrations", async () => {
        const container = getContainer()
        const renewalModule =
          container.resolve<RenewalModuleService>(RENEWAL_MODULE)
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const settlementInputs = {
          attempt_id: "renatt_smoke_001",
          audit: { provider: "async_provider", session_id: "payses_smoke_001" },
        }

        const cycle = await renewalModule.createRenewalCycles({
          subscription_id: "sub_smoke_001",
          scheduled_for: new Date("2026-03-30T12:00:00.000Z"),
          status: RenewalCycleStatus.AWAITING_PAYMENT,
          settlement_inputs: settlementInputs,
        })
        const dunningCase = await dunningModule.createDunningCases({
          subscription_id: "sub_smoke_001",
          renewal_cycle_id: cycle.id,
          status: DunningCaseStatus.AWAITING_PAYMENT,
          max_attempts: 3,
        })

        const storedCycle = await renewalModule.retrieveRenewalCycle(cycle.id)
        const storedCase = await dunningModule.retrieveDunningCase(
          dunningCase.id
        )

        expect(storedCycle.status).toEqual(RenewalCycleStatus.AWAITING_PAYMENT)
        expect(storedCycle.settlement_inputs).toEqual(settlementInputs)
        expect(storedCase.status).toEqual(DunningCaseStatus.AWAITING_PAYMENT)
      })
    })

    describe("payment fixtures", () => {
      it("creates a session carrying the given context and captures it into a payment", async () => {
        const container = getContainer()
        const paymentModule = container.resolve<IPaymentModuleService>(
          Modules.PAYMENT
        )
        const context = {
          dunning_case_id: "dunc_fixture_001",
          dunning_attempt_id: "dunatt_fixture_001",
        }

        const { collection, session } = await createPaymentSessionFixture(
          container,
          { amount: 129, context }
        )
        const stored = await paymentModule.retrievePaymentSession(session.id)

        expect(stored.provider_id).toEqual(SYSTEM_PAYMENT_PROVIDER_ID)
        expect(stored.payment_collection_id).toEqual(collection.id)
        expect(stored.context).toEqual(context)

        const payment = await authorizeAndCapturePaymentSession(
          container,
          session.id
        )

        expect(payment.captured_at).toBeTruthy()
        expect(Number(payment.amount)).toEqual(129)
        expect(payment.payment_session?.id ?? session.id).toEqual(session.id)
      })
    })
  },
})
