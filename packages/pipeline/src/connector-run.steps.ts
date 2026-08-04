import {
  CATALOG_PIPELINE_STORE,
  type CatalogPipelineStore,
  type ConnectorRun,
} from '@dudousxd/nestjs-catalog';
import { Step } from '@dudousxd/nestjs-durable';
import { FatalError, type StepLogger } from '@dudousxd/nestjs-durable-core';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConnectorRunnerService } from './connector-runner.service';
import {
  CATALOG_LOAD_EXPECTATIONS,
  type CatalogLoadExpectations,
  expectationFor,
  refuseUndeclaredDeletes,
} from './load-expectations';
import { CATALOG_PIPELINE_SCOPE, type CatalogPipelineScope } from './seams';

/**
 * The routing name the engine dispatches under.
 *
 * Written out rather than derived from `Class.method`, because it is a wire
 * identity: a run suspended on this step names it in the store, and renaming
 * the class would strand every run mid-flight on a name nothing serves.
 */
export const CONNECTOR_RUN_STEP = 'catalog.connector.run';

export interface ConnectorRunStepInput {
  connectorId: string;
  principalId: string;
  /** The durable run id, so a retry replaces its batches rather than doubling. */
  snapshotId: string;
}

export interface ConnectorRunStepOutput {
  /** The `ConnectorRun` row, not the durable run — one durable run may make several. */
  runId: string;
  fetched: number;
  written: number;
}

/**
 * The one durable checkpoint a scheduled connector has.
 *
 * A whole connector run in a single step rather than fetch/transform/publish as
 * three, because the pipeline is only resumable at its own boundary: the
 * snapshot is what makes a repeat safe, and half a snapshot is not a checkpoint
 * anybody can restart from. Splitting it would buy finer dashboard rows and pay
 * for them with checkpoints that cannot actually be resumed.
 */
@Injectable()
export class ConnectorRunSteps {
  constructor(
    private readonly runner: ConnectorRunnerService,
    // A durable step is a message off a queue, not a request, so it carries no
    // ambient scope. A host routing one store across several environments has to
    // enter one before the runner touches it; a single-connection host binds the
    // pass-through and pays nothing.
    @Inject(CATALOG_PIPELINE_SCOPE)
    private readonly scope: CatalogPipelineScope,
    // Both optional, and both only ever used by the preflight below. A host
    // that binds neither loses the early refusal and keeps the real one:
    // `PublishService.carryForwardAsSystem` asks the same question at the merge,
    // which no incremental load can avoid. What is bought here is *where* the
    // refusal happens — before a source is read, and without burning three
    // retries on a configuration that will be exactly as wrong in fifteen
    // minutes.
    @Optional()
    @Inject(CATALOG_PIPELINE_STORE)
    private readonly pipeline?: CatalogPipelineStore,
    @Optional()
    @Inject(CATALOG_LOAD_EXPECTATIONS)
    private readonly expectations?: CatalogLoadExpectations,
  ) {}

  /**
   * Retries are safe here *because* the snapshot id comes from the caller and
   * never changes between attempts — every attempt appends the same numbered
   * batches to the same snapshot and replaces them, so three attempts load the
   * data once. Minutes apart rather than seconds: the failures this is meant to
   * survive are a source being briefly unreachable, and hammering an
   * already-struggling source is not a retry policy.
   */
  @Step({
    name: CONNECTOR_RUN_STEP,
    retries: 3,
    backoff: 'exp',
    backoffMs: 60_000,
    backoffMaxMs: 900_000,
    jitter: true,
  })
  async runConnector(
    input: ConnectorRunStepInput,
    log?: StepLogger,
  ): Promise<ConnectorRunStepOutput> {
    const unreconciled = await this.scope.run(() => this.preflightDeletes(input.connectorId));
    if (unreconciled) throw new UnmetLoadExpectationError(unreconciled);

    let run: ConnectorRun;
    try {
      run = await this.scope.run(() =>
        this.runner.run(input.connectorId, input.principalId, input.snapshotId),
      );
    } catch (error) {
      // The runner throws for exactly two reasons before it opens a run: the
      // connector is gone, or it is disabled. Neither improves by waiting, and
      // a schedule that keeps firing at a deleted connector for fifteen minutes
      // is noise standing between somebody and the real failures.
      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw new UnavailableConnectorError(describe(error));
      }
      throw error;
    }

    // The run's own log lines, attached to the step rather than left only in the
    // `catalog_connector_run` row: whoever is looking at a failed durable run
    // should not have to know that a second table holds the reason.
    for (const line of run.logs) log?.info(line);

    if (run.status === 'failed') {
      // The runner records a failure and returns normally — which is right for
      // the HTTP path, where the caller wants the run object either way, and
      // wrong here: a step that returns is a step that succeeded, and a
      // scheduled load that silently "succeeds" while loading nothing is the
      // failure mode this whole feature exists to remove.
      throw new Error(run.error ?? `Connector run ${run.id} failed without a message.`);
    }

    return { runId: run.id, fetched: run.fetched, written: run.written };
  }

  /**
   * Whether this connector may run incrementally at all, asked before it reads.
   *
   * An incremental connector is blind to deletes by construction — it asks its
   * source for what changed since a watermark, and a deleted row never changes
   * again — so a type loaded this way accumulates rows that no longer exist
   * upstream until somebody notices the count drifting. The refusal itself
   * lives at the merge in `PublishService`, which every incremental load has to
   * pass through; this is the same question asked where it is cheapest to
   * answer.
   *
   * Worth asking twice for two reasons, neither cosmetic. The source is not
   * read, so a connector pointed at a production database does not pull forty
   * thousand rows on the way to being refused. And the refusal is *fatal* here:
   * a failure raised inside the run is recorded on the run row and rethrown as
   * an ordinary error, which this step retries three times over roughly fifteen
   * minutes — and a missing declaration will be exactly as missing on the third
   * attempt as on the first.
   *
   * Returns the sentence to refuse with, or nothing. Nothing is also the answer
   * when the store is unbound or the connector is gone: neither is a question
   * this method can answer, and the run's own `NotFoundException` says far more
   * about a deleted connector than a preflight guessing at it would.
   */
  private async preflightDeletes(connectorId: string): Promise<string | undefined> {
    if (!this.pipeline) return undefined;
    const connector = await this.pipeline.getConnector(connectorId);
    if (!connector || connector.mode !== 'incremental') return undefined;
    return refuseUndeclaredDeletes(
      connector.targetType,
      expectationFor(this.expectations, connector.targetType),
    );
  }
}

/**
 * A connector whose load has been refused before it started.
 *
 * Non-retryable for the same reason {@link UnavailableConnectorError} is, by
 * the same mechanism and with the same caveat about `retryable` being the only
 * field the dispatch boundary carries across — see the note on that class. It
 * is a separate class rather than a reuse because the two are opposite facts
 * about the connector: one says it is gone or switched off, this one says it is
 * there, enabled, and configured to do something nobody has authorised. An
 * operator filtering a failed-run list on `connector_unavailable` and finding
 * these in it would go looking for a deleted connector.
 */
class UnmetLoadExpectationError extends FatalError {
  /** The field the dispatch boundary serialises and the engine acts on. */
  readonly retryable = false;

  constructor(message: string) {
    super(message, 'load_expectation_unmet');
  }
}

/**
 * A connector that is gone or switched off, in the one form the engine reads.
 *
 * The comment above says these must not be retried, and until now the code did
 * not achieve it. `FatalError` carries a `message` and a `code` and nothing
 * else. Durable core honours the class itself only in `runStepHandler`'s
 * **local** retry loop — the path a step takes when it runs inside the engine's
 * own process. This step is dispatched: the worker serialises the throw into a
 * `{message, code, retryable}` envelope, and only `retryable` is read on the
 * way back in. The engine's own predicate is `existing.error?.retryable !==
 * false`, so an absent field means retryable, and the serialiser only emits one
 * at all when `typeof e.retryable === "boolean"`. A plain `FatalError` from a
 * dispatched step therefore burns all three attempts — here, roughly fifteen
 * minutes of a 60s exponential backoff capped at 900s — for a connector that
 * somebody deleted on purpose.
 *
 * `workflow-run.steps.ts` had already worked this out and fixed it the same
 * way; this is that fix, applied to the step that was left behind. Extending
 * `FatalError` rather than replacing it keeps the local path correct too, so
 * this is right whichever way the step is run.
 */
class UnavailableConnectorError extends FatalError {
  /** The field the dispatch boundary serialises and the engine acts on. */
  readonly retryable = false;

  constructor(message: string) {
    super(message, 'connector_unavailable');
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
