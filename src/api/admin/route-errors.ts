import { MedusaError } from "@medusajs/framework/utils"

export type AdminRouteError = {
  status: number
  type: string
  message: string
}

const STATUS_BY_MEDUSA_ERROR_TYPE: Record<string, number> = {
  [MedusaError.Types.NOT_FOUND]: 404,
  [MedusaError.Types.INVALID_DATA]: 400,
  [MedusaError.Types.NOT_ALLOWED]: 409,
  [MedusaError.Types.CONFLICT]: 409,
  // A charge the provider refused (a forced renewal, a retry) is not a fault of the server.
  [MedusaError.Types.PAYMENT_AUTHORIZATION_ERROR]: 409,
}

/**
 * The type of a MedusaError, also when a workflow run rethrows it as a plain object (which keeps
 * `__isMedusaError` and `type`) or another error carries it as its `cause`.
 */
function getMedusaErrorType(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null
  }

  if (MedusaError.isMedusaError(error) && typeof error.type === "string") {
    return error.type
  }

  return "cause" in error ? getMedusaErrorType(error.cause) : null
}

/**
 * Answers a MedusaError by its type, any type not listed being a 500. Returns `null` for any other
 * error (a lock failure, a provider's own error), which the caller answers from its message.
 */
export function mapMedusaErrorByType(
  error: unknown,
  message: string
): AdminRouteError | null {
  const type = getMedusaErrorType(error)

  if (!type) {
    return null
  }

  return {
    status: STATUS_BY_MEDUSA_ERROR_TYPE[type] ?? 500,
    type,
    message,
  }
}
