import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261111090100 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "dunning_case" drop constraint if exists "dunning_case_status_check";`);

    this.addSql(`alter table if exists "dunning_case" add constraint "dunning_case_status_check" check("status" in ('open', 'retry_scheduled', 'retrying', 'awaiting_payment', 'awaiting_manual_resolution', 'recovered', 'unrecovered'));`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "dunning_case" drop constraint if exists "dunning_case_status_check";`);

    // 'retrying' is the one old open status no retry charges ('awaiting_manual_resolution' can be retried).
    this.addSql(`update "dunning_case" set "status" = 'retrying' where "status" = 'awaiting_payment';`);

    this.addSql(`alter table if exists "dunning_case" add constraint "dunning_case_status_check" check("status" in ('open', 'retry_scheduled', 'retrying', 'awaiting_manual_resolution', 'recovered', 'unrecovered'));`);
  }

}
