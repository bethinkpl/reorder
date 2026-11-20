import { randomUUID } from "crypto"
import type { OperationLogOutcome } from "../../../common/types/log-outcome"

type LoggerLike = {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

type LogLevel = "info" | "warn" | "error"

export const DunningLogEvents = {
  RETRY: "dunning.retry",
  JOB: "dunning.job",
  JOB_BATCH: "dunning.job.batch",
  JOB_CASE: "dunning.job.case",
  JOB_DISCOVERY: "dunning.job.discovery",
  EVENT: "dunning.event",
  CUSTOMER_RECOVERY: "dunning.customer_recovery",
  AWAITING_PAYMENT_RESOLVED: "dunning.awaiting_payment_resolved",
  AWAITING_PAYMENT_OVERDUE: "dunning.awaiting_payment_overdue",
  AWAITING_PAYMENT_SESSION_MISSING: "dunning.awaiting_payment_session_missing",
  PAYMENT_FAILURE_RECORDED: "dunning.payment_failure_recorded",
  RECORDED_PAYMENT_FAILURE: "dunning.recorded_payment_failure",
  LATE_PAYMENT_FAILURE: "dunning.late_payment_failure",
  STALE_ATTEMPT_CLOSED: "dunning.stale_attempt_closed",
  STALE_RETRY: "dunning.stale_retry",
} as const

export type DunningFailureKind =
  | "already_retrying"
  | "not_due"
  | "closed_case"
  | "invalid_transition"
  | "retry_exhausted"
  | "lock_timeout"
  | "not_found"
  | "subscription_not_retryable"
  | "no_payment_method"
  | "unexpected_error"

type DunningLogPayload = {
  event: string
  correlation_id: string
  dunning_case_id?: string
  subscription_id?: string
  renewal_cycle_id?: string
  attempt_no?: number
  duration_ms?: number
  success_count?: number
  failure_count?: number
  blocked_count?: number
  awaiting_count?: number
  scanned_count?: number
  processed_count?: number
  recovered_count?: number
  rescheduled_count?: number
  unrecovered_count?: number
  avg_attempts?: number
  recovery_rate?: number
  fail_rate?: number
  avg_time_to_recover_ms?: number
  batch_size?: number
  job_name?: string
  outcome?: OperationLogOutcome
  failure_kind?: DunningFailureKind
  alertable?: boolean
  message?: string
  metadata?: Record<string, unknown> | null
}

export function createDunningCorrelationId(prefix: string) {
  return `${prefix}-${randomUUID()}`
}

export function getDunningErrorMessage(error: unknown) {
  const direct = getNestedMessage(error)

  if (direct) {
    return direct
  }

  return "Dunning processing failed"
}

export function classifyDunningFailure(error: unknown): DunningFailureKind {
  const message = getDunningErrorMessage(error).toLowerCase()

  if (message.includes("already retrying")) {
    return "already_retrying"
  }

  if (message.includes("retry is already processing")) {
    return "already_retrying"
  }

  if (message.includes("not due for retry yet")) {
    return "not_due"
  }

  if (message.includes("retry is not due")) {
    return "not_due"
  }

  if (message.includes("already closed")) {
    return "closed_case"
  }

  if (message.includes("already recovered")) {
    return "closed_case"
  }

  if (message.includes("already unrecovered")) {
    return "closed_case"
  }

  if (message.includes("already exhausted retry attempts")) {
    return "retry_exhausted"
  }

  if (message.includes("max attempts exceeded")) {
    return "retry_exhausted"
  }

  if (
    message.includes("timed-out acquiring lock") ||
    message.includes("timeout acquiring lock") ||
    message.includes("timed out acquiring lock")
  ) {
    return "lock_timeout"
  }

  if (message.includes("was not found")) {
    return "not_found"
  }

  if (message.includes("no longer retryable")) {
    return "subscription_not_retryable"
  }

  if (message.includes("no saved payment method")) {
    return "no_payment_method"
  }

  if (message.includes("can't") || message.includes("missing")) {
    return "invalid_transition"
  }

  return "unexpected_error"
}

export function isAlertableDunningFailure(kind: DunningFailureKind) {
  return ![
    "already_retrying",
    "not_due",
    "closed_case",
    "retry_exhausted",
    "lock_timeout",
    "subscription_not_retryable",
    "no_payment_method",
  ].includes(kind)
}

function getNestedMessage(value: unknown): string | null {
  if (!value) {
    return null
  }

  if (typeof value === "string") {
    return value
  }

  if (value instanceof Error) {
    const causeMessage = getNestedMessage((value as Error & { cause?: unknown }).cause)
    return value.message || causeMessage || null
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>

    const candidates = [
      record.message,
      record.error,
      record.details,
      record.cause,
      (record.response as Record<string, unknown> | undefined)?.data,
      (record.response as Record<string, unknown> | undefined)?.message,
      (record.data as Record<string, unknown> | undefined)?.message,
      (record.body as Record<string, unknown> | undefined)?.message,
    ]

    for (const candidate of candidates) {
      const nested = getNestedMessage(candidate)

      if (nested) {
        return nested
      }
    }
  }

  return null
}

export function logDunningEvent(
  logger: LoggerLike,
  level: LogLevel,
  payload: DunningLogPayload
) {
  const line = JSON.stringify({
    domain: "dunning",
    ...payload,
  })

  logger[level](line)
}
