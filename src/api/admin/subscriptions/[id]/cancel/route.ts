import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { isLockBusyError } from "../../../../../common/utils/lock-busy-error"
import type { PostAdminCancelSubscriptionSchemaType } from "../../validators"
import { getAdminSubscriptionDetailResponse } from "../../utils"
import { cancelSubscriptionWorkflow } from "../../../../../workflows"

/**
 * Medusa's error handler replaces every conflict's message with a generic one, so a conflict is
 * answered here. A workflow rethrows its step's error as a serialised plain object.
 */
function readConflictMessage(error: unknown, subscriptionId: string) {
  if (isLockBusyError(error)) {
    return `Subscription '${subscriptionId}' is being updated by a renewal or a payment right now; try again in a moment`
  }

  const record = error as { type?: unknown, message?: unknown } | null

  return record?.type === MedusaError.Types.CONFLICT &&
    typeof record.message === "string"
    ? record.message
    : null
}

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
    const conflict = readConflictMessage(error, req.params.id)

    if (conflict) {
      return res.status(409).json({
        type: MedusaError.Types.CONFLICT,
        message: conflict,
      })
    }

    throw error
  }

  const response = await getAdminSubscriptionDetailResponse(
    req.scope,
    req.params.id
  )

  res.status(200).json(response)
}
