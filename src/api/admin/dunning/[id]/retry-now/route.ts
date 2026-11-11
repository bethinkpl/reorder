import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import type { PostAdminRetryNowDunningSchemaType } from "../../validators"
import { getAdminDunningDetailResponse, mapDunningAdminRouteError } from "../../utils"
import { getDunningErrorMessage } from "../../../../../modules/dunning/utils/observability"
import { runDunningRetryWorkflow } from "../../../../../workflows"

export const POST = async (
  req: AuthenticatedMedusaRequest<PostAdminRetryNowDunningSchemaType>,
  res: MedusaResponse
) => {
  try {
    await runDunningRetryWorkflow(req.scope).run({
      input: {
        dunning_case_id: req.params.id,
        ignore_schedule: true,
        triggered_by: req.auth_context.actor_id,
        reason: req.validatedBody.reason,
      },
    })
  } catch (error) {
    const mapped = mapDunningAdminRouteError(error)

    return res.status(mapped.status).json({
      type: mapped.type,
      // The workflow engine rethrows a step's error as a serialised plain object, not an Error.
      message: getDunningErrorMessage(error),
    })
  }

  const response = await getAdminDunningDetailResponse(req.scope, req.params.id)

  return res.status(200).json(response)
}
