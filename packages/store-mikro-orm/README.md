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
  connections, transforms, runs, workflow graphs and stages.
- **`CatalogAuditRecorder`**, **`MySqlCatalogTraceStore`** — the audit trail.
- **Environment routing** — `runInEnvironment`, `currentEnvironment`, the `Routing*` proxies and
  `applyPromotion` / `readPromotable`, for serving several catalog environments from one process.
- **Entity classes** and `catalogStoreEntities`, if you would rather register them yourself.
