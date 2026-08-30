# @dudousxd/nestjs-catalog-store-duckdb

A DuckDB + Parquet storage adapter for
[`@dudousxd/nestjs-catalog`](https://davidecarvalho.github.io/aviary/docs/catalog). Rows
are Parquet objects in a bucket — or in a directory — and every read is a
`read_parquet` over them.

```bash
pnpm add @dudousxd/nestjs-catalog-store-duckdb @duckdb/node-api
# only if the root is an s3:// URL
pnpm add @aws-sdk/client-s3
```

## What this is for

Pick this adapter when the data should outlive the database. There is no server
to keep up, no schema to migrate and nothing to restore: a snapshot is a set of
Parquet objects and a JSON record beside them, readable by DuckDB, Spark,
pandas, Athena or anything else that opens Parquet, with or without this
package.

Pick the [ClickHouse adapter](../store-clickhouse) when reads are wide and
analytical against a warehouse that is already running. Pick the
[MikroORM adapter](../store-mikro-orm) when the catalog lives beside an OLTP
application and the same database can hold the model, the saved queries and the
connector definitions too.

**This adapter stores rows and nothing else.** No stored model, no workspace
store, no pipeline store. Saved queries, dashboards and connector definitions
are small, mutable, read-modify-write data, and object storage is the wrong home
for that. A full deployment mounts this for the rows and something else for the
model.

## Say the honest thing first

**DuckDB keeps no history of its own**, and neither does a bucket. Snapshots here
are `'emulated'`, exactly as they are on MySQL and ClickHouse: history is a
prefix per load and a pointer at one of them. What the format buys is that the
prefix *is* the artefact — dropping a snapshot is deleting objects, and reading
last month's load is reading last month's objects, with no compaction, no merge
and no background process that might have discarded a version.

The engine is opened `:memory:`. Nothing survives a restart inside DuckDB —
every byte that does is a Parquet object or a JSON record in the object store —
so there is no DuckDB file, and no single-writer file lock on a process that
does not need one.

## What is on disk

```
<root>/
  <type>/                                   # lowercased type name
    _current.json                           # {"snapshotId":"run-7"} — what readers get
    _snapshots/
      run-7.json                            # one SnapshotRef per load, tombstones included
    run-7/
      part-000000.parquet                   # one object per (type, snapshot, batch)
      part-000001.parquet
      carry.parquet                         # the incremental merge's carried rows
```

Three properties are load-bearing and worth stating:

- **A batch's key is derived from `(type, snapshot, batch)` and nothing else.**
  That is the whole idempotence story: a re-sent batch replaces itself because
  it lands at the same address, not because a statement remembered to delete
  first. Zero-padded to six digits so a listing sorts numerically.
- **`carry.parquet` is deliberately not a name `part-NNNNNN.parquet` could
  produce.** There is exactly one merge per snapshot, so a fixed name is all the
  idempotence a re-run needs, and the row glob can tell the two apart by shape.
- **`_snapshots/` and `_current.json` sit under the type prefix, not the
  snapshot prefix**, so the row glob `<type>/<snapshot>/*.parquet` can never read
  a record as if it were data. The underscore is reserved by a rule, not by
  convention: `typePrefix` and `snapshotPrefix` refuse a component that begins
  with `_`, and refuse `..`, `/`, `\` and an empty string with it. A snapshot id
  is the caller's own string, arriving on this store as a *path* rather than as a
  column value the way it does on both siblings, so it is validated where the
  path is built.

## The two bindings

`root` decides. A path is a directory; an `s3://bucket/prefix` URL is object
storage. Everything else goes through one `ObjectStore` port, and the port is
where the differences are named rather than assumed.

| | Local directory | S3 |
|---|---|---|
| `putIfAbsent` | atomic — `O_CREAT\|O_EXCL` | atomic — `If-None-Match: *` |
| `putIfMatch` | **not atomic**: a read then a write, with no synchronisation between them | atomic — `If-Match` |
| `put` / pointer swap | a sibling `.staging` object `rename`d into place, so a reader sees the old object or the new one | one `PutObject`; S3 never exposes a partial object |
| Prefix boundary | `readdir` never descends from `p` into a sibling `p2` | `Prefix` is built as `<key>/`, which is the same boundary spelled for a flat namespace |
| Concurrent writers | not for it — see below | the real guarantee |
| `prepare` | `mkdir -p`, because DuckDB's `COPY … TO` will not create the directory | a no-op; there are no directories |

**The `.staging` object is local-only and it is visible on disk while a write is
in flight.** It is a sibling of its destination — `rename` is atomic within one
filesystem and not across two, so it cannot live under `tmpdir()` — and `list`
hides it by matching the whole `<name>.<uuid>.staging` shape, files only. A
*directory* whose name ends in `.staging` is never skipped: a snapshot called
`nightly.staging` is a legitimate directory, and skipping it would report its
prefix as empty, which is the one wrong answer nothing downstream can tell apart
from the truth.

**A single-node deployment on the local binding is fine. Concurrent writers are
not.** `putIfMatch` there is a read followed by a write, so two processes can
each pass the etag check and both report success. Nothing is corrupted; an
update is lost. On NFS even the exclusive open is advisory. If more than one
process writes, use the S3 binding or bind your own `SnapshotCatalog` over a
transactional database.

## Deferred, deliberately

Named here so nobody has to guess whether they were forgotten. Each is absent
from the class rather than present and throwing, which is what the core package's
`isQueryStore`-style guards are for — a host that does not need one never
notices, and a host that does finds out at boot.

- **`CatalogQueryStore` — no SQL console against this store.** It needs a
  read-only boundary enforced by the engine rather than by inspecting the
  statement for keywords, and DuckDB's answer is not ClickHouse's `readonly = 1`
  or MySQL's `START TRANSACTION READ ONLY`. Shipping it before that question is
  settled would be shipping a console that looks constrained and is not. The
  core asks `isQueryStore` first, so the SQL tab is simply absent.
- **`recordSnapshotArchive` and `locateSnapshot` — snapshot eviction will not
  run.** This is the one deferral with a feature behind it: eviction refuses to
  run at all without `recordSnapshotArchive`, so a host that mounts this
  expecting eviction learns from a refusal. It is deferred rather than stubbed
  because "archive" has no settled meaning when the warehouse is *already*
  Parquet in object storage — archiving would copy the bytes to where the bytes
  already are — and a stub that recorded an archive which did not happen is
  worse than an absence. Retention through `dropSnapshot` works today.
- **`streamQuery`.** Only worth adding if the driver back-pressures all the way
  to the socket. `streamSnapshot` *is* implemented and does pull chunk by chunk
  (measured against the running engine); a `streamQuery` shipped without the same
  check would satisfy the type while doing the thing the type exists to avoid.

## What it refuses

Never a silent fallback:

- **A snapshot id or type name that is not a safe path component.** The rule is
  a charset, not a blocklist: 1-128 characters of letters, digits, dot, dash or
  underscore, starting with a letter or a digit. So `..`, `.`, empty, anything
  containing `/`, `\` or NUL and anything with a leading `_` are refused — and so
  are a leading `-`, an id containing a space, and a non-ASCII id like `café`. On
  the siblings a snapshot id is a column value; here it is a path component, so
  it decides where a `COPY … TO` writes, what a `deletePrefix` removes, and —
  through `snapshotRecordKey`, which every read of a named snapshot goes through
  — which file a record lookup opens.
- **A label key this store owns** — `_committed`, `_carriedFrom`,
  `_carryForwardStale`. They arrive on the same public surface a publisher's own
  labels do, and each one forges a fact the store reads back for its own
  correctness. `_expectShrink` — the core's caller-supplied acknowledgement — is
  explicitly *not* refused, which is why the rule is those three names rather
  than the underscore prefix.
- **Reading, streaming or committing a dropped snapshot**, and **dropping the
  snapshot the type is currently serving.** An empty result here is
  indistinguishable from a load that collapsed.
- **A batch that landed after the carry-forward**, at commit. The merge no
  longer covers the whole load. Carry forward again, then commit.
- **A type with no primary key on an incremental load**, and **NULL primary
  keys** on either side of a merge.
- **A load whose fields match none of the type's**, which otherwise produces
  rows of pure NULL and a row count that looks like success.
- **A negative batch, or one past `Number.MAX_SAFE_INTEGER`**, which are the keys
  the store writes under itself and the keys it cannot parse back out of a
  listing.
- **A property whose physical column would collide with a reserved one**
  (`_snapshot_id`, `_principal_id`, `_loaded_at`, `_batch`, `_row`). This one is
  the core package's own `CatalogColumnCollisionError`, raised by
  `assertNoColumnCollisions` and shared with both siblings rather than restated
  here.

Every refusal this adapter raises itself is a `BadRequestException`, matching
both shipped adapters: behind a fan-out, the same request must not be a 400 with
a sentence on one store and a 500 with the message swallowed on this one.

## Mount it

```ts
import { CatalogModule, CATALOG_STORE } from "@dudousxd/nestjs-catalog";
import {
  CatalogDuckDbStoreModule,
  DuckDbWarehouseStore,
} from "@dudousxd/nestjs-catalog-store-duckdb";

@Module({
  imports: [
    CatalogModule.forRoot({
      imports: [
        CatalogDuckDbStoreModule.forRoot({
          root: "s3://catalog-prod/warehouse",
          s3: { region: "us-east-1" },
          // DuckDB defaults to every core and 80% of RAM, measured against the
          // machine rather than the cgroup — so a pod with a memory limit is
          // OOMKilled by a query DuckDB believed was inside its budget.
          memoryLimit: "4GB",
          threads: 4,
          // Spilling to a path that is not on a writable volume turns a large
          // sort into a failure instead of a slow query.
          tempDirectory: "/var/tmp/duckdb",
        }),
      ],
      store: { provide: CATALOG_STORE, useExisting: DuckDbWarehouseStore },
    }),
  ],
})
export class AppModule {}
```

`root` is required and there is no default. A store that silently wrote to
`./catalog` because nothing was configured is a store that lands a production
snapshot in a developer's home directory.

Omit `s3.accessKeyId`/`secretAccessKey` to use the credential chain — an instance
profile, an assumed role, a pod identity. DuckDB is pointed at the same bucket
with `CREATE SECRET … PROVIDER credential_chain`, and `REGION`/`ENDPOINT` are set
explicitly rather than derived, because the derivation drops the region slug in
GovCloud.

### IAM

Two clients reach the bucket and they need different things. The AWS SDK moves
the pointer and the snapshot records; **DuckDB reads and writes the Parquet
objects itself**, at the path `locate` builds, never through this package.

| Action | Why |
|---|---|
| `s3:PutObject` | every write, from both clients |
| `s3:GetObject` | reads — **and, per AWS's conditional-request documentation, `putIfMatch`**, which needs it beyond `PutObject`, S3 reading the current object to compare its etag before allowing the write. That one is taken from the documentation rather than measured here, unlike everything else in this file; a write-only policy is expected to fail every conditional write with `403`. |
| `s3:ListBucket` | `list` and `deletePrefix`; **on the bucket resource, not the object resource** |
| `s3:DeleteObject` | `dropSnapshot` |

### `INSTALL httpfs` reaches the network

An `s3://` root makes this package run `INSTALL httpfs` at first connection,
which downloads the extension from DuckDB's extension repository unless it is
already present. In an air-gapped or egress-filtered deployment that is a boot
that hangs or fails on a call nobody expected to be made. Preinstall the
extension into the image and point DuckDB's `extension_directory` at it, or
allow egress to the repository — and decide which on purpose. A local root never
runs it.

## Scaling limits, stated

Three costs are real and none of them is hidden by the interface:

- **A batch is serialised to one string in memory.** `write` renders every row to
  NDJSON, joins it, and writes the whole thing to a staging file before `COPY`
  reads it back. Peak memory is the size of that string, not a bounded window. A
  batch of tens of thousands of rows is comfortable; a batch of tens of millions
  is not. Chunk before `write()`.
- **`SnapshotCatalog.put` and `setCurrent` are blind writes.** The port exposes a
  compare-and-swap and neither of them uses it: two concurrent commits of
  different snapshots to one type leave the pointer wherever the last write
  landed and both callers report success. That is the intended semantic —
  committing an *older* snapshot is how a rollback is expressed, so the pointer
  has to be able to move backwards — but it means concurrent commits of the same
  type are last-writer-wins, not serialised.
- **Listing snapshots reads every record the type ever had.** `find` is one GET
  at a derived key, but `list`/`listLive` GET every object under `_snapshots/`,
  and `limit` bounds what comes back rather than what is read. Nothing on the hot
  path pays it — an incremental load resolves its merge source through
  `current()`, one GET — but a type with thousands of retained snapshots pays it
  on every history page. A host for which that is a problem binds its own
  `SnapshotCatalog` over a transactional database, which is why it is a port.

## Loading

The order is the library's, and there is only one:

```ts
// Full reload: every batch, then commit. No key needed.
for (const [index, chunk] of chunks.entries()) {
  await store.write(Vehicle, chunk, { snapshotId: runId, principalId, batch: index });
}
await store.commit(Vehicle, runId);

// Incremental: every batch, then carryForward exactly once, then commit.
for (const [index, chunk] of changed.entries()) {
  await store.write(Vehicle, chunk, { snapshotId: runId, principalId, batch: index });
}
await store.carryForward(Vehicle, runId, { principalId });
await store.commit(Vehicle, runId);
```

`carryForward` writes the previous snapshot's surviving rows into
`carry.parquet` beside this run's batches, so **a snapshot is always the complete
state**. Time travel is the same read against a different prefix, and the copy is
paid once per run rather than by every reader forever.

Re-running any of it is safe, which is the point: there are no transactions here
— `commit` is a count, a record write and a pointer move — and every sequence is
ordered so that running it again from the top is the repair. A durable step that
retries restarts from the top and re-sends every batch.

## What is atomic and what is not

- **The cutover is atomic**, and that is a measurement rather than a reading of
  the docs. Sixteen readers looping for the lifetime of 200 commits, seven runs:
  0 torn pointer reads out of 38,558. The same experiment against a `writeFile`
  aimed straight at the pointer key tears 229-8,296 times per run, which is the
  control that makes the clean result a result.
- **Replacing an already-served batch is not stated**, because the two bindings
  disagree and one field cannot honestly describe both. Locally DuckDB's
  `COPY … TO` truncates the destination and writes, so a reader gunning for that
  exact object mid-copy can see a partial one. On S3 it is one `PutObject` and a
  concurrent `GET` returns the previous object whole. `atomicBatchReplace` is
  therefore left absent rather than set to one binding's answer.
- **Nothing spanning two statements is atomic.** There are no transactions.

## Licence

MIT © Davide Carvalho
