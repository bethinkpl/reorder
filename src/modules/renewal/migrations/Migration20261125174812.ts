import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261125174812 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "renewal_cycle" drop constraint if exists "renewal_cycle_status_check";`);

    this.addSql(`alter table if exists "renewal_cycle" add constraint "renewal_cycle_status_check" check("status" in ('scheduled', 'processing', 'succeeded', 'failed', 'awaiting_payment'));`);
  }

  override async down(): Promise<void> {
    this.addSql(`update "renewal_cycle" set "status" = 'processing' where "status" = 'awaiting_payment';`);
    this.addSql(`alter table if exists "renewal_cycle" drop constraint if exists "renewal_cycle_status_check";`);

    this.addSql(`alter table if exists "renewal_cycle" add constraint "renewal_cycle_status_check" check("status" in ('scheduled', 'processing', 'succeeded', 'failed'));`);
  }

}
