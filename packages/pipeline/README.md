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

## Running a transform is running code

Transforms are JavaScript, TypeScript or Python, and they run in a child process of **this** pod.
`SubprocessTransformRunner` gives that child a timeout, a working directory of its own and an
environment of `{PATH, NODE_ENV}`. None of that is a sandbox, and the gap is worth being exact about
rather than leaving to be discovered: the child runs as the same uid as the service, so it reads the
whole of the parent's environment back out of `/proc/<ppid>/environ`, reads any absolute path the
service can — a mounted service-account token included — and opens sockets.

**So the control is authorisation, not isolation.** `POST pipeline/transforms/try` executes code
immediately, and asks for all three of:

| | why |
|---|---|
| `catalog:write` | it is code that decides what gets stored |
| at least one `writeTypes` grant | the bar the graph path already charges — see below |
| a signed-in person (`RequireHuman`) | it stores no row, so the log line naming a person is the only record that code ran |

The last one is a **declaration your guard has to enforce** for machine callers to be turned away at
the door, via the `REQUIRES_HUMAN` metadata key from `@dudousxd/nestjs-catalog`. The route does not
rely on that: it checks `principal.actor` itself. Reading the key in your guard is still worth doing,
because it is the mechanism that will govern the next such route.

### What this deliberately does not stop

**A principal that may write any type can run arbitrary code in this process.** Not only through the
try route — through the ordinary one: save a transform, save a graph whose sink commits a type it may
write, press Run, and `WorkflowRunnerService` executes that code in the same runner.
`ConnectorRunnerService` is the same story. Gating the try route harder than the graph path would
inconvenience the person iterating in an editor and nobody else, so it is gated the same and no
tighter.

That is the trust model the class docblock describes: transforms are written by people who already
have database access. If your deployment does not look like that — analysts you would not give a
shell, a multi-tenant console — the supported change is to bind your own `TransformRunner` (a
container, gVisor, a WASM runtime) rather than to tighten a scope. It is an interface precisely so
that swap is a provider change.

## Notes

**Credentials are redacted at the HTTP boundary, including inside a graph.** `GET connections`,
`GET connectors` and `GET workflows` replace the password in any top-level config URL with
`REDACTED` — a workflow's source nodes carry the same `config.url` a connector does, so a graph is a
place credentials live. The store is not redacted, deliberately: the runner needs a URL that
connects, and environment promotion copies connectors by reading and re-writing them. Posting a
redacted value straight back is understood as "unchanged" and restores what is stored, so a console
that reads a graph and saves it does not overwrite the password with the placeholder. The stated
limit is that only *top-level* strings are covered — a secret inside `config.headers` is not, and
belongs in `secretEnvVar`.


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
