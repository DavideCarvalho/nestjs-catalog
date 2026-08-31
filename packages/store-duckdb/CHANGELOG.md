# @dudousxd/nestjs-catalog-store-duckdb

## 0.2.0

### Minor Changes

- 67ddf4e: Emit the catalog lifecycle events. `DuckDbWarehouseStore` published nothing on
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

## 0.1.1

### Patch Changes

- a035d57: Republished so the package carries build provenance. 0.1.0 is identical in content
  but was published without an attestation, so it cannot be verified against the
  workflow that built it.

## 0.1.0

### Minor Changes

- cff737f: New adapter: object rows as Parquet in blob storage, read through DuckDB. One object per
  snapshot batch at a deterministic key, so a retried durable step replaces rather than
  appends. Snapshot bookkeeping and the served pointer go through a `SnapshotCatalog` port,
  with an object-backed binding that needs nothing but a bucket.
