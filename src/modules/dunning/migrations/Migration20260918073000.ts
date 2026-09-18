import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260918073000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "dunning_attempt" drop constraint if exists "dunning_attempt_status_check";`);

    this.addSql(`alter table if exists "dunning_attempt" add constraint "dunning_attempt_status_check" check("status" in ('processing', 'succeeded', 'failed', 'aborted'));`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "dunning_attempt" drop constraint if exists "dunning_attempt_status_check";`);

    this.addSql(`alter table if exists "dunning_attempt" add constraint "dunning_attempt_status_check" check("status" in ('processing', 'succeeded', 'failed'));`);
  }

}
