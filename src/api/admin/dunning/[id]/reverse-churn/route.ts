import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import type { PostAdminReverseChurnDunningSchemaType } from "../../validators"
import { getAdminDunningDetailResponse, mapDunningAdminRouteError } from "../../utils"
import { reverseInvoluntaryChurnWorkflow } from "../../../../../workflows"

export const POST = async (
  req: AuthenticatedMedusaRequest<PostAdminReverseChurnDunningSchemaType>,
  res: MedusaResponse
) => {
  try {
    await reverseInvoluntaryChurnWorkflow(req.scope).run({
      input: {
        dunning_case_id: req.params.id,
        triggered_by: req.auth_context.actor_id,
        reason: req.validatedBody.reason,
      },
    })
  } catch (error) {
    const mapped = mapDunningAdminRouteError(error)

    return res.status(mapped.status).json({
      type: mapped.type,
      message: mapped.message,
    })
  }

  const response = await getAdminDunningDetailResponse(req.scope, req.params.id)

  return res.status(200).json(response)
}
