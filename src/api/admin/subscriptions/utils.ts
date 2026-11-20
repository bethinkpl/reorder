import type { MedusaContainer } from "@medusajs/framework/types"
import { MedusaError } from "@medusajs/framework/utils"
import type { GetAdminSubscriptionsSchemaType } from "./validators"
import {
  isLockAcquisitionFailure,
  isRenewalPaymentInProgress,
} from "../../../modules/subscription/utils/errors"
import {
  getAdminSubscriptionDetail,
  listAdminSubscriptions,
  type ListAdminSubscriptionsInput,
} from "../../../modules/subscription/utils/admin-query"

export function normalizeAdminSubscriptionsListQuery(
  query: GetAdminSubscriptionsSchemaType
): ListAdminSubscriptionsInput {
  const normalized: ListAdminSubscriptionsInput = {
    limit: query.limit,
    offset: query.offset,
    q: query.q,
    status: query.status,
    customer_id: query.customer_id,
    product_id: query.product_id,
    variant_id: query.variant_id,
    next_renewal_from: query.next_renewal_from,
    next_renewal_to: query.next_renewal_to,
    is_trial: query.is_trial,
    skip_next_cycle: query.skip_next_cycle,
  }

  if (query.order) {
    if (query.order.startsWith("-")) {
      normalized.order = query.order.slice(1)
      normalized.direction = "desc"
    } else {
      normalized.order = query.order
      normalized.direction = query.direction
    }
  } else {
    normalized.direction = query.direction
  }

  return normalized
}

export async function getAdminSubscriptionDetailResponse(
  container: MedusaContainer,
  id: string
) {
  return await getAdminSubscriptionDetail(container, id)
}

export async function getAdminSubscriptionsListResponse(
  container: MedusaContainer,
  query: GetAdminSubscriptionsSchemaType
) {
  return await listAdminSubscriptions(
    container,
    normalizeAdminSubscriptionsListQuery(query)
  )
}

/**
 * The refusals of a subscription change an admin can act on. Medusa's error handler would replace
 * the message of both (and answer the lock with an unexpected error), so the routes answer them.
 */
export function mapAdminSubscriptionChangeConflict(
  error: unknown,
  subscriptionId: string
) {
  if (isRenewalPaymentInProgress(error)) {
    return { type: MedusaError.Types.CONFLICT, message: error.message }
  }

  if (isLockAcquisitionFailure(error)) {
    return {
      type: MedusaError.Types.CONFLICT,
      message: `Subscription '${subscriptionId}' is being updated by a renewal or a payment right now; try again in a moment`,
    }
  }

  return null
}
