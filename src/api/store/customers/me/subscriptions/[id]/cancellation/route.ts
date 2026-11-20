import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { isLockBusyError } from "../../../../../../../common/utils/lock-busy-error"
import type { PostStoreStartCancellationSchemaType } from "../../validators"
import { cancelSubscriptionByCustomerWorkflow } from "../../../../../../../workflows"
import { SubscriptionStatus } from "../../../../../../../modules/subscription/types"
import {
  getOwnedSubscriptionForAction,
  getStoreSubscriptionDetailResponse,
  requireStoreCustomer,
  sendStoreJson,
} from "../../utils"

/** A workflow rethrows its step's error as a serialised plain object, which keeps the flag. */
function findMedusaError(error: unknown): Pick<MedusaError, "type" | "message"> | null {
  const cause =
    typeof error === "object" && error !== null
      ? (error as { cause?: unknown }).cause
      : null

  for (const candidate of [error, cause]) {
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      MedusaError.isMedusaError(candidate)
    ) {
      return candidate as Pick<MedusaError, "type" | "message">
    }
  }

  return null
}

const CONFLICT_TYPES: readonly string[] = [
  MedusaError.Types.CONFLICT,
  MedusaError.Types.NOT_ALLOWED,
]

export function mapStoreCancellationError(error: unknown) {
  if (isLockBusyError(error)) {
    return {
      status: 409,
      type: MedusaError.Types.CONFLICT,
      message:
        "This subscription is already being updated. Please try again in a moment.",
    }
  }

  const medusaError = findMedusaError(error)

  if (medusaError) {
    const typeToStatus: Record<string, number> = {
      [MedusaError.Types.NOT_FOUND]: 404,
      [MedusaError.Types.INVALID_DATA]: 400,
    }

    if (CONFLICT_TYPES.includes(medusaError.type)) {
      const isRetryInFlight = medusaError.message
        .toLowerCase()
        .includes("retry is in flight")

      return {
        status: 409,
        type: MedusaError.Types.CONFLICT,
        message: isRetryInFlight
          ? "A payment recovery attempt is in progress. Please try again in a moment."
          : "This subscription can't be cancelled right now. Please try again in a moment.",
      }
    }

    return {
      status: typeToStatus[medusaError.type] ?? 500,
      type: medusaError.type,
      message: medusaError.message,
    }
  }

  return {
    status: 500,
    type: MedusaError.Types.UNEXPECTED_STATE,
    message: "Unexpected error while cancelling the subscription",
  }
}

export const POST = async (
  req: AuthenticatedMedusaRequest<PostStoreStartCancellationSchemaType>,
  res: MedusaResponse
) => {
  const subscriptionId = req.params.id
  const subscription = await getOwnedSubscriptionForAction(req, subscriptionId)
  const customerId = await requireStoreCustomer(req)

  let alreadyCancelled = subscription.status === SubscriptionStatus.CANCELLED

  if (!alreadyCancelled) {
    try {
      await cancelSubscriptionByCustomerWorkflow(req.scope).run({
        input: {
          subscription_id: subscriptionId,
          reason: req.validatedBody.reason,
          reason_category: req.validatedBody.reason_category,
          notes: req.validatedBody.notes,
          metadata: req.validatedBody.metadata
            ? { customer_metadata: req.validatedBody.metadata }
            : null,
          triggered_by: req.auth_context?.actor_id ?? null,
        },
      })
    } catch (error) {
      const mapped = mapStoreCancellationError(error)

      if (mapped.status !== 409) {
        return res.status(mapped.status).json({
          type: mapped.type,
          message: mapped.message,
        })
      }

      const currentSubscription = await getOwnedSubscriptionForAction(
        req,
        subscriptionId
      )

      if (currentSubscription.status !== SubscriptionStatus.CANCELLED) {
        return res.status(mapped.status).json({
          type: mapped.type,
          message: mapped.message,
        })
      }

      alreadyCancelled = true
    }
  }

  const response = await getStoreSubscriptionDetailResponse(req.scope, {
    customer_id: customerId,
    subscription_id: subscriptionId,
  })

  return sendStoreJson(res, {
    ...response,
    result: {
      cancelled: true,
      already_cancelled: alreadyCancelled,
      cancel_effective_at: response.subscription.cancel_effective_at,
    },
  })
}
