# @dudousxd/nestjs-catalog-store-mikro-orm

MikroORM/MySQL storage for [`@dudousxd/nestjs-catalog`](https://www.npmjs.com/package/@dudousxd/nestjs-catalog).

It binds both of the catalog library's swappable seams to a warehouse: the **model is stored rather
than derived**, and the **rows live in tables this package owns** rather than in somebody else's.

```bash
pnpm add @dudousxd/nestjs-catalog @dudousxd/nestjs-catalog-store-mikro-orm
```

Peers: `@mikro-orm/core`, `@mikro-orm/decorators`, `@mikro-orm/mysql`, `@nestjs/common`.

## Use

```ts
import { CatalogModule, CatalogRegistry, CATALOG_STORE } from '@dudousxd/nestjs-catalog';
import {
  CatalogMikroOrmStoreModule,
  MySqlWarehouseStore,
  StoredCatalogRegistry,
} from '@dudousxd/nestjs-catalog-store-mikro-orm';

// Held in a const, not called twice: `forRoot` returns a fresh DynamicModule per
// call, so importing two of them builds two registries — two in-memory copies of
// the model, one of which nobody reloads after a publish.
const store = CatalogMikroOrmStoreModule.forRoot({ contextName: 'catalog' });

@Module({
  imports: [
    store,
    CatalogModule.forRoot({
      imports: [store],
      registry: { provide: CatalogRegistry, useExisting: StoredCatalogRegistry },
      store: { provide: CATALOG_STORE, useExisting: MySqlWarehouseStore },
    }),
  ],
})
export class MyCatalogModule {}
```

Binding `registry` and `store` explicitly is not optional decoration. Without them the library
registers its MikroORM-derived defaults, which reflect over whatever entities the *default*
connection discovered — and a provider declared inside a module shadows the same token exported by
an imported one, so the default wins silently.

## `forRoot` options

| option | what it does |
|---|---|
| `contextName` | Which MikroORM connection to resolve the EntityManager from. **Set this whenever the catalog lives in its own database.** Omit it and the store resolves the *default* EntityManager, creating the catalog's tables and loading every snapshot into the host application's schema. Nothing reports an error, because writing to the wrong database is not a type error and the rows land successfully. |
| `autoSchema` | Manage this package's tables at boot instead of through the host's migrations. |
| `audit` | Record `aviary:catalog:*` events into the audit table. Note that the library emits them process-wide over `diagnostics_channel`, so if two catalogs share one process the trail over-reports. |
| `staleAfterMs` | How long a process may serve its in-memory model before checking the database for a newer one. Default `1000`; `0` turns the check off. See below. |

## More than one replica

The model is held in memory and rebuilt when something writes. On a deployment with two replicas
that used to mean a published type existed for part of the traffic and did not exist for the rest —
`PUT publish/:type/schema` answered 200 from the pod that handled it, and a connector run routed to
its sibling was refused — until the stale pod happened to serve a write itself, or restarted.

Each process now re-reads a **watermark** over the model tables (their row counts and newest
`updated_at`) and rebuilds only when it has moved. No writer participates: an invalidation every
write path has to remember is correct exactly until one forgets, and the symptom is a model quietly
a day out of date. A replica that never writes anything converges on its own.

What it costs the read path is nothing — `getSnapshot()` and `getType()` stay synchronous, the check
runs without them waiting for it, and the caller is served the snapshot already in memory. What it
costs the database is at most one small statement per `staleAfterMs` per process, whatever the
traffic. Set `staleAfterMs: 0` on a deployment that genuinely runs one process and wants its query
count exactly as it was.

## Object tables

Each published type's rows live in an `obj_*` table, one snapshot per load, and carry two indexes:

| index | columns | what it serves |
|---|---|---|
| `ix_snapshot_batch` | `(_snapshot_id, _batch)` | replacing a retried batch, counting a snapshot |
| `ix_snapshot_row` | `(_snapshot_id, _row)` | a page of `GET /catalog/objects/:name`, which is `ORDER BY _row LIMIT … OFFSET …` within one snapshot |

A new table is created with both. An existing table that lacks one gets it from `ensureType`, which
runs on the first write or publish of that type after boot. If adding it fails, the store logs a
warning containing the exact statement and carries on: a missing index makes reads slow, not wrong.
On MySQL `ADD INDEX` is an online InnoDB operation. On Postgres, `CREATE INDEX` blocks writes to
that table while it builds, so on a large table you can build it yourself first with
`CREATE INDEX CONCURRENTLY` under the name the store looks for, and `ensureType` will skip it.

On MySQL an index name is scoped to its table, so the names are the bare ones above. On Postgres it
is scoped to the schema, so each table's index is called `<table>_<index>` (for example
`obj_vehicle_ix_snapshot_row`). When that is longer than 63 characters it is cut short and given an
8-character hash suffix; `dialect.indexName(table, index)` gives the exact name. A Postgres table
that already carries the bare name counts as having that index.

**What a page read costs.** A read is three statements: the type, the total, and the page. When
nothing narrows the read (no search, no filters) and the snapshot is committed, the total is the
`rowCount` its snapshot record holds, read by primary key, so a page does not scan the snapshot to
count it. `commit` records that count, and a `write()` into a snapshot that is already committed
recounts it. A search, any filter, or an uncommitted snapshot still runs `COUNT(*)` over the rows
it selects.

## Keeping the host's migration differ away

The tables here belong to the library, so a host that runs its own migrations must be told to leave
them alone. `catalogManagedTables()` derives the names from the entities' own `@Entity({ tableName })`,
so a rename upstream cannot drift from what the host skips:

```ts
import { catalogManagedTables, MARKER_TABLE } from '@dudousxd/nestjs-catalog-store-mikro-orm';

// in your MikroORM config's schema-generator ignore list
...catalogManagedTables(),
MARKER_TABLE,   // excluded from the list above, like other Aviary stores treat theirs
/^obj_/,        // per-type snapshot tables: their names only exist at runtime
```

The per-type `obj_*` tables are deliberately absent from `catalogManagedTables()`. Their names are
data, not schema, and no differ should be allowed to reason about them at all.

## What is exported

- **`StoredCatalogRegistry`** — the model read from `catalog_object_type` / `catalog_property`,
  rather than reflected off entity classes.
- **`MySqlWarehouseStore`** — reads and writes the `obj_*` snapshot tables.
- **`MySqlWorkspaceStore`**, **`MySqlPipelineStore`** — saved queries and dashboards; connectors,
  connections, transforms, runs, workflow graphs and stages. The workspace store implements the
  optional `getSavedQueries` (one `IN` lookup) and `listSavedQuerySummaries` /
  `listDashboardSummaries` (only the columns search ranks), and the routing proxy forwards them.
- **`CatalogAuditRecorder`**, **`MySqlCatalogTraceStore`** — the audit trail.
- **Environment routing** — `runInEnvironment`, `currentEnvironment`, the `Routing*` proxies and
  `applyPromotion` / `readPromotable`, for serving several catalog environments from one process.
- **Entity classes** and `catalogStoreEntities`, if you would rather register them yourself.
