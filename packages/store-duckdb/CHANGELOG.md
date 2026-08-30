# @dudousxd/nestjs-catalog-store-duckdb

## 0.1.0

### Minor Changes

- cff737f: New adapter: object rows as Parquet in blob storage, read through DuckDB. One object per
  snapshot batch at a deterministic key, so a retried durable step replaces rather than
  appends. Snapshot bookkeeping and the served pointer go through a `SnapshotCatalog` port,
  with an object-backed binding that needs nothing but a bucket.
