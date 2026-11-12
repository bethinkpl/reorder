import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import {
  isLockAcquisitionFailure,
  subscriptionErrors,
} from "../../../../../modules/subscription/utils/errors"
import type { PostAdminCancelSubscriptionSchemaType } from "../../validators"
import { getAdminSubscriptionDetailResponse } from "../../utils"
import { cancelSubscriptionWorkflow } from "../../../../../workflows"

export const POST = async (
  req: AuthenticatedMedusaRequest<PostAdminCancelSubscriptionSchemaType>,
  res: MedusaResponse
) => {
  try {
    await cancelSubscriptionWorkflow(req.scope).run({
      input: {
        id: req.params.id,
        triggered_by: req.auth_context.actor_id,
        ...req.validatedBody,
      },
    })
  } catch (error) {
    if (isLockAcquisitionFailure(error)) {
      throw subscriptionErrors.conflict(
        `Subscription '${req.params.id}' is being updated by a renewal or a payment right now; try again in a moment`
      )
    }

    throw error
  }

  const response = await getAdminSubscriptionDetailResponse(
    req.scope,
    req.params.id
  )

  res.status(200).json(response)
}
