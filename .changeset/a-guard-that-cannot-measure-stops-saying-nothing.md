---
"@dudousxd/nestjs-catalog": patch
"@dudousxd/nestjs-catalog-pipeline": patch
---

Two guards that answered "fine" when what they meant was "I could not tell".

## The staleness clock could be stopped by one unreadable timestamp

`refuseStaleReconciliation` is the half that makes `periodic-full-reload` a mechanism rather than a
note: once the newest full snapshot of a type is older than the declared interval, incremental loads
of it stop committing. All of it rests on picking which of the store's full snapshots is the newest,
and that was decided by comparing the two `createdAt` **strings**.

Two of them sort chronologically only while every store writes the same UTC ISO-8601 shape — which
this cannot check, and which did not hold.

- **A timestamp that cannot be read at all was the expensive case.** `"unknown"` sorts above every
  real timestamp, because `'u'` is past every digit. It won the comparison for newest,
  `Date.parse` of it is `NaN`, and `NaN > withinMs` is false — so the load was admitted. One
  unreadable row, in a list whose other rows could have dated the type perfectly well, switched the
  bound off, and nothing anywhere said so. A type nine days past a one-day interval went on carrying
  forward rows deleted upstream, reporting healthy the whole time.
- **An offset other than `Z` was the cheap case**, wrong in the safe direction: it mis-ordered by up
  to a day and therefore refused slightly more than it should.

Both are the same fix. The unreadable ones are now dropped **before** the newest is chosen, and the
newest is chosen by parsed instant. A refusal also names the snapshot it actually dated the interval
from, which it could not be relied on to do before — being refused with the wrong snapshot named
sends an operator to look at a load that was fine.

**This can refuse a load it previously admitted**, which is the point of it: the loads it now refuses
are the ones whose last full reload really is past the interval. A store that gives every full
snapshot an unreadable `createdAt` is still admitted, unchanged and deliberately — that is the same
permissive-rather-than-punishing stance `CARRIED_FROM_LABEL` takes, and there is nothing to refuse ON
when every comparison available is against `NaN`. What changed is how narrow that branch is: it used
to be reached by one bad row, and now needs all of them.

## `InMemoryCatalogOverlayStore` handed out the object it holds

`load()` returned the store's own overlay and `save()` kept the caller's. The registry edits the
overlay in place — `this.overlay.types[name] = { ...current, ...patch }` — before it persists, so the
store's state moved on a patch, before any `save`, in both directions.

The net behaviour was identical, because every edit is followed by a persist. Two things were not:

- **The two bundled stores disagreed about the one sentence a store is for.**
  `FileCatalogOverlayStore` round-trips through JSON and so has never aliased anything. Every spec in
  this repository runs on the in-memory one, so a test asserting that an edit had not been written
  yet passed vacuously here and would have failed on the store a deployment actually uses.
- **Two registries over one store shared mutable state**, each able to see the other's half-applied
  edit with no write between them.

Both ends now copy, and one end would not have been enough: copy only on `load` and the object handed
to `save` becomes the store's own again on the very next patch; copy only on `save` and the object
handed out by `load` already is. The copy is a `structuredClone` rather than a JSON round-trip, so a
key whose value is `undefined` survives it instead of being silently dropped.

The cost is one deep copy per load and per save. The overlay holds the names, descriptions and
per-property patches a human has typed — not the catalog, which is derived from entity metadata and
does not live there — so the two paths that pay it are a boot and a curator pressing save. Neither is
a read.
