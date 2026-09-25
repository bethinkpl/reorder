import type { MedusaContainer } from "@medusajs/framework/types"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { SUBSCRIPTION_MODULE } from "../../modules/subscription"
import type SubscriptionModuleService from "../../modules/subscription/service"
import {
  type SubscriptionPaymentContext,
  SubscriptionStatus,
} from "../../modules/subscription/types"
import {
  findCapturedPaymentForCart,
  resolveLatestSavedPaymentMethod,
} from "../../modules/subscription/utils/resolve-captured-payment-method"

export type ActivateSubscriptionIfAlreadyPaidStepInput = {
  subscription_id: string
  cart_id: string
}

export type ActivateSubscriptionIfAlreadyPaidStepOutput = {
  subscription_id: string
  activated: boolean
}

type SubscriptionRecord = {
  id: string
  customer_id: string
  status: SubscriptionStatus
  payment_context: SubscriptionPaymentContext | null
}

type Compensation = {
  subscription_id: string
  status: SubscriptionStatus
  payment_context: SubscriptionPaymentContext | null
}

/**
 * The storefront creates the subscription (POST `/store/carts/:id/subscribe`) before redirecting
 * to the hosted Checkout Session, so this step normally no-ops. It stays as a defensive reconcile
 * for callers that complete payment before the subscription exists, and its exported function is
 * shared with the `pending_payment` sweeper job.
 */
export async function activateSubscriptionIfAlreadyPaid(
  container: MedusaContainer,
  input: ActivateSubscriptionIfAlreadyPaidStepInput
): Promise<{
  output: ActivateSubscriptionIfAlreadyPaidStepOutput
  compensation: Compensation | null
}> {
  const subscriptionModule =
    container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

  const subscription = (await subscriptionModule.retrieveSubscription(
    input.subscription_id
  )) as SubscriptionRecord

  const pending = {
    output: { subscription_id: input.subscription_id, activated: false },
    compensation: null,
  }

  if (subscription.status !== SubscriptionStatus.PENDING_PAYMENT) {
    return pending
  }

  const payment = await findCapturedPaymentForCart(container, input.cart_id)

  if (!payment) {
    return pending
  }

  const paymentContext = subscription.payment_context

  const resolved = paymentContext?.payment_provider_id
    ? await resolveLatestSavedPaymentMethod(container, {
        customer_id: subscription.customer_id,
        provider_id: paymentContext.payment_provider_id,
      })
    : null

  await subscriptionModule.updateSubscriptions({
    id: subscription.id,
    status: SubscriptionStatus.ACTIVE,
    ...(resolved && paymentContext
      ? {
          payment_context: {
            ...paymentContext,
            account_holder_id: resolved.account_holder_id,
            payment_method_id: resolved.payment_method_id,
          } satisfies SubscriptionPaymentContext,
        }
      : {}),
  })

  return {
    output: { subscription_id: subscription.id, activated: true },
    compensation: {
      subscription_id: subscription.id,
      status: subscription.status,
      payment_context: paymentContext,
    },
  }
}

export const activateSubscriptionIfAlreadyPaidStep = createStep(
  "activate-subscription-if-already-paid",
  async function (
    input: ActivateSubscriptionIfAlreadyPaidStepInput,
    { container }
  ) {
    const { output, compensation } = await activateSubscriptionIfAlreadyPaid(
      container,
      input
    )

    return new StepResponse<
      ActivateSubscriptionIfAlreadyPaidStepOutput,
      Compensation
    >(output, compensation ?? undefined)
  },
  async function (compensation: Compensation | undefined, { container }) {
    if (!compensation) {
      return
    }

    const subscriptionModule =
      container.resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)

    await subscriptionModule.updateSubscriptions({
      id: compensation.subscription_id,
      status: compensation.status,
      payment_context: compensation.payment_context,
    })
  }
)
