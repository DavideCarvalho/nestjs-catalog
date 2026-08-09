---
'@dudousxd/nestjs-catalog': minor
'@dudousxd/nestjs-catalog-pipeline': minor
---

A snapshot can be copied out to parquet, verified, and left exactly where it is

A snapshot is a whole version of an object type, and committing a new one leaves
the old rows in `obj_<type>` beside the new ones. That is what makes a cutover a
pointer move rather than a rewrite, and nothing has ever removed the old rows. A
deployment reached 441 retained snapshots and filled a 100 GB instance —
`obj_subwo` alone was 48.54 GB over 27,036,756 rows — at which point the database
refused connections and every pod that booted died on `ECONNREFUSED`. The staged
rows and the audit trail, which are the tables people reach for first, were 2.3
GB of 79.

**The obvious repair is a retention cap and it is the wrong one.**
`catalog_connector_run.snapshotId` is documented as "also the snapshot this run
wrote, and the durable run id" — one identifier across all three — and
`dropSnapshot` deletes the rows *and* the `catalog_snapshot` row. So a cap leaves
every run older than the window naming a snapshot that has no record anywhere,
and the store already treats that as a defect: `currentSnapshot` warns when a
pointer names a snapshot with no row, because an id alone tells a caller nothing.
The repository had reached the same conclusion in prose before this existed —
`audit-recorder.service.ts` says `catalog_snapshot` is "not on a timer at all",
because "dropping one by age is how a published type comes to point at nothing".

What makes the run history resolvable is **keeping the record**. What makes it
resolvable *to data* is **keeping the bytes**. This release adds the second.

**`archiveSnapshot` writes and verifies. It deletes nothing.** Deliberately, and
this is the shape of the whole feature rather than a staging decision: deleting
is the irreversible half, so archives are made to accumulate beside a database
that is exactly the size it was, until there is reason to trust them. Removing
rows is a later, separate operation, and it may only ever act on an archive
carrying a `verifiedAt`.

The ordering that cannot be broken is arranged so it cannot be reached, not
merely so it is not reached today:

- Rows are streamed from the store's `streamSnapshot` — pinned by id, one
  statement, index-backed — and encoded a row group at a time. Peak memory is one
  row group, so a 48 GB type is archived by a pod with a gigabyte. Measured: 120
  MiB of heap for a 500,000-row write.
- The sink shows **nothing at its destination until it is finished**, so a crash
  leaves no object rather than a truncated parquet file at the path a later
  reader trusts.
- The row count is checked *before* the sink is finished, so a snapshot that
  streamed short leaves nothing at all.
- The bytes are read back **through this package's own parquet reader** — the
  same code and the same by-name refusals any later read would use — and the rows
  are counted and hashed again. A count catches a short archive; the SHA-256 over
  the ordered row stream catches a complete archive with a changed value, which
  is the failure a count cannot see.
- Only then is a ref returned, and it carries `verifiedAt`.

`SnapshotRef` gains an optional `archive?: SnapshotArchiveRef` — vocabulary only;
`@dudousxd/nestjs-catalog` writes none of these and gains no notion of storage.
Its presence distinguishes the three states a console has to tell apart, which
"gone" and "elsewhere" have been conflated into everywhere this did not exist: no
`archive` (in the database and nowhere else), `archive` present with rows still
in the table (copied, not moved), and `archive` present with rows gone (in object
storage, and **not** the same price as a hot read — which is what `bytes` is on
the ref for). A snapshot with no `SnapshotRef` at all remains the only thing that
means gone.

**`json` and `unknown` columns are written as JSON text rather than as parquet's
JSON logical type, because that type loses data.** Measured against
`hyparquet-writer` 0.16.5, which is the current release: a nullable JSON column
holding `[{a:1}, null, {c:3}]` reads back as `[{a:1}, null, null]`, and
`[null, {b:2}, {c:3}]` reads back as `[null, null, {b:2}]` — values after a null
are dropped or shifted. It is the writer and not this package's reader:
hyparquet's own `parquetReadObjects`, with no custom parsers, produces the same
wrong answer from the same bytes, and the identical three cases are exact for
STRING, DOUBLE and BOOLEAN. A nullable JSON column is the ordinary case here, not
an exotic one. The upstream bug is pinned by a test so a fixed release is noticed
rather than assumed. What the workaround costs is named on the ref and in the
manifest: an archived `json` column reads back as the JSON *text*, and the
manifest carries every column's catalog type beside its parquet type so a reader
can undo it without guessing.

Everything else round-trips byte-identically, and that is a property of the
catalog's narrow type system rather than luck. There are seven scalars; a `date`
has already been turned into an ISO-8601 string by the store's `normalise` and
the parquet reader turns temporal values into ISO-8601 strings too, so writing it
as a STRING is the same bytes coming back rather than a parse-and-reformat that
could pick up a timezone. `number` is a DOUBLE, which is the width `read` already
hands out. Nothing here can produce a DECIMAL, an INT96 or a geospatial column —
the types the reader refuses by name — so an archive written by this package is
readable by the reader beside it. Verified against real MySQL through
testcontainers, including the values as mysql2 actually hands them over.

New in `@dudousxd/nestjs-catalog-pipeline`: `archiveSnapshot`, `archivePathFor`,
`archiveColumns`, `parquetTypeFor`, `isTextEncodedScalar`, `localArchiveStore`,
`ArchiveStore`, `ArchiveSink`, `SnapshotArchiveManifest`, and the
`ARCHIVE_*` constants. `hyparquet-writer` is a devDependency reached through
`importOptional`, exactly as `hyparquet` already is, so the package still
declares zero runtime dependencies and a deployment that archives nothing
installs no parquet encoder.

Nothing in `WORKFLOW_NODE_KINDS` changes, no sink kind or sink mode is added, and
no graph becomes aware of where its data is stored. An archive is not a second
sink and not a replication follower — `store-fanout` already occupies the "one
dataset in several stores" slot and its whole design is that the primary's commit
decides. This is one dataset at two ages, which is retention: it runs after a
commit, driven by a host that calls it, never in the commit's critical path.

The layout is `<prefix>/<objectType>/<snapshotId>/`, holding `part-0000.parquet`
and `_manifest.json`. Type above snapshot so an object-storage lifecycle rule can
be scoped per type by prefix; the snapshot as its own directory level so a whole
snapshot is one listing and one delete, and so a future multi-part write needs no
new layout. A type name or snapshot id that cannot be a path segment is refused
rather than escaped, because a path that cannot be predicted from the id is one
nothing can find again.
