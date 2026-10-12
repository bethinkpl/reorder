import type { MedusaContainer } from "@medusajs/framework/types"
import { PLAN_OFFER_MODULE } from ".."
import type PlanOfferModuleService from "../service"
import type {
  PlanOfferAllowedFrequency,
  PlanOfferDiscountPerFrequency,
  PlanOfferRules,
  ProductSubscriptionConfig,
} from "../types"
import { PlanOfferScope } from "../types"

type PlanOfferRecord = {
  id: string
  scope: "product" | "variant"
  product_id: string
  variant_id: string | null
  allowed_frequencies: PlanOfferAllowedFrequency[]
  discount_per_frequency: PlanOfferDiscountPerFrequency[] | null
  rules: PlanOfferRules | null
}

const effectiveConfigFields = [
  "id",
  "scope",
  "product_id",
  "variant_id",
  "allowed_frequencies",
  "discount_per_frequency",
  "rules",
] as const

export function mapRecordToEffectiveConfig(
  record: PlanOfferRecord
): ProductSubscriptionConfig {
  return {
    product_id: record.product_id,
    variant_id: record.variant_id,
    source_offer_id: record.id,
    source_scope:
      record.scope === "product"
        ? PlanOfferScope.PRODUCT
        : PlanOfferScope.VARIANT,
    is_enabled: true,
    allowed_frequencies: record.allowed_frequencies ?? [],
    discount_per_frequency: record.discount_per_frequency ?? [],
    rules: record.rules,
  }
}

export function getInactiveEffectiveConfig(input: {
  product_id: string
  variant_id?: string | null
}): ProductSubscriptionConfig {
  return {
    product_id: input.product_id,
    variant_id: input.variant_id ?? null,
    source_offer_id: null,
    source_scope: null,
    is_enabled: false,
    allowed_frequencies: [],
    discount_per_frequency: [],
    rules: null,
  }
}

export type SubscriptionConfigTarget = {
  product_id: string
  variant_id?: string | null
}

async function listEnabledPlanOffers(
  planOfferService: PlanOfferModuleService,
  filters:
    | { scope: PlanOfferScope.VARIANT, variant_id: string[] }
    | { scope: PlanOfferScope.PRODUCT, product_id: string[] }
): Promise<PlanOfferRecord[]> {
  const records = await planOfferService.listPlanOffers(
    { ...filters, is_enabled: true },
    { select: [...effectiveConfigFields] }
  )

  return records as unknown as PlanOfferRecord[]
}

export async function resolveProductSubscriptionConfigs(
  planOfferService: PlanOfferModuleService,
  targets: SubscriptionConfigTarget[]
): Promise<ProductSubscriptionConfig[]> {
  if (targets.length === 0) {
    return []
  }

  const variantIds = [
    ...new Set(
      targets.flatMap((target) => (target.variant_id ? [target.variant_id] : []))
    ),
  ]
  const productIds = [...new Set(targets.map((target) => target.product_id))]

  const [variantRecords, productRecords] = await Promise.all([
    variantIds.length > 0
      ? listEnabledPlanOffers(planOfferService, {
          scope: PlanOfferScope.VARIANT,
          variant_id: variantIds,
        })
      : [],
    listEnabledPlanOffers(planOfferService, {
      scope: PlanOfferScope.PRODUCT,
      product_id: productIds,
    }),
  ])

  const variantRecordsById = new Map(
    variantRecords.map((record) => [record.variant_id, record])
  )
  const productRecordsById = new Map(
    productRecords.map((record) => [record.product_id, record])
  )

  return targets.map((target) => {
    const variantRecord = target.variant_id
      ? variantRecordsById.get(target.variant_id)
      : undefined

    if (variantRecord) {
      return mapRecordToEffectiveConfig(variantRecord)
    }

    const productRecord = productRecordsById.get(target.product_id)

    if (productRecord) {
      return {
        ...mapRecordToEffectiveConfig(productRecord),
        variant_id: target.variant_id ?? null,
      }
    }

    return getInactiveEffectiveConfig(target)
  })
}

export async function resolveProductSubscriptionConfig(
  container: MedusaContainer,
  input: SubscriptionConfigTarget
): Promise<ProductSubscriptionConfig> {
  const [config] = await resolveProductSubscriptionConfigs(
    container.resolve<PlanOfferModuleService>(PLAN_OFFER_MODULE),
    [input]
  )

  return config
}
