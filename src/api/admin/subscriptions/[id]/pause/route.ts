import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import type { PostAdminPauseSubscriptionSchemaType } from "../../validators"
import {
  getAdminSubscriptionDetailResponse,
  mapAdminSubscriptionChangeConflict,
} from "../../utils"
import { pauseSubscriptionWorkflow } from "../../../../../workflows"

export const POST = async (
  req: AuthenticatedMedusaRequest<PostAdminPauseSubscriptionSchemaType>,
  res: MedusaResponse
) => {
  try {
    await pauseSubscriptionWorkflow(req.scope).run({
      input: {
        id: req.params.id,
        triggered_by: req.auth_context.actor_id,
        ...req.validatedBody,
      },
    })
  } catch (error) {
    const conflict = mapAdminSubscriptionChangeConflict(error, req.params.id)

    if (!conflict) {
      throw error
    }

    return res.status(409).json(conflict)
  }

  const response = await getAdminSubscriptionDetailResponse(
    req.scope,
    req.params.id
  )

  res.status(200).json(response)
}
