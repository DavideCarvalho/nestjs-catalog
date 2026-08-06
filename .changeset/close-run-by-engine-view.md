---
'@dudousxd/nestjs-catalog-pipeline': minor
---

A run row nothing revisits is closed by asking the engine, not a clock

`closeAbandonedAttempts` closes a row left at `running` when the **next attempt at the same
snapshot** opens. That is exact, and it is also the whole of its reach: a durable run plans once and
its node retries reuse that row, so the attempt that does the closing is a planning step being
retried or an operator re-driving the same `snapshotId`. A durable run that dies without ever
reaching its finish step — the two-hour execution timeout, a cancellation, a worker that never
resumes — leaves a row nothing comes back to, because the next run of that pipeline mints a *new*
snapshot. That row sat at `running` with `fetched = 0` and no error indefinitely. `minor` and not
`major`: this is 0.x, and the project versions on that basis.

**The lever is that the snapshot id IS the durable run id.** It is minted by `WorkflowLauncher.run`
and handed straight to `engine.start`, so there is nothing to correlate: the question "is this load
still going" can be put to the component that decides the answer. `closeRunsTheEngineHasFinished`
asks `engine.getRun(snapshotId)` and closes the row when the engine has no record of the run or
reports it terminal. An age threshold was never available here for the reason it was never available
to the first rule — the loads this is about *are* the slow ones, so "open for a long time" is
indistinguishable from working.

**Three answers, and only two of them are writes.** No record of the run (never held, or pruned by a
retention policy) and a terminal status are closes. A **non-terminal** status is left exactly alone,
and that is the answer that must never be got wrong: closing a live load writes `failed` onto a
healthy run and makes the row disagree with the data it is about to commit. Terminal is read from the
engine's own exported `TERMINAL_RUN_STATUSES` rather than a hand-written list, so a status a later
release adds — `blocked` and `cancelling` are both recent, both non-terminal — falls to "alive",
which is the direction that costs nothing.

**When the engine cannot be asked, nothing is written and the reason is said once, at boot.** Two
shapes, reported differently because they are different facts: no engine resolved at all
(`CATALOG_DURABLE=off`, so every run here is `inline` and there is nothing to reconcile — logged as
the ordinary state it is), and an engine that resolved and cannot read a run. The second is the thin
tenant worker, which is given `DurableStartClient` under the `WorkflowEngine` token — a store-less,
start-only facade with no `getRun` at all — and it warns, because durable runs exist on that
deployment and this process can see none of them. The engine is therefore injected by explicit token
and typed `object`: declaring `WorkflowEngine` as the *type* would state a contract that token does
not keep, and the compiler would agree that `engine.getRun` exists where it does not.

**A timer, on one process, and here is what it costs.** The trigger had to be something other than
"the next attempt", which by definition never comes for these rows.

- **Boot only** was the cheapest and does not work: the run dies mid-afternoon, and a pod not
  restarted until Thursday leaves the row `running` until Thursday. Kept as the *first* tick, because
  a pod replacing a killed one is exactly when the killed one's leftovers are visible.
- **A read path** is always fresh and is refused on principle: it makes a `GET` write to a governance
  record, so what a run row says would depend on who looked and when — and it costs an engine
  round-trip per open row on every render of the runs list.
- **A pass every `CATALOG_RUN_RECONCILE_MS`** (default 5 minutes) costs one
  `ORDER BY started_at DESC LIMIT CATALOG_RUN_RECONCILE_SCAN` (default 200) over the run table, one
  `listConnectors` for the names, and one `engine.getRun` per row *currently* marked running — nought
  or one when nothing is wrong. Nothing in that grows with the data a load moves. Not the scheduler's
  30s tick: a hundredfold the queries for no gain, in the loop whose one job is starting loads on
  time.

New: `AbandonedRunReconciler`, `CATALOG_RECONCILE_RUNS`, and
`CatalogPipelineModuleOptions.reconcileRuns` — defaulting to `scheduler` and then to `true`, the same
axis and the same default as `adoptConnectors`, because this writes and six replicas racing to close
one row is six copies of the warning about it.

Two things it deliberately will not do:

- **Only rows that positively say `executionMode: 'durable'`.** An `inline` row has no durable run,
  so `getRun` would answer "no record" for a load running perfectly — the same third-state error,
  reached by asking a question that never applied. A row with *no* execution mode is refused for the
  same reason rather than guessed at, which means `ConnectorRunnerService`'s rows are not reconciled:
  that path is being retired into workflows, it keeps the next-attempt rule, and buying it a second
  would mean inferring durability from a missing column.
- **It re-reads the run list before it writes.** Between listing the rows and the engine answering,
  every one of them had a chance to record its own outcome, and its own outcome is worth more — it is
  the one that knows what the load did. Only a row still `running` at the second read is closed. The
  starting race needs no such guard and gets none: `engine.start` awaits `createRun` strictly before
  it dispatches, and the catalog row is opened by the plan step, which runs after the dispatch — so
  "no record" can never mean "not started yet", and a grace period would be a clock with the same
  objection as before.
