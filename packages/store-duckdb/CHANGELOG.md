# @dudousxd/nestjs-catalog-store-duckdb

## 0.3.0

### Minor Changes

- [#248](https://github.com/DavideCarvalho/nestjs-catalog/pull/248) [`6110c71`](https://github.com/DavideCarvalho/nestjs-catalog/commit/6110c71a0aef0d24fc6cc97910c65d05a6cc3182) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **Breaking:** require Node.js 24 or newer. Every package declares `engines.node >= 24` (most declared none before; `-secrets-vault` said `>=18`, `-telescope` `>=22`). CI tests on Node 24 and 26.

  - `@dudousxd/nestjs-catalog-telescope`: removed the default export, a duplicate of `catalogTelescopeExtension` that broke default imports from ESM in some bundlers. Import it by name.
  - `@dudousxd/nestjs-catalog-react`: relative imports in the published files now carry their `.js` extension, so the package and its types resolve under TypeScript's `node16`/`nodenext` resolution, not only under a bundler.
  - Every CommonJS package now declares `"type": "commonjs"`.

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
