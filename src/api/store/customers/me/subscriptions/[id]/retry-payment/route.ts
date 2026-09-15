import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import type { PostStoreRetrySubscriptionPaymentSchemaType } from "../../validators"
import { MedusaError } from "@medusajs/framework/utils"
import { runDunningRetryWorkflow } from "../../../../../../../workflows"
import {
  getOwnedSubscriptionForAction,
  getRetryableDunningCaseForSubscription,
  getStoreSubscriptionDetailResponse,
  requireStoreCustomer,
  sendStoreJson,
  StoreRetryNotEligibleError,
} from "../../utils"

function mapStoreRetryError(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Unexpected subscription retry error"
  const normalized = message.toLowerCase()

  if (normalized.includes("was not found")) {
    return {
      status: 404,
      type: MedusaError.Types.NOT_FOUND,
      message,
    }
  }

  if (normalized.includes("invalid") || normalized.includes("missing")) {
    return {
      status: 400,
      type: MedusaError.Types.INVALID_DATA,
      message,
    }
  }

  return {
    status: 409,
    type: MedusaError.Types.CONFLICT,
    message,
  }
}

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
    const mapped = mapStoreRetryError(error)

    return res.status(mapped.status).json({
      type: mapped.type,
      message: mapped.message,
    })
  }

  const customerId = await requireStoreCustomer(req)
  const response = await getStoreSubscriptionDetailResponse(req.scope, {
    customer_id: customerId,
    subscription_id: req.params.id,
  })

  return sendStoreJson(res, response)
}
