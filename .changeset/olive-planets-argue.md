---
'@dudousxd/nestjs-catalog': minor
'@dudousxd/nestjs-catalog-store-mikro-orm': minor
'@dudousxd/nestjs-catalog-pipeline': minor
'@dudousxd/nestjs-catalog-react': minor
---

A `catalog` source can read a named snapshot, not only the current one

The `catalog` source kind exists because reading `obj_<type>` as a physical table
reads every retained snapshot at once — measured at 89,440 rows where 44,720 were
current, run status `succeeded`, the row count unchanged because a downstream
`GROUP BY` collapsed the duplicates, and every `SUM` doubled. Naming a *type*
respects the pointer; naming a table does not.

Which left one question unanswered: keeping history is only worth something if an
older version can be read. A snapshot could be kept, listed, archived and — since
the last release — dropped without losing its record, and there was still no way
for a graph to read one. So a source node can now carry `objectSnapshot`, and it
reads that load instead of whatever is being served.

Everything else about the read is unchanged, and deliberately so. The current-
snapshot path resolves an id and then streams *that* id, so a commit landing
mid-read cannot splice two loads together; a named snapshot is already pinned by
construction, and the run reads exactly one `_snapshot_id` either way. There is no
second mechanism — only a different answer to "who chose the id".

**It is an id, and only an id.** Not `latest`, not `previous`, not `-1`, not `*`.
A relative reference is the thing somebody actually wants when diffing two
versions, and it is the one property a stored graph must not have: it resolves
against whatever has been committed by the time the node runs, so the same graph
reads different data on different days while `workflowGraphHash` reports no
change. It is also unstable *per node* — a diff graph with one source on the
current load and one on "previous" resolves them at two different instants, so a
commit landing between the two probes leaves both on the same snapshot and the
diff comes out empty and green. And a name that could mean several loads at once
is exactly the failure the kind was built to end. The friction a relative
reference would have saved — having to look an id up — is answered by the
inspector instead, which lists the type's loads by date and stores the id behind
the one that gets picked.

**Three ways a named snapshot can be wrong, and three different sentences.**
Every one of them would otherwise be zero rows and a successful run, which is
indistinguishable from a load that collapsed:

- **No such snapshot anywhere.** Existence cannot be read off a count, because a
  snapshot that legitimately committed nothing is a real state; the store is
  asked instead, through a new optional `locateSnapshot`.
- **It belongs to another type.** The mistake people actually make, since ids are
  copied out of one history and pasted under another. The refusal names the type
  that has it, because "not found" sends somebody hunting for a snapshot that is
  sitting one type along. This is why the lookup is not scoped to a type — and
  why it returns a list: a durable run that loads two types gives both snapshots
  its run id.
- **Its rows were dropped.** The tombstone from the last release is what makes
  this reachable at all, and it refuses with the date. When the record carries an
  archive it says where the copy went, because *reading an archived snapshot back
  is not offered yet* and "the rows are gone" would send somebody to re-run a load
  whose data is sitting in a bucket.

Two more refusals follow from the id no longer coming from the pointer. A store
that reports `timeTravel: false` documents `snapshot` as *ignored*, so naming one
there would read the current load and report the id that was asked for — refused
instead. And a store that can neither locate nor list snapshots cannot vouch for
the id at all, so nothing is read.

**`producedColumns` goes quiet for a named snapshot, and that is the subtle
part.** A `catalog` source is the one kind whose column set the graph knows — the
named type's published properties — which is what lets a filter at the root of a
graph be refused for naming a column that cannot be there. That claim is about
the type *as declared now*, and an older snapshot was written under whatever was
declared *then*. Rename a property and the published list is wrong in both
directions: a filter on the current name is allowed and matches nothing (null for
every row of that load), and a filter on the name the load actually carries is
refused although the graph is right. So a pinned source answers `undefined` — the
same silence four other source kinds already give — rather than a set that is
confidently the wrong shape.

The field is `objectSnapshot` rather than `snapshotId` on purpose. A run body
already carries a `snapshotId` and it is the **durable run id**: reusing one that
succeeded replays that run and returns its old counts as a fresh success. The two
are frequently the same string, since a snapshot's id is caller-supplied and a
durable pipeline passes its run id — so one spelling for both would mean "run this
again" in one field and "read that load" in another with nothing to tell them
apart. `objectSnapshot` pairs with `objectType` instead.

No stored graph is renumbered. The snapshot lives in the source's `config`, which
the canonical form already sorts and hashes, so a config with no such key hashes
to exactly the string it always did — pinned by a test against a value recorded
off the previous build. The console omits the key rather than storing `""` for a
blank field, which is the one way this could have gone wrong.

No eviction, no reading a snapshot back out of parquet, and no retention policy.
An evicted snapshot is refused with a sentence saying where it went.
