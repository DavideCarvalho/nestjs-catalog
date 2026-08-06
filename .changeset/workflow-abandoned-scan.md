---
'@dudousxd/nestjs-catalog-pipeline': minor
---

A run the graph path left open is closed by the attempt that follows it

`closeAbandonedAttempts` existed only on `ConnectorRunnerService`, and the two runners are two
implementations of a load rather than one wrapping the other — so making the workflow the only
thing anybody runs took the protection away with it. A step whose lease expires is re-dispatched
while the attempt holding it is still inside the load: that attempt never reaches `finishRun`, and
its row sits at `running` with `fetched = 0` and no error for good, with the truth written down
only in `durable_step_checkpoints`. `minor` and not `major`: this is 0.x, and the project versions
on that basis.

**One implementation, two callers.** The rule moves to `abandoned-runs.ts` and both runners call
it. It is subtle in a specific way — what it keys on, and which of two attempts it may touch — and
a second copy that drifted would not fail; it would quietly close the wrong row, or stop closing
any. The keying is unchanged and is the whole design: **the snapshot id, not age**. A durable retry
reuses the snapshot and nothing else does, so a concurrent run of the same connector is untouched,
and an age threshold is unusable because the loads this is about are the slow ones. Both stated
limits survive: the last attempt of a series is closed by nothing, and an attempt still alive
elsewhere may write its own outcome over this — which is correct, it is the one that knows.

**A workflow run stops adopting the row it finds.** `WorkflowRunnerService.plan` was idempotent by
`(connectorId, snapshotId)`: an existing row at the same snapshot was adopted rather than opened
again, so a planning step that committed `startRun` and lost its result would not leave one row per
attempt. That answered the multiplicity and left the silence — the adopting attempt wrote its own
outcome over the row and nothing anywhere said an earlier one had vanished, which is the failure
this scan exists to end, arrived at from the other side. The earlier row is now closed with the
message that names the three causes and points at the checkpoints table, and this attempt opens its
own. A run list reporting "a load that never happened" is exactly right when the row says which
load and why it never happened.

Consequences worth knowing:

- **A snapshot can carry more than one row.** `findRun` answers with the one still being written,
  and otherwise with the one that recorded an outcome last. `started_at` is stored to the second,
  so a first match could otherwise report an abandoned attempt's failure as the outcome of the run
  that had just replaced it — which is what `WorkflowLauncher.awaitRun` hands back to whoever
  pressed Run.
- **`WorkflowPlanResult` gains `notes`.** The row a workflow run reports into is opened by the plan
  step and finished by a later one, so a line written at the open would be overwritten by the finish
  step's `logs`. The closure travels on the plan's checkpoint instead — which is also what makes it
  survive a replay, the case that matters, since what is being recorded is that a previous attempt
  did not. Optional, so a run whose plan was checkpointed by an older build replays without it.
- **`emptyProgress(logs?)`** takes the lines a run starts with, so the note sits above the first
  node's output rather than wherever a caller remembered to push it.
- **The two housekeeping rules read one list.** `sweepAbandonedStages` no longer runs its own
  query. Two reads are two answers to which runs there were, and the read is now guarded — the
  workflow path's `findRun` on the way in was not, so a store that could not answer took the load
  with it.

`sweepAbandonedStages` and this are **not** the same job and are not merged: the sweep takes runs
that *failed*, at *other* snapshots, older than the retention window, and drops staged rows; this
takes runs still *running*, at *this* snapshot, at any age, and writes them an outcome. Disjoint on
every clause. They do compose — staged rows are only ever collected from a failed run, so a row
abandoned at `running` kept its stages for good until something closed it.

**The limit is wider on the graph path and is written down rather than papered over.** A durable
workflow run plans once and its node retries reuse that row, so the attempt that does the closing is
a planning step being retried or an operator re-driving the same `snapshotId`. A durable run that
dies without reaching its finish step — an execution timeout, a cancellation, a worker that never
resumes — leaves a row nothing revisits, because the next run mints a new snapshot. Closing that one
needs the engine's own view of the run, which is not a clock. `AbandonedRunReconciler` does it, in
the changeset beside this one: the snapshot id *is* the durable run id, so `engine.getRun` answers
whether a run this deployment still calls `running` is actually alive. The two rules are complements
— this one needs no engine and closes the earlier attempts of a retry series as the next one opens;
that one needs an engine and closes the row nothing will ever come back to.
