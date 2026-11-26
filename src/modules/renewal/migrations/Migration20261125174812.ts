import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261125174812 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "renewal_cycle" drop constraint if exists "renewal_cycle_status_check";`);

    this.addSql(`alter table if exists "renewal_cycle" add constraint "renewal_cycle_status_check" check("status" in ('scheduled', 'processing', 'succeeded', 'failed', 'awaiting_payment'));`);
  }

  override async down(): Promise<void> {
    // Older code never settles or fails a parked charge, and any status it does act on could charge
    // the order again, so the rows have to be resolved by hand first.
    const [{ count }] = await this.execute(`select count(*)::int as "count" from "renewal_cycle" where "status" = 'awaiting_payment';`);

    if (count > 0) {
      throw new Error(`${count} renewal cycle(s) still await a payment answer: settle or fail them before reverting Migration20261125174812`);
    }

    this.addSql(`alter table if exists "renewal_cycle" drop constraint if exists "renewal_cycle_status_check";`);

    this.addSql(`alter table if exists "renewal_cycle" add constraint "renewal_cycle_status_check" check("status" in ('scheduled', 'processing', 'succeeded', 'failed'));`);
  }

}
