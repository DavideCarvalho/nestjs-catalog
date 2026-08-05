---
"@dudousxd/nestjs-catalog": minor
"@dudousxd/nestjs-catalog-pipeline": minor
"@dudousxd/nestjs-catalog-store-mikro-orm": minor
---

A version number that names code you can still read

A connector run records `transformVersion` and a workflow run records
`graphHash`, so the catalog has always known *which* version produced a load. It
did not keep the text of that version: `catalog_transform` is one row per
transform, overwritten in place, and a saved query's `sql` was overwritten with
nothing recorded at all — while the runs list rendered `code v3`, which reads as
a reference to something retrievable. Every version's body is kept now, and the
number on a run and the number on a revision are the same number.

**New table: `catalog_revision`.** Host-visible. It is created by
`ensureCatalogSchema` and named by `catalogManagedTables()`, so a differ's skip
list picks it up with no action from a host that already feeds it that list. A
host registering entities by hand gets it from `catalogStoreEntities`.
`SavedQueryRow` also gains a `version` column, defaulted to 1 — every saved query
that exists has had exactly one statement as far as anything can tell, and
calling that version 1 is the only claim about it that is true.

**Two routes**, both `catalog:read` and both newest-first:
`GET <pipeline>/transforms/:id/revisions` and
`GET <catalog>/saved-queries/:id/revisions`. They are the same scope as the
routes that already serve the current `code` and `sql`, because history is that
field one version older; the authoring scope holds back *choosing what SQL runs*,
which reading an old body is not. `CatalogRevision` is exported from both the
package root and `/client`.

**Bounded, and that is the decision worth reading.** The newest
`CATALOG_REVISION_LIMIT` (50) revisions per subject are kept; older ones are
dropped as newer ones arrive. This is the fourth append-only table in the store
and the first that grows with how often somebody edits rather than with what
happened, with a whole code body per row — so a run's `transformVersion` can name
a revision that has been evicted. That loss is real, it is strictly smaller than
the one it replaces, and the constant's docblock states the arithmetic. A
revision is written only when the text actually changed, following the rule the
version counter already used, which under a cap matters more than it did before:
a revision per save would let twenty renames evict twenty bodies that loads ran.

**Existing rows are not left empty.** A subject with nothing recorded answers
with its live text at its live version, synthesised on read and not written down;
the first save that changes the text backfills that same revision for real,
byte-for-byte identical, so a screen does not shift underneath somebody.

**Workflow graphs are deliberately excluded**, and `CatalogWorkflow` says so
where a reader will look for the missing feature. A graph is a structure rather
than text a person typed, and its `version` is bumped on draft edits by design —
archiving one body per version would fill a bounded table with autosaves of a
canvas somebody is still dragging boxes around on, evicting the versions that
ran.

Both store methods are optional on their interfaces, so a store written against
the previous shape still compiles; `supportsTransformRevisions` and
`supportsSavedQueryRevisions` are how a caller asks, and a store that keeps none
gets a route that says so rather than one that answers `[]` — "nothing recorded"
and "not kept here" draw identically and mean opposite things.
