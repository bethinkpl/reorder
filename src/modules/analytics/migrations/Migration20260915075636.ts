import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260915075636 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "subscription_metrics_daily" drop constraint if exists "subscription_metrics_daily_status_check";`);

    this.addSql(`alter table if exists "subscription_metrics_daily" add constraint "subscription_metrics_daily_status_check" check("status" in ('pending_payment', 'active', 'paused', 'cancelled', 'past_due', 'payment_failed'));`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "subscription_metrics_daily" drop constraint if exists "subscription_metrics_daily_status_check";`);

    this.addSql(`alter table if exists "subscription_metrics_daily" add constraint "subscription_metrics_daily_status_check" check("status" in ('active', 'paused', 'cancelled', 'past_due'));`);
  }

}
