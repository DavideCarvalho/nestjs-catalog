import type { ConnectorRun } from '@dudousxd/nestjs-catalog';
import { Step } from '@dudousxd/nestjs-durable';
import { FatalError, type StepLogger } from '@dudousxd/nestjs-durable-core';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConnectorRunnerService } from './connector-runner.service';
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
        throw new FatalError(describe(error), 'connector_unavailable');
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
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
