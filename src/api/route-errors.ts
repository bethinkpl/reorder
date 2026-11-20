import { MedusaError } from "@medusajs/framework/utils"

export type RouteError = {
  status: number
  type: string
  message: string
}

const STATUS_BY_MEDUSA_ERROR_TYPE: Record<string, number> = {
  [MedusaError.Types.NOT_FOUND]: 404,
  [MedusaError.Types.INVALID_DATA]: 400,
  [MedusaError.Types.NOT_ALLOWED]: 409,
  [MedusaError.Types.CONFLICT]: 409,
  [MedusaError.Types.PAYMENT_AUTHORIZATION_ERROR]: 409,
}

/** A workflow rethrows a MedusaError as a plain object, keeping `__isMedusaError` and `type`. */
function getMedusaErrorType(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null
  }

  if (MedusaError.isMedusaError(error) && typeof error.type === "string") {
    return error.type
  }

  return "cause" in error ? getMedusaErrorType(error.cause) : null
}

export function mapMedusaErrorByType(
  error: unknown,
  message: string
): RouteError | null {
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
