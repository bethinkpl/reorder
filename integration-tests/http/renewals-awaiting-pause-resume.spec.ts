import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import path from "path"
import { Modules } from "@medusajs/framework/utils"
import { CANCELLATION_MODULE } from "../../src/modules/cancellation"
import type CancellationModuleService from "../../src/modules/cancellation/service"
import {
  CancellationCaseStatus,
  RetentionOfferType,
} from "../../src/modules/cancellation/types"
import { DunningCaseStatus } from "../../src/modules/dunning/types"
import { RenewalCycleStatus } from "../../src/modules/renewal/types"
import { renewalSubscriptionLockKey } from "../../src/modules/renewal/utils/lock-key"
import { SUBSCRIPTION_MODULE } from "../../src/modules/subscription"
import type SubscriptionModuleService from "../../src/modules/subscription/service"
import { SubscriptionStatus } from "../../src/modules/subscription/types"
import { seedDunningCase } from "../helpers/awaiting-dunning-fixtures"
import {
  readRenewalState,
  seedAwaitingRenewal,
  whileRenewalLockHeld,
} from "../helpers/awaiting-renewal-fixtures"
import { createCancellationCaseSeed } from "../helpers/cancellation-fixtures"
import { captureOnOrder, deliverCapture, deliverFailure } from "../helpers/payment-fixtures"
import { createAdminAuthHeaders } from "../helpers/renewal-fixtures"
import { createStoreCustomerHeaders } from "../helpers/store-fixtures"

jest.setTimeout(120 * 1000)

const DAY_MS = 24 * 60 * 60 * 1000

type RequestOptions = { headers: Record<string, string> }

const storeRefusal = {
  status: 409,
  data: {
    type: "conflict",
    code: "renewal_payment_in_progress",
    message: "A payment for this subscription is being processed. Please try again once it has completed.",
  },
}

function adminRefusal(action: string, charge: RegExp) {
  return {
    status: 409,
    data: {
      type: "conflict",
      message: expect.stringMatching(new RegExp(`can't ${action} while ${charge.source}`)),
    },
  }
}

medusaIntegrationTestRunner({
  medusaConfigFile: path.resolve(process.cwd(), "integration-tests"),
  env: { JWT_SECRET: "supersecret", COOKIE_SECRET: "supersecret" },
  testSuite: ({ api, getContainer }) => {
    const subscriptions = () => getContainer().resolve<SubscriptionModuleService>(SUBSCRIPTION_MODULE)
    const cancellations = () => getContainer().resolve<CancellationModuleService>(CANCELLATION_MODULE)

    afterEach(() => {
      jest.restoreAllMocks()
      jest.clearAllMocks()
    })

    async function refusalOf(request: Promise<unknown>) {
      return ((await request.catch((error: { response?: unknown }) => error)) as { response?: unknown })
        .response
    }

    async function expectRenewalLockFree(subscriptionId: string) {
      const locking = getContainer().resolve(Modules.LOCKING)
      const key = renewalSubscriptionLockKey(subscriptionId)

      await expect(locking.acquire(key, { ownerId: "lock-probe", expire: 5 })).resolves.toBeUndefined()
      await locking.release(key, { ownerId: "lock-probe" })
    }

    async function asAdmin(): Promise<RequestOptions> {
      return { headers: await createAdminAuthHeaders(getContainer()) }
    }

    async function asCustomer(subscriptionId: string): Promise<RequestOptions> {
      const { customer_id } = await subscriptions().retrieveSubscription(subscriptionId)

      return { headers: await createStoreCustomerHeaders(getContainer(), customer_id) }
    }

    const adminUrl = (id: string, action: string) => `/admin/subscriptions/${id}/${action}`
    const storeUrl = (id: string, action: string) => `/store/customers/me/subscriptions/${id}/${action}`

    describe("pausing while a renewal charge awaits the provider's answer", () => {
      it("refuses an admin and a customer pause with a reason, writes nothing and frees the lock, then pauses once the capture settled the renewal", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, { reference: "SUB-AWP-PAUSE" })
        const id = seeded.subscription.id
        const admin = await asAdmin()
        const before = await readRenewalState(container, seeded)

        expect(await refusalOf(api.post(adminUrl(id, "pause"), {}, admin))).toMatchObject(
          adminRefusal("be paused", new RegExp(`renewal '${seeded.cycle.id}' is awaiting its payment`))
        )
        expect(await refusalOf(api.post(storeUrl(id, "pause"), {}, await asCustomer(id)))).toMatchObject(
          storeRefusal
        )
        expect(await readRenewalState(container, seeded)).toEqual(before)
        await expectRenewalLockFree(id)

        const payment = await captureOnOrder(container, seeded.order.id, seeded.session.id)
        await deliverCapture(container, payment.id)

        const response = await api.post(adminUrl(id, "pause"), {}, admin)
        const paused = await readRenewalState(container, seeded)

        expect(response.status).toEqual(200)
        expect(paused.cycle.status).toEqual(RenewalCycleStatus.SUCCEEDED)
        expect(paused.subscription).toMatchObject({
          status: SubscriptionStatus.PAUSED,
          next_renewal_at: expect.any(Date),
        })
        await expectRenewalLockFree(id)
      })

      it.each([
        {
          name: "a renewal left processing after submitting its charge",
          charge: /renewal '.+' has a charge in progress/,
          seed: async (reference: string) => {
            const seeded = await seedAwaitingRenewal(getContainer(), {
              reference,
              cycle_status: RenewalCycleStatus.PROCESSING,
            })

            return { subscriptionId: seeded.subscription.id, sessionId: seeded.session.id }
          },
        },
        ...[DunningCaseStatus.RETRYING, DunningCaseStatus.AWAITING_PAYMENT].map((status) => ({
          name: `a dunning case is ${status}`,
          charge: /dunning case '.+' has a retry charge in progress/,
          seed: async (reference: string) => {
            const seeded = await seedDunningCase(getContainer(), reference, { status })

            return { subscriptionId: seeded.subscription.id, sessionId: seeded.attempts[0].session.id }
          },
        })),
      ])("refuses a pause while $name, and pauses once the charge failed", async ({ name, charge, seed }) => {
        const { subscriptionId, sessionId } = await seed(`SUB-AWP-PAUSE-${name}`)
        const admin = await asAdmin()

        expect(await refusalOf(api.post(adminUrl(subscriptionId, "pause"), {}, admin))).toMatchObject(
          adminRefusal("be paused", charge)
        )
        expect(
          await refusalOf(api.post(storeUrl(subscriptionId, "pause"), {}, await asCustomer(subscriptionId)))
        ).toMatchObject(storeRefusal)
        expect((await subscriptions().retrieveSubscription(subscriptionId)).status).not.toEqual(
          SubscriptionStatus.PAUSED
        )
        await expectRenewalLockFree(subscriptionId)

        await deliverFailure(getContainer(), sessionId, { reason: "declined" })

        const response = await api.post(adminUrl(subscriptionId, "pause"), {}, admin)

        expect(response.status).toEqual(200)
        expect((await subscriptions().retrieveSubscription(subscriptionId)).status).toEqual(
          SubscriptionStatus.PAUSED
        )
      })

      it("answers a conflict and writes nothing while a renewal run holds the lock", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, {
          reference: "SUB-AWP-LOCKED",
          cycle_status: RenewalCycleStatus.SUCCEEDED,
        })
        const id = seeded.subscription.id
        const admin = await asAdmin()
        const customer = await asCustomer(id)
        const before = await readRenewalState(container, seeded)

        const [adminAnswer, storeAnswer] = await whileRenewalLockHeld(container, id, async () => [
          await refusalOf(api.post(adminUrl(id, "pause"), {}, admin)),
          await refusalOf(api.post(storeUrl(id, "pause"), {}, customer)),
        ])

        expect(adminAnswer).toMatchObject({
          status: 409,
          data: { type: "conflict", message: expect.stringContaining("is being updated by a renewal") },
        })
        expect(storeAnswer).toMatchObject({
          status: 409,
          data: {
            type: "conflict",
            message: "This subscription is already being updated. Please try again in a moment.",
          },
        })
        expect(await readRenewalState(container, seeded)).toEqual(before)
        await expectRenewalLockFree(id)
      })
    })

    describe("resuming while a renewal charge awaits the provider's answer", () => {
      it("refuses an admin resume with and without a resume date and a customer resume, creating no cycle, and resumes once the charge failed", async () => {
        const container = getContainer()
        const seeded = await seedAwaitingRenewal(container, {
          reference: "SUB-AWP-RESUME",
          subscription_status: SubscriptionStatus.PAUSED,
        })
        const id = seeded.subscription.id
        const admin = await asAdmin()
        const resumeAt = new Date(Date.now() + 7 * DAY_MS).toISOString()
        const charge = new RegExp(`renewal '${seeded.cycle.id}' is awaiting its payment`)
        const before = await readRenewalState(container, seeded)

        for (const body of [{}, { resume_at: resumeAt }]) {
          expect(await refusalOf(api.post(adminUrl(id, "resume"), body, admin))).toMatchObject(
            adminRefusal("be resumed", charge)
          )
        }
        expect(
          await refusalOf(api.post(storeUrl(id, "resume"), { resume_at: resumeAt }, await asCustomer(id)))
        ).toMatchObject(storeRefusal)
        expect(await readRenewalState(container, seeded)).toEqual(before)
        await expectRenewalLockFree(id)

        await deliverFailure(container, seeded.session.id, { reason: "declined" })

        const response = await api.post(adminUrl(id, "resume"), { resume_at: resumeAt }, admin)
        const resumed = await readRenewalState(container, seeded)

        expect(response.status).toEqual(200)
        expect(resumed.cycle.status).toEqual(RenewalCycleStatus.FAILED)
        expect(resumed.subscription).toMatchObject({
          status: SubscriptionStatus.ACTIVE,
          next_renewal_at: new Date(resumeAt),
        })
        expect(resumed.otherCycles).toEqual([
          expect.objectContaining({ status: RenewalCycleStatus.SCHEDULED, scheduled_for: new Date(resumeAt) }),
        ])
      })
    })

    describe("accepting a retention offer while a renewal charge awaits the provider's answer", () => {
      const applyOffer = (caseId: string, body: Record<string, unknown>, options: RequestOptions) =>
        api.post(`/admin/cancellations/${caseId}/apply-offer`, body, options)
      const pauseOffer = {
        offer_type: RetentionOfferType.PAUSE_OFFER,
        offer_payload: { pause_offer: { pause_cycles: 1, resume_at: null, note: null } },
      }
      const bonusOffer = {
        offer_type: RetentionOfferType.BONUS_OFFER,
        offer_payload: {
          bonus_offer: { bonus_type: "gift", value: null, label: "Mug", duration_cycles: null, note: null },
        },
      }

      async function seedCaseOnAwaitingRenewal(reference: string) {
        const seeded = await seedAwaitingRenewal(getContainer(), { reference })
        const cancellationCase = await createCancellationCaseSeed(getContainer(), {
          subscription_id: seeded.subscription.id,
          status: CancellationCaseStatus.EVALUATING_RETENTION,
        })

        return { seeded, cancellationCase }
      }

      it("refuses a pause offer without recording it, then applies it once the capture settled the renewal", async () => {
        const container = getContainer()
        const admin = await asAdmin()
        const { seeded, cancellationCase } = await seedCaseOnAwaitingRenewal("SUB-AWP-OFFER-PAUSE")
        const caseBefore = await cancellations().retrieveCancellationCase(cancellationCase.id)
        const renewalBefore = await readRenewalState(container, seeded)

        expect(await refusalOf(applyOffer(cancellationCase.id, pauseOffer, admin))).toMatchObject(
          adminRefusal("be paused", new RegExp(`renewal '${seeded.cycle.id}' is awaiting its payment`))
        )
        expect(await cancellations().retrieveCancellationCase(cancellationCase.id)).toEqual(caseBefore)
        expect(
          await cancellations().listRetentionOfferEvents({ cancellation_case_id: cancellationCase.id })
        ).toHaveLength(0)
        expect(await readRenewalState(container, seeded)).toEqual(renewalBefore)
        await expectRenewalLockFree(seeded.subscription.id)

        const payment = await captureOnOrder(container, seeded.order.id, seeded.session.id)
        await deliverCapture(container, payment.id)

        const response = await applyOffer(cancellationCase.id, pauseOffer, admin)

        expect(response.status).toEqual(200)
        expect(await cancellations().retrieveCancellationCase(cancellationCase.id)).toMatchObject({
          status: CancellationCaseStatus.PAUSED,
        })
        expect((await subscriptions().retrieveSubscription(seeded.subscription.id)).status).toEqual(
          SubscriptionStatus.PAUSED
        )
      })

      it("applies an offer that does not pause the subscription", async () => {
        const admin = await asAdmin()
        const { seeded, cancellationCase } = await seedCaseOnAwaitingRenewal("SUB-AWP-OFFER-BONUS")

        const response = await applyOffer(cancellationCase.id, bonusOffer, admin)

        expect(response.status).toEqual(200)
        expect(await cancellations().retrieveCancellationCase(cancellationCase.id)).toMatchObject({
          status: CancellationCaseStatus.RETAINED,
        })
        expect((await readRenewalState(getContainer(), seeded)).cycle.status).toEqual(
          RenewalCycleStatus.AWAITING_PAYMENT
        )
        await expectRenewalLockFree(seeded.subscription.id)
      })
    })
  },
})
