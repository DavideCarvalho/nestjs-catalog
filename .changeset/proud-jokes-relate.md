---
'@dudousxd/nestjs-catalog': minor
'@dudousxd/nestjs-catalog-store-mikro-orm': minor
'@dudousxd/nestjs-catalog-store-clickhouse': minor
'@dudousxd/nestjs-catalog-store-fanout': minor
'@dudousxd/nestjs-catalog-pipeline': minor
---

A retention sweep asks which snapshots still hold rows, instead of filtering a bounded list of records

A dropped snapshot leaves a tombstone — the record survives so a connector run
naming it stays resolvable — and a tombstone stays in `listSnapshots`, which is
bounded. So a caller asking "which snapshots still hold rows" by filtering that
result was holding the live snapshots **of the newest N records**, a set that
shrinks as tombstones accumulate and reaches empty while the type still has
loads to retire. Empty reads as "nothing to do", so the sweep keeps running,
keeps reporting success, and the disk keeps filling. Measured on the deployment
this was found on: ~4.5 snapshot records an hour for one type against a
500-record window, so about four days.

The ClickHouse adapter already had the fix internally — `dropped_at IS NULL`
inside the statement rather than applied to the result — and this is that lesson
given a name on the interface so the next adapter inherits it:

- `CatalogReadStore.listSnapshotsWithRows(type, limit?)` — the snapshots that
  still hold rows, newest first, with the bound applied to the **live** ones.
  Implemented by the MikroORM store (MySQL and Postgres), by the ClickHouse
  store, and forwarded by the fan-out. Optional, so an adapter that does not
  implement it still works and its callers degrade rather than break.
- `CatalogReadStore.findSnapshot(type, snapshotId)` — one snapshot by id,
  tombstone included, unaffected by any window. An eviction reads its
  candidate's row count and archive ref through it, because the id came off a
  checkpoint written before the sweep started and a bounded list has no
  obligation to still contain it. Without it, "older than the window" and "never
  existed" were the same answer, and `evictSnapshot` said the second.
- `planSnapshotEviction()` in the pipeline package, so a host that checkpoints
  its plan runs this package's selection rather than a copy of it. It reports
  `listTruncated` and `answeredLiveInStatement`, which is what lets a caller tell
  "nothing left to retire" from "could not see what is left to retire" — the two
  are otherwise the same short list. `evictSnapshots()` now carries that plan out
  in its result.
- `CATALOG_SNAPSHOT_LIST_LIMIT` is exported from the MikroORM package's entry
  point. It was reachable only by deep-importing `dist/warehouse.store`, and the
  alternative a host was left with is copying `500` into its own code, where it
  drifts silently.

No behaviour changes for a caller that does not adopt the new methods, and
nothing about tombstones changes: they are still kept, still listed, and still
what makes a `catalog_connector_run.snapshotId` resolve.
