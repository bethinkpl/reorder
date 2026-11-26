import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261125174811 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "dunning_case" drop constraint if exists "dunning_case_status_check";`);

    this.addSql(`alter table if exists "dunning_case" add constraint "dunning_case_status_check" check("status" in ('open', 'retry_scheduled', 'retrying', 'awaiting_payment', 'awaiting_manual_resolution', 'recovered', 'unrecovered'));`);
  }

  override async down(): Promise<void> {
    // Older code never settles or fails a parked charge, and any status it does act on could charge
    // the order again, so the rows have to be resolved by hand first.
    const [{ count }] = await this.execute(`select count(*)::int as "count" from "dunning_case" where "status" = 'awaiting_payment';`);

    if (count > 0) {
      throw new Error(`${count} dunning case(s) still await a payment answer: settle or fail them before reverting Migration20261125174811`);
    }

    this.addSql(`alter table if exists "dunning_case" drop constraint if exists "dunning_case_status_check";`);

    this.addSql(`alter table if exists "dunning_case" add constraint "dunning_case_status_check" check("status" in ('open', 'retry_scheduled', 'retrying', 'awaiting_manual_resolution', 'recovered', 'unrecovered'));`);
  }

}
