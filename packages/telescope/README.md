# `@dudousxd/nestjs-catalog-telescope`

> Part of the [Aviary](https://davidecarvalho.github.io/aviary) · a **Catalog** tab for [`@dudousxd/nestjs-telescope`](https://davidecarvalho.github.io/aviary/docs/telescope).

Adds a **Catalog** dashboard to Telescope: loads, connector runs, schema changes and curation
edits, grouped by the snapshot that already correlated them. It subscribes to the
`aviary:catalog:*` diagnostics channel and reads the catalog's own trace store — no
instrumentation in your code, and no change to `@dudousxd/nestjs-catalog`.

`@dudousxd/nestjs-catalog` does not know this package exists. It publishes on the neutral
[`@dudousxd/nestjs-diagnostics`](https://davidecarvalho.github.io/aviary/docs/diagnostics)
channel; this package subscribes. A deployment without Telescope carries none of this code and
loses nothing; a deployment with it gets the tab by installing one package.

## Install

```bash
pnpm add @dudousxd/nestjs-catalog-telescope
```

Peers: `@dudousxd/nestjs-telescope` (>= 1.18), `@dudousxd/nestjs-catalog` (>= 0.1),
`@nestjs/common`, `@nestjs/core`.

`@dudousxd/nestjs-catalog` **must** be a peer, never a nested copy. `CATALOG_TRACE_STORE` is a
plain `Symbol()`, not `Symbol.for()`, so it is only equal to itself within one loaded copy of the
package. Two copies means the DI lookup misses and every durable panel is permanently, silently
blank.

## Use

```ts
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { catalogTelescopeExtension } from '@dudousxd/nestjs-catalog-telescope';

@Module({
  imports: [
    TelescopeModule.forRoot({
      extensions: [catalogTelescopeExtension()],
    }),
  ],
})
export class ObservabilityModule {}
```

That is the whole registration. The extension contributes its own watcher, entry type, dashboard
and data providers — you do not add the watcher to `forRoot({ watchers })` yourself.

### Wiring the durable panels

Everything about loads is read from the catalog's trace store. The providers resolve
`CATALOG_TRACE_STORE` out of the host container **at request time**, so bind it in the same
module that registers Telescope:

```ts
import { CATALOG_TRACE_STORE } from '@dudousxd/nestjs-catalog';

@Module({
  imports: [TelescopeModule.forRoot({ extensions: [catalogTelescopeExtension()] })],
  providers: [{ provide: CATALOG_TRACE_STORE, useExisting: MikroOrmCatalogWorkspaceStore }],
})
export class ObservabilityModule {}
```

If the token is not bound, the durable panels render empty and the **live** section keeps working
— including its failures table. That is deliberate: a failure must be unmistakable in every
supported configuration, not only the fully-wired one.

### Options

```ts
catalogTelescopeExtension({
  recordBatches: false, // record snapshot.written (per batch). Default false.
  sinceHours: 24,       // lookback for the durable panels. Default 24.
  limit: 50,            // rows per durable table. Default 50.
  loadHref: undefined,  // deep-link a load to your own console instead of the trace waterfall.
});
```

## What the tab shows

Four sections, in the order somebody actually asks the questions at 3am.

**Loads (last 24h)** — four stat cards: *Failed*, *Incomplete*, *Running now*, *Rows committed*.

They are four cards and not one number with a breakdown because they are four different
questions. *Incomplete* is the one worth knowing about: it is the catalog's own outcome for a load
that stopped without ever saying how it went — batches written and never committed, a snapshot
dropped, a process that died in between. Rows landed and no reader can see any of them. Folded
into "failed" it is understated; folded into "succeeded" it is a silent data loss rendered in
green. So it is neither, and it gets its own card. *Running now* is separate for the same class of
reason: a load in flight has committed nothing, and must never be counted beside a result.

**Outcomes** — the outcome mix, and a table of the window's loads.

**Needs attention** — the failed and incomplete loads on their own, and beside them the schema
changes, curation edits and transform changes. A failure sitting at row 31 of a table of successes
is not something a tired person finds by scrolling, so the problems get a table that is *empty on
a good night* — "not empty" is the signal. The changes table is the second question of any
incident: the first is "what broke", and for a load that produced a number nobody believes, the
answer is almost always "somebody changed a transform".

**Live channel activity** — what is arriving on the diagnostics channel right now, and failures
seen on it.

This section answers something the durable panels structurally cannot: *is the wiring alive at
all*. An empty loads table means either a quiet night or that the emitter and this subscriber
disagree about a channel name and nothing has been recorded since the upgrade. Those look
identical and are opposite.

### How a load is grouped

A load is not a new concept invented here. The catalog already defines one: a connector run, the
snapshot it writes, each batch, the commit and the finish all carry the **same `snapshotId`**, and
when the durable engine schedules the run that id *is* the durable run id. `CatalogTrace` is that
grouping, and this package reads it rather than defining a second one.

On the Telescope side the same id does the same job for free. The watcher stamps each event's
`snapshotId` as the entry's `traceId`, which is exactly the field Telescope's own trace waterfall
groups by — so `#/traces/<snapshotId>` renders the load's story, and every table row deep-links
there with no host wiring. Events that carry no snapshot id (curation, transform and schema
changes) get **no** `traceId`: they are standalone acts, and attaching them to whatever trace
happened to be ambient would fabricate a causal link that later reads as evidence.

### Failed vs in-progress

- A failed `connector.run.finished` is tagged **`failed`** — Telescope core's own cross-type
  convention, the same tag its exceptions carry — so a failed load is filterable and alertable
  next to every other failure in the system, not only findable by knowing to open this tab.
- The error message rides on the entry and in the failures tables, capped (see below).
- A **running** load renders its committed rows and its duration as `—`, never `0`. A zero there
  would state that zero rows were committed and that it took no time: a claim about a finished
  load, made about one that has not finished.
- `failureCount` is shown beside the outcome, because a retry reuses the snapshot id — a load can
  honestly be "succeeded, on the third attempt", and reporting that as a plain success hides two
  failures.

## What it captures — and what it does not

**Captured.** The seven milestone events on `aviary:catalog:*`: `connector.run.started`,
`connector.run.finished`, `snapshot.committed`, `snapshot.dropped`, `schema.changed`,
`type.curated`, `transform.changed`. Their payloads are recorded verbatim: type names, table and
column names, connector names, principal ids, row counts, fetched/written counts, transform name,
language and version.

**Not captured.**

- **No row contents, ever.** No event on this channel carries them, and this package adds no code
  path that could reach the data. What leaks, if anything leaks, is the *shape* of an integration
  — which types exist, which columns were added, which connector ran — and never its data.
- **No credentials.** Nothing on the channel carries a secret, a token or a connection string.
- **`snapshot.written` is off by default.** It fires once per batch, so its volume is a function
  of how much data you move, not of how much is happening: a ten-million-row load emits ten
  thousand identical entries and drowns a timeline shared with requests, queries and logs. It
  costs nothing to leave off — the size of a load is on `snapshot.committed` as `rowCount`, and
  every batch is durably in the catalog's audit trail, which the durable panels read. Set
  `recordBatches: true` to watch a load arrive in real time while debugging a stall.
  While it is off, the event is deliberately left *unclaimed*, so
  `@dudousxd/nestjs-diagnostics-telescope`'s generic bridge still captures it if you want the raw
  feed.
- **Error messages are capped at 500 characters.** This is the one field whose contents the
  catalog does not control — it is whatever the remote system, the driver or the transform threw,
  and a database error routinely echoes the statement while a connection failure routinely echoes
  the DSN. Capping is a bound, not redaction, and it is applied on both paths because provider
  output never passes through Telescope's redaction pipeline at all.

## Retention and volume

This package records **7 entries per load** by default (run started, commit, run finished, plus
whatever schema or curation activity accompanied it) rather than one per batch. A catalog running
a thousand loads a day produces a few thousand entries a day — comparable to a moderately busy
HTTP route, not to a query log.

- **Live entries** are governed by the host's own prune window; this package does not and cannot
  set retention. Because entries here are milestones rather than a stream, a longer window is
  cheap and worth it:

  ```ts
  prune: { after: '5m', perType: { catalog: '24h' } }
  ```

  24 hours matches the window the dashboard queries, so the live section and the durable section
  agree about the same night.
- **Durable data** lives in the catalog's own audit trail, retained by whatever the host retains
  it for. This package only reads it.
- **The dashboard queries the trailing 24 hours** by default (`sinceHours`), because the question
  it is opened to answer is "what happened tonight". A longer default buries a single failure
  under a week of successes.
- **Tables cap at 50 rows**; the live failures table at 25; the live scan at 2,000 entries.
- **Tags are bounded-cardinality only** — event name, type name, connector name, and the outcome.
  The snapshot id is *not* a tag; it goes on `traceId`, which is the field built to carry a
  correlation key without growing a tag index at the rate you run loads.
- **Rows committed** sums over at most 500 successful loads. A busier window undercounts — chosen
  because an undercount makes a good night look quiet (and prompts a look), while an overcount
  would make a bad night look productive.

## Coexisting with the generic diagnostics bridge

`@dudousxd/nestjs-diagnostics-telescope` records *every* `aviary:*` channel. Running both is fine
and needs no `exclude` wiring: `CatalogWatcher.register()` claims each key it records via
`claimDiagnostics`, which the generic watcher checks at record time and skips, so nothing is
recorded twice. Claims are reference-counted and checked at record time, so registration order
does not matter. `dispose()` releases the claim.

## License

MIT © Davide Carvalho
