import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import type { PostStorePauseSubscriptionSchemaType } from "../../validators"
import { pauseSubscriptionWorkflow } from "../../../../../../../workflows"
import {
  getOwnedSubscriptionForAction,
  getStoreSubscriptionDetailResponse,
  requireStoreCustomer,
  respondChargeInFlight,
  sendStoreJson,
} from "../../utils"

export const POST = async (
  req: AuthenticatedMedusaRequest<PostStorePauseSubscriptionSchemaType>,
  res: MedusaResponse
) => {
  await getOwnedSubscriptionForAction(req, req.params.id)

  try {
    await pauseSubscriptionWorkflow(req.scope).run({
      input: {
        id: req.params.id,
        triggered_by: req.auth_context.actor_id,
        ...req.validatedBody,
      },
    })
  } catch (error) {
    return respondChargeInFlight(res, error)
  }

  const customerId = await requireStoreCustomer(req)
  const response = await getStoreSubscriptionDetailResponse(req.scope, {
    customer_id: customerId,
    subscription_id: req.params.id,
  })

  return sendStoreJson(res, response)
}
