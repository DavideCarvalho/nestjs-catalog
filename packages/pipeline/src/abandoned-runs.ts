import type { CatalogPipelineStore, ConnectorRun } from '@dudousxd/nestjs-catalog';
import { TERMINAL_RUN_STATUSES } from '@dudousxd/nestjs-durable-core';

/**
 * How many recent runs of a connector are examined for one left open.
 *
 * A durable retry reuses the snapshot id, so the runs that can be orphans of
 * *this* load are the handful of attempts that came before it — three, at the
 * step's current retry count. Twenty is room for other runs of the same
 * connector to have interleaved without the scan missing them, and it is a
 * bounded query rather than a scan of the table.
 *
 * A caller that has already read a longer list for another reason passes it in
 * instead of paying for a second query — see {@link closeAbandonedAttempts}.
 */
export const ORPHAN_SCAN_LIMIT = 20;

/** The two store methods this needs, and deliberately no more. */
export type AbandonedRunStore = Pick<CatalogPipelineStore, 'listRuns' | 'finishRun'>;

/** Somewhere to warn. `Logger` satisfies it; so does a spec's recorder. */
export interface AbandonedRunLog {
  warn(message: string): void;
}

export interface AbandonedScan {
  /**
   * What the thing being loaded is called, for the message. The connector's
   * name on the single-transform path and the workflow's on the graph path —
   * which is the same name each of those paths already puts on the run's
   * events, so a reader is not asked to hold two vocabularies.
   */
  name: string;
  connectorId: string;
  /** The load's identity. Everything below turns on this — see the docblock. */
  snapshotId: string;
  /**
   * This connector's recent runs, when the caller already has them.
   *
   * The workflow path reads a list on the way into every run for the stale-stage
   * sweep, and one list answering both questions is not a saved query so much as
   * a correctness property: two reads at two instants are two different answers
   * to "which runs were there", and the two rules would then be reasoning about
   * different sets. Omitted, this lists {@link ORPHAN_SCAN_LIMIT} itself.
   */
  runs?: ConnectorRun[];
}

/**
 * Close any run of this connector left open by an earlier attempt at the same
 * snapshot.
 *
 * The failure this exists for leaves no trace at all. A step whose lease
 * expires is re-dispatched by the durable engine while the attempt holding it
 * is still inside the load — so that attempt never reaches `finishRun`, and its
 * row sits at `running` with `fetched = 0` and an empty `error` for good. The
 * only place the truth was written down was `durable_step_checkpoints`, where
 * a rising `attempts` against an empty error means a lease and not a failure,
 * and reading that is not something an operator should have to know to do.
 *
 * **Keyed on the snapshot id, which makes it exact rather than a heuristic.** A
 * durable retry reuses the snapshot id and nothing else does, so the rows this
 * closes are attempts at *this* load and cannot be a different run of the same
 * connector happening at the same time. An age threshold was the alternative
 * and is unusable here: the loads this is about are the slow ones, so "open for
 * a long time" is indistinguishable from working.
 *
 * Two things it cannot do, both worth knowing before trusting it:
 *
 * - **The last attempt is closed by nothing on this rule.** Nothing runs after
 *   it, so nothing revisits its snapshot. Three abandoned attempts leave two
 *   rows saying so and one still `running`, which is two more than there were
 *   and is enough to recognise the pattern. That last row — and the whole class
 *   of durable runs that die without ever reaching their finish step, where the
 *   *next* run mints a new snapshot and so never comes back to this one — is
 *   what {@link closeRunsTheEngineHasFinished} closes, by asking the engine
 *   whether the run is still alive rather than by waiting for another attempt.
 *   The two rules are complements and neither subsumes the other: this one
 *   needs no engine and closes the earlier attempts of a retry series the
 *   moment the next one opens, and that one needs an engine and closes the row
 *   nothing will ever revisit.
 * - **An attempt still alive in another process may write over this.** The
 *   lease expired; the work did not stop. If it finishes it calls `finishRun`
 *   and its own outcome wins, which is the right answer — it is the one that
 *   actually knows.
 *
 * Never fatal. This is bookkeeping about a previous run, and a store that
 * cannot answer must not take out the load in front of it.
 *
 * **One implementation, two runners, and that is the whole reason this is a
 * module rather than a method.** `ConnectorRunnerService` and
 * `WorkflowRunnerService` are two implementations of a load rather than one
 * wrapping the other, so a rule copied into both is a rule that has two places
 * to be edited and one of them will be missed. The rule is subtle in a specific
 * way — what it keys on, and which of the two attempts it is allowed to touch —
 * and a second copy that drifted would not fail; it would quietly close the
 * wrong row, or stop closing any.
 *
 * Returns the lines to put on the log of the run that did the closing. They are
 * returned rather than written anywhere, because the two callers put them in
 * different places: the connector runner opens its own row and seeds its log,
 * and the workflow runner carries them through the plan step so the durable
 * path records them too.
 */
export async function closeAbandonedAttempts(
  store: AbandonedRunStore,
  scan: AbandonedScan,
  logger: AbandonedRunLog,
): Promise<string[]> {
  try {
    const recent = scan.runs ?? (await store.listRuns(scan.connectorId, ORPHAN_SCAN_LIMIT));
    const lines: string[] = [];

    for (const stale of recent) {
      if (stale.status !== 'running' || stale.snapshotId !== scan.snapshotId) continue;

      const reason = abandonedRunMessage(scan.name, stale);
      await store.finishRun(stale.id, {
        status: 'failed',
        error: reason,
        logs: [...stale.logs, reason],
      });
      lines.push(
        `Closed run ${stale.id}, an earlier attempt at snapshot ${scan.snapshotId} that was still marked running and had recorded no outcome of its own.`,
      );
      logger.warn(`${scan.name}: ${reason}`);
    }

    return lines;
  } catch (error) {
    // Warned rather than swallowed, and warned rather than thrown. See the
    // docblock: this is a note about a run that is already over.
    logger.warn(
      `Could not check "${scan.name}" for attempts left open at snapshot ${scan.snapshotId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

/**
 * What a run that vanished should have said, in the one place it can still be
 * written down.
 *
 * It names the three things that produce this row and refuses to pick between
 * them, because from inside the runner they are the same fact: nothing wrote an
 * outcome. Naming only the lease would be a guess with a plausible-sounding
 * cause attached, which is worse than the silence it replaces. What it can do is
 * say where the difference is recorded, so the next person does not have to
 * discover `durable_step_checkpoints` for themselves the way the first one did.
 */
export function abandonedRunMessage(name: string, run: ConnectorRun): string {
  return `This run of "${name}" was still marked running when another attempt at snapshot ${run.snapshotId} started, and it recorded no outcome of its own — it had fetched ${run.fetched} and written ${run.written}. A step whose lease expired, a pod that was killed, and a process that died between starting and finishing all look like this from here: nothing failed, so nothing was written down. The engine's side of it is in durable_step_checkpoints for ${run.snapshotId}, where a rising "attempts" against an empty error is a lease expiring rather than a source refusing.`;
}

/* ===========================================================================
 * The other half: closing a row nothing will ever revisit.
 * ========================================================================= */

/**
 * How many recent runs — of every connector, newest first — one reconciling
 * pass examines.
 *
 * Wider than {@link ORPHAN_SCAN_LIMIT} and for a different reason. That one is
 * bounded by a retry count, because the rows it can possibly match are the
 * handful of attempts at one snapshot. This one is bounded by nothing intrinsic:
 * a row becomes closable only once the durable run behind it has died, which for
 * an execution timeout is two hours after it started, and in those two hours
 * every other load on the deployment has started runs that sort ahead of it.
 *
 * So this number is the window, said plainly: **a run row is reachable by this
 * rule until 200 newer runs have started.** It is one indexed
 * `ORDER BY started_at DESC LIMIT 200`, not a scan, and it is the whole cost of
 * a pass on a deployment where nothing is wrong. A deployment that starts more
 * than this within the lifetime of its longest load raises
 * `CATALOG_RUN_RECONCILE_SCAN` rather than discovering the bound from a row that
 * stayed `running`.
 */
export const RECONCILE_SCAN_LIMIT = positiveInt(process.env.CATALOG_RUN_RECONCILE_SCAN, 200);

/**
 * The engine, narrowed to the one question this asks of it.
 *
 * Structural rather than `WorkflowEngine`, and that is not decoration: the
 * *reason* this type exists is that the thing bound to the `WorkflowEngine` DI
 * token is not always a `WorkflowEngine`. A thin tenant worker gets
 * `DurableStartClient` under the same token — a store-less facade whose whole
 * job is to publish a start onto a queue — and it has no `getRun` at all. A
 * declared dependency on the class would compile and then be `undefined` at the
 * call, which is the shape of failure this whole file is about. So the question
 * asked is "can this thing answer?", by {@link engineRunView}, and the answer is
 * allowed to be no.
 *
 * `status` is widened to `string` deliberately. The engine's `RunStatus` union
 * grows — `blocked` and `cancelling` are both recent additions — and a closed
 * union here would make a *new non-terminal status* fail to match anything and
 * fall wherever the `else` went. Against {@link TERMINAL_RUN_STATUSES} the
 * unknown status falls to "alive", which is the direction that costs nothing.
 */
export interface EngineRunView {
  getRun(runId: string): Promise<{ status: string } | null>;
}

/**
 * What the engine said about a run, as the four answers it can actually give.
 *
 * Four rather than a boolean, because "not alive" is three different facts and
 * only two of them license a write:
 *
 * - `gone` — no run under that id. Either it never existed here or retention
 *   pruned it; both mean nothing will ever advance it again.
 * - `finished` — a terminal status. The run is over and wrote no outcome onto
 *   the catalog row.
 * - `alive` — a non-terminal status. **This is the answer that must never be got
 *   wrong**: closing a load that is genuinely still going writes `failed` onto a
 *   healthy run and, worse, makes the row disagree with the data it is about to
 *   commit.
 * - `unanswerable` — the engine could not be asked, or refused. Not a fourth
 *   flavour of dead: it is the absence of an answer, and it produces no write.
 *   The alternative is guessing, and a guess here forges a governance record.
 */
export type EngineVerdict =
  | { liveness: 'gone' }
  | { liveness: 'finished'; status: string }
  | { liveness: 'alive'; status: string }
  | { liveness: 'unanswerable'; because: string };

/**
 * The engine's view, if there is one to be had.
 *
 * Three states collapse to `undefined` here and each is reported differently by
 * the caller: no engine resolved at all (`CATALOG_DURABLE=off`, where nothing is
 * durable and there is nothing to reconcile), an engine that is a start-only
 * facade (a thin worker — durable rows exist and this pod cannot see them), and
 * something else entirely bound to the token. What they share is that no
 * question can be asked, so nothing may be written.
 */
export function engineRunView(engine: unknown): EngineRunView | undefined {
  if (typeof engine !== 'object' || engine === null) return undefined;
  const getRun = Reflect.get(engine, 'getRun');
  if (typeof getRun !== 'function') return undefined;
  // Bound back to its owner, because it is a method reading `this.store`.
  return { getRun: (runId: string) => Reflect.apply(getRun, engine, [runId]) };
}

/**
 * Ask the engine whether one run is still going.
 *
 * **The snapshot id is the durable run id**, minted by `WorkflowLauncher.run`
 * and handed straight to `engine.start`, so there is nothing to correlate and
 * no join to get wrong — see `ConnectorRun.snapshotId`. That identity is the
 * entire reason this rule can be exact where a clock cannot: the question is
 * "is run X alive", answered by the component that decides it, rather than "has
 * run X been open suspiciously long", answered by arithmetic on a field.
 *
 * A throw is `unanswerable` rather than `gone`. They are easy to conflate — both
 * are "the engine did not hand back a run" — and they are opposites: a store
 * that timed out is the case where the run is most likely still executing.
 */
export async function askEngineAboutRun(
  view: EngineRunView,
  runId: string,
): Promise<EngineVerdict> {
  try {
    const run = await view.getRun(runId);
    if (!run) return { liveness: 'gone' };
    // `.some` rather than `.includes`: the constant is `readonly RunStatus[]`
    // and this status is a `string`, and comparing the two element-wise is the
    // narrowing-free way to ask. An unrecognised status is not terminal, so it
    // is treated as alive — see {@link EngineRunView}.
    const finished = TERMINAL_RUN_STATUSES.some((terminal) => terminal === run.status);
    return finished
      ? { liveness: 'finished', status: run.status }
      : { liveness: 'alive', status: run.status };
  } catch (error) {
    return { liveness: 'unanswerable', because: say(error) };
  }
}

/** What one pass did, so a caller can log it and a spec can assert on it. */
export interface ReconcileOutcome {
  /** Rows that were `running` and durable, so the engine was asked about them. */
  examined: number;
  closed: number;
  /** Rows the engine reported as still going. Left exactly as they were. */
  alive: number;
  /** Rows nobody could be asked about. Also left exactly as they were. */
  unanswerable: number;
}

export interface ReconcileScan {
  /** Connector id → the name to put in the message. Falls back to the id. */
  names?: ReadonlyMap<string, string>;
  /** How many recent runs to examine. Defaults to {@link RECONCILE_SCAN_LIMIT}. */
  limit?: number;
}

/**
 * Close every run row this deployment still calls `running` whose durable run
 * the engine says is over.
 *
 * ## The gap this closes, and why it needed a second rule
 *
 * {@link closeAbandonedAttempts} keys on the snapshot id, which makes it exact
 * and also bounds what it can reach: the row is closed *by the next attempt at
 * the same snapshot*. A durable run plans once and its node retries reuse that
 * row, so the attempt that does the closing is a planning step being retried or
 * an operator re-driving the same `snapshotId`. When a durable run dies without
 * ever reaching its finish step — the two-hour execution timeout, a cancel, a
 * worker that never resumes — the next run mints a *new* snapshot, so no attempt
 * at the old one is ever made and the row stays `running` for good. That is the
 * row this closes.
 *
 * ## Why an engine and not a clock
 *
 * The same objection that ruled a clock out for the first rule rules it out
 * here, only harder. An age threshold cannot separate a slow load from an
 * abandoned one, and the loads this is about *are* the slow ones — the incident
 * behind all of it was a 981k-row load. What it can be separated by is the fact
 * itself: the engine owns run state, the snapshot id **is** the durable run id,
 * so the question can be put to the component that decides the answer.
 *
 * ## The three answers, and which two are writes
 *
 * See {@link EngineVerdict}. `gone` and `finished` are closes; `alive` and
 * `unanswerable` are not. The asymmetry is the whole safety argument: a row
 * wrongly left `running` is the status quo and is visible, and a row wrongly
 * closed is a false outcome written into the record somebody audits a load by.
 *
 * ## What it will not look at, and why the list is an allow-list
 *
 * Only rows that positively say `executionMode: 'durable'`. An `inline` row has
 * no durable run at all, so `getRun` would answer `gone` for a load that is
 * running perfectly — the exact third-state error, arrived at by asking a
 * question that never applied. `undefined` is refused for the same reason and it
 * is worth being explicit that this is a real exclusion rather than a
 * formality: `ConnectorRunnerService` opens its rows without the field, so the
 * single-transform connector path is **not** reconciled by this. That path is
 * the one being retired into workflows, it keeps the first rule, and buying it
 * a second would mean guessing durability from the absence of a column.
 *
 * ## Two reads of the row, and the races between them
 *
 * - **Starting.** A durable row cannot be observed before its run exists:
 *   `engine.start` awaits `store.createRun` strictly before it dispatches, and
 *   the catalog row is opened by the plan step, which runs after the dispatch.
 *   So `gone` cannot mean "not started yet". This is why no grace period is
 *   needed and none is used — a grace period would be a clock, with the same
 *   objection as before.
 * - **Finishing.** The engine may reach terminal, or a step may write
 *   `finishRun`, while this pass is mid-flight. So the rows are read again after
 *   the engine has answered and before anything is written, and only a row still
 *   `running` at that second read is closed. What that leaves is the last few
 *   milliseconds, and it resolves the way the first rule's does: whichever write
 *   lands second wins, and the run's own finish step is the one that knows.
 *
 * Never fatal, for the reason the whole file is: this is bookkeeping about runs
 * that are already over.
 */
export async function closeRunsTheEngineHasFinished(
  store: AbandonedRunStore,
  view: EngineRunView,
  logger: AbandonedRunLog,
  scan: ReconcileScan = {},
): Promise<ReconcileOutcome> {
  const outcome: ReconcileOutcome = { examined: 0, closed: 0, alive: 0, unanswerable: 0 };
  const limit = scan.limit ?? RECONCILE_SCAN_LIMIT;

  try {
    const candidates = (await store.listRuns(undefined, limit)).filter(isDurableAndStillOpen);
    outcome.examined = candidates.length;
    if (candidates.length === 0) return outcome;

    const closable: Array<{ run: ConnectorRun; verdict: EngineVerdict }> = [];
    for (const run of candidates) {
      const verdict = await askEngineAboutRun(view, run.snapshotId);
      if (verdict.liveness === 'alive') {
        outcome.alive += 1;
        continue;
      }
      if (verdict.liveness === 'unanswerable') {
        outcome.unanswerable += 1;
        // Per run rather than once per pass. A store that answers for nine runs
        // and times out on the tenth is a different fault from an engine that
        // cannot answer at all, and one line saying "some of them" would not
        // tell them apart.
        logger.warn(
          `Could not ask the engine about durable run ${run.snapshotId}, so run ${run.id} is left marked running: ${verdict.because}`,
        );
        continue;
      }
      closable.push({ run, verdict });
    }
    if (closable.length === 0) return outcome;

    // The second read. See the docblock: between the list above and here, every
    // one of these rows had a chance to record its own outcome, and its outcome
    // is worth more than this one.
    const stillOpen = new Map(
      (await store.listRuns(undefined, limit))
        .filter(isDurableAndStillOpen)
        .map((run) => [run.id, run] as const),
    );

    for (const { run, verdict } of closable) {
      const current = stillOpen.get(run.id);
      if (!current) continue;
      const name = scan.names?.get(current.connectorId) ?? current.connectorId;
      const reason = lostRunMessage(name, current, verdict);
      await store.finishRun(current.id, {
        status: 'failed',
        error: reason,
        logs: [...current.logs, reason],
      });
      outcome.closed += 1;
      logger.warn(`${name}: ${reason}`);
    }

    return outcome;
  } catch (error) {
    logger.warn(
      `Could not reconcile open run rows against the engine's view of them: ${say(error)}`,
    );
    return outcome;
  }
}

/**
 * What a run the engine has finished with should have said.
 *
 * It quotes the engine rather than describing the outcome in its own words, and
 * that is the difference from {@link abandonedRunMessage}. That message names
 * three possible causes and refuses to choose, because from inside a runner the
 * three are the same silence. Here there is no silence to interpret: the engine
 * was asked, by run id, and it answered — so the honest thing is to say what it
 * answered and where to go and read the rest of it.
 *
 * `gone` and `finished` get different sentences because they send a reader to
 * different places. A run the engine has no record of is one whose history has
 * been pruned or which was created somewhere this pod cannot see; a run with a
 * terminal status has a row, an error and a step history to read.
 */
export function lostRunMessage(name: string, run: ConnectorRun, verdict: EngineVerdict): string {
  const counters = `it had fetched ${run.fetched} and written ${run.written}`;
  if (verdict.liveness === 'finished') {
    return `This run of "${name}" is still marked running and never recorded an outcome — ${counters}. Its durable run ${run.snapshotId} reached "${verdict.status}", so nothing is going to advance it: the run ended without reaching the step that writes this row, which is what an execution timeout, a cancellation and a worker that never resumed all look like. The engine's side of it is durable_runs and durable_step_checkpoints for ${run.snapshotId}.`;
  }
  return `This run of "${name}" is still marked running and never recorded an outcome — ${counters}. The engine has no record of durable run ${run.snapshotId} at all, so nothing is going to advance it: either the run never got past being started, or its history has since been pruned by a retention policy. Nothing further about it is recoverable, which is why this row is being closed rather than left to look like a load in flight.`;
}

/**
 * A row this rule is allowed to have an opinion about.
 *
 * Both clauses, and the second is the allow-list argued for in
 * {@link closeRunsTheEngineHasFinished}: `durable` is the only value for which
 * "the engine has no record of this" means anything at all.
 */
function isDurableAndStillOpen(run: ConnectorRun): boolean {
  return run.status === 'running' && run.executionMode === 'durable';
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function say(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
