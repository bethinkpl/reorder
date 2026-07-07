import { model } from "@medusajs/framework/utils"

const RenewalJobCursor = model.define("renewal_job_cursor", {
  id: model.id().primaryKey(),
  job_name: model.text().unique(),
  window_key: model.text(),
  cursor: model.text().default(""),
  last_run_at: model.dateTime().nullable(),
})

export default RenewalJobCursor
