---
'@dudousxd/nestjs-catalog': minor
'@dudousxd/nestjs-catalog-store-mikro-orm': minor
'@dudousxd/nestjs-catalog-store-fanout': patch
'@dudousxd/nestjs-catalog-pipeline': patch
'@dudousxd/nestjs-catalog-react': patch
---

Dropping a snapshot now keeps its record and only deletes its rows

A snapshot is a whole version of an object type's data: a load writes rows into
`obj_<type>` under a new `_snapshot_id` beside the live ones, and `commit` moves
the pointer. Nothing removed the old ones, which is how one deployment's catalog
reached 441 retained snapshots of a single type and 100 GB, and the database then
refused connections.

The obvious repair is a retention cap, and there wasn't one for a reason that was
written down in this repository: `catalog_connector_run.snapshotId` names the
snapshot each run produced, so deleting old snapshots turns the run history into
a list of pointers to nothing — and the store already treats an unresolvable
pointer as a defect.

**That objection is about the record. The disk is held by the rows, and the two
deletions were separable.** `dropSnapshot` deleted both; it now deletes the rows
and keeps the `catalog_snapshot` row, marked with the new
`SnapshotRef.droppedAt`. A dropped snapshot is still named, still attributed to
whoever loaded it, and still says how many rows it held — the count is taken
immediately before the delete, which is the last moment it exists — so every run
that produced it stays answerable. What it no longer has is the data.

`droppedAt` is orthogonal to the `archive` field added in 0.31.0 rather than a
second vocabulary for the same thing: `archive` says a copy exists somewhere,
`droppedAt` says the rows are no longer here, and the four combinations are the
four states a console has to tell apart — hot, copied, tombstoned, evicted.

**Every reader that could have presented a tombstone as data now refuses out
loud**, because the failure mode is an empty result and an empty result here is
indistinguishable from a load that collapsed:

- `read` refuses a `snapshot` whose rows were dropped, with the date. Only on the
  history path — the served snapshot cannot be a tombstone, so an ordinary read
  is the same two statements it was.
- `streamSnapshot` refuses always: it never resolves the pointer, so any snapshot
  it is given may be one. A workflow reading a tombstone would otherwise iterate
  zero rows and commit an empty load downstream.
- `commit` refuses a tombstone. This is the one that mattered: it recounts, would
  have found zero, and its empty-snapshot branch only logs — so a rollback onto a
  dropped snapshot would have pointed a published type at nothing.
- `dropSnapshot` still refuses the snapshot being served, which is what keeps the
  hot read free of the question.
- `carryForward` no longer merges onto a tombstone. The row survives a drop now,
  so the newest committed snapshot can be one whose rows are gone; carrying
  forward from it would copy nothing and commit a full replacement wearing an
  incremental load's name.
- `currentSnapshot`'s "points at a snapshot with no row" warning is no longer
  what a deliberate drop looks like, and a served snapshot found tombstoned says
  something different and specific.
- The object explorer's load picker labels a dropped load as dropped, with the
  size it held, rather than offering it as an ordinary choice.

`listSnapshots`' window moves from 50 to `CATALOG_SNAPSHOT_LIST_LIMIT` (500). It
was a page size doing a bound's job — it is the only list of snapshots anything
has, so a console reading it was blind to 391 of those 441 — and tombstones make
it matter more, because a dropped snapshot used to leave the list and now stays
in it.

**No retention policy, and this does not imply one.** Nothing here runs on a
timer and nothing chooses a snapshot to drop. What changed is that dropping is
now safe to build a policy on; deciding when is a separate decision. The
ClickHouse store still removes its snapshot record along with the rows, so its
`pruneSnapshots` has the old behaviour and reports no `droppedAt`.
