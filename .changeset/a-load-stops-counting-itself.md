---
"@dudousxd/nestjs-catalog-store-mikro-orm": minor
---

A load stops counting itself once per batch

`MySqlWarehouseStore.write` ended every batch with

```sql
SELECT COUNT(*) AS total FROM <obj_table> WHERE _snapshot_id = ?
```

The predicate names the **snapshot**, not the batch, so the scan grows with the
snapshot while the number of scans grows with the load: a load costs
O(rows² / batch). At `BATCH_SIZE = 500` and the 783,000 rows a deployment's
Subwo load carries, that is 1,566 scans of an ever-larger range.

A previous changeset in this series looked at this statement and left it alone,
on the evidence that it was 15s against the batch `DELETE`'s 821s in a
deployment's query log. That reading was right about the ranking and wrong about
what it implied: the `DELETE` was 821s **because it had no usable index and was
scanning the whole table**, and now that it does, the count is what is left, and
it is the only term on the path that is quadratic rather than linear.

Measured on MySQL 8.0 against the 42-column PriBuy shape, three isolated samples
per size, the scratch schema **recreated between every sample** — without that,
three identical 50,000-row loads report 14.6s, 34s and 61.6s as the table
outgrows the buffer pool, which measures the cache and not the code:

| load | before | after | |
|---|---|---|---|
| 50,000 rows + commit | 4,409ms ±201 | **3,272ms ±85** | −25.8% |
| 100,000 rows + commit | 9,596ms ±567 | **6,887ms ±745** | −28.2% |

The saving grows faster than the data — 1.14s at 50k, 2.71s at 100k, 2.4× for 2×
the rows — which is the quadratic term leaving. Per batch, the cost stops
climbing with the load: 44.1 → 48.0 ms/batch before, 32.7 → 34.4 after.

One `COUNT(*)` in isolation costs 1.7ms over 10,000 rows, 3.9ms over 25,000,
7.0ms over 50,000 and 14.4ms over 100,000 — linear, as an index range scan
should be. Multiplied out per load that is 0.03s, 0.19s, 0.70s, 2.87s.

**Local absolute numbers do not transfer to a deployment.** This machine has 22
vCPU and a 128 MB buffer pool; the deployment is a `db.t4g.medium` with 300
baseline IOPS and a 1.5 GB pool against ~36 GB of data. It is not uniformly
faster or slower — only the ratios and the shape of the curve carry over.

**Statements per batch fell from 7 to 3.3** (70 → 33 over ten batches, counted
from MikroORM's query log). `rowCount` was the only field a batch after the
first one changed, so maintaining it cost an `UPDATE catalog_snapshot` per batch
as well as the scan; with nothing to change, change tracking issues neither.
That half is round trips rather than scans, which is what a remote database
charges for.

## Arithmetic is not the answer, and the reason is not the obvious one

`rowCount += inserted - deleted` is the tempting repair. It fails twice.

First, **the number is not there to add**. `write` issues its DELETE through
`connection.execute(sql, params)`, whose default method is `all`. Measured, not
assumed: that call returns `[]` for a DELETE that removed 300 rows and `[]` for
one that removed none — the affected-row count is discarded. It is reachable
only by passing the method explicitly, where `execute(sql, params, 'run')`
returns `{ affectedRows, insertId, row, rows }`. (The usual `ON DUPLICATE KEY
UPDATE` hazard — updated rows counting 2, unchanged 0, depending on
`CLIENT_FOUND_ROWS` — does not arise: the object-table INSERT is a plain
multi-row `INSERT ... VALUES` and the insert count is just `rows.length`.)

Second, and fatal: **it drifts on the event it exists to survive.** `write` is
three statements outside a transaction — DELETE, INSERT, then the snapshot row's
flush. A crash between the INSERT and the flush leaves the table holding N rows
the snapshot row was never told about; the retry re-sends the batch, deletes
those N, inserts N, nets zero, and the snapshot is permanently N rows short.
Counting has no such window — it reports what is there whenever it is asked, so
a replay converges instead of accumulating error. Making arithmetic safe would
mean putting all three statements in one transaction, which is a much larger
claim than this class makes today (`transactional: false`).

## So it is still counted — once per read, not once per batch

`commit` counts the snapshot it is about to publish, which makes the stored
number final and authoritative for every later reader of that committed row.
`listSnapshots` counts the **uncommitted** snapshots it reports, in one grouped
statement, because that is what `PublishService.assertRowCountIsPlausible` reads
the pending snapshot's size from — and it runs *before* `commit`, so a count
taken only at commit would arrive after the check that needs it. Committed rows
are not recounted: `commit` is the only thing that sets the flag, and it sets the
count in the same flush. `carryForward` already counted from the table and still
does, once, as part of the statement that tells it how many rows it carried.

Both properties the old comment bought are kept and are now covered by tests
that fail without this change: a replaced batch does not double-count, and a
snapshot whose stored count has drifted commits at the size the table actually
holds.

**One observable change.** `catalog_snapshot.row_count` is no longer maintained
while a load is in flight, so a host reading that column directly for an
uncommitted snapshot now sees `0` rather than a partial total. Everything that
goes through the store — `commit`, `listSnapshots`, `currentSnapshot`,
`carryForward` — reports the true size, and the row-count bound is unaffected.
Committed rows written by earlier versions are already correct and need no
backfill.
