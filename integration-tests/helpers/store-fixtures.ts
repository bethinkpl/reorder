import jwt from "jsonwebtoken"
import type { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

export async function createStoreCustomerHeaders(
  container: MedusaContainer,
  customerId: string
) {
  const apiKey = await container.resolve(Modules.API_KEY).createApiKeys({
    title: "Storefront",
    type: "publishable",
    created_by: "store-customer-headers",
  })
  const token = jwt.sign(
    {
      actor_id: customerId,
      actor_type: "customer",
      auth_identity_id: `authid_${customerId}`,
      app_metadata: { customer_id: customerId },
      user_metadata: {},
    },
    process.env.JWT_SECRET || "supersecret",
    { expiresIn: "1d" }
  )

  return { "authorization": `Bearer ${token}`, "x-publishable-api-key": apiKey.token }
}
