import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261111090000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "renewal_cycle" drop constraint if exists "renewal_cycle_status_check";`);

    this.addSql(`alter table if exists "renewal_cycle" add column if not exists "settlement_inputs" jsonb null;`);
    this.addSql(`alter table if exists "renewal_cycle" add constraint "renewal_cycle_status_check" check("status" in ('scheduled', 'processing', 'succeeded', 'failed', 'awaiting_payment'));`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "renewal_cycle" drop constraint if exists "renewal_cycle_status_check";`);

    this.addSql(`update "renewal_cycle" set "status" = 'processing' where "status" = 'awaiting_payment';`);

    this.addSql(`alter table if exists "renewal_cycle" drop column if exists "settlement_inputs";`);

    this.addSql(`alter table if exists "renewal_cycle" add constraint "renewal_cycle_status_check" check("status" in ('scheduled', 'processing', 'succeeded', 'failed'));`);
  }

}
