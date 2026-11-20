import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import type { PostStoreStartCancellationSchemaType } from "../../validators"
import { cancelSubscriptionByCustomerWorkflow } from "../../../../../../../workflows"
import { SubscriptionStatus } from "../../../../../../../modules/subscription/types"
import {
  getOwnedSubscriptionForAction,
  getStoreSubscriptionDetailResponse,
  requireStoreCustomer,
  sendStoreJson,
} from "../../utils"

function getNestedMessage(value: unknown): string | null {
  if (!value) {
    return null
  }

  if (typeof value === "string") {
    return value
  }

  if (typeof value === "object") {
    const { message, cause } = value as { message?: unknown, cause?: unknown }

    return (typeof message === "string" && message) || getNestedMessage(cause)
  }

  return null
}

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

export function mapStoreCancellationError(error: unknown) {
  const medusaError = findMedusaError(error)

  if (medusaError) {
    const typeToStatus: Record<string, number> = {
      [MedusaError.Types.NOT_FOUND]: 404,
      [MedusaError.Types.INVALID_DATA]: 400,
      [MedusaError.Types.CONFLICT]: 409,
    }

    if (medusaError.type === MedusaError.Types.CONFLICT) {
      const isRetryInFlight = medusaError.message
        .toLowerCase()
        .includes("retry is in flight")

      return {
        status: 409,
        type: medusaError.type,
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

  const message = getNestedMessage(error) ?? ""
  const normalized = message.toLowerCase()

  if (
    normalized.includes("failed to acquire lock") ||
    normalized.includes("acquiring lock")
  ) {
    return {
      status: 409,
      type: MedusaError.Types.CONFLICT,
      message:
        "This subscription is already being updated. Please try again in a moment.",
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
