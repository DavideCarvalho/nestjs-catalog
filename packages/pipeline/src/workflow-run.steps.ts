import type { WorkflowNodeStepInput, WorkflowNodeStepOutput } from '@dudousxd/nestjs-catalog';
import { Step } from '@dudousxd/nestjs-durable';
import { FatalError, type StepLogger } from '@dudousxd/nestjs-durable-core';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CATALOG_PIPELINE_SCOPE, type CatalogPipelineScope } from './seams';
import {
  type WorkflowFinishInput,
  type WorkflowPlanResult,
  WorkflowRunnerService,
} from './workflow-runner.service';

/**
 * The routing names the engine dispatches under.
 *
 * Written out rather than derived from `Class.method`, because they are wire
 * identities: a run suspended on one of these names it in the store, and a step
 * renamed between two deploys strands every run mid-flight on a name nothing
 * serves. The node step's name is *not* per node — a node id is data, and a
 * routing name that grew with the graph would mean a worker had to subscribe to
 * a name it can only learn by reading the database.
 */
export const WORKFLOW_PLAN_STEP = 'catalog.workflow.plan';
export const WORKFLOW_NODE_STEP = 'catalog.workflow.node';
export const WORKFLOW_FINISH_STEP = 'catalog.workflow.finish';

export interface WorkflowPlanStepInput {
  workflowId: string;
  workflowVersion: number;
  /** The durable run id, which is also the snapshot and the stage key. */
  snapshotId: string;
  connectorId: string;
  principalId: string;
}

/**
 * One step per node, iterating that node's batches inside it.
 *
 * Not one step per node *and batch*, which was the other candidate. Resumption
 * per node is the granularity that matters because a node is where user code
 * runs and therefore where a run fails: a ten-node graph that fails at node
 * seven resumes at node seven. Per batch would multiply the durable store's
 * write volume by the size of the data to buy a finer restart of the one thing
 * — re-reading a batch — that is already cheap.
 *
 * Every step here returns ids and counters. The rows a node produced live in
 * the stage store and are named by a {@link WorkflowStageRef}, because
 * `durable_step_checkpoints` persists each step's input and output as JSON and
 * a contract that passed rows would write the whole intermediate dataset into
 * the durable store once per node.
 */
@Injectable()
export class WorkflowRunSteps {
  constructor(
    private readonly runner: WorkflowRunnerService,
    // See the note on `ConnectorRunSteps`: a step carries no ambient scope, so a
    // multi-environment host enters one here and a single-connection host binds
    // the pass-through.
    @Inject(CATALOG_PIPELINE_SCOPE)
    private readonly scope: CatalogPipelineScope,
  ) {}

  /**
   * Open the run row and work out the order.
   *
   * Retried quickly rather than in minutes: nothing here reaches a source, so
   * the only failures it can have are the store being briefly unavailable.
   */
  @Step({
    name: WORKFLOW_PLAN_STEP,
    retries: 3,
    backoff: 'exp',
    backoffMs: 5_000,
    jitter: true,
  })
  async plan(input: WorkflowPlanStepInput): Promise<WorkflowPlanResult> {
    return this.guard(() =>
      this.scope.run(() =>
        this.runner.plan({
          workflowId: input.workflowId,
          workflowVersion: input.workflowVersion,
          snapshotId: input.snapshotId,
          connectorId: input.connectorId,
          principalId: input.principalId,
          // This step only exists on the durable path, so the mode it records
          // is not a guess: a run that reached here *is* checkpointed per node.
          mode: 'durable',
        }),
      ),
    );
  }

  /**
   * One node.
   *
   * Retried minutes apart, exactly like the connector step and for the same
   * reason: the failures worth surviving here are a source being briefly
   * unreachable, and hammering an already-struggling source is not a retry
   * policy. A retry is safe because the stage store is idempotent per
   * `(runId, nodeId, batch)` and the node clears any tail a longer previous
   * attempt left behind, so three attempts stage the data once.
   */
  @Step({
    name: WORKFLOW_NODE_STEP,
    retries: 3,
    backoff: 'exp',
    backoffMs: 60_000,
    backoffMaxMs: 900_000,
    jitter: true,
  })
  async runNode(input: WorkflowNodeStepInput, log?: StepLogger): Promise<WorkflowNodeStepOutput> {
    const output = await this.guard(() => this.scope.run(() => this.runner.executeNode(input)));
    // The node's own log lines, attached to the step as well as to the run row:
    // whoever is looking at a failed durable run should not have to know that a
    // second table holds what the transform said.
    for (const line of output.logs) log?.info(line);
    return output;
  }

  /**
   * Close the run row, and drop the staged rows if it succeeded.
   *
   * Retried harder than the others because it is the step that makes a finished
   * run *look* finished: a load that committed and then failed to record itself
   * leaves a `running` row that nothing will ever close, and the console reads
   * that as a load still in flight.
   */
  @Step({
    name: WORKFLOW_FINISH_STEP,
    retries: 5,
    backoff: 'exp',
    backoffMs: 5_000,
    backoffMaxMs: 60_000,
    jitter: true,
  })
  async finish(input: WorkflowFinishInput): Promise<{ status: string }> {
    const run = await this.guard(() => this.scope.run(() => this.runner.finish(input)));
    return { status: run.status };
  }

  /**
   * Turn the two failures that never improve by waiting into fatal ones.
   *
   * A deleted workflow, a deleted node, a transform that no longer exists, a
   * graph edited mid-run, a load whose fields match nothing in the type — none
   * of these are transient, and retrying them for fifteen minutes is noise
   * standing between somebody and the real failure. Everything else is left
   * retryable, which is the safer default: a source that is briefly unreachable
   * looks like an ordinary `Error`.
   */
  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw new UnrunnableWorkflowError(describe(error));
      }
      throw error;
    }
  }
}

/**
 * A failure that will never succeed, in the one form the engine actually reads.
 *
 * `FatalError` alone is not enough here, and the reason is worth writing down
 * because the same assumption is made elsewhere in this service. Durable core
 * honours `FatalError` in `runStepHandler`'s **local** retry loop — the path a
 * step takes when it runs inside the engine's own process. Every `ctx.step` in
 * this codebase is *dispatched*: the engine hands the task to a worker over the
 * transport, and the worker returns a serialised `{message, code, retryable}`
 * envelope. Only `retryable === false` is read on the way back in (see the
 * engine's `existing.error?.retryable !== false`); a `code` is carried but
 * decides nothing. So a plain `FatalError` thrown from a dispatched step is
 * retried the full three times regardless — measured, not assumed: a node
 * pointing at a deleted transform recorded `attempts: 3` and took forty seconds
 * to fail.
 *
 * Extending `FatalError` rather than replacing it keeps the local path correct
 * as well, so this is right whichever way the step is run.
 */
class UnrunnableWorkflowError extends FatalError {
  /**
   * The field the dispatch boundary serialises and the engine acts on. Read as
   * "do not try this again": a deleted transform, a graph edited mid-run and a
   * load whose fields match nothing in the target type do not improve by
   * waiting a minute.
   */
  readonly retryable = false;

  constructor(message: string) {
    super(message, 'workflow_unrunnable');
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
