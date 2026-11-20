export function getAdminErrorMessage(error: unknown, fallback: string) {
  return getNestedErrorMessage(error) ?? fallback
}

function getNestedErrorMessage(value: unknown): string | null {
  if (!value) {
    return null
  }

  if (typeof value === "string") {
    return value
  }

  if (value instanceof Error) {
    return (
      getNestedErrorMessage((value as Error & { cause?: unknown }).cause) ??
      value.message
    )
  }

  if (typeof value !== "object") {
    return null
  }

  const record = value as Record<string, unknown>

  return (
    getNestedErrorMessage(record.message) ??
    getNestedErrorMessage(record.error) ??
    getNestedErrorMessage(record.details) ??
    getNestedErrorMessage(record.response) ??
    getNestedErrorMessage(record.data) ??
    getNestedErrorMessage(record.body) ??
    getNestedErrorMessage(record.cause) ??
    null
  )
}
