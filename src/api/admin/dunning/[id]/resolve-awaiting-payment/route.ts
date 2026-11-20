import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import type { MedusaContainer } from "@medusajs/framework/types"
import { DunningAwaitingPaymentAdminResolution } from "../../../../../admin/types/dunning"
import { PaymentAttemptErrorCode } from "../../../../../common/types/payment-attempt-error-code"
import { DUNNING_MODULE } from "../../../../../modules/dunning"
import { DunningEvents } from "../../../../../modules/dunning/events"
import type DunningModuleService from "../../../../../modules/dunning/service"
import {
  DunningAttemptStatus,
  DunningCaseStatus,
} from "../../../../../modules/dunning/types"
import { dunningErrors } from "../../../../../modules/dunning/utils/errors"
import {
  createDunningCorrelationId,
  DunningLogEvents,
  logDunningEvent,
} from "../../../../../modules/dunning/utils/observability"
import {
  isAwaitingPaymentOverdue,
  resolveAwaitingPaymentResolveMinHours,
} from "../../../../../modules/renewal/utils/awaiting-payment-age"
import { emitDunningEvent } from "../../../../../workflows/steps/emit-dunning-event"
import { recoverDunningFromCapturedPayment } from "../../../../../workflows/steps/recover-dunning-from-captured-payment"
import { loadOrderAmounts } from "../../../../../workflows/steps/run-dunning-retry"
import {
  emitDunningAttemptOutcomeEvents,
  failAwaitingDunningAttemptUnderLock,
} from "../../../../../workflows/utils/fail-awaiting-dunning-attempt"
import {
  getAdminDunningDetailResponse,
  mapDunningAdminRouteError,
} from "../../utils"
import type { PostAdminResolveAwaitingDunningPaymentSchemaType } from "../../validators"
import { dunningCaseLockKey } from "../../../../../modules/dunning/utils/lock-key"
import { runUnderLock } from "../../../../../workflows/utils/run-under-lock"

const DUNNING_LOCK_TIMEOUT_SECONDS = 30
const DUNNING_LOCK_HOLD_SECONDS = 120

type ResolveAwaitingPaymentInput = {
  dunning_case_id: string
  reason: string | null
  triggered_by: string | null
}

function notAwaitingPayment(dunningCaseId: string) {
  return dunningErrors.conflict(
    `DunningCase '${dunningCaseId}' isn't awaiting the payment of its retry`
  )
}

function noAttemptToFail(dunningCaseId: string) {
  return dunningErrors.conflict(
    `DunningCase '${dunningCaseId}' has no retry payment in progress to fail`
  )
}

function paymentMayStillArrive(dunningCaseId: string, minHours: number) {
  return dunningErrors.conflict(
    `DunningCase '${dunningCaseId}' is unpaid, but its retry's payment may still arrive; it can be resolved as failed once it has waited for more than ${minHours} hours`
  )
}

async function isRenewalOrderPaid(
  container: MedusaContainer,
  renewalOrderId: string | null
) {
  return (
    renewalOrderId !== null &&
    (await loadOrderAmounts(container, renewalOrderId)).pending <= 0
  )
}

async function recoverPaidUnderLock(
  container: MedusaContainer,
  dunningCaseId: string
): Promise<DunningAwaitingPaymentAdminResolution> {
  const { output } = await recoverDunningFromCapturedPayment(container, {
    dunning_case_id: dunningCaseId,
    payment_id: null,
  })

  if (!output.recovered) {
    throw notAwaitingPayment(dunningCaseId)
  }

  await emitDunningEvent(container, {
    eventName: DunningEvents.RECOVERED,
    data: {
      subscription_id: output.subscription_id,
      dunning_case_id: output.dunning_case_id,
      renewal_order_id: output.renewal_order_id,
      recovery_reason: output.recovery_reason,
    },
  })

  return DunningAwaitingPaymentAdminResolution.RECOVERED
}

async function failUnpaidUnderLock(
  container: MedusaContainer,
  input: ResolveAwaitingPaymentInput
): Promise<DunningAwaitingPaymentAdminResolution> {
  const [latest] = await container
    .resolve<DunningModuleService>(DUNNING_MODULE)
    .listDunningAttempts(
      { dunning_case_id: input.dunning_case_id },
      { order: { attempt_no: "DESC" }, take: 1 }
    )

  if (!latest || latest.status !== DunningAttemptStatus.PROCESSING) {
    throw noAttemptToFail(input.dunning_case_id)
  }

  const minHours = resolveAwaitingPaymentResolveMinHours()

  if (!isAwaitingPaymentOverdue(latest.started_at, new Date(), minHours)) {
    throw paymentMayStillArrive(input.dunning_case_id, minHours)
  }

  const output = await failAwaitingDunningAttemptUnderLock(container, {
    dunning_case_id: input.dunning_case_id,
    dunning_attempt_id: latest.id,
    session_id: latest.payment_reference,
    action: PaymentAttemptErrorCode.RESOLVED_UNPAID,
    reason: null,
    message: input.reason
      ? `Retry payment never arrived; resolved as failed by an admin: ${input.reason}`
      : "Retry payment never arrived; resolved as failed by an admin",
  })

  if (!output) {
    throw noAttemptToFail(input.dunning_case_id)
  }

  await emitDunningAttemptOutcomeEvents(container, output)

  return DunningAwaitingPaymentAdminResolution.FAILED
}

async function resolveUnderLock(
  container: MedusaContainer,
  input: ResolveAwaitingPaymentInput
): Promise<DunningAwaitingPaymentAdminResolution> {
  const dunningCase = await container
    .resolve<DunningModuleService>(DUNNING_MODULE)
    .retrieveDunningCase(input.dunning_case_id)

  if (dunningCase.status !== DunningCaseStatus.AWAITING_PAYMENT) {
    throw notAwaitingPayment(dunningCase.id)
  }

  if (await isRenewalOrderPaid(container, dunningCase.renewal_order_id)) {
    return await recoverPaidUnderLock(container, dunningCase.id)
  }

  return await failUnpaidUnderLock(container, input)
}

async function resolveAwaitingPayment(
  container: MedusaContainer,
  input: ResolveAwaitingPaymentInput
): Promise<DunningAwaitingPaymentAdminResolution> {
  const dunningModule = container.resolve<DunningModuleService>(DUNNING_MODULE)
  const [dunningCase] = await dunningModule.listDunningCases({
    id: input.dunning_case_id,
  })

  if (!dunningCase) {
    throw dunningErrors.notFound("DunningCase", input.dunning_case_id)
  }

  if (dunningCase.status !== DunningCaseStatus.AWAITING_PAYMENT) {
    throw notAwaitingPayment(dunningCase.id)
  }

  const resolution = await runUnderLock(
    container,
    dunningCaseLockKey(dunningCase.id),
    () => resolveUnderLock(container, input),
    { wait_seconds: DUNNING_LOCK_TIMEOUT_SECONDS, hold_seconds: DUNNING_LOCK_HOLD_SECONDS }
  )

  logDunningEvent(container.resolve("logger"), "info", {
    event: DunningLogEvents.AWAITING_PAYMENT_RESOLVED,
    outcome: resolution === DunningAwaitingPaymentAdminResolution.RECOVERED ? "succeeded" : "failed",
    correlation_id: createDunningCorrelationId("dunning-admin-resolve"),
    dunning_case_id: dunningCase.id,
    subscription_id: dunningCase.subscription_id,
    renewal_cycle_id: dunningCase.renewal_cycle_id,
    message: `DunningCase '${dunningCase.id}' awaiting its retry's payment was resolved as ${resolution} by an admin`,
    metadata: { reason: input.reason, triggered_by: input.triggered_by },
  })

  return resolution
}

export const POST = async (
  req: AuthenticatedMedusaRequest<PostAdminResolveAwaitingDunningPaymentSchemaType>,
  res: MedusaResponse
) => {
  let resolution: DunningAwaitingPaymentAdminResolution

  try {
    resolution = await resolveAwaitingPayment(req.scope, {
      dunning_case_id: req.params.id,
      reason: req.validatedBody.reason ?? null,
      triggered_by: req.auth_context.actor_id,
    })
  } catch (error) {
    const mapped = mapDunningAdminRouteError(error)

    return res.status(mapped.status).json({
      type: mapped.type,
      message: mapped.message,
    })
  }

  const response = await getAdminDunningDetailResponse(req.scope, req.params.id)

  return res.status(200).json({ ...response, resolution })
}
