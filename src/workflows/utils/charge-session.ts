import type { MedusaContainer } from "@medusajs/framework/types"
import { PaymentSessionStatus } from "@medusajs/framework/utils"
import type { SubscriptionSourceSnapshot } from "../../modules/subscription/types"
import type { RenewalExecutionContext } from "../steps/process-renewal-cycle"
import {
  loadOrderPaymentCollections,
  type PaymentSessionRecord,
} from "./customer-payment-in-progress"
import type { RenewalSettlementAudit } from "./settle-renewal-cycle-succeeded"

export type RenewalChargeContext = Omit<RenewalSettlementAudit, "attempt_no"> &
  Pick<RenewalExecutionContext, "reason"> & { source_snapshot: SubscriptionSourceSnapshot | null }

export const ChargeSessionMarker = {
  RENEWAL: "renewal_attempt_id",
  DUNNING: "dunning_attempt_id",
} as const

export type ChargeSessionMarker =
  (typeof ChargeSessionMarker)[keyof typeof ChargeSessionMarker]

const CHARGE_UNDER_WAY_SESSION_STATUSES: readonly string[] = [
  PaymentSessionStatus.PENDING_AUTHORIZATION,
  PaymentSessionStatus.AUTHORIZED,
  PaymentSessionStatus.CAPTURED,
]

type ChargeAttempt = { id: string, payment_reference: string | null, order_id: string | null }

export async function findChargeSession(
  container: MedusaContainer,
  attempt: ChargeAttempt,
  marker: ChargeSessionMarker
): Promise<PaymentSessionRecord | null> {
  if (!attempt.order_id) {
    return null
  }

  const sessions = (await loadOrderPaymentCollections(container, attempt.order_id))
    .flatMap((collection) => collection.payment_sessions ?? [])

  return (
    sessions.find((session) => session.id === attempt.payment_reference) ??
    sessions.find((session) => session.context?.[marker] === attempt.id) ??
    null
  )
}

export async function isChargeUnderWay(
  container: MedusaContainer,
  attempt: ChargeAttempt,
  marker: ChargeSessionMarker
) {
  const session = await findChargeSession(container, attempt, marker)

  return CHARGE_UNDER_WAY_SESSION_STATUSES.includes(String(session?.status))
}
