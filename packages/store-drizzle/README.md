# @dudousxd/nestjs-catalog-store-drizzle

The catalog's application state on **Drizzle and PostgreSQL**, for a host that does
not run MikroORM: saved queries, dashboards, saved-query revisions, the audit trail
and the curation overlay.

```bash
pnpm add @dudousxd/nestjs-catalog-store-drizzle drizzle-orm
```

It implements the same interfaces the MikroORM store does (`CatalogWorkspaceStore`
and `CatalogOverlayStore` from `@dudousxd/nestjs-catalog`). Both stores pass one
shared contract (`test/workspace-store-contract.ts`) on a real Postgres.

## What it covers today

| Storage | Interface | Here |
|---|---|---|
| Saved queries, dashboards, revisions, audit events | `CatalogWorkspaceStore` (`CATALOG_WORKSPACE_STORE`) | `DrizzleWorkspaceStore` |
| Curation overlay | `CatalogOverlayStore` (`CatalogModule.forRoot({ overlayStore })`) | `DrizzleCatalogOverlayStore` |
| Traces: the audit trail grouped by load, graded and paged | `CatalogTraceStore` (`CATALOG_TRACE_STORE`) | `DrizzleCatalogTraceStore` |
| Recording catalog events into the audit table | | `CatalogAuditRecorder` (from the core package), registered unless `audit: false` |
| The model: object types, properties, relations, serving snapshot, curation | `CatalogRegistry` | `DrizzleCatalogRegistry` |
| Applications that may reach the catalog, and the types they own | `CatalogDirectory` (`CATALOG_DIRECTORY`) | `DrizzleCatalogDirectory` |
| Warehouse (`CATALOG_STORE`: snapshot rows, `ObjectExplorer`, lineage, queries), pipeline | | Not yet |

## Connecting: your database or your transaction

A store takes **one** of:

- `db`: any Drizzle Postgres database (`node-postgres`, `postgres-js`, ...). Each
  store call runs in one `db.transaction(...)`.
- `run`: a function that runs a callback in **your** transaction. Every statement a
  store call issues goes through it, so a host can set row-security settings,
  tenant context or its own guards first.

**`run` must give each call exactly one transaction of its own, or a savepoint**
(`db.transaction(work)`, or `tx.transaction(work)` inside a transaction you already
hold). The store relies on it twice. A saved query and its revision are written by
separate statements and are atomic only inside one transaction. An edit locks the
row `FOR UPDATE`, and that lock lasts only until the transaction ends, so in
autocommit mode it protects nothing. `recordEvent`, which never throws, writes in a
savepoint of its own, so a failed audit insert does not abort your transaction.

```ts
import { CatalogDrizzleStoreModule, DrizzleCatalogOverlayStore } from '@dudousxd/nestjs-catalog-store-drizzle';

CatalogDrizzleStoreModule.forRootAsync({
  imports: [DatabaseModule],
  inject: [Database],
  useFactory: (database: Database) => ({
    // Your wrapper: open a transaction, set what your policies read, run the work.
    run: (work) => database.withTenant(currentPrincipal(), (tx) => work(tx)),
    prefix: 'catalog_',
  }),
});

CatalogModule.forRoot({
  overlayStore: new DrizzleCatalogOverlayStore({ run, prefix: 'catalog_' }),
  // registry and store: your own, until the Drizzle registry and warehouse ship.
});
```

The module registers `DrizzleWorkspaceStore` under `CATALOG_WORKSPACE_STORE`,
`DrizzleCatalogTraceStore` under `CATALOG_TRACE_STORE` and the core
`CatalogAuditRecorder`, which writes every catalog diagnostics event into the audit
table (pass `audit: false` to leave it out). It exports `DrizzleCatalogOverlayStore`
as a provider.

## The registry and the directory

`DrizzleCatalogRegistry` serves the catalog model from the `object_type`, `property`
and `snapshot` tables, like the MikroORM `StoredCatalogRegistry`:

- Types are ordered by group, then display name; properties and relations by
  position.
- A type reports its newest committed snapshot.
- `patchType` and `patchProperty` write the rows themselves, curating a relation
  through the same patch.
- Each replica checks a cheap watermark (row counts and newest `updated_at`) at most
  once per `staleAfterMs` (default 1000), and reloads when another replica changed
  the model.
- The module loads it on init and binds it to `CatalogRegistry`. Hand that to
  `CatalogModule.forRoot({ registry: { provide: CatalogRegistry, useExisting:
  DrizzleCatalogRegistry } })`.

Nothing in this package writes the model yet: publishing types and loading snapshots
are the warehouse's and the pipeline's job, and both still come.

`DrizzleCatalogDirectory` lists applications from the `principal` table, with the
types each owns and whether it authenticates with a key. It never exposes the key
hash. It has no `listPeople`; extend the class to read people from your own user
table.

## Traces

`DrizzleCatalogTraceStore` groups the audit table into one trace per snapshot id in
a single Postgres statement, using `jsonb` operators and an ordered `string_agg`.
It passes the same contract (`test/trace-store-contract.ts`) the MikroORM trace store
passes on MySQL, on a trail of 30,000 loads:

- events within one millisecond keep their lifecycle order;
- a trace's outcome comes from its last terminal event;
- pages neither repeat nor lose a trace, and a filter still pages by when a load
  began;
- `listTraces` and `traceTotals` agree.

One difference: under an outcome filter, a page past the end reports the real total.
The MikroORM store reports 0 there.

## Tables and migrations

`catalogDrizzleTables({ prefix, schema })` returns the Drizzle table definitions.
`prefix` defaults to `catalog_`, which gives the MikroORM store's table names
(`catalog_saved_query`, `catalog_dashboard`, `catalog_revision`,
`catalog_audit_event`), plus `catalog_overlay`. A prefix is at most 17 characters, so
every index name fits in Postgres's 63-byte limit. `schema` puts the tables in a
named Postgres schema; `public` is the same as leaving it out.

The column types, precisions, defaults and index names are the ones the MikroORM
store creates on Postgres, and a database test compares the two. A database the
MikroORM store already set up can therefore move to this store without a migration
and without duplicate indexes.

Two ways to create them:

- **drizzle-kit.** Export the tables from your schema file and generate as usual:

  ```ts
  // db/schema/catalog.ts
  import { catalogDrizzleTables } from '@dudousxd/nestjs-catalog-store-drizzle';
  export const { savedQuery, dashboard, auditEvent, revision, overlay } =
    catalogDrizzleTables({ prefix: 'catalog_' });
  ```

- **Hand-written SQL.** Copy `catalogDrizzleSql({ prefix, schema })`, or
  `sql/catalog.sql` for the default prefix, into a migration. A unit test keeps the
  file equal to the function, and a database test keeps the function equal to the
  table definitions.

## No superuser

The SQL creates tables and indexes only: no roles, extensions, schemas, owners,
grants or definer functions. The store issues `SELECT`, `INSERT`, `UPDATE` and
`DELETE` and nothing else. The database tests create the tables as a plain owner
role and run every case as an application role that holds only those four
privileges. One run puts the tables under `FORCE ROW LEVEL SECURITY` with a policy
that admits rows only while the host wrapper's setting is on. Grants and policies
are yours to write beside the tables.

## Behaviour

The same as the MikroORM store:

- A saved query's version bumps, and its SQL is archived as a revision, only when
  the SQL changes. The first statement is revision 1. Revision ids are
  `saved-query:<id>:<version>`.
- At most `CATALOG_REVISION_LIMIT` revisions are kept per subject.
- `recordEvent` never throws.
- Overlay `load` and `save` hand out copies, never the store's own object.
