# @dudousxd/nestjs-catalog-store-clickhouse

A ClickHouse storage adapter for [`@dudousxd/nestjs-catalog`](https://davidecarvalho.github.io/aviary/docs/catalog). It
holds the catalog's own copy of the data: one table per object type, every load
ever made, and a snapshot you can still read next year.

```bash
pnpm add @dudousxd/nestjs-catalog-store-clickhouse @clickhouse/client
```

## What this is for

Pick this adapter when reads are wide and analytical — scans across whole
datasets, aggregates over millions of rows, a SQL console people actually use.
Pick the [MikroORM adapter](../nestjs-catalog-store-mikro-orm) when the catalog
lives beside an OLTP application and the same database can hold the model, the
saved queries and the connector definitions as well.

**This adapter stores rows and nothing else.** It does not provide a stored
model, a workspace store or a pipeline store, and that is deliberate: saved
queries, dashboards and connector definitions are small, mutable,
read-modify-write data, which is the one thing a column store is bad at. A full
deployment mounts this for the rows and something else for the model.

## Say the honest thing first

A column store's reputation suggests it does versioning for you. It does not.

**ClickHouse keeps no history of its own.** `ReplacingMergeTree` — the engine
everyone reaches for — is not versioning, it is the opposite: a background merge
that discards every version but the newest, on its own schedule, with no promise
about when. Building object tables on it would turn "you can read last month's
load" into "you can read last month's load until a merge runs". So snapshots
here are **emulated**, exactly as they are on MySQL: a `_snapshot_id` column, and
reads filter to the committed one. ClickHouse was chosen for read speed over wide
tables, not because it makes any of this simpler. The engines that give history
for free are table formats — Iceberg, Delta — read *through* an engine like this
one.

What ClickHouse *does* give, and what this adapter is built around, is partition
manipulation: `DROP PARTITION` is a metadata operation rather than a mutation,
and `REPLACE PARTITION ... FROM` swaps a partition between two identically-shaped
tables under one metadata commit, hardlinking rather than copying. Not one
`ALTER ... DELETE` mutation is issued anywhere in this package.

## Against the MikroORM/MySQL adapter

| | ClickHouse (this) | MikroORM / MySQL |
|---|---|---|
| Snapshots | emulated | emulated |
| Time travel | yes, until you drop the snapshot | yes |
| Writable | yes | yes |
| Physical layout | `MergeTree`, one partition per `(_snapshot_id, _batch)` | InnoDB table, index on `_snapshot_id` |
| Retried batch | staged and swapped in with `REPLACE PARTITION` — **atomic**, no intermediate state | `DELETE` + `INSERT` — correct, but briefly shows neither copy |
| Commit cutover | `EXCHANGE TABLES` for the view, one INSERT for the pointer — **atomic** | `CREATE OR REPLACE VIEW` — atomic |
| Multi-step atomicity | **none.** No transactions; every operation is written to be re-runnable | a transaction |
| Concurrent writers to one type | last writer wins, no locking | serialised by row locks |
| Incremental merge | `LEFT ANTI JOIN` into staging, swapped in | `INSERT ... SELECT` anti-join in place |
| Schema evolution | additive; metadata-only `ADD COLUMN` on both tables | additive; `ADD COLUMN` |
| Ad-hoc SQL console | `readonly = 1`, enforced by the server | `START TRANSACTION READ ONLY` |
| Stored model / workspace / pipeline stores | **not provided** | provided |
| Snapshot bookkeeping | two `ReplacingMergeTree` tables in ClickHouse | ORM entities |
| Batch size that works | large — a batch is a *partition* | any |

The last row is the one that decides whether a load will be healthy. Read on.

## A batch is a partition

The partition key is `(_snapshot_id, _batch)`, because that is what makes a
retried batch replace itself instead of doubling: the batch is rebuilt in a
staging table and swapped into its own partition. It also means **the number of
partitions on a table is batches × retained snapshots.** ClickHouse is
comfortable with hundreds to low thousands of partitions per table and miserable
above that.

So batches should be large — tens of thousands of rows or more. A load streamed
in 100-row batches will work, and will slowly ruin the table. If your connector
chunks by page size, chunk by something bigger before it reaches `write()`.

`pruneSnapshots(type, keep)` is the other side of that arithmetic. It is a method
you call, not something a commit does on its own — a store that quietly enforced
a retention window would be breaking the catalog's central promise on a schedule
nobody chose. What ClickHouse changes is the price: dropping a snapshot is
unlinking partitions.

**A drop takes the rows and keeps the record.** The snapshot's row survives with
`dropped_at` set, and `listSnapshots()` reports it as `SnapshotRef.droppedAt`
along with the count it held — because `catalog_connector_run.snapshotId` names
a snapshot, and a run log whose ids resolve to nothing cannot answer what it is
asked. Reading such a snapshot is refused with a sentence naming the drop and
its date rather than answered with an empty page, and committing one is refused
outright: that is how a published type comes to serve nothing. `keep` counts
snapshots that still hold rows, so a table of tombstones cannot push live
snapshots out of the window.

## What is atomic and what is not

Three things were checked against a live server rather than read off a docs page:

- **`CREATE OR REPLACE VIEW` is not atomic.** 400 concurrent `SELECT`s against a
  view being replaced 400 times produced 18 `UNKNOWN_TABLE` errors on 24.8 — the
  replace drops the name and recreates it. So this adapter does not use it for
  the cutover.
- **`EXCHANGE TABLES` is atomic** on an Atomic database engine (the default). The
  same 400-and-400 test produced zero misses. The commit builds the new
  definition under a shadow name and exchanges it in.
- **`REPLACE PARTITION` is atomic and is not a mutation.** Readers see the old
  batch or the new one, never neither. That matters most in the case that looks
  impossible: a durable run whose commit succeeded and which then retries from
  the top, re-sending batches into a snapshot that is live and being served.

What is *not* atomic is any operation made of more than one statement, because
ClickHouse has no transactions. `commit()` is three: the view exchange, the
snapshot row, the pointer row. A crash between them leaves the SQL console
showing a snapshot the API does not yet serve — a blessing that did not finish,
not a half-written load — and re-running `commit()` finishes it. Every operation
in this package is written to be re-runnable for that reason, which is also what
makes it safe under a durable workflow that replays.

## What it refuses

Never a silent fallback. A load that appears to succeed while doing something
other than what was asked is the worst outcome available here, so each of these
throws with a message naming the fix:

- **A type with no primary key, on an incremental load.** Appending without a key
  duplicates the dataset on every run; promoting the load to a full reload
  commits a partial slice as the complete state.
- **NULL primary keys**, on either side of a merge. This bites harder here than
  on MySQL: ClickHouse's JOIN treats NULL as equal to NULL, so NULL-keyed rows do
  not duplicate — they *collapse*, and one NULL-keyed incoming row would suppress
  every NULL-keyed row in the previous snapshot. Silent loss is harder to notice
  than silent growth.
- **A batch that landed after the carry-forward.** The merge no longer covers the
  whole load, so the commit is refused rather than served. Carry forward again,
  then commit.
- **An object table this adapter did not shape** — wrong engine, wrong partition
  key, wrong sorting key. Pointed at a `ReplacingMergeTree` the writes would
  succeed and merges would erase old snapshots; pointed at a `Distributed` table
  `REPLACE PARTITION` would address the local shard only. Both look like working
  loads until the data is wrong. `verifyEngine: false` turns the check off if you
  built the table yourself.
- **A property whose physical column would collide with a reserved one**
  (`_snapshot_id`, `_principal_id`, `_loaded_at`, `_batch`, `_row`). Nothing
  would fail; every retry from then on would replace the wrong partition.
- **A negative batch number**, which is the range the store writes under itself.
- **A load whose fields match none of the type's**, which produces rows of pure
  NULL and a row count that looks like success.
- **Dropping or retyping a column.** Schema evolution is additive, always. Those
  go through a human.

Not refused, and worth knowing: two processes committing the same type at the
same moment. MySQL serialises that with row locks and ClickHouse cannot. The
higher version wins and the loser is lost, rather than anything being corrupted.

## Mount it

```ts
import { CatalogModule, CATALOG_STORE } from "@dudousxd/nestjs-catalog";
import {
  CatalogClickHouseStoreModule,
  ClickHouseWarehouseStore,
} from "@dudousxd/nestjs-catalog-store-clickhouse";

@Module({
  imports: [
    CatalogModule.forRoot({
      imports: [
        CatalogClickHouseStoreModule.forRoot({
          connection: {
            url: process.env.CLICKHOUSE_URL,
            username: process.env.CLICKHOUSE_USER,
            password: process.env.CLICKHOUSE_PASSWORD,
            database: "catalog",
          },
          // Optional, and the strongest form of the read-only promise: a
          // credential that cannot write at all, for the ad-hoc SQL console.
          queryConnection: {
            url: process.env.CLICKHOUSE_URL,
            username: "catalog_reader",
            password: process.env.CLICKHOUSE_READER_PASSWORD,
            database: "catalog",
          },
        }),
      ],
      // Explicit rather than relying on which imported module Nest resolves
      // last. Swapping adapters is swapping this one line.
      store: { provide: CATALOG_STORE, useExisting: ClickHouseWarehouseStore },
    }),
  ],
})
export class AppModule {}
```

`connection` is required — there is no default. A store that silently connects to
`http://localhost:8123` because nothing was configured is a store that loads a
production dataset into a developer's laptop.

## Loading

The order is the library's, and there is only one:

```ts
// Full reload: every batch, then commit. No key needed.
for (const [index, chunk] of chunks.entries()) {
  await store.write(Vehicle, chunk, { snapshotId: runId, principalId, batch: index });
}
await store.commit(Vehicle, runId);

// Incremental: every batch, then carryForward exactly once, then commit.
for (const [index, chunk] of changed.entries()) {
  await store.write(Vehicle, chunk, { snapshotId: runId, principalId, batch: index });
}
await store.carryForward(Vehicle, runId, { principalId });
await store.commit(Vehicle, runId);
```

`carryForward` copies the previous snapshot's surviving rows in beside this run's,
so **a snapshot is always the complete state**. Reading is one predicate over one
table, time travel is the same predicate with a different value, and the copy is
paid once per run rather than by every reader forever.

Re-running any of it is safe, and that is the point: a durable step that retries
restarts from the top and re-sends every batch.

## The SQL console

`runQuery` is read-only at the *database*, not by inspecting the string for
keywords. Every statement is sent with `readonly = 1`, which the server enforces
and which the statement cannot turn off — ClickHouse refuses to modify the
`readonly` setting while it is set.

One caveat, stated because it is measurable rather than theoretical: the
statement is wrapped in a subquery to impose the row cap, and a `SETTINGS` clause
written inside the user's own statement is applied inside that subquery. It
cannot introduce a write (there is no write syntax in a `FROM` position) and it
cannot escape the row cap (the `LIMIT` is outside the subquery and belongs to
this package), but it can raise the execution timeout. Two things close that: the
request is aborted from this side at the deadline, and
`cancel_http_readonly_queries_on_client_close` tells the server to stop working
when the connection drops. A deployment that wants the timeout to be unarguable
should point `queryConnection` at a user whose *profile* constrains
`max_execution_time`.

## What it creates

| Table | What it is |
|---|---|
| `obj_<type>` | Every load of a type ever written. `MergeTree`, one partition per `(_snapshot_id, _batch)`. |
| `obj_<type>__stage` | Where a batch is built before it is swapped in. Empty between writes. |
| `<type>` | A view over the committed snapshot. What the SQL console selects from. |
| `<type>__next` | The shadow the commit exchanges with. Holds the previously-served definition. |
| `catalog_ch_snapshot` | One row per snapshot: row count, principal, labels, committed, and `dropped_at` once its rows have gone. |
| `catalog_ch_current` | One row per type: which snapshot readers get. |

`catalogClickHouseManagedTables()` names the last two, for a deployment that
provisions them through its own change management (`autoSchema: false`). The
`obj_*` tables are deliberately absent from that list: their names are not
knowable ahead of time and no change-management tool should reason about them.

## Licence

MIT © Davide Carvalho
