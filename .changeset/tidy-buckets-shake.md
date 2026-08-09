---
'@dudousxd/nestjs-catalog-store-clickhouse': minor
---

ClickHouse drops a snapshot's rows and keeps its record, the way MySQL now does

`dropSnapshot` removed two things: the partitions holding the rows, and the
snapshot's row in `catalog_ch_snapshot`. The second is what made a drop unsafe —
`catalog_connector_run.snapshotId` names a snapshot, and a run log whose ids
resolve to nothing cannot answer what it is asked. That is written down
elsewhere in this library as the reason nothing may be dropped by age.

This adapter dropped by age anyway. `pruneSnapshots(type, keep)` is a real
retention policy with a real cap, so the dangling pointer was not a hazard here
but a scheduled output: MySQL only *could* produce that state, ClickHouse was
producing it every time the cap bit.

The record now survives with `dropped_at` set, and the ref reports
`SnapshotRef.droppedAt` — the same field, spelling and sentence the MikroORM
adapter uses, so a caller cannot tell which store refused it. `droppedAt` is
*are the rows still here*; `archive` is *does a copy exist elsewhere*; the two
compose into hot / copied / tombstoned / evicted, with "no `SnapshotRef` at all"
still the only state meaning gone.

The `deleted` column stays and keeps its predicate. It answers a different
question — it erases the *record* — and nothing writes it any more, but rows
carrying it exist in deployments written by earlier versions and dropping the
predicate would resurrect every snapshot those deployments meant to be rid of.

Readers taught about tombstones:

- **`commit`** refuses one, naming the drop and its date. This is the refusal
  that mattered: committing a tombstone points a published type at a snapshot
  holding nothing, and this method takes the record's own count, so not even a
  warning would have been logged.
- **`read`** refuses a `snapshot` that names one, rather than answering with an
  empty page. Paid only on the history path — the served snapshot can never be a
  tombstone, so an ordinary read is the two statements it always was.
- **`carryForward`** excludes tombstones when choosing what to merge onto.
  Newly reachable now that records survive a drop: roll back to a good load,
  drop the bad one, and the newest committed snapshot is one with no rows.
  Merging onto it copies nothing and commits a full replacement wearing an
  incremental load's name.
- **`dropSnapshot`** counts before unlinking the partitions and writes
  `droppedAt` after, so a crash between them leaves a snapshot still claiming
  its rows — visible and re-runnable — rather than a tombstone over partitions
  nobody will unlink. Idempotent: a replay does not rewrite the date. Its
  existing refusal of the served snapshot is now load-bearing rather than
  advisory.
- **`listSnapshots`** reports tombstones with `droppedAt` and the count they
  held, never a fresh count (which would report a 27M-row load as an empty one).
  Its default bound rises from 50 to `CATALOG_SNAPSHOT_LIST_LIMIT` (500), the
  MikroORM adapter's number for the MikroORM adapter's reason: 50 was a page
  size doing a bound's job, and a dropped snapshot used to leave the list and
  now stays in it.

`pruneSnapshots` unlinks exactly the partitions it always did — every byte of a
snapshot's data — and no longer erases the record. That reclaims no less than
before: the old code did not delete the record either, it inserted a
`deleted = 1` row that `ReplacingMergeTree` collapses onto the original and
which then stays for good. The record count under a daily load has always grown
by one a day; what changes is the width of those rows, by the labels and
principal the `deleted` marker blanked plus a nullable `DateTime64(3)`.

Measured on 20,000 records of realistic width, merged and read out of
`system.parts`: a live snapshot is 32.0 B/record on disk, the old `deleted`
marker collapsed to 15.6 B/record, a tombstone is 38.0 B/record. Same row count
in every case; a dropped snapshot costs about 22 more bytes than it used to. A
deployment loading one type hourly for ten years accumulates ~88,000 records —
3.3 MB where it would have been 1.4 MB. No second bound is needed for space, and
none is added.

`keep` counts snapshots that still hold rows, asked for with tombstones already
excluded in SQL. A snapshot that is already a tombstone is not visited, not
re-dropped and not reported in `dropped`. Counting tombstones towards `keep`
would have been the quiet failure: a type with seven tombstones and one live
snapshot would report itself at a cap of seven, and the next load would push the
only readable snapshot out.

`ensureCatalogClickHouseSchema` adds `dropped_at` to an existing table with
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, which is metadata-only on a nullable
column and cannot lose data.

Covered by two new cases in the shared store contract, so MySQL, Postgres, the
fan-out and ClickHouse are held to one account of what a drop leaves behind
rather than agreeing by coincidence.
