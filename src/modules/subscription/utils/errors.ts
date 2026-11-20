import { MedusaError } from "@medusajs/framework/utils"
import { isLockBusyError } from "../../../common/utils/lock-busy-error"

export const subscriptionErrors = {
  notFound(entity: string, id: string) {
    return new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `${entity} '${id}' was not found`
    )
  },
  invalidState(id: string, action: string, status: string) {
    return new MedusaError(
      MedusaError.Types.CONFLICT,
      `Subscription '${id}' can't ${action} from status '${status}'`
    )
  },
  invalidData(message: string) {
    return new MedusaError(MedusaError.Types.INVALID_DATA, message)
  },
  planChangeVariantMismatch(variantId: string, productId: string) {
    return new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Variant '${variantId}' does not belong to subscription product '${productId}'`
    )
  },
  planChangeNotAllowed(productId: string, variantId: string) {
    return new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `No active subscription offer is configured for product '${productId}' and variant '${variantId}'`
    )
  },
  planChangeFrequencyNotAllowed(interval: string, value: number) {
    return new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Subscription frequency '${interval}:${value}' is not allowed by the active subscription offer`
    )
  },
  conflict(message: string) {
    return new MedusaError(MedusaError.Types.CONFLICT, message)
  },
}

/** The older name of `isLockBusyError`, kept for callers that still use it. */
export const isLockAcquisitionFailure = isLockBusyError
