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
| Traces (`CATALOG_TRACE_STORE`), directory (`CATALOG_DIRECTORY`), stored registry, warehouse, pipeline | | Not yet. Later releases add them |

## Connecting: your database or your transaction

A store takes **one** of:

- `db`: any Drizzle Postgres database (`node-postgres`, `postgres-js`, ...). Each
  store call runs in one `db.transaction(...)`.
- `run`: a function that runs a callback in **your** transaction. Every statement a
  store call issues goes through it, so a host can set row-security settings,
  tenant context or its own guards first.

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

The module registers `DrizzleWorkspaceStore` under `CATALOG_WORKSPACE_STORE` and
exports `DrizzleCatalogOverlayStore` as a provider.

## Tables and migrations

`catalogDrizzleTables({ prefix, schema })` returns the Drizzle table definitions.
`prefix` defaults to `catalog_`, which gives the MikroORM store's table names
(`catalog_saved_query`, `catalog_dashboard`, `catalog_revision`,
`catalog_audit_event`), plus `catalog_overlay`. `schema` puts them in a named Postgres
schema.

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
