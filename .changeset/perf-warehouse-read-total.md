---
"@dudousxd/nestjs-catalog-store-mikro-orm": patch
---

Make paging through an object type cheap on large snapshots. An unfiltered page read now takes its
total from the committed snapshot's stored row count instead of running `COUNT(*)` over the whole
snapshot on every page; a search, a filter, or a read of an uncommitted snapshot still counts. A
batch written into a snapshot after its commit now updates that stored count, so the two stay equal.

Object tables also gain an `(_snapshot_id, _row)` index, so a page ordered by `_row` is an index walk
rather than a sort of the whole snapshot. New tables are created with it and existing ones get it
the next time `ensureType` runs (the first write or publish after boot), the same way the
`(_snapshot_id, _batch)` index is added. On Postgres both indexes are now named per table: index
names there are unique per schema, so a bare `ix_snapshot_batch` existed on only the first object
table and every other table went without it.
