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
| `CATALOG_PIPELINE_ENVIRONMENT` | what this host calls the copy of the world it is serving (optional) |

**`em` is a function, not a value.** A host serving several environments resolves the connection per
call. A value captured at construction pins every write to whichever environment happened to be
current when the module booted — and writing to the wrong database raises nothing, because it is not
a type error and the rows land successfully.

**`scope` defaults to pass-through.** A durable step is a message off a queue and a scheduler tick is
a timer callback, so neither carries an ambient scope. A host routing one store across environments
enters one; a single-connection host configures nothing.

**`environmentName` is a function too, and omitting it is a real answer.** Bind it as
`environmentName: 'prod'` or, on a host routing several environments through one process,
`environmentName: () => currentEnvironment()?.id`. It surfaces as `context.environment` to transform
code and to nothing else. Leaving it unbound leaves that field absent, which is different from
`'dev'` and the only truthful option: this package has no environment identity it can read, so a
default derived from `NODE_ENV` would be a guess presented as a fact.

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

## Per-record transforms, and why the mode is declared

A transform is called once with the whole batch by default, and that is what aggregating,
deduplicating, sorting and joining need. It is also what stops a graph streaming: the runner has to
buffer the source before it can make the call. And that is not an edge case — a column rename is
mandatory for every DPAS file this ingests, because real headers contain spaces (`Mgmt Cd`,
`Asset Id`) and both `WORKFLOW_FILTER_COLUMN_PATTERN` and `property-names.ts` refuse them.

So a transform declares which contract it is written against.

```js
// mode: 'record' — called once per record, over a stream
export default function transform({ record, context }) {
  return { mgmtCd: record['Mgmt Cd'] };
}
```

Return one object for one row, an array to turn one record into several, `[]` or `null` to drop it.
Map, filter and flatMap under one rule.

The runner feeds the source into the child as NDJSON and pulls rows back as they are produced, so
source, transform and sink all run at once and nothing anywhere holds the dataset. Over the real
102,520-row `af_fleet.csv` (`packages/catalog/bench/transform-stream.mjs`): 938 ms and 636 MB
buffered against 485 ms and 154 MB streamed. At three times the data the buffered arm does not get
slower — it **fails**, because a 44 MB JSON result exceeds `MAX_OUTPUT_BYTES`; the streamed arm holds
159 MB, and 231 MB at 1.2 million records.

**The mode is declared and never inferred.** Destructuring is not reliably introspectable and a
parameter name is the author's to choose, and both wrong guesses commit silently: guess towards
per-record and an aggregation returns one partial answer per record; guess towards batch and a
per-record function reads `undefined` off every property. Absent means `'batch'`, which is every
transform stored before the field existed.

Two combinations are refused by name, at save and again at run:

- **it must be a module.** A bare body has `records` in scope by the harness's own construction, so
  there is no honest way to hand it one record under a name it never wrote;
- **it cannot be Python yet.** That harness writes `def transform(records, context):` itself, so a
  Python transform never states a signature and there is no second `def` for the per-record shape.
  Whole-batch Python is unaffected.

### What a per-record transform may retain

| | |
|---|---|
| other records | **no** — there is no array in scope; the call shape enforces it |
| an end-of-stream emit | **no** — there is no finish hook, so an accumulated aggregate has nowhere to go. The node's row count comes out zero, which is loud rather than silently wrong |
| anything past the node | **no** — the child is spawned for one node run and killed at the end of it |
| module-scope state within one run | **yes** — a memo table or a compiled regex. No harness can prevent it without forbidding modules, so it is written down rather than pretended otherwise |

### What the timeout means for a stream

Total wall clock for a batch, **a stall for a stream**, and the difference is deliberate. A streamed
transform's elapsed time would include waiting on its source — which the batch path finished before
it spawned anything — so a total bound would fail loads that work today for reasons that have nothing
to do with the transform. What is bounded instead is the child owing an answer and nobody hearing
one: a hang is caught, a slow source is not, and a slow sink back-pressuring the chain is not. The
outer bound is still the durable step and `abandoned-runs.ts`.

A failure names where it happened — `failed on record 618` — where a batch call could only report
that the transform threw. A killed child cannot say where it got to, so a stall reports the window it
stopped in rather than picking a record inside it. Rows already produced sit in an **uncommitted**
snapshot and **no watermark moves**: the commit is above this path and is never reached.

## What code is told: `context`

Records are not the whole of what code needs. So it also gets `context` — in JavaScript, TypeScript
and Python alike, and in both modes — carrying the run, the graph, how much arrived, and the
environment variables this deployment admits.

```js
// javascript / typescript
const res = await fetch(url, { headers: { authorization: `Bearer ${context.env.VENDOR_TOKEN}` } });
if (context.rowCount === 0) return [];          // nothing upstream; do not fabricate rows
console.log(`run ${context.runId} on ${context.environment ?? 'an unnamed environment'}`);
```

```python
# python — a plain dict, so the same expression as any other JSON payload
token = context["env"]["VENDOR_TOKEN"]
```

| field | what it is |
|---|---|
| `contract` | `CODE_CONTEXT_CONTRACT` at the time the code ran |
| `runId` | the run, which is also the snapshot id. **Absent in the try pane**, where nothing is stored |
| `workflow` / `node` | `{id, name, version}` and `{id, name}`, in a graph. Absent for a connector's single transform |
| `connectorId` | the connector, when the code runs as a connector's transform rather than in a graph |
| `environment` | what the host calls this copy of the world, when it declared one — see `environmentName` |
| `rowCount` | how many records reached this code. **`0` on a streamed connector**, which does not know the total until the read has finished — a guess would be worse than a number that cannot be mistaken for a measurement |
| `inputs` | per inbound edge, in edge order: `{runId, nodeId, batches, rowCount}` — handles, never rows |
| `env` | the environment variables the credential allow-list admits, **and only those** |

The second parameter is generated by the harness, so every transform stored before it existed keeps
running unchanged.

### `env` is the allow-list, not `process.env`

`context.env` is filtered by the same credential allow-list a connector's `secretEnvVar` goes
through — `secretEnvAllowlist` in `forRoot`, or `CATALOG_SECRET_ENV_ALLOW` in the environment. It is
one policy, one list, one boot warning, and one place to look to answer "what can code on this
deployment read".

Handing code raw `process.env` would repeal that list rather than extend it. Transform code is a
string saved by a `catalog:write` principal, it runs in this pod, and it can print whatever it reads
into `logs` — which land in the run record and are served at `catalog:read`. That is exactly the hole
the allow-list closed for connectors, reopened somewhere nobody would think to look for it.

Three configurations, three answers, and the run's own log says which:

| allow-list | `context.env` |
|---|---|
| nothing bound | `{}`, with a line naming both levers |
| `['*']` | **`{}`** — see below |
| `['VENDOR_TOKEN', 'FLEET_*']` | those, from this pod, empty values dropped |

**`['*']` admits nothing to code.** The escape hatch exists so an upgrade under time pressure has one
honest line that keeps connectors running: a connector reads *one named variable*, shown on its own
screen. Copying the whole pod environment into every transform's context is a different disclosure,
into a place one `console.log` publishes at `catalog:read`, and nobody consented to it by typing one
character. Name the variables and they appear.

### Replay

Everything in the context is plain JSON, and everything except `env` and `environment` comes from a
durable step's checkpointed input — the run id, the node, the graph's version, the stage handles —
so it is byte-identical on every attempt and every replay. `env` and `environment` are reads of
pod-local state.

For a transform that does not matter: it runs inside a step whose output is checkpointed, so a replay
returns the recorded answer and never re-runs the code. **For code evaluated in a workflow body — a
conditional's predicate — it matters a great deal**, because a redeploy between the original run and
the replay could otherwise move the branch. Resolve `allowlistedCodeEnv()` and `namedEnvironment()`
inside a step, build the context with the pure `codeContext()`, and let the checkpoint carry it. The
shape is JSON precisely so that it can.

### What the context deliberately does not carry

No database handle, no store, no `process` — code reaches nothing but what is on this object. Nor a
list of the connections or connectors that exist: it is an inventory of a deployment's integrations,
it is a read at code-run time and therefore not replay-safe, and no use case asked for it. A node
that needs a source should have an edge from one.

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

**An attempt that never came back is closed by the next one, on both run paths.** A step whose lease
expires is re-dispatched while the attempt holding it is still running, so that attempt never reaches
`finishRun` and its run row sits at `running` with `fetched = 0` and no error for good. On the way
in, a run closes any earlier run *at the same snapshot id* that is still marked running, recording
what that state means and pointing at `durable_step_checkpoints`, where a rising `attempts` against
an empty error is the engine's side of the same fact. Keyed on the snapshot rather than on age,
because the loads this is about are the slow ones — the last attempt of a series is closed by nothing
on this rule, since nothing runs after it, and is picked up by the engine-view pass below.

One implementation (`closeAbandonedAttempts`), called by both `ConnectorRunnerService` and
`WorkflowRunnerService`: they are two implementations of a load rather than one wrapping the other,
and a rule this specific about what it keys on would not survive being written down twice. Two things
follow from the graph path having a *planning step* rather than a per-attempt row:

- A workflow run's row used to be **adopted** by whichever attempt found it — so the attempt that
  replaced an abandoned one wrote its own outcome over the row and nothing said an earlier attempt
  had vanished. It now opens its own row and closes the one before it, which means a snapshot can
  carry more than one row and `findRun` answers with the one still being written.
- The scan is not the stale-stage sweep beside it. That takes runs that **failed**, at **other**
  snapshots, older than `CATALOG_STAGE_RETENTION_MS`, and drops their staged rows; this takes runs
  still **running**, at **this** snapshot, at any age, and writes them an outcome. They compose:
  staged rows are only collected from a failed run, so a row abandoned at `running` kept its stages
  for good until something closed it.

**The row nothing revisits is closed by asking the engine.** A durable workflow run plans once and
its node retries reuse that row, so the attempt that closes an abandoned row is a planning step being
retried or an operator re-driving the same `snapshotId`. A durable run that dies without ever
reaching its finish step — an execution timeout, a cancellation, a worker that never resumes — leaves
a row nothing will revisit, because the next run of that workflow mints a new snapshot. The answer to
that row is not a clock but the engine: **the snapshot id *is* the durable run id**, so
`AbandonedRunReconciler` asks `engine.getRun` whether the run this deployment still calls `running` is
actually alive, and closes it when the engine has no record of it or reports it terminal.

- **A pass every `CATALOG_RUN_RECONCILE_MS` (default 5 min), on one process.** One
  `ORDER BY started_at DESC LIMIT CATALOG_RUN_RECONCILE_SCAN` over the run table, one
  `listConnectors` for the names, and one `engine.getRun` per row *currently* open — nought or one on
  a healthy deployment. Nothing in it grows with the data a load moves. Loaded on the same axis as the
  scheduler (`reconcileRuns`, defaulting to `scheduler`), because it writes.
- **Three answers, and only two are writes.** No record of the run, or a terminal status, are closes.
  A non-terminal status — including one a later engine release adds — is left exactly alone: a row
  wrongly left `running` is visible and is the status quo, a row wrongly closed is a false outcome in
  the record a load is audited by.
- **When the engine cannot be asked, nothing is written and the reason is said at boot.** No engine
  at all means every run here is `inline` and there is nothing to reconcile. An engine that resolved
  and cannot read a run is the thin-worker case — `DurableStartClient` is bound under the
  `WorkflowEngine` token as a store-less, start-only facade — and warns, because durable rows exist
  and this process cannot see them.
- **Only rows that say `executionMode: 'durable'`.** An `inline` row has no durable run, so
  `getRun` would answer "no record" for a load running perfectly. A row with no execution mode —
  which is every `ConnectorRunnerService` row — is refused for the same reason rather than guessed at,
  so the single-transform path keeps the next-attempt rule and gets no second one.

**A MySQL connector reads a batch at a time; a Postgres one does not, and neither does a connector
with a transform.** The write side has always been bounded — 500 rows per batch — and the read side
was not: the driver materialised the whole result set first, which on a large table is a step that
holds a table in the heap until its lease expires with nothing recorded anywhere. `fetchSql` now
reads MySQL through mysql2's row stream, and back-pressure reaches the socket, so the pipeline holds
a batch. Two exceptions, both deliberate:

- **Postgres.** Plain `pg` buffers the result set inside the driver; streaming needs an explicit
  portal, which lives in `pg-cursor`/`pg-query-stream` — a dependency this package does not require.
  Narrow a large Postgres connector with `watermarkColumn` or a `LIMIT`.
- **A connector whose transform is `mode: 'batch'`.** A batch transform is called once with every
  record — that is the contract, and it is what lets one deduplicate, aggregate or join — so it is
  given the whole read in one call and the whole read is therefore in memory. Chunking the calls
  would silently change what an aggregating transform computes. The run log says when this is what
  happened, and names the way out.

  A transform whose mode is `'record'` has no such contract, so it **streams**: see below.

**`scheduler` is per process.** Starting a run from a process that "should not" would still be
correct — the run id is derived from the cron fire time and `engine.start` is idempotent, so a
duplicate start is a no-op. The option exists so that every replica does not poll the store on a
timer, not for safety.

**The publish path is MikroORM-shaped today.** It writes against `ObjectTypeRow`, `PropertyRow` and
physical table names via `tableFor`, so `@dudousxd/nestjs-catalog-store-mikro-orm` is a peer rather
than an optional one. The other stores in this repo are not yet publish targets.
