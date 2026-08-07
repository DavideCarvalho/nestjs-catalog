---
'@dudousxd/nestjs-catalog-pipeline': minor
'@dudousxd/nestjs-catalog-react': minor
---

An s3 connector can read a named `@dudousxd/nestjs-media` disk

`disk: "drops"` reads through the host's `StorageManager` instead of a bucket,
an endpoint, a region and a credential of the connector's own. The disk already
holds all four, configured once by the host and rotated in one place. The
measured saving is the duplication that disappears: pointing the catalog at a
local MinIO needed `CATALOG_MINIO_KEY=minioadmin:minioadmin` plus a
`CATALOG_SECRET_ENV_ALLOW` entry to admit the name — a second copy of a
credential the host had already configured.

**Nothing changes for a deployment without media.** A connector that names no
disk takes the same `@aws-sdk/client-s3` path it always has, and the existing
source tests pass untouched. There are no new dependencies, not even a
type-only import: the manager resolves from the injector by
`Symbol.for('nestjs-media:storage')`, the globally registered token media minted
for cross-package use and which its own telescope dashboard reads the same way.
DI rather than `importOptional` because a `StorageManager` is not a constructor
to configure — it is already-configured host state, and that configuration is
the entire feature.

**One reader, not two.** The transport is now behind a four-method
`ObjectStore` seam, so the watermark and its tie set, the oldest-first sort
`maxObjectsPerRun` cuts against, the per-object format resolution, the
blank-row ledger and the spool-or-whole dispatch exist exactly once and do not
know which transport produced the bytes.

**The screen says what is lost.** `GET pipeline/capabilities` gained a
`storage` field — `available`, `disks`, and a full-sentence `detail` — and the
source inspector renders `describeStorage()` in every state, including the one
where no manager resolved. It says the cost out loud, because a hidden picker
is a silent fallback: nobody misses a feature they have never seen, and what
they do instead is mint a second credential. Naming a disk that does not exist
is refused at authoring time with the list of names that would have worked, and
a connector that names a disk on a pod with no media is refused rather than
quietly falling back — it carries no bucket, so the fallback would read nothing
and call the run a success.
