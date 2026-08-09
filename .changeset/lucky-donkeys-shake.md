---
'@dudousxd/nestjs-catalog-store-mikro-orm': minor
'@dudousxd/nestjs-catalog-pipeline': minor
'@dudousxd/nestjs-catalog': minor
---

A snapshot whose archive still verifies can have its rows evicted

The third and irreversible piece. A tombstone keeps the record after the rows
go; an archive writes a verified copy out; this deletes the rows, and it is the
only one of the three that can lose anything permanently. So the ordering is the
whole safety property — **write, verify, then delete, never the other way** —
and every failure below is a refusal rather than a warning.

**`evictSnapshot` re-establishes verification at eviction time.** It does not
read `verifiedAt` off the ref. A flag is a memory of a measurement, and the
measurement it remembers may have been taken by a writer that was losing a
column: that is not hypothetical, it is what `hyparquet-writer` 0.16.5 did to a
nullable JSON column and the reason the read-back check exists at all. So the
bytes are re-read through this package's own parquet reader and both numbers are
re-derived, immediately before the delete.

Three of the six checks are ones `archiveSnapshot` structurally cannot make,
because it compares its output against its own input:

- **The archive covers every property the type has.** An archiver handed a
  narrowed field list writes a short file that passes every check it makes.
- **The archive carries `_principal_id` and `_loaded_at`.** A snapshot streamed
  without `{ provenance: true }` yields rows with no such key, the absent key
  encodes as a null, the null reads back as a null — count right, checksum
  right, and none of the two values a later merge copies forward. The archiver
  refuses that on the way in now; archives written before it did are already in
  the bucket carrying a `verifiedAt` earned against a check that could not see
  it, and those are exactly the archives nothing may be deleted on.
- **The archive is of this snapshot**, by object type and snapshot id from the
  manifest.

**Retention is a count, `keep`, and it is required.** Size makes retention depend
on type width, so the widest type — the one whose rollback you most want — keeps
fewest. Age makes it depend on load cadence, so 30 days gives an hourly type 720
snapshots and a monthly type one. A count is the only policy where "how far back
can I go" has an answer that does not move. `keep` means *this many snapshots
still have their rows* in every state: the served snapshot is one of them
wherever it sits in the list, and tombstones do not consume a slot.

Host-called, never a commit hook, following `pruneSnapshots`' precedent. A sweep
collects failures rather than stopping at the first, so one unarchived snapshot
cannot wedge a type behind its oldest load.

**`CatalogSnapshotArchiveStore.recordSnapshotArchive`** puts the ref on the
snapshot, and eviction refuses a store that lacks it. Not an optional argument to
`dropSnapshot`, because an adapter that cannot record has to be able to refuse
and an ignored argument cannot: it would leave a tombstone reporting *no copy of
it was recorded anywhere*, which is the sentence somebody hunting for their data
reads. The mikro-orm store gains a nullable JSON `catalog_snapshot.archive`,
reported on every `SnapshotRef`, which makes the `catalog` source's
archive-naming refusal reachable for the first time.

**`dropSnapshot` and `commit` now take the same two row locks in the same
order** — the snapshot record, then the type row. The served-snapshot check and
the delete used to be unlocked statements with a gap between them, and rolling a
bad load back means committing an *older* snapshot, which is exactly what a
retention sweep picks: a commit landing in that gap left a type serving rows
being deleted underneath it. Narrow while dropping was done by hand; a schedule
is what turns narrow into eventually.

**Restoring an archive is still not possible and this does not imply it is.**
`write` stamps `_principal_id` and `_loaded_at` itself, one value per call, so
there is no seam for per-row provenance to go back through. The bytes are
preserved and proved whole; putting them back needs a write path that does not
exist yet.
