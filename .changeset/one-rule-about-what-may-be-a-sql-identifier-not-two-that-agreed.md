---
"@dudousxd/nestjs-catalog": minor
"@dudousxd/nestjs-catalog-store-mikro-orm": patch
"@dudousxd/nestjs-catalog-store-clickhouse": patch
"@dudousxd/nestjs-catalog-pipeline": patch
---

One rule about what may be a SQL identifier, rather than two that agreed

`store-mikro-orm` and `store-clickhouse` each carried the pattern
`/^[A-Za-z_][A-Za-z0-9_]{0,62}$/`, an `UnsafeIdentifierError`, and the sentence
`Refusing to use "…" as a SQL identifier: letters, digits and underscore only,
starting with a letter or underscore, 63 characters max.` — byte for byte
identical, in two files, with nothing anywhere comparing them.

That mattered because the publish-time refusal added alongside this reuses a
store's rule on purpose, so that a name refused at publish and the same name
refused at DDL cannot be described differently. It reused the MySQL copy. Which
bought the guarantee for a MySQL deployment and left a ClickHouse-only one
trusting two files to have been edited in step.

The rule now lives in `@dudousxd/nestjs-catalog` beside
`CATALOG_RESERVED_COLUMNS`, which is already shared for exactly this reason:
both are part of what the catalog promises a *publisher*, and a publisher should
be able to read the answer out of the contract rather than out of whichever
adapter happens to be mounted. New exports: `isSafeIdentifier`,
`assertSafeIdentifier`, `UnsafeIdentifierError`.

Each store keeps its own `ident`, because *quoting* is engine syntax and not the
catalog's business — what may be quoted at all is. Both now call
`assertSafeIdentifier` and re-export the core's `UnsafeIdentifierError` rather
than declaring one, which also makes `error instanceof UnsafeIdentifierError` a
question worth asking across packages: it used to be false whenever the mounted
store was not the one the catching code imported from.

No behaviour changes. The character set, the 63-character limit, the wording and
the quoting are all what they were; there is one copy of them instead of two.
