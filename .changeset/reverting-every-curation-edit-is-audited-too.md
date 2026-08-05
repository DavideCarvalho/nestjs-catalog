---
"@dudousxd/nestjs-catalog": minor
"@dudousxd/nestjs-catalog-store-mikro-orm": patch
---

Reverting every curation edit at once is audited too.

`patchType` and `patchProperty` emit `type.curated`, on the argument that "who renamed this column
and when" is a governance question with no other answer. `resetOverlay` discards every curated label,
description, unit, order, hidden flag and **classification** in the catalog, needs the same
`catalog:curate` scope, and emitted nothing — so the trail could name the person who renamed one
column and not the person who reverted every name at once.

Un-classifying a property this way is not cosmetic either: `visibleToPrincipal` filters search
results on `classification`, so a reset silently re-admits every classified property's *name* to
searches by principals who could not see it a moment before.

**New event: `overlay.reset`.** It could not be a `type.curated` — that payload leads with a
`typeName` a recorder lifts into an indexed column, and a reset has no single one — so `CATALOG_EVENTS`
gains a name, and every recorder and watcher that iterates that list picks it up with no change.

What it carries is a **summary, not a copy**. The overlay is discarded rather than versioned, so what
is not in the payload is nowhere, which argues for carrying all of it — and all of it would be a
backup nobody designed, with no restore path and no retention policy of its own. So:

- `typeNames` — every type that carried curation, because "was the work on `Dispute` in it" is the
  question actually asked six months later.
- `properties` — how many per-property entries went with them, as one number. The property names are
  where the summary would become the dump.
- `classifications` — every classification that stopped applying, with its value, in full. They are
  the one part of the overlay whose loss changes what the catalog shows to whom, they are a small
  subset of it, and re-typing them is the only recovery available.

There is no `principalId`, and the absence is a limit rather than a claim that the actor does not
matter: `resetOverlay()` takes no principal and the route that calls it resolves none, so the field
would be empty on every row — which an audit table reads as "nobody did this" rather than "not
captured". `type.curated` has the same gap; closing it is a change to the controller, the service and
every registry.

**`StoredCatalogRegistry` deliberately emits nothing.** It has no overlay — the published values *are*
the stored values — so it still throws, and a refusal that wrote an audit row would claim a reset
happened while the caller got an exception and every stored label stayed put.

`InMemoryCatalogOverlayStore` no longer describes itself as being for "deployments that want the
catalog strictly read-only". It never was: `save` accepts writes, `PATCH /catalog/types/:name`
answers 200 and emits `type.curated`, and the edit is real until the process ends — but it lives in
one process's heap, so replicas disagree about what a column is called. Read-only is the host guard's
decision about the `catalog:curate` scope, not a store's, so the docblock now says what the store
actually is: non-persistent, and single-process.
