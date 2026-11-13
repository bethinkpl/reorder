import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import type { IPaymentModuleService, MedusaContainer, PaymentMethodDTO } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { createStep, createWorkflow, type StepFunction, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { CANCELLATION_MODULE } from "../../src/modules/cancellation"
import type CancellationModuleService from "../../src/modules/cancellation/service"
import { CancellationCaseStatus, RetentionOfferType } from "../../src/modules/cancellation/types"
import { DUNNING_MODULE } from "../../src/modules/dunning"
import type DunningModuleService from "../../src/modules/dunning/service"
import { DunningCaseStatus } from "../../src/modules/dunning/types"
import { PlanOfferScope } from "../../src/modules/plan-offer/types"
import { RenewalCycleStatus } from "../../src/modules/renewal/types"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { type SubscriptionPaymentContext, SubscriptionStatus } from "../../src/modules/subscription/types"
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
import { createCancellationCaseSeed, createDunningCaseSeed, createRenewalCycleSeed } from "../helpers/cancellation-fixtures"
import { createPlanOfferSeed, createProductWithVariant, createSubscriptionSeed } from "../helpers/plan-offer-fixtures"

const LATER_STEP_FAILURE = "later step failed after the host wrote payment_context"
const PROVIDER_ID = "pp_stripe_stripe"

const contextBefore: SubscriptionPaymentContext = {
  payment_provider_id: PROVIDER_ID,
  account_holder_id: "acch_before",
  payment_method_id: "pm_before",
}
const contextFromHost: SubscriptionPaymentContext = {
  payment_provider_id: PROVIDER_ID,
  account_holder_id: "acch_host",
  payment_method_id: "pm_saved_by_host",
}
const requestedCase = { status: CancellationCaseStatus.REQUESTED, final_outcome: null, finalized_at: null }

type Subscription = Awaited<ReturnType<typeof createSubscriptionSeed>>
type HostWrite = { subscription_id: string, payment_context: SubscriptionPaymentContext | null }
type Arranged<T> = { input: T, verify?: () => Promise<void> }

type Scenario = {
  name: string
  status?: SubscriptionStatus
  seed?: (container: MedusaContainer) => Promise<Parameters<typeof createSubscriptionSeed>[1]>
  hostWrites?: boolean
  seen: Record<string, unknown>
  restores: (keyof Subscription)[]
  failAfterStep: (container: MedusaContainer, subscription: Subscription) => Promise<void>
}

let seenByHost: Subscription | null = null

const subscriptions = (container: MedusaContainer) =>
  container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
const cancellations = (container: MedusaContainer) =>
  container.resolve<CancellationModuleService>(CANCELLATION_MODULE)
const dunning = (container: MedusaContainer) => container.resolve<DunningModuleService>(DUNNING_MODULE)

const hostWritesPaymentContextThenFailsStep = createStep(
  "host-writes-payment-context-then-fails",
  async function ({ subscription_id: id, payment_context }: HostWrite, { container }) {
    seenByHost = await subscriptions(container).retrieveSubscription(id)

    if (payment_context) {
      await subscriptions(container).updateSubscriptions({ id, payment_context })
    }

    throw new Error(LATER_STEP_FAILURE)
  }
)

function scenario<T>(
  name: string,
  step: StepFunction<T, unknown>,
  spec: Omit<Scenario, "name" | "failAfterStep"> & {
    arrange: (subscription: Subscription, container: MedusaContainer) => Arranged<T> | Promise<Arranged<T>>
  }
): Scenario {
  const workflow = createWorkflow(
    `payment-context-guard-${name.replace(/\W+/g, "-")}`,
    function (input: { step: T, host: HostWrite }) {
      step(input.step)
      hostWritesPaymentContextThenFailsStep(input.host)

      return new WorkflowResponse(undefined)
    }
  )

  return {
    ...spec,
    name,
    failAfterStep: async (container, subscription) => {
      const { input, verify } = await spec.arrange(subscription, container)
      const host = {
        subscription_id: subscription.id,
        payment_context: spec.hostWrites === false ? null : contextFromHost,
      }

      await expect(workflow(container).run({ input: { step: input, host } })).rejects.toMatchObject({
        message: LATER_STEP_FAILURE,
      })
      await verify?.()
    },
  }
}

function stageCapturedCartPayment(container: MedusaContainer, customerId: string, savedMethods: PaymentMethodDTO[]) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const originalGraph = query.graph.bind(query)
  const staged: Record<string, unknown[]> = {
    cart_payment_collection: [{ payment_collection_id: "paycol_staged" }],
    payment: [{ id: "pay_staged", payment_collection_id: "paycol_staged", captured_at: new Date().toISOString() }],
    customer: [{ id: customerId, account_holders: [{ id: "acch_resolved", provider_id: PROVIDER_ID, data: {} }] }],
  }

  jest.spyOn(query, "graph").mockImplementation(async (args: any) => {
    const rows = staged[args.entity]

    return rows ? ({ data: rows } as any) : originalGraph(args)
  })
  jest
    .spyOn(container.resolve<IPaymentModuleService>(Modules.PAYMENT), "listPaymentMethods")
    .mockResolvedValue(savedMethods)
}

const seedFailedCycle = (container: MedusaContainer, subscriptionId: string) =>
  createRenewalCycleSeed(container, { subscription_id: subscriptionId, status: RenewalCycleStatus.FAILED })

const seedCancellationCase = (container: MedusaContainer, subscriptionId: string) =>
  createCancellationCaseSeed(container, { subscription_id: subscriptionId, reason: "too expensive" })

const scenarios = [
  scenario("pause", pauseSubscriptionStep, {
    arrange: ({ id }) => ({ input: { id, reason: "holiday" } }),
    seen: { status: SubscriptionStatus.PAUSED },
    restores: ["status", "paused_at", "metadata"],
  }),
  scenario("resume", resumeSubscriptionStep, {
    status: SubscriptionStatus.PAUSED,
    arrange: ({ id }) => ({ input: { id, resume_at: "2031-01-15T10:00:00.000Z" } }),
    seen: { status: SubscriptionStatus.ACTIVE },
    restores: ["status", "next_renewal_at", "metadata"],
  }),
  scenario("cancel", cancelSubscriptionStep, {
    arrange: ({ id }) => ({ input: { id, reason: "too expensive" } }),
    seen: { status: SubscriptionStatus.CANCELLED },
    restores: ["status", "cancelled_at", "cancel_effective_at", "next_renewal_at", "metadata"],
  }),
  scenario("skip next delivery", skipNextDeliveryStep, {
    arrange: ({ id }) => ({ input: { id } }),
    seen: { skip_next_cycle: true },
    restores: ["skip_next_cycle", "metadata"],
  }),
  scenario("plan change", scheduleSubscriptionPlanChangeStep, {
    seed: async (container) => {
      const { product, variant } = await createProductWithVariant(container)
      await createPlanOfferSeed(container, {
        scope: PlanOfferScope.VARIANT,
        product_id: product.id,
        variant_id: variant.id,
        allowed_frequencies: [{ interval: FrequencyInterval.MONTH, value: 2 }],
      })

      return { product_id: product.id, variant_id: variant.id }
    },
    arrange: ({ id, variant_id }) => ({
      input: { id, variant_id, frequency_interval: FrequencyInterval.MONTH, frequency_value: 2 },
    }),
    seen: { pending_update_data: { frequency_value: 2 } },
    restores: ["pending_update_data", "metadata"],
  }),
  scenario("shipping address change", updateSubscriptionShippingAddressStep, {
    arrange: ({ id }) => ({
      input: {
        id, first_name: "Anna", last_name: "Nowak", company: null, phone: null,
        address_1: "Nowa 2", address_2: null, city: "Kraków", postal_code: "30-001",
        province: "Małopolskie", country_code: "PL",
      },
    }),
    seen: { shipping_address: { city: "Kraków" } },
    restores: ["shipping_address", "metadata"],
  }),
  scenario("start dunning", startDunningStep, {
    arrange: async ({ id }, container) => {
      const cycle = await seedFailedCycle(container, id)

      return {
        input: {
          subscription_id: id,
          renewal_cycle_id: cycle.id,
          payment_failure_source: "payment_provider" as const,
          payment_error_message: "card declined",
        },
        verify: async () =>
          expect(await dunning(container).listDunningCases({ renewal_cycle_id: cycle.id })).toEqual([]),
      }
    },
    seen: { status: SubscriptionStatus.PAST_DUE },
    restores: ["status"],
  }),
  scenario("finalize cancellation", finalizeCancellationStep, {
    arrange: async (subscription, container) => {
      const { id } = await seedCancellationCase(container, subscription.id)

      return {
        input: { cancellation_case_id: id, finalized_by: "customer" },
        verify: async () =>
          expect(await cancellations(container).retrieveCancellationCase(id)).toMatchObject(requestedCase),
      }
    },
    seen: { status: SubscriptionStatus.CANCELLED },
    restores: ["status", "cancelled_at", "cancel_effective_at", "next_renewal_at", "skip_next_cycle", "metadata"],
  }),
  scenario("retention offer", applyRetentionOfferStep, {
    arrange: async (subscription, container) => {
      const { id } = await seedCancellationCase(container, subscription.id)

      return {
        input: {
          cancellation_case_id: id,
          offer_type: RetentionOfferType.PAUSE_OFFER,
          offer_payload: { pause_offer: { pause_cycles: 1, resume_at: null, note: null } },
          decided_by: "admin",
        },
        verify: async () => {
          expect(await cancellations(container).listRetentionOfferEvents({ cancellation_case_id: id })).toEqual([])
          expect(await cancellations(container).retrieveCancellationCase(id)).toMatchObject(requestedCase)
        },
      }
    },
    seen: { status: SubscriptionStatus.PAUSED },
    restores: ["status", "paused_at", "metadata"],
  }),
  scenario("mark dunning recovered", markDunningRecoveredStep, {
    status: SubscriptionStatus.PAST_DUE,
    arrange: async (subscription, container) => {
      const { id } = await createDunningCaseSeed(container, {
        subscription_id: subscription.id,
        renewal_cycle_id: (await seedFailedCycle(container, subscription.id)).id,
        status: DunningCaseStatus.RETRY_SCHEDULED,
      })
      const untouched = { status: DunningCaseStatus.RETRY_SCHEDULED, recovered_at: null, closed_at: null }

      return {
        input: { dunning_case_id: id, triggered_by: "admin" },
        verify: async () => expect(await dunning(container).retrieveDunningCase(id)).toMatchObject(untouched),
      }
    },
    seen: { status: SubscriptionStatus.ACTIVE },
    restores: ["status"],
  }),
  scenario("activate if already paid without a saved method", activateSubscriptionIfAlreadyPaidStep, {
    status: SubscriptionStatus.PENDING_PAYMENT,
    arrange: ({ id, cart_id, customer_id }, container) => {
      stageCapturedCartPayment(container, customer_id, [])

      return { input: { subscription_id: id, cart_id: cart_id! } }
    },
    seen: { status: SubscriptionStatus.ACTIVE, payment_context: contextBefore },
    restores: ["status"],
  }),
  scenario(
    "activate if already paid with a saved method restores the payment_context it wrote",
    activateSubscriptionIfAlreadyPaidStep,
    {
      status: SubscriptionStatus.PENDING_PAYMENT,
      hostWrites: false,
      arrange: ({ id, cart_id, customer_id }, container) => {
        const savedMethod = { id: "pm_resolved", provider_id: PROVIDER_ID, data: { created: 200 } }
        stageCapturedCartPayment(container, customer_id, [savedMethod])

        return { input: { subscription_id: id, cart_id: cart_id! } }
      },
      seen: { status: SubscriptionStatus.ACTIVE, payment_context: { payment_method_id: "pm_resolved" } },
      restores: ["status"],
    }
  ),
]

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: { JWT_SECRET: "supersecret", COOKIE_SECRET: "supersecret" },
  testSuite: ({ getContainer }) => {
    describe("a failed workflow restores what the step changed and keeps a payment_context written meanwhile", () => {
      beforeEach(() => {
        jest.restoreAllMocks()
        seenByHost = null
      })

      it.each(scenarios)("$name", async (scenario) => {
        const container = getContainer()
        const subscription = await createSubscriptionSeed(container, {
          ...(await scenario.seed?.(container)),
          status: scenario.status,
          payment_context: contextBefore,
        })

        await scenario.failAfterStep(container, subscription)

        expect(seenByHost).toMatchObject(scenario.seen)
        expect(await subscriptions(container).retrieveSubscription(subscription.id)).toMatchObject({
          ...Object.fromEntries(scenario.restores.map((field) => [field, subscription[field]])),
          payment_context: scenario.hostWrites === false ? contextBefore : contextFromHost,
        })
      })
    })
  },
})

jest.setTimeout(60 * 1000)
