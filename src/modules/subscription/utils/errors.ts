import { MedusaError } from "@medusajs/framework/utils"

/** `code` of the refusal to pause or resume while a renewal charge awaits the provider's answer. */
export const RENEWAL_PAYMENT_IN_PROGRESS = "renewal_payment_in_progress"

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
  renewalPaymentInProgress(id: string, action: string, charge: string) {
    return new MedusaError(
      MedusaError.Types.CONFLICT,
      `Subscription '${id}' can't ${action} while ${charge}; try again once the payment has been settled or has failed`,
      RENEWAL_PAYMENT_IN_PROGRESS
    )
  },
}

/** Matches the error itself and the plain object a workflow run rethrows in its place. */
export function isRenewalPaymentInProgress(
  error: unknown
): error is { message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === RENEWAL_PAYMENT_IN_PROGRESS &&
    "message" in error &&
    typeof error.message === "string"
  )
}

export function isLockAcquisitionFailure(error: unknown) {
  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message.toLowerCase()
      : ""

  return (
    message.includes("failed to acquire lock") ||
    message.includes("acquiring lock") ||
    // The Postgres locking provider's answer when another owner inserted the lock first.
    message.endsWith("is already locked.")
  )
}
