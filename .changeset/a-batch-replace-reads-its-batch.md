---
"@dudousxd/nestjs-catalog-store-mikro-orm": minor
"@dudousxd/nestjs-catalog": minor
---

A batch replace reads its batch instead of scanning the table

A deployment's query log had one statement at **821 seconds**:

```
DELETE FROM obj_subwo WHERE _snapshot_id = ? AND _batch = ?    821021 ms
DELETE FROM obj_util  WHERE _snapshot_id = ? AND _batch = ?    612990 ms
SELECT COUNT(*) AS total FROM obj_subwo WHERE _snapshot_id = ?  15213 ms
```

Every `obj_*` table was created with one secondary index, `ix_snapshot
(_snapshot_id)`, and the statement that replaces a batch names two columns.
Every row of a snapshot carries the same `_snapshot_id`, so that index narrows
nothing — and MySQL, correctly, **declines to use it and scans the whole table**,
taking row locks the whole way. Thirty batches per load, on a 313,833-row
snapshot, with the API on the same database waiting behind the locks.

Measured on MySQL 8.0 with 300,000 rows in one snapshot and 30 batches
(`write-path.db.spec.ts`), replacing one 10,000-row batch:

| | before | after |
|---|---|---|
| plan | **no index**, ~296,500 rows examined | `ix_snapshot_batch`, ~19,100 |
| time | 248ms | 90ms |

The 90ms that remain are removing 10,000 rows, which is the work the load asked
for. The scan is what has gone, and with it the row locks it held across the
whole table. On a warm local container with nothing else running the wall-clock
gain is 2.8×; on the contended table above, where the cost *is* the scan and the
locking, it should be far larger — but that is a prediction and only the plan is
measured here.

**The load-bearing half is the evolution path, not the `CREATE TABLE`.** The
index only ever appeared inside `CREATE TABLE`, and nothing added indexes to
tables that already existed — so changing the DDL alone would have fixed no
deployment that has ever run this package. `ensureType` now checks
`information_schema.STATISTICS` and adds the composite where it is missing,
beside the reserved-column path that already existed for exactly this reason. It
runs on the first write to each table after boot, not at boot: boot does not know
which types exist, and the pod that needs the index is the one about to write.
InnoDB builds it in place without blocking DML — 1,010ms for 300,000 rows here,
once.

A failure there is a **warning, not a throw**, and the asymmetry is the argument:
a missing column makes the next INSERT fail, so evolving it is a correctness
repair; a missing index makes it slow. Refusing the load would turn a performance
problem into an outage on a deployment whose database user may simply not hold
ALTER. The log names the statement to run by hand.

New tables get `ix_snapshot_batch` **instead of** `ix_snapshot`: a composite
leading on `_snapshot_id` answers every snapshot-only lookup as a prefix match —
confirmed, not assumed, by dropping `ix_snapshot` and checking that both the
snapshot count and a page of rows still plan onto the composite at the same cost
— and a redundant index is not free on a table whose ingestion pattern is
delete-and-reinsert. Existing tables **keep** `ix_snapshot`: adding an index is
recoverable and dropping one is not, this package does not otherwise remove
anything from a table it did not create in this process, and the log says it can
go.

`schema.changed` gains an optional `addedIndexes`, so a table that acquires an
index appears in the audit trail as the real event it is rather than as a
column-less one. Additive, and separate from `addedColumns` because an operator
asking when a column appeared must not get an index name back.

**Staging a batch is now one statement.** `writeStage` read the row before
writing it, and the deployment's N+1 list had that `SELECT` at 29 executions per
request. The key is computed in the method from three arguments, so the read only
ever chose between two writes that end in the same row. It is an upsert now, and
the replace-not-append guarantee is *strengthened*: read-then-write is two
statements with a gap, so two attempts at one batch could both read nothing and
both insert; `ON DUPLICATE KEY UPDATE` makes it a property of one statement.
`createdAt` stays out of the merge — a retry is not a new batch.

**Deliberately not changed: the per-batch `SELECT COUNT(*)`.** It was the
suspect, and the numbers say it is second-order — 15s against 821s in the
deployment's own log, and 65ms against 248ms here. The composite does not improve
it (it already had an index it could use), so removing it would mean accumulating
`rowCount += inserted - deleted` in Node instead of counting the table. That
trades an exact number for arithmetic, and that number feeds `refuseRowCountDrift`
— the bound that stops an empty load replacing a live dataset. Not a trade worth
making for the third-largest cost on the path, and it is written down here so the
next person does not have to re-derive the decision.

**Also deliberately not changed: the batched `DELETE`/`INSERT` pairs** that a
query profiler flags as N+1. They are the delete-and-reinsert ingestion pattern
working as designed, one per batch by construction; the profiler is counting them
per request. Nothing to fix.
