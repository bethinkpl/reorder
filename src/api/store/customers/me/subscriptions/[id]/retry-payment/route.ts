import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import type { PostStoreRetrySubscriptionPaymentSchemaType } from "../../validators"
import { runDunningRetryWorkflow } from "../../../../../../../workflows"
import {
  getOwnedSubscriptionForAction,
  getRetryableDunningCaseForSubscription,
  getStoreSubscriptionDetailResponse,
  mapStoreRetryError,
  requireStoreCustomer,
  sendStoreJson,
  StoreRetryNotEligibleError,
} from "../../utils"

export const POST = async (
  req: AuthenticatedMedusaRequest<PostStoreRetrySubscriptionPaymentSchemaType>,
  res: MedusaResponse
) => {
  const subscription = await getOwnedSubscriptionForAction(req, req.params.id)

  let dunningCase: Awaited<ReturnType<typeof getRetryableDunningCaseForSubscription>>

  try {
    dunningCase = await getRetryableDunningCaseForSubscription(
      req,
      req.params.id,
      subscription
    )
  } catch (error) {
    if (error instanceof StoreRetryNotEligibleError) {
      return res.status(409).json({
        type: error.type,
        message: error.message,
        blocked_reason: error.blocked_reason,
      })
    }

    throw error
  }

  try {
    await runDunningRetryWorkflow(req.scope).run({
      input: {
        dunning_case_id: dunningCase.id,
        ignore_schedule: true,
        triggered_by: req.auth_context.actor_id,
        reason: req.validatedBody.reason,
      },
    })
  } catch (error) {
    const { status, ...body } = mapStoreRetryError(req.params.id, error)

    return res.status(status).json(body)
  }

  const customerId = await requireStoreCustomer(req)
  const response = await getStoreSubscriptionDetailResponse(req.scope, {
    customer_id: customerId,
    subscription_id: req.params.id,
  })

  return sendStoreJson(res, response)
}
