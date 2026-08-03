# @dudousxd/nestjs-catalog-pipeline

Fetch, transform, publish — the connector pipeline for
[`@dudousxd/nestjs-catalog`](https://www.npmjs.com/package/@dudousxd/nestjs-catalog).

Connectors and their sources, Python/JS transforms, workflow graphs, the durable workflows that run
them, and a cron scheduler.

```bash
pnpm add @dudousxd/nestjs-catalog @dudousxd/nestjs-catalog-store-mikro-orm @dudousxd/nestjs-catalog-pipeline
```

## Use

```ts
import { CatalogPipelineModule, CATALOG_PIPELINE_TOKENS } from '@dudousxd/nestjs-catalog-pipeline';
import {
  CATALOG_STORE_ENTITY_MANAGER,
  StoredCatalogRegistry,
} from '@dudousxd/nestjs-catalog-store-mikro-orm';

CatalogPipelineModule.forRoot({
  imports: [storeModule],
  em: {
    provide: CATALOG_PIPELINE_TOKENS.em,
    inject: [CATALOG_STORE_ENTITY_MANAGER],
    useFactory: (em) => () => em,
  },
  registry: {
    provide: CATALOG_PIPELINE_TOKENS.registry,
    useExisting: StoredCatalogRegistry,
  },
  scheduler: process.env.APP_TYPE !== 'API',
});
```

## The three seams

The engine is the same everywhere; three things are not, and they are injected rather than imported
because the two applications this was extracted from disagreed on all three.

| token | what it answers |
|---|---|
| `CATALOG_PIPELINE_EM` | which EntityManager a write lands on |
| `CATALOG_PIPELINE_REGISTRY` | which registry the model is read from (`reload()` + `getType()`) |
| `CATALOG_PIPELINE_SCOPE` | what scope, if any, a durable step runs inside |

**`em` is a function, not a value.** A host serving several environments resolves the connection per
call. A value captured at construction pins every write to whichever environment happened to be
current when the module booted — and writing to the wrong database raises nothing, because it is not
a type error and the rows land successfully.

**`scope` defaults to pass-through.** A durable step is a message off a queue and a scheduler tick is
a timer callback, so neither carries an ambient scope. A host routing one store across environments
enters one; a single-connection host configures nothing.

## Notes

**Nothing here decides *when* a load runs.** The scheduler starts runs and a human can press the
button; the runners only execute. Two systems believing they decide when a load happens is the
failure this split exists to avoid.

**Retries are safe because the snapshot id comes from the caller.** A connector run is a snapshot
load: rows arrive under a snapshot id in numbered batches, a retried batch replaces itself, and a
separate commit makes it visible. Three attempts load the data once.

**`scheduler` is per process.** Starting a run from a process that "should not" would still be
correct — the run id is derived from the cron fire time and `engine.start` is idempotent, so a
duplicate start is a no-op. The option exists so that every replica does not poll the store on a
timer, not for safety.

**The publish path is MikroORM-shaped today.** It writes against `ObjectTypeRow`, `PropertyRow` and
physical table names via `tableFor`, so `@dudousxd/nestjs-catalog-store-mikro-orm` is a peer rather
than an optional one. The other stores in this repo are not yet publish targets.
