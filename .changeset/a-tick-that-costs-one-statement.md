---
"@dudousxd/nestjs-catalog-pipeline": minor
---

An idle host pays one statement a tick, not one per pipeline

This library mounts inside somebody else's application, so what it costs a
process that is not using it is a property it has to hold rather than a detail.
It was not holding it. On a worker with twelve scheduled graphs, a
`ConnectorScheduler` tick issued **13 statements** — one `listWorkflows`, then a
`connectorsUsingWorkflow` per runnable graph to re-confirm a "not due" that could
not have changed — every thirty seconds, forever. `AbandonedRunReconciler` read
the whole connector table on every pass to have names ready for a warning that,
on a healthy deployment, is never written.

Measured against MySQL 8.0 with 20 workflows (12 scheduled), 20 connectors and
200 run rows, through the real classes rather than fakes. `blocked` is time the
event loop was held without yielding, sampled with a 1ms heartbeat — the number
that matters to a host, and the one an average CPU figure hides:

| | statements | blocked | wall |
|---|---|---|---|
| scheduler tick, steady | 13 → **1** | 16.10ms → **0ms** | 26.41ms → **4.36ms** |
| reconciler pass | 2 → **1** | 8.62ms → 4.94ms | 22.53ms → 20.56ms |

Per idle hour on one worker: **1,584 → 132 statements**, and **2.04s → 0.06s** of
held event loop.

The scheduler now records the window it last carried each graph to a decision
for, fingerprinted with that graph's cron, version and `updatedAt`, and returns
without touching the store when the next tick brings the same one. It is not a
cached schedule: the schedule list is still rebuilt from the store on every
single tick, so an edit still takes effect within one poll interval. What it
gives up is a connector row whose `updatedAt` moves *backwards*, which only a
promotion importing an older environment's rows can do, and which costs one
catch-up window on a pipeline somebody is mid-migration on. The guarantee that
a window starts exactly once is untouched — it was never this filter, it is the
deterministic run id. A `ready` graph with no connector is deliberately left
paying a query per tick, so publishing again is still seen.

`ReconcileScan.names` is now `() => Promise<ReadonlyMap<string, string>>` rather
than the map itself, and is called only by a pass that has something to close.
That is a breaking change to an exported type, hence minor: a caller passing a
map gets a compile error rather than names that silently stop appearing.

`ConnectorScheduler.tick()` is public, for the reason
`AbandonedRunReconciler.pass()` already was — a host that drives it from its own
scheduler, and a measurement that would rather not own a timer.

`packages/pipeline/src/idle-cost.db.spec.ts` is that measurement, and it runs
under `pnpm test:db`. It asserts statement counts, which are the same everywhere,
and only reports timings, which are not.

**What this does not fix, said plainly.** On an API-role process a host passes
`scheduler: false` and `reconcileRuns` defaults to it, so neither loop runs there
and none of the above changes what an API pod pays. Measured on that side, a
mounted catalog costs ~19ms of held event loop once at boot (13.7ms for the
second MikroORM connection and its schema check, 5.2ms for the registry build
over 60 types and 902 properties) and nothing at all until somebody opens the
console. The one expensive request is `GET catalog/events/traces`, which is
already fixed and not yet released.
