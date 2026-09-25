import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260915075637 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "subscription" drop constraint if exists "subscription_status_check";`);

    this.addSql(`alter table if exists "subscription" add constraint "subscription_status_check" check("status" in ('pending_payment', 'active', 'paused', 'cancelled', 'past_due', 'payment_failed'));`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "subscription" drop constraint if exists "subscription_status_check";`);

    this.addSql(`alter table if exists "subscription" add constraint "subscription_status_check" check("status" in ('active', 'paused', 'cancelled', 'past_due'));`);
  }

}
