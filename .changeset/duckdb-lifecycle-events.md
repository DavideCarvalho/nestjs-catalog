---
'@dudousxd/nestjs-catalog-store-duckdb': minor
---

Emit the catalog lifecycle events. `DuckDbWarehouseStore` published nothing on
`aviary:catalog:*`, so with it bound as `CATALOG_STORE` every subscriber to those events was
silently inert: `CatalogAuditRecorder` recorded no snapshot lifecycle rows while still logging
the count of event types it was about to record, and a host driving retention off
`snapshot.committed` had a subscription that succeeded and then waited forever. Nothing said
so on either side — a consumer could not tell "no snapshots have been committed" from "this
store does not report commits".

`write` and `carryForward` now emit `snapshot.written`, `commit` emits `snapshot.committed`,
and `dropSnapshot` emits `snapshot.dropped`, with the same payloads and at the same points as
the MikroORM store. Each fires only for a call that did the thing: a refused commit, a refused
drop, and a re-drop of an already-dropped snapshot emit nothing.

`schema.changed` is not emitted, and that is now stated on `ensureType` rather than merely
absent — this store applies no DDL, so there is no table to name and no column addition that
any storage performed.
