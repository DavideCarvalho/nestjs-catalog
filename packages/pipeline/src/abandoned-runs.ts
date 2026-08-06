import type { CatalogPipelineStore, ConnectorRun } from '@dudousxd/nestjs-catalog';

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
 * - **The last attempt is never closed by anything.** Nothing runs after it.
 *   Three abandoned attempts leave two rows saying so and one still `running`,
 *   which is two more than there were and is enough to recognise the pattern.
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
