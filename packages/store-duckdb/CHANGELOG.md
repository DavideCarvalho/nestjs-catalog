# @dudousxd/nestjs-catalog-store-duckdb

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
