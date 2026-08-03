import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260706163601 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "renewal_job_cursor" drop constraint if exists "renewal_job_cursor_job_name_unique";`);
    this.addSql(`create table if not exists "renewal_job_cursor" ("id" text not null, "job_name" text not null, "window_key" text not null, "cursor" text not null default '', "last_run_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "renewal_job_cursor_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_renewal_job_cursor_job_name_unique" ON "renewal_job_cursor" ("job_name") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_renewal_job_cursor_deleted_at" ON "renewal_job_cursor" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "renewal_job_cursor" cascade;`);
  }

}
