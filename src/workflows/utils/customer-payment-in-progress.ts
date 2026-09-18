import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

export type PaymentSessionRecord = {
  id: string
  status?: string | null
  context?: Record<string, unknown> | null
  data?: Record<string, unknown> | null
  created_at?: Date | string | null
}

export type PaymentCollectionRecord = {
  id: string
  status?: string | null
  payment_sessions?: PaymentSessionRecord[] | null
}

type OrderPaymentCollectionsRecord = {
  id: string
  payment_collections?: PaymentCollectionRecord[] | null
}

/** How long a session the customer opened counts as one they may still be paying on. */
export const CUSTOMER_SESSION_LIVE_MINUTES = 60

/**
 * The statuses a session the customer could still be paying on carries. String literals rather than
 * `PaymentSessionStatus`: `pending_authorization` is missing from this Medusa version's enum but is
 * where newer hosts leave a redirect flow the customer has yet to come back from.
 */
const CUSTOMER_LIVE_SESSION_STATUSES: readonly string[] = [
  "pending",
  "pending_authorization",
  "requires_more",
]

/** The collection statuses core cancels and recreates, throwing away whatever they hold. */
const AUTHORIZED_COLLECTION_STATUSES: readonly string[] = [
  "authorized",
  "partially_authorized",
]

/**
 * Every payment session on every payment collection of the order.
 *
 * Creating a session deletes every session already on the collection it lands on, and an authorized
 * collection is cancelled and recreated, so anything charging this order automatically has to see
 * what is there before it touches anything.
 */
export async function loadOrderPaymentCollections(
  container: MedusaContainer,
  id: string
): Promise<PaymentCollectionRecord[]> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "payment_collections.id",
      "payment_collections.status",
      "payment_collections.payment_sessions.id",
      "payment_collections.payment_sessions.status",
      "payment_collections.payment_sessions.context",
      "payment_collections.payment_sessions.data",
      "payment_collections.payment_sessions.created_at",
    ],
    filters: {
      id: [id],
    },
  })

  const order = (data as OrderPaymentCollectionsRecord[])[0]

  return order?.payment_collections ?? []
}

/** A hosted checkout session the provider already timed out is not one anybody is still paying on. */
function isExpiredSessionData(
  data: Record<string, unknown> | null | undefined,
  now: Date
) {
  const expiresAt = data?.expiresAt

  return typeof expiresAt === "number" && expiresAt * 1000 <= now.getTime()
}

/**
 * Whether one of our own automatic charges opened this session rather than the customer. The two
 * markers are what keep the renewal job and the dunning retry from reading each other's sessions as
 * a customer's and stepping aside forever.
 */
function isOurSession(session: PaymentSessionRecord) {
  return Boolean(
    session.context?.dunning_case_id || session.context?.renewal_cycle_id
  )
}

/**
 * Whether the customer may be paying on this session right now.
 *
 * Sessions we create mark themselves with `context.dunning_case_id`, so a session without that
 * marker belongs to someone else - the host app's own checkout - and deleting it drops the customer
 * out of a payment they are in the middle of. A session whose `created_at` can't be read counts as
 * not live: the callers of this never escalate on their own, so a predicate that can never age out
 * would block the order forever.
 */
export function isCustomerLiveSession(session: PaymentSessionRecord, now: Date) {
  if (
    !CUSTOMER_LIVE_SESSION_STATUSES.includes(
      String(session.status ?? "").toLowerCase()
    )
  ) {
    return false
  }

  const context = session.context ?? {}

  if (context.initiated_by !== "customer" && isOurSession(session)) {
    return false
  }

  const createdAt = session.created_at ? new Date(session.created_at) : null

  if (!createdAt || Number.isNaN(createdAt.getTime())) {
    return false
  }

  if (
    now.getTime() - createdAt.getTime() >=
    CUSTOMER_SESSION_LIVE_MINUTES * 60 * 1000
  ) {
    return false
  }

  return !isExpiredSessionData(session.data, now)
}

/**
 * A collection holding an authorization somebody else took. One of our own is ours to capture or
 * abandon: treating it as a conflict would deadlock the order, because the authorization outlives
 * the run that took it and nothing else would ever clear it.
 */
function isForeignAuthorizedCollection(collection: PaymentCollectionRecord) {
  if (
    !AUTHORIZED_COLLECTION_STATUSES.includes(
      String(collection.status ?? "").toLowerCase()
    )
  ) {
    return false
  }

  return !(collection.payment_sessions ?? []).some(isOurSession)
}

/**
 * Whether charging this order automatically would destroy a payment already under way: a session
 * the customer is on, or somebody else's authorized collection that
 * `createOrUpdateOrderPaymentCollectionWorkflow` cancels and recreates.
 */
export function hasCustomerPaymentInProgress(
  paymentCollections: PaymentCollectionRecord[],
  now: Date
) {
  return paymentCollections.some(
    (collection) =>
      isForeignAuthorizedCollection(collection) ||
      (collection.payment_sessions ?? []).some((session) =>
        isCustomerLiveSession(session, now)
      )
  )
}
