# Implementing a Windowed, Sequential, Single-Instance Batch Scheduled Job in Medusa

**Audience.** Engineers building on the Medusa framework who need to implement a
recurring background job with strong operational guarantees. This document is an
*implementation guide/design spec* — it explains which framework mechanisms to
use, which ones **look** right but silently fail under multiple processes, and
gives a complete, correct reference implementation.

**Target feature (verbatim requirements).**

1. Runs **within a time window** (e.g. `05:00`–`09:00`) at a **fixed interval**
   (e.g. every 5 minutes), **every day**.
2. Each consecutive run processes the **next part** of a large dataset
   **sequentially** (10 records at `05:00`, the next 10 at `05:05`, …).
3. **Only one instance of the job may run at a time.**
4. **Each part of the dataset is processed exactly once**, and this must be
   **guaranteed by the job itself** — *not* by mutating a flag on the processed
   records.
5. All of the above must hold when the Medusa app runs across **multiple
   processes**, and for **both** the Redis and the in-memory workflow engines.

> Line numbers in citations are hints against the repository at the time of
> writing; re-read the cited region before relying on an exact location.

---

## 0. TL;DR — requirement → mechanism

| Requirement | Use | Do **not** rely on |
|---|---|---|
| Daily window + fixed interval | A **cron** `config.schedule` (e.g. `*/5 5-8 * * *`) | `{ interval: ms }` — it fires continuously with no window |
| Only one run at a time (multi-process, both engines) | A **distributed lock** via the `Locking` module with a **cross-process provider** (`locking-redis` or `locking-postgres`), acquired **fail-fast** and released in `finally` | `SchedulerOptions.concurrency: "forbid"` — see [§2](#2-the-trap-concurrency-forbid-does-not-do-what-it-looks-like) |
| Sequential, exactly-once parts | A **durable cursor** in a **custom module** + **keyset pagination**; advance the cursor **transactionally** (same-DB work) or make processing **idempotent** (external work) | `OFFSET`; `scheduledFor` slot math; marking source rows |
| "Guaranteed by the job, not by the data" | The cursor is the job's own persisted state; source records are never mutated to record progress | a `processed_at`/`is_processed` column on the dataset |

The two non-obvious facts that drive the whole design:

- **`concurrency: "forbid"` cannot enforce single-execution across processes.**
  It is only *structurally* honoured by the **in-memory** engine, and only
  *within a single process*. The **Redis** engine does **not** enforce it at
  all today (there is an explicit `TODO` in the code). See [§2](#2-the-trap-concurrency-forbid-does-not-do-what-it-looks-like).
- **The lock provider choice is independent of the workflow-engine choice.**
  Correctness (single-execution + exactly-once) is provided entirely by a
  shared-backend lock + a shared-backend cursor. That is why the same design is
  correct under the in-memory engine *and* the Redis engine, across N processes
  — as long as the lock and the cursor live in Postgres/Redis, not in process
  memory.

---

## 1. Background: how a scheduled job actually runs

This section is the minimum internal model you need; the deep dives live in
`local-docs/jobs-and-concurrency/` (`01-worker-modes.md`, `02-scheduled-jobs.md`,
`03-locking-and-exclusivity.md`) and `local-docs/workflow-engine/`.

### 1.1 A scheduled job *is* a scheduled workflow

There is no separate cron daemon. A file under `jobs/` is discovered by
`JobLoader` (`packages/core/framework/src/jobs/job-loader.ts`), which wraps your
handler in a single step and registers a workflow named `job-<config.name>`
with an attached `schedule` (`job-loader.ts:101`). Registration fans out to the
scheduler:

```ts
// packages/core/orchestration/src/workflow/workflow-manager.ts:138
WorkflowManager.workflows.set(workflowId, workflow)
if (options.schedule) {
  this.scheduler.scheduleWorkflow(workflow)   // -> WorkflowScheduler
}
```

`WorkflowScheduler.scheduleWorkflow` (`packages/core/orchestration/src/workflow/scheduler.ts:11`)
**always injects `concurrency: "forbid"`** as the default and forwards to the
backend-specific `IDistributedSchedulerStorage.schedule(jobId, options)`.

The handler is invoked with `(container, { scheduledFor })` — `scheduledFor` is
the timestamp of the *slot* the run is filling (`ScheduledJobContext`,
`packages/core/framework/src/jobs/types.ts`).

### 1.2 Jobs only load on background processors

`workerMode` gates what a process loads (`packages/medusa/src/loaders/index.ts`):

- `jobsLoader` runs only when `workerMode` is `worker` or `shared`
  (`shouldLoadBackgroundProcessors`). A pure `server` process **never registers
  scheduled jobs**.
- `shared` (the dev default) is one process doing everything; production usually
  splits into `server` + one-or-more `worker` processes.

So in a real deployment your job runs on the **worker fleet** — potentially
several processes.

### 1.3 The two scheduler backends behave differently under multiple processes

**In-memory** (`packages/modules/workflow-engine-inmemory/src/utils/workflow-orchestrator-storage.ts`):
`schedule` parses the cron with `cron-parser` and arms a `setTimeout`
(`:645`, `:672`). `jobHandler` (`:703`) runs the workflow and **re-arms the next
timer only after the current run resolves** (`:720`–`:731`):

```ts
await this.workflowOrchestratorService_.run(jobId, { input: { scheduledFor } })
const timer = this.createManagedTimer(() => this.jobHandler(jobId, nextScheduledFor), nextExecution)
```

Consequences:
- Timers live **in process memory**. Every `worker`/`shared` process that loaded
  the job **arms its own timer**. With N processes you get **N fires per slot**.
- Within *one* process, the re-arm-after-resolve pattern means a run cannot
  overlap its own previous run. This is the *only* place `concurrency: "forbid"`
  is real — and it is single-process-scoped.
- Timers are `unref`'d; schedules do not survive a restart (re-armed from the
  job file on boot).

**Redis** (`packages/modules/workflow-engine-redis/src/utils/workflow-orchestrator-storage.ts`,
`RedisDistributedTransactionStorage`): `schedule` (`:790`) registers a **BullMQ
repeatable job** keyed `SCHEDULE_<jobId>` on a dedicated queue
`medusa-workflows-jobs` (`jobQueueName`, `loaders/redis.ts:59`), with `pattern`
= cron (or `every` = interval) and `limit` = `numberOfExecutions`. A single
worker in the fleet picks up each scheduled instance, so the slot fires
**~once across the fleet**. The scheduled instance is dispatched by
`executeScheduledJob` (`:437`).

### 1.4 What "run" does — a fresh transaction id every time

Both backends ultimately call `workflowOrchestratorService.run(jobId, { input: { scheduledFor } })`.
In the orchestrator (`packages/modules/workflow-engine-redis/src/services/workflow-orchestrator.ts:236`):

```ts
context.transactionId = transactionId ?? "auto-" + ulid()
```

Every scheduled fire that does not pass an explicit `transactionId` gets a
**brand-new random transaction id**. There is therefore **no idempotency
dedup** between one slot's run and the next, or between two concurrent fires.

---

## 2. The trap: `concurrency: "forbid"` does not do what it looks like

Requirement (3) — "only one at a time" — looks like it maps directly onto
`SchedulerOptions.concurrency: "forbid"`. It does not, and relying on it is the
single most likely way to ship a broken implementation.

**In-memory engine.** `forbid` is *emergent*, not enforced by a check: the next
timer is armed only after the current `run()` resolves (`:720`–`:731`). This is
correct **only inside one process**. Two `shared`/`worker` processes each keep
their own `scheduled` map and their own timers, so the same slot fires in both
and both runs proceed concurrently.

**Redis engine.** `forbid` is **not implemented**. `executeScheduledJob` just
dispatches a run and carries a `TODO`
(`workflow-engine-redis/src/utils/workflow-orchestrator-storage.ts:443`):

```ts
// TODO: In the case of concurrency being forbidden, we want to generate a predictable transaction ID
// and rely on the idempotency of the transaction to ensure that the transaction is only executed once.
await this.workflowOrchestratorService_.run(jobId, {
  logOnError: true,
  input: { scheduledFor: scheduledFor.toISOString() },
})
```

Because the transaction id is random (`§1.4`), a slow run overlapping the next
slot yields two live, independent transactions. BullMQ schedules the next
repeatable iteration off the wall-clock pattern, not off the previous run's
completion, so overlap is entirely possible.

### Fires-per-slot matrix (why a distributed lock is mandatory)

| Engine | 1 process | N `worker`/`shared` processes |
|---|---|---|
| In-memory | 1 fire/slot; no self-overlap (re-arm after resolve) | **N fires/slot**, fully concurrent |
| Redis | 1 fire/slot; **can overlap** if a run outlasts the interval | ~1 fire/slot; **can overlap** if a run outlasts the interval |

There is **no engine/scheduler configuration** that reduces every cell to
"exactly one run at a time." The only mechanism that does is an
application-level **distributed lock** ([§3](#3-constraint-only-one-run-at-a-time)),
combined with a **durable cursor** ([§4](#4-constraint-sequential-exactly-once-parts))
so that even when a redundant fire is allowed to *start*, it either skips or
provably reprocesses the same part.

`concurrency: "forbid"` is still worth setting (it removes self-overlap on the
in-memory single-process/dev path for free), but treat it as an optimization,
never as the guarantee.

---

## 3. Constraint: the daily window and interval (the cron)

`SchedulerOptions` (`packages/core/orchestration/src/transaction/types.ts:170`):

```ts
export type SchedulerOptions = {
  concurrency?: "allow" | "forbid"
  numberOfExecutions?: number
} & ({ cron: string } | { interval: number })
```

- **Use `cron`, not `interval`.** `interval` fires every N ms indefinitely with
  no notion of a time-of-day window; it cannot express "only between 05:00 and
  09:00". A window *requires* a cron expression.
- **Window formula.** "Every 5 minutes from 05:00 up to (but not including)
  09:00, every day":

  ```
  */5 5-8 * * *
  ```

  `*/5` in the minute field = minutes `0,5,…,55`; `5-8` in the hour field =
  hours `5,6,7,8`. First fire `05:00`, last fire `08:55`. Cron ranges are
  inclusive, so if you want a tick *at* `09:00` too you cannot express it in one
  5-field expression alongside `*/5 5-8`; either accept `*/5 5-9 * * *` (which
  also runs `09:05…09:55`) or register a second job for the `09:00` tick. For a
  half-open `[05:00, 09:00)` window, `*/5 5-8 * * *` is exactly right.
- **`numberOfExecutions`** — leave unset for a perpetual daily job. If set, the
  scheduler stops after that many total runs (in-memory deletes the job at the
  cap, `:709`; Redis passes it as the BullMQ repeatable `limit`).

### Timezone (a real gotcha)

`SchedulerOptions` has **no timezone field**. The in-memory backend calls
`parseExpression(cron)` with no options, and the Redis backend registers the
BullMQ `pattern` without a `tz`. Both therefore evaluate the window in the
**process's local timezone** (governed by the `TZ` environment variable / host
clock).

- Pin `TZ` on every `worker`/`shared` process so all replicas agree on the
  window, e.g. `TZ=Europe/Warsaw` or `TZ=UTC`.
- Under a DST-observing zone, a local-time window shifts by an hour twice a year
  and can skip or repeat the boundary hour. If you need wall-clock stability
  across DST, run the processes in `TZ=UTC` and express the window in UTC.

---

## 4. Constraint: only one run at a time (distributed lock)

Given [§2](#2-the-trap-concurrency-forbid-does-not-do-what-it-looks-like), the
job must gate itself with a lock that is visible to **all** processes.

### 4.1 The Locking module and its providers

The `Locking` module (`Modules.LOCKING`,
`packages/modules/locking/src/services/locking-module.ts`) is a thin facade over
a pluggable provider (`local-docs/jobs-and-concurrency/03-locking-and-exclusivity.md`).
Resolution order at a call site: explicit `provider` arg → module default →
built-in `in-memory`.

Provider semantics you must know (verified against source):

| Provider (`identifier`) | Cross-process? | `acquire` (no `awaitQueue`) | Crash-safety of `acquire`/`release` |
|---|---|---|---|
| `in-memory` | **No** — a per-process `Map` | Fail-fast: throws on contention (`in-memory.ts:136`) | N/A (single process) |
| `locking-redis` | Yes (Redis keys `medusa_lock:*`) | **Fail-fast**: `awaitQueue` defaults to `false`, throws on contention (`redis-lock.ts:171,202`) | **Good** — key gets `EX ttl` **only if you pass `expire`**; a crashed holder's key auto-expires (`redis-lock.ts:186`) |
| `locking-postgres` (`execute`) | Yes (`pg_advisory_xact_lock`) | — (`execute` **waits**, blocking, up to `timeout`) | **Excellent** — advisory lock auto-releases on txn commit/rollback/disconnect (`advisory-lock.ts:38-67`) |
| `locking-postgres` (`acquire`/`release`) | Yes (a `locking` table row) | **Fail-fast**: throws on contention (`advisory-lock.ts:120-122`) | **Poor** — see caveat below |

**Two behaviors that dictate the design:**

1. **`acquire` is fail-fast; `execute` waits.** For a scheduled job you want
   *skip if busy*, not *queue behind the busy run* (queueing causes pile-ups and
   defeats the window). So use `acquire` + `release` (fail-fast) — **not**
   `execute` — for the redis/in-memory providers. `execute` blocks up to
   `timeout` then throws `"Timed-out acquiring lock."` (`getTimeout` rejects,
   `in-memory.ts:188`, `redis-lock.ts`, `advisory-lock.ts:189`).

2. **Postgres table-based `acquire` does not reclaim an expired lock held by a
   different owner.** `acquire` loads the row and throws at
   `row.owner_id !== ownerId` (`advisory-lock.ts:120`) *before* it ever looks at
   `expiration`. So if a run crashes while holding a table lock, its row wedges
   the key until it is deleted — the TTL does **not** save you on this path.
   The Postgres **advisory `execute`** path has no such problem (the lock dies
   with the connection). Therefore:
   - With Redis available → **`locking-redis` + `acquire`/`release`** gives you
     *both* fail-fast skip *and* crash-safety (via `EX`). This is the default
     recommendation.
   - Postgres-only → prefer the **advisory `execute`** path (crash-safe) with a
     short `timeout` so waiters give up quickly, **or** the Postgres-native
     single-transaction pattern in [§5.4](#54-pattern-b-postgres-native-exactly-once-same-database-work)
     which uses `pg_try_advisory_xact_lock` (fail-fast *and* crash-safe).
     Avoid the table-based `acquire`/`release` unless you add a reaper for stale
     rows.

3. **Use a unique `ownerId` per run.** The providers treat "same `ownerId`" as
   re-entrant (they refresh rather than block). Two different runs sharing an
   `ownerId` can both believe they hold the lock (Postgres table path swallows
   the PK-violation when `ownerId` matches, `advisory-lock.ts:106-115`). Mint a
   fresh id per run (`ulid()`), pass it to `acquire`, and pass the *same* id to
   `release` (release is ownership-checked: `in-memory.ts:158`,
   `advisory-lock.ts:156`, redis release Lua).

4. **Always pass `expire` (TTL).** Without it the Redis lock is set with no
   expiry (`redis-lock.ts:186` → `EX 0`) and a crashed holder wedges the key
   forever. Set the TTL comfortably above the worst-case run duration.

### 4.2 The `in-memory` locking provider is not an option for multi-process

The default provider is `in-memory` (a process-local `Map`,
`packages/modules/locking/src/loaders/providers.ts`). It cannot coordinate
across processes. **For requirement (5) you must configure `locking-redis` or
`locking-postgres`.** This is independent of which workflow engine you run —
you can (and, for the degenerate "in-memory engine across N processes" case,
must) run the **in-memory workflow engine with a Postgres/Redis locking
provider**, and the single-execution guarantee still holds because the lock
lives in the shared backend.

---

## 5. Constraint: sequential, exactly-once processing (the durable cursor)

### 5.1 Why a cursor, and why not the alternatives

- **"Guaranteed by the job, not by the data" (requirement 4)** rules out the
  `WHERE processed = false … UPDATE SET processed = true` pattern. The job keeps
  its **own** persisted position; source records are read-only from the job's
  perspective.
- **`scheduledFor` slots are not a partitioning key.** Slots can be skipped
  (overrun, missed fire, downtime) and are not durable, so you cannot map slot →
  dataset partition and preserve "each part once." Use `scheduledFor` only for
  logging/observability.
- **"Next part" is defined by the cursor, not by wall-clock.** If a slot is
  skipped because the previous run overran (and held the lock) or the fleet was
  down, the next successful run simply continues from the stored cursor. No part
  is skipped and none is repeated — coverage is driven by the cursor, which is
  exactly what makes the sequence robust to the irregular firing shown in
  [§2](#fires-per-slot-matrix-why-a-distributed-lock-is-mandatory).

### 5.2 Keyset (seek) pagination, not `OFFSET`

The cursor must be a **stable, immutable, monotonic ordering key** of the
dataset — an autoincrement id, a ULID/`created_at`-derived id, or a composite
`(created_at, id)`. Fetch the next part with a **keyset** predicate:

```sql
SELECT ... FROM dataset
WHERE id > :cursor          -- strictly greater than the last processed key
ORDER BY id ASC
LIMIT :batchSize
```

then advance `cursor := id_of_last_row_in_batch`.

Do **not** use `OFFSET`/`LIMIT`. With `OFFSET`, any insert or delete *before* the
current offset shifts every subsequent page, causing records to be **skipped or
processed twice** — a direct violation of requirement (4). Keyset pagination is
immune: new rows always sort after the cursor and are picked up on a later run;
already-processed rows (with keys `<= cursor`) are never revisited. (If your
dataset can have rows *back-dated* below the current cursor, the ordering key is
not monotonic for your use case — pick a key that is, e.g. the surrogate
insertion id, not a mutable business date.)

### 5.3 Exactly-once vs at-least-once: where you advance the cursor

The lock guarantees single execution; the *ordering of "process" vs "advance
cursor"* decides the delivery guarantee if a run crashes mid-flight:

- **Advance *after* processing** → **at-least-once**. A crash after side effects
  but before the cursor write reprocesses the batch next time. Safe **iff
  processing is idempotent** (e.g. upserts keyed by record id, or writes guarded
  by a natural unique key). This is the pragmatic default for **external** side
  effects (HTTP calls, emails) — combine it with idempotency keys.
- **Advance *before* processing** → **at-most-once**. A crash after the cursor
  write but before/within processing *loses* that batch. Only acceptable if
  dropping a part is tolerable.
- **Advance in the *same* transaction as the side effects** → **exactly-once**.
  Only achievable when the side effects are writes to the **same Postgres
  connection/transaction** as the cursor (see [§5.4](#54-pattern-b-postgres-native-exactly-once-same-database-work)).
  Medusa modules each own their unit of work, so you generally **cannot** span
  one transaction across another module's writes — in that case fall back to
  advance-after + idempotency.

> Requirement (4) says "processed once." If your processing writes to the same
> DB, use [§5.4](#54-pattern-b-postgres-native-exactly-once-same-database-work)
> for true exactly-once. If it calls external systems, use advance-after with
> idempotent effects ([§5.3](#53-exactly-once-vs-at-least-once-where-you-advance-the-cursor))
> — that is the strongest guarantee physically possible without distributed
> transactions.

---

## 6. Reference implementation

Layout in a Medusa app (paths are conventional):

```
src/
  modules/
    batch-cursor/
      index.ts
      models/batch-job-cursor.ts
      service.ts
  jobs/
    process-dataset.ts
```

### 6.1 The cursor module

A tiny custom module (see `local-docs/modules/` and
`local-docs/data-modeling/`) that persists one row per named job stream. Storing
it in Postgres (the app's shared DB) is what makes the cursor visible to every
process regardless of workflow engine.

```ts title="src/modules/batch-cursor/models/batch-job-cursor.ts"
import { model } from "@medusajs/framework/utils"

// One row per logical dataset/job stream.
export const BatchJobCursor = model.define("batch_job_cursor", {
  id: model.id({ prefix: "bjc" }).primaryKey(),
  job_name: model.text().unique(),   // stream identifier, e.g. "sync-widgets"
  cursor: model.text(),              // last processed key (stringified)
  completed: model.boolean().default(false),
  last_run_at: model.dateTime().nullable(),
})

export default BatchJobCursor
```

```ts title="src/modules/batch-cursor/service.ts"
import {
  InjectManager,
  InjectTransactionManager,
  MedusaContext,
  MedusaService,
} from "@medusajs/framework/utils"
import { Context } from "@medusajs/framework/types"
import { ulid } from "ulid"
import { BatchJobCursor } from "./models/batch-job-cursor"

// djb2 (matches the hashing the locking-postgres provider uses for advisory keys)
function hashStringToInt(str: string): number {
  let hash = 5381
  for (let i = str.length; i--; ) {
    hash = (hash * 33) ^ str.charCodeAt(i)
  }
  return hash >>> 0
}

type FetchFn = (cursor: string, size: number, manager: any) => Promise<any[]>
type ProcessFn = (rows: any[], manager: any) => Promise<void>
type KeyOfFn = (row: any) => string

export default class BatchCursorService extends MedusaService({
  BatchJobCursor,
}) {
  /** Read the current cursor (empty string if the stream has never run). */
  @InjectManager()
  async getCursor(
    jobName: string,
    @MedusaContext() _ctx: Context = {}
  ): Promise<string> {
    const [row] = await this.listBatchJobCursors({ job_name: jobName })
    return row?.cursor ?? ""
  }

  /** Advance-after helper for Pattern A (idempotent external work). */
  @InjectTransactionManager()
  async setCursor(
    jobName: string,
    cursor: string,
    @MedusaContext() _ctx: Context = {}
  ): Promise<void> {
    const [row] = await this.listBatchJobCursors({ job_name: jobName })
    if (row) {
      await this.updateBatchJobCursors({
        id: row.id,
        cursor,
        last_run_at: new Date(),
      })
    } else {
      await this.createBatchJobCursors({
        job_name: jobName,
        cursor,
        last_run_at: new Date(),
      })
    }
  }

  /**
   * Pattern B — exactly-once for same-DB work.
   * A single transaction: try-advisory-lock (skip if busy) → read cursor
   * FOR UPDATE → fetch → process (via the SAME manager) → advance cursor.
   * On commit the advisory lock releases; on any throw the whole batch
   * (side effects + cursor) rolls back, so nothing is half-applied.
   */
  @InjectTransactionManager()
  async processNextBatch(
    args: {
      jobName: string
      batchSize: number
      fetch: FetchFn // MUST query with the passed manager (same tx)
      process: ProcessFn // MUST write with the passed manager (same tx)
      keyOf: KeyOfFn
    },
    @MedusaContext() ctx: Context = {}
  ): Promise<
    | { skipped: true }
    | { skipped: false; processed: number; done: boolean; cursor?: string }
  > {
    const manager: any = ctx.transactionManager

    // (1) Mutual exclusion — non-blocking. Another live tx holding it => skip.
    const lockId = hashStringToInt(`batch:${args.jobName}`)
    const [{ locked }] = await manager.execute(
      "SELECT pg_try_advisory_xact_lock(?) AS locked",
      [lockId]
    )
    if (!locked) {
      return { skipped: true }
    }

    // (2) Cursor row, row-locked (belt-and-suspenders under the advisory gate).
    const [row] = await manager.execute(
      "SELECT id, cursor FROM batch_job_cursor WHERE job_name = ? FOR UPDATE",
      [args.jobName]
    )
    const cursor: string = row?.cursor ?? ""

    // (3) Keyset fetch of the next part.
    const rows = await args.fetch(cursor, args.batchSize, manager)
    if (!rows.length) {
      return { skipped: false, processed: 0, done: true }
    }

    // (4) Process in the SAME transaction => atomic with the advance.
    await args.process(rows, manager)

    // (5) Advance the cursor.
    const newCursor = args.keyOf(rows[rows.length - 1])
    if (row) {
      await manager.execute(
        "UPDATE batch_job_cursor SET cursor = ?, last_run_at = NOW() WHERE id = ?",
        [newCursor, row.id]
      )
    } else {
      await manager.execute(
        "INSERT INTO batch_job_cursor (id, job_name, cursor, last_run_at) VALUES (?, ?, ?, NOW())",
        [`bjc_${ulid()}`, args.jobName, newCursor]
      )
    }

    return { skipped: false, processed: rows.length, done: false, cursor: newCursor }
  }
}
```

```ts title="src/modules/batch-cursor/index.ts"
import { Module } from "@medusajs/framework/utils"
import BatchCursorService from "./service"

export const BATCH_CURSOR_MODULE = "batch_cursor"

export default Module(BATCH_CURSOR_MODULE, {
  service: BatchCursorService,
})
```

Register the module and generate/run its migration:

```ts title="medusa-config.ts (excerpt)"
module.exports = defineConfig({
  modules: [
    { resolve: "./src/modules/batch-cursor" },
    // ...locking + workflow engine below (§6.5)
  ],
})
```

```bash
npx medusa db:generate batch_cursor
npx medusa db:migrate
```

### 6.2 Pattern A — general purpose (Locking module + idempotent processing)

Use this when the batch does **external** side effects, or writes across other
Medusa modules (i.e. cannot share one transaction with the cursor). It is the
most broadly applicable form and works with any provider/engine combination.

```ts title="src/jobs/process-dataset.ts (Pattern A)"
import { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { ulid } from "ulid"
import { BATCH_CURSOR_MODULE } from "../modules/batch-cursor"

const JOB_NAME = "sync-widgets"
const LOCK_KEY = `batch:${JOB_NAME}`
const BATCH_SIZE = 10
const LOCK_TTL_SECONDS = 600 // MUST exceed worst-case run duration
const LOCK_PROVIDER = "locking-redis" // or "locking-postgres"

export default async function processDatasetJob(
  container: MedusaContainer,
  context?: { scheduledFor: Date }
) {
  const logger = container.resolve("logger")
  const locking = container.resolve(Modules.LOCKING)
  const cursors = container.resolve(BATCH_CURSOR_MODULE)

  const ownerId = ulid() // unique per run — required for correct ownership

  // (1) Single-execution gate: fail-fast. If another run holds it, skip.
  try {
    await locking.acquire(LOCK_KEY, {
      ownerId,
      expire: LOCK_TTL_SECONDS, // crash-safety (Redis EX); DO NOT omit
      provider: LOCK_PROVIDER,
    })
  } catch (e) {
    logger.info(`[${JOB_NAME}] another run holds the lock; skipping slot ${context?.scheduledFor?.toISOString()}`)
    return
  }

  try {
    // (2) Read the job's own position.
    const cursor = await cursors.getCursor(JOB_NAME)

    // (3) Keyset fetch of the next part (query your dataset here).
    const batch = await fetchNextBatch(container, cursor, BATCH_SIZE)
    if (!batch.length) {
      logger.info(`[${JOB_NAME}] dataset fully processed`)
      return
    }

    // (4) Process. MUST be idempotent (keyed by record id) for exactly-once
    //     under crash-then-retry, since side effects and the cursor commit
    //     in separate transactions here.
    await processBatch(container, batch)

    // (5) Advance-after: commit progress only once processing succeeded.
    const newCursor = String(batch[batch.length - 1].id)
    await cursors.setCursor(JOB_NAME, newCursor)
    logger.info(`[${JOB_NAME}] processed ${batch.length}; cursor -> ${newCursor}`)
  } finally {
    // (6) Always release; ownership-checked so only this run's lock is freed.
    await locking.release(LOCK_KEY, { ownerId, provider: LOCK_PROVIDER })
  }
}

export const config = {
  name: JOB_NAME,
  schedule: "*/5 5-8 * * *", // every 5 min, 05:00–08:55, daily (see §3)
  // concurrency defaults to "forbid" — kept as a cheap single-process optimization
}
```

`fetchNextBatch`/`processBatch` are yours; the important properties are
**keyset** fetch ([§5.2](#52-keyset-seek-pagination-not-offset)) and
**idempotent** processing.

### 6.3 Why Pattern A already satisfies every requirement

- **One at a time / multi-process / both engines** — the fail-fast `acquire`
  against a cross-process provider lets exactly one run past the gate per moment;
  every redundant fire (N fires under the in-memory engine, or an overlap under
  Redis) hits the lock and returns immediately. The lock lives in Redis/Postgres,
  so it is engine-independent.
- **Sequential, next-part** — driven by the durable cursor, not by slots.
- **Exactly-once** — advance-after + idempotent processing. (If you need
  exactly-once *without* relying on idempotency, and your writes are same-DB, use
  Pattern B.)
- **Guaranteed by the job** — the cursor is the job's state; the dataset is only
  read.

### 6.4 Pattern B — Postgres-native exactly-once (same-database work)

Use this when the batch's side effects are writes to the **same Postgres** you
can reach through the module's transaction manager. It folds the lock, the
cursor read, the side effects, and the advance into **one transaction**, giving
true exactly-once and crash-safety with no reliance on idempotency or on a TTL.

```ts title="src/jobs/process-dataset.ts (Pattern B)"
import { MedusaContainer } from "@medusajs/framework/types"
import { BATCH_CURSOR_MODULE } from "../modules/batch-cursor"

const JOB_NAME = "sync-widgets"
const BATCH_SIZE = 10

export default async function processDatasetJob(container: MedusaContainer) {
  const logger = container.resolve("logger")
  const cursors = container.resolve(BATCH_CURSOR_MODULE)

  const result = await cursors.processNextBatch({
    jobName: JOB_NAME,
    batchSize: BATCH_SIZE,
    // Keyset fetch using the SAME transaction manager:
    fetch: async (cursor, size, manager) =>
      manager.execute(
        "SELECT id FROM widget WHERE id > ? ORDER BY id ASC LIMIT ?",
        [cursor || "", size]
      ),
    // Side effects MUST use the same manager to stay in the transaction:
    process: async (rows, manager) => {
      const ids = rows.map((r: any) => r.id)
      await manager.execute(
        "UPDATE widget SET synced_at = NOW() WHERE id IN (?)",
        [ids]
      )
    },
    keyOf: (row: any) => String(row.id),
  })

  if ("skipped" in result && result.skipped) {
    logger.info(`[${JOB_NAME}] another run active; skipped`)
  } else if (!result.skipped && result.done) {
    logger.info(`[${JOB_NAME}] dataset fully processed`)
  } else if (!result.skipped) {
    logger.info(`[${JOB_NAME}] processed ${result.processed}; cursor -> ${result.cursor}`)
  }
}

export const config = {
  name: JOB_NAME,
  schedule: "*/5 5-8 * * *",
}
```

Notes:
- `pg_try_advisory_xact_lock` is **non-blocking**: a second concurrent
  transaction gets `false` and the job **skips** — exactly the "skip if busy"
  behavior, and it needs no TTL because the advisory lock is released
  automatically when the transaction ends or the connection drops.
- The `FOR UPDATE` on the cursor row is redundant while the advisory gate holds,
  but it protects the cursor if some other code path ever reads/writes it
  without taking the advisory lock.
- This pattern is engine-independent: it only touches Postgres, so it is correct
  under the in-memory *and* the Redis workflow engine, across N processes.

### 6.5 Configuration for both engines and a cross-process lock

The lock provider is the part that must be cross-process; the workflow engine can
be either. Canonical package names come from
`packages/core/utils/src/modules-sdk/definition.ts`.

```ts title="medusa-config.ts — Redis engine + Redis lock (recommended production)"
module.exports = defineConfig({
  projectConfig: {
    // workerMode resolved per process: server vs worker (see §1.2)
    redisUrl: process.env.REDIS_URL,
  },
  modules: [
    { resolve: "./src/modules/batch-cursor" },
    {
      resolve: "@medusajs/medusa/workflow-engine-redis",
      options: { redis: { url: process.env.WORKFLOW_REDIS_URL } },
    },
    {
      resolve: "@medusajs/medusa/locking",
      options: {
        providers: [
          {
            resolve: "@medusajs/medusa/locking-redis",
            id: "locking-redis",
            is_default: true,
            options: { redisUrl: process.env.LOCKING_REDIS_URL },
          },
        ],
      },
    },
  ],
})
```

```ts title="medusa-config.ts — in-memory engine + Postgres lock (multi-process still correct)"
module.exports = defineConfig({
  modules: [
    { resolve: "./src/modules/batch-cursor" },
    // in-memory engine is the default; shown explicitly for clarity
    { resolve: "@medusajs/medusa/workflow-engine-inmemory" },
    {
      resolve: "@medusajs/medusa/locking",
      options: {
        providers: [
          {
            resolve: "@medusajs/locking-postgres",
            id: "locking-postgres",
            is_default: true,
          },
        ],
      },
    },
  ],
})
```

- With the in-memory engine and multiple worker processes, every process fires
  the slot ([§2](#fires-per-slot-matrix-why-a-distributed-lock-is-mandatory)),
  but the **Postgres** lock ensures only one proceeds and the **Postgres** cursor
  keeps the sequence coherent. If you use this combination with **Pattern A**,
  prefer the advisory `execute` path or **Pattern B**, because the Postgres
  *table-based* `acquire` does not reclaim a crashed holder's expired lock
  ([§4.1](#41-the-locking-module-and-its-providers)). Pattern B sidesteps that
  entirely by using the advisory lock.
- The `locking-redis` provider **requires** `options.redisUrl`
  (`locking-redis/src/loaders/index.ts:16`). Its backoff parameters
  (`waitLockingTimeout`, `defaultRetryInterval`, `maximumRetryInterval`,
  `backoffFactor`) are configurable but only affect the *waiting* (`execute`)
  path; our fail-fast `acquire` does not wait.

---

## 7. End-to-end behavior matrix

| Engine | Processes | Lock provider | Fires/slot | Runs that proceed | Correct? |
|---|---|---|---|---|---|
| In-memory | 1 (`shared`, dev) | in-memory | 1 | 1 | ✅ |
| In-memory | N (`worker`) | **in-memory** | N | **up to N** | ❌ lock not shared |
| In-memory | N (`worker`) | redis / postgres | N | **1** (others skip) | ✅ |
| Redis | N (`worker`) | in-memory | ~1 | ≥1 if overlap | ❌ lock not shared |
| Redis | N (`worker`) | redis / postgres | ~1 | **1** (overlap skips) | ✅ |

The only ❌ rows are those using the **in-memory lock provider** in a
multi-process deployment. The engine never changes the verdict — the lock
provider does.

---

## 8. Failure modes and edge cases

- **Crash mid-run (Pattern A).** Side effects committed, cursor not yet advanced
  → next run reprocesses that batch → **needs idempotent processing** for
  exactly-once. Lock is freed either by `release` in `finally` (clean exit) or by
  TTL expiry (`expire`) after a hard crash. **Set `expire` > worst-case run
  duration.**
- **Crash mid-run (Pattern B).** Transaction rolls back → neither side effects
  nor cursor persist → next run redoes the batch cleanly (exactly-once). Advisory
  lock auto-released on connection drop.
- **Run outlasts the interval.** The next slot fires, fails to acquire the lock,
  and **skips** — no pile-up. The slot after that resumes from the cursor. This
  is why "next part" is cursor-defined, not slot-defined.
- **TTL shorter than the run (Pattern A).** The lock can expire mid-run and a
  second run may start → double processing. Mitigate by sizing `expire`
  generously, and for very long batches periodically re-`acquire` with the
  **same `ownerId`** (refreshes the expiration: `redis-lock.ts` `SET … XX`,
  `advisory-lock.ts:135`). Pattern B has no TTL and no such window.
- **End of dataset.** Keyset fetch returns `[]` → the run no-ops (optionally set
  `completed = true`). New rows appended later (keys `> cursor`) are picked up on
  a subsequent run automatically.
- **Back-dated inserts.** If rows can appear with a key `<= cursor`, your
  ordering key is not monotonic for this purpose — switch to a strictly
  increasing surrogate key (insertion id/ULID), never a mutable business date,
  or keyset skips them. ([§5.2](#52-keyset-seek-pagination-not-offset).)
- **Missed slots / downtime.** No special handling needed — the next successful
  run continues from the cursor. If you must "catch up" faster than one batch per
  slot, either raise `BATCH_SIZE` or loop inside the run while the lock is held
  and time remains in the window.
- **Timezone/DST.** The window is evaluated in the process's local `TZ`
  ([§3](#timezone-a-real-gotcha)); pin `TZ` on all workers; use `TZ=UTC` if you
  need DST-stable wall-clock behavior.
- **`server`-mode process.** Never runs the job (`jobsLoader` gated to
  worker/shared, [§1.2](#12-jobs-only-load-on-background-processors)). Ensure at
  least one `worker`/`shared` process exists.
- **`concurrency: "forbid"` is not your guarantee.** It removes self-overlap only
  on the in-memory single-process path; it is unimplemented on Redis
  ([§2](#2-the-trap-concurrency-forbid-does-not-do-what-it-looks-like)). The lock
  is the guarantee.

---

## 9. Testing strategy

- **Concurrency (the core guarantee).** Instantiate the lock provider
  (`locking-redis` against a real/ephemeral Redis, or `locking-postgres` against
  the test DB) and invoke the job handler **N times in parallel**. Assert exactly
  one acquires and advances the cursor; the rest return "skipped." Repeat with the
  cursor advanced to prove the *next* invocation processes the *next* part and
  never a repeat. This directly exercises requirements (3) and (4) and does not
  depend on the workflow engine.
- **Sequential coverage.** Seed a dataset of, say, 55 rows with `BATCH_SIZE=10`;
  drive 6 sequential invocations; assert the concatenation of processed ids is
  exactly the dataset, in order, with no gaps or dupes; the 7th invocation
  no-ops.
- **Crash / exactly-once.** Pattern B: make `process` throw after partial work;
  assert the transaction rolled back (no side effects, cursor unchanged) and a
  re-run reprocesses cleanly. Pattern A: kill between processing and
  `setCursor`; assert the re-run reprocesses and that idempotent processing left
  a single logical effect.
- **Keyset vs offset.** Insert a row *below* the current position between two
  runs and assert no record is skipped or double-processed (guards the
  [§5.2](#52-keyset-seek-pagination-not-offset) invariant).
- **Cron window.** Unit-test the expression with `cron-parser`'s
  `parseExpression("*/5 5-8 * * *").next()` under a fixed `TZ` to confirm the
  first/last fire times of the window.
- **Do not** assert on `concurrency: "forbid"` for the single-execution property
  — it is not the mechanism ([§2](#2-the-trap-concurrency-forbid-does-not-do-what-it-looks-like)).

---

## 10. References

**Local docs**
- `local-docs/jobs-and-concurrency/02-scheduled-jobs.md` — jobs as scheduled workflows, `SchedulerOptions`, backends.
- `local-docs/jobs-and-concurrency/03-locking-and-exclusivity.md` — locking module, providers, the three exclusivity mechanisms.
- `local-docs/jobs-and-concurrency/01-worker-modes.md` — where jobs load.
- `local-docs/jobs-and-concurrency/00-overview.md` — how distribution depends on the backend.
- `local-docs/modules/`, `local-docs/data-modeling/` — authoring a custom module + model + transactional service methods.

**Source (line numbers are hints)**
- `packages/core/framework/src/jobs/job-loader.ts:101` — job → `job-<name>` workflow.
- `packages/core/orchestration/src/workflow/scheduler.ts:11` — `concurrency: "forbid"` default injection.
- `packages/core/orchestration/src/transaction/types.ts:170` — `SchedulerOptions`.
- `packages/modules/workflow-engine-inmemory/src/utils/workflow-orchestrator-storage.ts:645,672,703-741` — per-process `setTimeout`, re-arm-after-resolve.
- `packages/modules/workflow-engine-redis/src/utils/workflow-orchestrator-storage.ts:437-462` — `executeScheduledJob` + the `forbid` `TODO`; `:790-833` — BullMQ repeatable `schedule`.
- `packages/modules/workflow-engine-redis/src/services/workflow-orchestrator.ts:236` — random `transactionId` per run.
- `packages/modules/locking/src/services/locking-module.ts` — `execute`/`acquire`/`release`/`releaseAll`.
- `packages/modules/locking/src/providers/in-memory.ts:34-68,81-138,140-168,188` — fail-fast `acquire`, waiting `execute`, ownership-checked `release`, rejecting `getTimeout`.
- `packages/modules/providers/locking-redis/src/services/redis-lock.ts:107-213` — fail-fast `acquire` (`awaitQueue=false`), `EX` only when `expire` set; `:144` config.
- `packages/modules/providers/locking-postgres/src/services/advisory-lock.ts:28-68` — advisory `execute`; `:83-140` — table `acquire` (no expired-lock reclaim across owners); `:181` — key hash.
- `packages/core/utils/src/modules-sdk/definition.ts:53,62,80-81` — package names for the workflow engines and locking providers.
