---
"@dudousxd/nestjs-catalog-store-mikro-orm": minor
---

A second replica stops serving last week's model

`StoredCatalogRegistry` held the catalog in memory and rebuilt it only when
something in **its own process** wrote. With one replica that is invisible. With
two, `PUT publish/:type/schema` answered 200 from the pod that handled it and the
connector run that followed was told by the other pod that the type had never
been published — for as long as that pod lived, or until it happened to serve a
publish itself. Which answer a caller got was load-balancer luck.

Each process now re-reads a **watermark** over the two model tables — their row
counts and their newest `updated_at` — and rebuilds when it has moved.
Deliberately no writer takes part in this. An invalidation that every write path
has to remember is correct until somebody adds one that forgets, and the symptom
of forgetting is a model quietly a day out of date on half the traffic. Reading
the rows themselves means a replica that never writes anything converges anyway,
and so does one whose sibling was updated through a code path this package has
never heard of.

**The read path costs nothing.** `getSnapshot()` and `getType()` stay synchronous
field reads; what they gained is one integer comparison, and when it says the
window has elapsed they start the check *without waiting for it*. No request is
ever slower for this. What the database sees is at most one statement per
`staleAfterMs` per process — two counts and two maxima over a few hundred types
and their columns — however much traffic arrives.

New `forRoot` option **`staleAfterMs`**, default 1000. `0` turns the check off
entirely, which is what a deployment that genuinely runs one process sets to keep
its query count exactly as it was.

Handled along the way: two replicas checking at once need no coordination and get
none, since both are reads; a check that fails leaves the previous model serving
rather than emptying the registry, and retries on the next window; and a
watermark read inside the second of its own newest write is treated as
provisional, because `updated_at` is a `DATETIME` and two writes in one second
otherwise share a maximum that would hide the second one forever.

**Schema note.** `catalog_property` gains a nullable `updated_at`. Half the model
lives in that table and there are writes that touch nothing else — a curation
rename, or a re-publish whose only change is a column's type — so a watermark
over `catalog_object_type` alone would call those invisible. Adding a scalar
column moves the fingerprint `autoSchema` gates on, so an already-running
deployment does get it; what it does not get is a backfill, so rows written
before this holds `NULL` until something next writes them. That is harmless by
construction — `MAX()` ignores nulls and the row counts in the same watermark
still move — and is covered against MySQL 8 in
`stored-registry.staleness.db.spec.ts`. No index is declared, because
`fingerprintOf` does not hash indexes and one would therefore never reach an
existing database at all.
