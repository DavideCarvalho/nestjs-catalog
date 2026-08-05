---
"@dudousxd/nestjs-catalog-store-mikro-orm": patch
---

Two things this package spent in its host's process, and no longer does

Both are the same kind of bug: work that is invisible from inside the catalog because it lands
somewhere else — the host's heap, or a connection the host will borrow back.

## Dating a type read every snapshot ever committed

`StoredCatalogRegistry.reload()` resolved each type's `lastCommittedAt` with
`em.find(SnapshotRow, { committed: true }, { orderBy: { committedAt: 'desc' } })` — the entire
committed history of every type, hydrated into managed entities, so that one row per type could be
kept and the rest thrown away.

Measured against MySQL 8.0 at 200 types and 50,000 committed snapshots: `reload()` took **450–500 ms**
and the hydrated rows added **161 MB** to the heap. Both are spent in the process this package is
mounted inside. `reload()` runs at boot, after every publish, after every commit and after every
curation edit, so a nightly connector fleet pays it several times a night — and neither number is
stable, because a snapshot row is written per load per type and **nothing in this repository ever
deletes one**. The cost grows with how long the deployment has been running, forever.

It is now a grouped query that asks the database which rows are the serving ones, followed by a
primary-key `IN` over that handful. Same answer, and the same `reload()` at the same 200 types and
50,000 snapshots now takes **119–133 ms** while hydrating 200 rows instead of 50,000.

What it costs elsewhere, stated plainly: the grouped query still **scans** the table. The only
declared index is `(type_name, created_at)`, which covers neither the `committed` filter nor the
`committed_at` ordering. The scan is now the database server's work rather than the host's, which is
the trade being made on purpose — but it does not vanish, and it still grows with history. An index
on `(committed, type_name, committed_at)` takes the grouped query from ~85 ms to ~14 ms at 50k rows.
It is deliberately **not** added here, for two reasons that are decisions rather than defects: the
DDL runs at boot on every pod, behind the host's readiness probe, against a table that may be very
large; and `fingerprintOf` hashes only column names, types and nullability, so an added `@Index`
would not move the schema fingerprint and would never be applied to an already-booted database
anyway. Retention for `catalog_snapshot` is the other half of that conversation, and there is
currently none.

## The query console left a statement timeout on a pooled connection

`runReadOnlyQuery` bounded the caller's statement with `SET SESSION MAX_EXECUTION_TIME`. That is
session scope, and a session here is a pooled connection: the value stayed set on that connection
after the request finished, for whoever borrowed it next. With no `contextName` configured,
`catalogConnectionProviders` binds this package to the **host's** `EntityManager` — so the connection
being altered is one of the host's, and the host's next statement on it silently inherited a
fifteen-second timeout it never asked for and had no way to see. Confirmed against MySQL 8.0: after
one query, a different `em.fork()` read the value back.

It is now a per-statement optimizer hint on the wrapper this function already builds. Both forms
interrupt a runaway cross join at 1.00 s; the hint leaves `@@SESSION.MAX_EXECUTION_TIME` at 0, and
removes a round trip, since it rides on the statement instead of preceding it. The hint attaches to
the outer `SELECT` written here, never to the caller's text, so a statement beginning with `WITH` is
untouched.

The `START TRANSACTION READ ONLY` that makes the screen safe to expose is unchanged, and was checked
rather than assumed while this was in hand: an `INSERT` issued between it and the `ROLLBACK` comes
back as `Cannot execute statement in a READ ONLY transaction`, sequentially and with eight such
sequences in flight at once, with the connection id stable across all four statements.
