import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import type { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { RENEWAL_MODULE } from "../../../../../modules/renewal"
import type RenewalModuleService from "../../../../../modules/renewal/service"
import { RenewalCycleStatus } from "../../../../../modules/renewal/types"
import {
  isAwaitingPaymentOverdue,
  resolveAwaitingPaymentAlertHours,
} from "../../../../../modules/renewal/utils/awaiting-payment-age"
import { renewalErrors } from "../../../../../modules/renewal/utils/errors"
import {
  createRenewalCorrelationId,
  logRenewalEvent,
} from "../../../../../modules/renewal/utils/observability"
import { failAwaitingRenewalCycleUnderLock } from "../../../../../workflows/utils/fail-awaiting-renewal-cycle"
import { settleAwaitingRenewalCycleUnderLock } from "../../../../../workflows/utils/settle-awaiting-renewal-cycle"
import {
  getAdminRenewalDetailResponse,
  mapRenewalAdminRouteError,
} from "../../utils"
import type { PostAdminResolveAwaitingRenewalPaymentSchemaType } from "../../validators"

const RENEWAL_LOCK_TIMEOUT_SECONDS = 30
const UNPAID_ERROR_CODE = "resolved_unpaid"

const RESOLVABLE_STATUSES: readonly RenewalCycleStatus[] = [
  RenewalCycleStatus.AWAITING_PAYMENT,
  RenewalCycleStatus.PROCESSING,
]

type AwaitingPaymentResolution = "settled" | "failed"

type LatestRenewalAttempt = Awaited<
  ReturnType<RenewalModuleService["listRenewalAttempts"]>
>[number]

type ResolveAwaitingPaymentInput = {
  renewal_cycle_id: string
  reason: string | null
  triggered_by: string | null
}

function notAwaitingPayment(renewalCycleId: string) {
  return renewalErrors.conflict(
    `Renewal '${renewalCycleId}' isn't awaiting its payment`
  )
}

function noAttemptToFail(renewalCycleId: string) {
  return renewalErrors.conflict(
    `Renewal '${renewalCycleId}' has no payment attempt in progress to fail`
  )
}

function paymentMayStillArrive(renewalCycleId: string, alertHours: number) {
  return renewalErrors.conflict(
    `Renewal '${renewalCycleId}' is unpaid, but its payment may still arrive; it can be resolved as failed once it has waited for more than ${alertHours} hours`
  )
}

async function failUnpaidUnderLock(
  container: MedusaContainer,
  input: ResolveAwaitingPaymentInput,
  attempt: LatestRenewalAttempt | undefined
): Promise<AwaitingPaymentResolution> {
  if (!attempt) {
    throw noAttemptToFail(input.renewal_cycle_id)
  }

  const alertHours = resolveAwaitingPaymentAlertHours()

  if (!isAwaitingPaymentOverdue(attempt.started_at, new Date(), alertHours)) {
    throw paymentMayStillArrive(input.renewal_cycle_id, alertHours)
  }

  const message = input.reason
    ? `Renewal payment never arrived; resolved as failed by an admin: ${input.reason}`
    : "Renewal payment never arrived; resolved as failed by an admin"
  const failed = await failAwaitingRenewalCycleUnderLock(container, {
    renewal_cycle_id: input.renewal_cycle_id,
    session_id: attempt.payment_reference,
    attempt_id: attempt.id,
    action: UNPAID_ERROR_CODE,
    reason: null,
    message,
  })

  if (!failed) {
    throw noAttemptToFail(input.renewal_cycle_id)
  }

  return "failed"
}

async function resolveUnderLock(
  container: MedusaContainer,
  input: ResolveAwaitingPaymentInput
): Promise<AwaitingPaymentResolution> {
  const [latest] = await container
    .resolve<RenewalModuleService>(RENEWAL_MODULE)
    .listRenewalAttempts(
      { renewal_cycle_id: input.renewal_cycle_id },
      { order: { attempt_no: "DESC" }, take: 1 }
    )
  const outcome = await settleAwaitingRenewalCycleUnderLock(
    container,
    input.renewal_cycle_id,
    latest
      ? {
          processing_signal: {
            session_id: latest.payment_reference,
            attempt_id: latest.id,
          },
        }
      : {}
  )

  switch (outcome) {
    case "settled":
    case "closed_superseded":
      return "settled"
    case "order_unpaid":
      return await failUnpaidUnderLock(container, input, latest)
    case "not_awaiting":
      throw notAwaitingPayment(input.renewal_cycle_id)
    case "subscription_terminal":
      throw renewalErrors.conflict(
        `Renewal '${input.renewal_cycle_id}' is paid but its subscription has ended, so it can't be settled`
      )
  }
}

async function resolveAwaitingPayment(
  container: MedusaContainer,
  input: ResolveAwaitingPaymentInput
): Promise<AwaitingPaymentResolution> {
  const renewalModule = container.resolve<RenewalModuleService>(RENEWAL_MODULE)
  const cycle = await renewalModule.retrieveRenewalCycle(input.renewal_cycle_id)

  if (!RESOLVABLE_STATUSES.includes(cycle.status)) {
    throw notAwaitingPayment(cycle.id)
  }

  const resolution = await container
    .resolve(Modules.LOCKING)
    .execute(
      `renewal:subscription:${cycle.subscription_id}`,
      () => resolveUnderLock(container, input),
      { timeout: RENEWAL_LOCK_TIMEOUT_SECONDS }
    )

  logRenewalEvent(container.resolve("logger"), "info", {
    event: "renewal.awaiting_payment_resolved",
    outcome: resolution === "settled" ? "succeeded" : "failed",
    correlation_id: createRenewalCorrelationId("renewal-admin-resolve"),
    renewal_cycle_id: cycle.id,
    subscription_id: cycle.subscription_id,
    trigger_type: "manual",
    triggered_by: input.triggered_by,
    message: `RenewalCycle '${cycle.id}' awaiting payment was resolved as ${resolution} by an admin`,
    metadata: { reason: input.reason },
  })

  return resolution
}

export const POST = async (
  req: AuthenticatedMedusaRequest<PostAdminResolveAwaitingRenewalPaymentSchemaType>,
  res: MedusaResponse
) => {
  let resolution: AwaitingPaymentResolution

  try {
    resolution = await resolveAwaitingPayment(req.scope, {
      renewal_cycle_id: req.params.id,
      reason: req.validatedBody.reason ?? null,
      triggered_by: req.auth_context.actor_id,
    })
  } catch (error) {
    const mapped = mapRenewalAdminRouteError(error)

    return res.status(mapped.status).json({
      type: mapped.type,
      message: mapped.message,
    })
  }

  const response = await getAdminRenewalDetailResponse(
    req.scope,
    req.params.id
  )

  return res.status(200).json({ ...response, resolution })
}
