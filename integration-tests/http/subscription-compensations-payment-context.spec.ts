import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import type {
  IPaymentModuleService,
  MedusaContainer,
  PaymentMethodDTO,
} from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  createStep,
  createWorkflow,
  type StepFunction,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { CANCELLATION_MODULE } from "../../src/modules/cancellation"
import type CancellationModuleService from "../../src/modules/cancellation/service"
import {
  CancellationCaseStatus,
  RetentionOfferType,
} from "../../src/modules/cancellation/types"
import { DUNNING_MODULE } from "../../src/modules/dunning"
import type DunningModuleService from "../../src/modules/dunning/service"
import { DunningCaseStatus } from "../../src/modules/dunning/types"
import { PlanOfferScope } from "../../src/modules/plan-offer/types"
import { RenewalCycleStatus } from "../../src/modules/renewal/types"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import {
  type SubscriptionPaymentContext,
  SubscriptionStatus,
} from "../../src/modules/subscription/types"
import { FrequencyInterval } from "../../src/common/types/frequency-interval"
import { activateSubscriptionIfAlreadyPaidStep } from "../../src/workflows/steps/activate-subscription-if-already-paid"
import { applyRetentionOfferStep } from "../../src/workflows/steps/apply-retention-offer"
import { cancelSubscriptionStep } from "../../src/workflows/steps/cancel-subscription"
import { finalizeCancellationStep } from "../../src/workflows/steps/finalize-cancellation"
import { markDunningRecoveredStep } from "../../src/workflows/steps/mark-dunning-recovered"
import { pauseSubscriptionStep } from "../../src/workflows/steps/pause-subscription"
import { resumeSubscriptionStep } from "../../src/workflows/steps/resume-subscription"
import { scheduleSubscriptionPlanChangeStep } from "../../src/workflows/steps/schedule-subscription-plan-change"
import { skipNextDeliveryStep } from "../../src/workflows/steps/skip-next-delivery"
import { startDunningStep } from "../../src/workflows/steps/start-dunning"
import { updateSubscriptionShippingAddressStep } from "../../src/workflows/steps/update-subscription-shipping-address"
import {
  createCancellationCaseSeed,
  createDunningCaseSeed,
  createRenewalCycleSeed,
} from "../helpers/cancellation-fixtures"
import {
  createPlanOfferSeed,
  createProductWithVariant,
  createSubscriptionSeed,
} from "../helpers/plan-offer-fixtures"

const LATER_STEP_FAILURE = "later step failed after the host wrote payment_context"

const paymentContextBefore: SubscriptionPaymentContext = {
  payment_provider_id: "pp_stripe_stripe",
  account_holder_id: "acch_before",
  payment_method_id: "pm_before",
}

const paymentContextFromHost: SubscriptionPaymentContext = {
  payment_provider_id: "pp_stripe_stripe",
  account_holder_id: "acch_host",
  payment_method_id: "pm_saved_by_host",
}

type SubscriptionRow = Awaited<
  ReturnType<SubscriptionModuleService["retrieveSubscription"]>
>

type HostWriteInput = {
  subscription_id: string
  payment_context: SubscriptionPaymentContext | null
}

let seenByHost: SubscriptionRow | null = null

const hostWritesPaymentContextThenFailsStep = createStep(
  "host-writes-payment-context-then-fails",
  async function (input: HostWriteInput, { container }) {
    const subscriptionModule =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

    seenByHost = await subscriptionModule.retrieveSubscription(
      input.subscription_id
    )

    if (input.payment_context) {
      await subscriptionModule.updateSubscriptions({
        id: input.subscription_id,
        payment_context: input.payment_context,
      })
    }

    throw new Error(LATER_STEP_FAILURE)
  }
)

function failingAfter<TStepInput>(
  workflowId: string,
  step: StepFunction<TStepInput, unknown>
) {
  return createWorkflow(
    workflowId,
    function (input: { step: TStepInput, host: HostWriteInput }) {
      step(input.step)
      hostWritesPaymentContextThenFailsStep(input.host)

      return new WorkflowResponse(undefined)
    }
  )
}

const pauseThenFail = failingAfter(
  "payment-context-guard-pause",
  pauseSubscriptionStep
)
const resumeThenFail = failingAfter(
  "payment-context-guard-resume",
  resumeSubscriptionStep
)
const cancelThenFail = failingAfter(
  "payment-context-guard-cancel",
  cancelSubscriptionStep
)
const skipThenFail = failingAfter(
  "payment-context-guard-skip",
  skipNextDeliveryStep
)
const planChangeThenFail = failingAfter(
  "payment-context-guard-plan-change",
  scheduleSubscriptionPlanChangeStep
)
const shippingAddressThenFail = failingAfter(
  "payment-context-guard-shipping-address",
  updateSubscriptionShippingAddressStep
)
const startDunningThenFail = failingAfter(
  "payment-context-guard-start-dunning",
  startDunningStep
)
const finalizeCancellationThenFail = failingAfter(
  "payment-context-guard-finalize-cancellation",
  finalizeCancellationStep
)
const applyRetentionOfferThenFail = failingAfter(
  "payment-context-guard-apply-retention-offer",
  applyRetentionOfferStep
)
const markDunningRecoveredThenFail = failingAfter(
  "payment-context-guard-mark-dunning-recovered",
  markDunningRecoveredStep
)
const activateIfPaidThenFail = failingAfter(
  "payment-context-guard-activate-if-paid",
  activateSubscriptionIfAlreadyPaidStep
)

async function seedSubscription(
  container: MedusaContainer,
  input: Parameters<typeof createSubscriptionSeed>[1] = {}
) {
  return await createSubscriptionSeed(container, {
    payment_context: paymentContextBefore,
    ...input,
  })
}

async function runToFailure<TStepInput>(
  workflow: ReturnType<typeof failingAfter<TStepInput>>,
  container: MedusaContainer,
  input: { step: TStepInput, host: HostWriteInput }
) {
  await expect(workflow(container).run({ input })).rejects.toMatchObject({
    message: LATER_STEP_FAILURE,
  })
}

function hostWrite(subscriptionId: string): HostWriteInput {
  return {
    subscription_id: subscriptionId,
    payment_context: paymentContextFromHost,
  }
}

async function reload(container: MedusaContainer, subscriptionId: string) {
  return await container
    .resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
    .retrieveSubscription(subscriptionId)
}

function stageCapturedCartPayment(
  container: MedusaContainer,
  input: {
    customer_id: string
    saved_methods: PaymentMethodDTO[]
  }
) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const originalGraph = query.graph.bind(query)
  const staged: Record<string, unknown[]> = {
    cart_payment_collection: [{ payment_collection_id: "paycol_staged" }],
    payment: [
      {
        id: "pay_staged",
        payment_collection_id: "paycol_staged",
        captured_at: new Date().toISOString(),
        canceled_at: null,
        amount: 2999,
        refunds: [],
      },
    ],
    customer: [
      {
        id: input.customer_id,
        account_holders: [
          {
            id: "acch_resolved",
            provider_id: paymentContextBefore.payment_provider_id,
            data: {},
          },
        ],
      },
    ],
  }

  jest.spyOn(query, "graph").mockImplementation(async (args: any) => {
    const rows = staged[args.entity]

    return rows ? ({ data: rows } as any) : originalGraph(args)
  })

  jest
    .spyOn(
      container.resolve<IPaymentModuleService>(Modules.PAYMENT),
      "listPaymentMethods"
    )
    .mockResolvedValue(input.saved_methods)
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: {
    JWT_SECRET: "supersecret",
    COOKIE_SECRET: "supersecret",
  },
  testSuite: ({ getContainer }) => {
    describe("subscription compensations and a payment_context written meanwhile", () => {
      beforeEach(() => {
        jest.restoreAllMocks()
        seenByHost = null
      })

      it("pause restores status, paused_at and metadata and keeps the host's payment_context", async () => {
        const container = getContainer()
        const subscription = await seedSubscription(container, {
          status: SubscriptionStatus.ACTIVE,
        })

        await runToFailure(pauseThenFail, container, {
          step: { id: subscription.id, reason: "holiday" },
          host: hostWrite(subscription.id),
        })

        expect(seenByHost?.status).toBe(SubscriptionStatus.PAUSED)
        expect(await reload(container, subscription.id)).toMatchObject({
          status: SubscriptionStatus.ACTIVE,
          paused_at: null,
          metadata: null,
          payment_context: paymentContextFromHost,
        })
      })

      it("resume restores status, next_renewal_at and metadata and keeps the host's payment_context", async () => {
        const container = getContainer()
        const subscription = await seedSubscription(container, {
          status: SubscriptionStatus.PAUSED,
        })

        await runToFailure(resumeThenFail, container, {
          step: {
            id: subscription.id,
            resume_at: "2031-01-15T10:00:00.000Z",
          },
          host: hostWrite(subscription.id),
        })

        expect(seenByHost?.status).toBe(SubscriptionStatus.ACTIVE)
        expect(await reload(container, subscription.id)).toMatchObject({
          status: SubscriptionStatus.PAUSED,
          next_renewal_at: subscription.next_renewal_at,
          metadata: null,
          payment_context: paymentContextFromHost,
        })
      })

      it("cancel restores status, cancellation dates, next_renewal_at and metadata and keeps the host's payment_context", async () => {
        const container = getContainer()
        const subscription = await seedSubscription(container, {
          status: SubscriptionStatus.ACTIVE,
        })

        await runToFailure(cancelThenFail, container, {
          step: { id: subscription.id, reason: "too expensive" },
          host: hostWrite(subscription.id),
        })

        expect(seenByHost?.status).toBe(SubscriptionStatus.CANCELLED)
        expect(await reload(container, subscription.id)).toMatchObject({
          status: SubscriptionStatus.ACTIVE,
          cancelled_at: null,
          cancel_effective_at: null,
          next_renewal_at: subscription.next_renewal_at,
          metadata: null,
          payment_context: paymentContextFromHost,
        })
      })

      it("skip restores skip_next_cycle and metadata and keeps the host's payment_context", async () => {
        const container = getContainer()
        const subscription = await seedSubscription(container, {
          status: SubscriptionStatus.ACTIVE,
        })

        await runToFailure(skipThenFail, container, {
          step: { id: subscription.id },
          host: hostWrite(subscription.id),
        })

        expect(seenByHost?.skip_next_cycle).toBe(true)
        expect(await reload(container, subscription.id)).toMatchObject({
          skip_next_cycle: false,
          metadata: null,
          payment_context: paymentContextFromHost,
        })
      })

      it("plan change restores pending_update_data and metadata and keeps the host's payment_context", async () => {
        const container = getContainer()
        const { product, variant } = await createProductWithVariant(container)
        await createPlanOfferSeed(container, {
          scope: PlanOfferScope.VARIANT,
          product_id: product.id,
          variant_id: variant.id,
          allowed_frequencies: [{ interval: FrequencyInterval.MONTH, value: 2 }],
        })
        const subscription = await seedSubscription(container, {
          status: SubscriptionStatus.ACTIVE,
          product_id: product.id,
          variant_id: variant.id,
        })

        await runToFailure(planChangeThenFail, container, {
          step: {
            id: subscription.id,
            variant_id: variant.id,
            frequency_interval: FrequencyInterval.MONTH,
            frequency_value: 2,
          },
          host: hostWrite(subscription.id),
        })

        expect(seenByHost?.pending_update_data).toMatchObject({
          frequency_value: 2,
        })
        expect(await reload(container, subscription.id)).toMatchObject({
          pending_update_data: null,
          metadata: null,
          payment_context: paymentContextFromHost,
        })
      })

      it("shipping address change restores the address and metadata and keeps the host's payment_context", async () => {
        const container = getContainer()
        const subscription = await seedSubscription(container, {
          status: SubscriptionStatus.ACTIVE,
        })

        await runToFailure(shippingAddressThenFail, container, {
          step: {
            id: subscription.id,
            first_name: "Anna",
            last_name: "Nowak",
            company: null,
            address_1: "Nowa 2",
            address_2: null,
            city: "Kraków",
            postal_code: "30-001",
            province: "Małopolskie",
            country_code: "PL",
            phone: null,
          },
          host: hostWrite(subscription.id),
        })

        expect(seenByHost?.shipping_address).toMatchObject({ city: "Kraków" })
        expect(await reload(container, subscription.id)).toMatchObject({
          shipping_address: subscription.shipping_address,
          metadata: null,
          payment_context: paymentContextFromHost,
        })
      })

      it("start dunning deletes its case, restores status and keeps the host's payment_context", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const subscription = await seedSubscription(container, {
          status: SubscriptionStatus.ACTIVE,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.FAILED,
        })

        await runToFailure(startDunningThenFail, container, {
          step: {
            subscription_id: subscription.id,
            renewal_cycle_id: cycle.id,
            payment_failure_source: "payment_provider",
            payment_error_message: "card declined",
          },
          host: hostWrite(subscription.id),
        })

        expect(seenByHost?.status).toBe(SubscriptionStatus.PAST_DUE)
        expect(
          await dunningModule.listDunningCases({ renewal_cycle_id: cycle.id })
        ).toEqual([])
        expect(await reload(container, subscription.id)).toMatchObject({
          status: SubscriptionStatus.ACTIVE,
          payment_context: paymentContextFromHost,
        })
      })

      it("finalize cancellation restores the case and the subscription and keeps the host's payment_context", async () => {
        const container = getContainer()
        const cancellationModule =
          container.resolve<CancellationModuleService>(CANCELLATION_MODULE)
        const subscription = await seedSubscription(container, {
          status: SubscriptionStatus.ACTIVE,
        })
        const cancellationCase = await createCancellationCaseSeed(container, {
          subscription_id: subscription.id,
          status: CancellationCaseStatus.REQUESTED,
          reason: "too expensive",
        })

        await runToFailure(finalizeCancellationThenFail, container, {
          step: {
            cancellation_case_id: cancellationCase.id,
            finalized_by: "customer",
          },
          host: hostWrite(subscription.id),
        })

        expect(seenByHost?.status).toBe(SubscriptionStatus.CANCELLED)
        expect(
          await cancellationModule.retrieveCancellationCase(cancellationCase.id)
        ).toMatchObject({
          status: CancellationCaseStatus.REQUESTED,
          final_outcome: null,
          finalized_at: null,
        })
        expect(await reload(container, subscription.id)).toMatchObject({
          status: SubscriptionStatus.ACTIVE,
          cancelled_at: null,
          cancel_effective_at: null,
          next_renewal_at: subscription.next_renewal_at,
          skip_next_cycle: false,
          metadata: null,
          payment_context: paymentContextFromHost,
        })
      })

      it("retention offer removes its event, restores the case and the subscription and keeps the host's payment_context", async () => {
        const container = getContainer()
        const cancellationModule =
          container.resolve<CancellationModuleService>(CANCELLATION_MODULE)
        const subscription = await seedSubscription(container, {
          status: SubscriptionStatus.ACTIVE,
        })
        const cancellationCase = await createCancellationCaseSeed(container, {
          subscription_id: subscription.id,
          status: CancellationCaseStatus.REQUESTED,
          reason: "too expensive",
        })

        await runToFailure(applyRetentionOfferThenFail, container, {
          step: {
            cancellation_case_id: cancellationCase.id,
            offer_type: RetentionOfferType.PAUSE_OFFER,
            offer_payload: {
              pause_offer: { pause_cycles: 1, resume_at: null, note: null },
            },
            decided_by: "admin",
          },
          host: hostWrite(subscription.id),
        })

        expect(seenByHost?.status).toBe(SubscriptionStatus.PAUSED)
        expect(
          await cancellationModule.listRetentionOfferEvents({
            cancellation_case_id: cancellationCase.id,
          })
        ).toEqual([])
        expect(
          await cancellationModule.retrieveCancellationCase(cancellationCase.id)
        ).toMatchObject({
          status: CancellationCaseStatus.REQUESTED,
          finalized_at: null,
        })
        expect(await reload(container, subscription.id)).toMatchObject({
          status: SubscriptionStatus.ACTIVE,
          paused_at: null,
          metadata: null,
          payment_context: paymentContextFromHost,
        })
      })

      it("mark dunning recovered restores the case and the past-due status and keeps the host's payment_context", async () => {
        const container = getContainer()
        const dunningModule =
          container.resolve<DunningModuleService>(DUNNING_MODULE)
        const subscription = await seedSubscription(container, {
          status: SubscriptionStatus.PAST_DUE,
        })
        const cycle = await createRenewalCycleSeed(container, {
          subscription_id: subscription.id,
          status: RenewalCycleStatus.FAILED,
        })
        const dunningCase = await createDunningCaseSeed(container, {
          subscription_id: subscription.id,
          renewal_cycle_id: cycle.id,
          status: DunningCaseStatus.RETRY_SCHEDULED,
        })

        await runToFailure(markDunningRecoveredThenFail, container, {
          step: { dunning_case_id: dunningCase.id, triggered_by: "admin" },
          host: hostWrite(subscription.id),
        })

        expect(seenByHost?.status).toBe(SubscriptionStatus.ACTIVE)
        expect(
          await dunningModule.retrieveDunningCase(dunningCase.id)
        ).toMatchObject({
          status: DunningCaseStatus.RETRY_SCHEDULED,
          recovered_at: null,
          closed_at: null,
        })
        expect(await reload(container, subscription.id)).toMatchObject({
          status: SubscriptionStatus.PAST_DUE,
          payment_context: paymentContextFromHost,
        })
      })

      describe("activate if already paid", () => {
        it("restores the payment_context it wrote when it resolved a saved method", async () => {
          const container = getContainer()
          const subscription = await seedSubscription(container, {
            status: SubscriptionStatus.PENDING_PAYMENT,
          })
          stageCapturedCartPayment(container, {
            customer_id: subscription.customer_id,
            saved_methods: [
              {
                id: "pm_resolved",
                provider_id: "pp_stripe_stripe",
                data: { created: 200 },
              },
            ],
          })

          await runToFailure(activateIfPaidThenFail, container, {
            step: {
              subscription_id: subscription.id,
              cart_id: subscription.cart_id!,
            },
            host: { subscription_id: subscription.id, payment_context: null },
          })

          expect(seenByHost).toMatchObject({
            status: SubscriptionStatus.ACTIVE,
            payment_context: { payment_method_id: "pm_resolved" },
          })
          expect(await reload(container, subscription.id)).toMatchObject({
            status: SubscriptionStatus.PENDING_PAYMENT,
            payment_context: paymentContextBefore,
          })
        })

        it("restores status and keeps the host's payment_context when it resolved no saved method", async () => {
          const container = getContainer()
          const subscription = await seedSubscription(container, {
            status: SubscriptionStatus.PENDING_PAYMENT,
          })
          stageCapturedCartPayment(container, {
            customer_id: subscription.customer_id,
            saved_methods: [],
          })

          await runToFailure(activateIfPaidThenFail, container, {
            step: {
              subscription_id: subscription.id,
              cart_id: subscription.cart_id!,
            },
            host: hostWrite(subscription.id),
          })

          expect(seenByHost).toMatchObject({
            status: SubscriptionStatus.ACTIVE,
            payment_context: paymentContextBefore,
          })
          expect(await reload(container, subscription.id)).toMatchObject({
            status: SubscriptionStatus.PENDING_PAYMENT,
            payment_context: paymentContextFromHost,
          })
        })
      })
    })
  },
})

jest.setTimeout(60 * 1000)
