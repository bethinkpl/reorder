import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261120034321 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "renewal_attempt" add column if not exists "reported_payment_failure" jsonb null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "renewal_attempt" drop column if exists "reported_payment_failure";`);
  }

}
