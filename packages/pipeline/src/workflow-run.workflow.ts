import { Workflow } from '@dudousxd/nestjs-durable';
import { type WorkflowCtx, isWorkflowControlFlowSignal } from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';
import { WorkflowRunSteps } from './workflow-run.steps';
import { WorkflowRunnerService, stageRefsFor } from './workflow-runner.service';

/**
 * The workflow name, on the wire.
 *
 * Runs are started by name — that is the only form a `ScheduledWorkflow` takes,
 * and in `attach` mode the control plane that creates the run is a different
 * process that only ever sees this string. One exported constant so the two
 * ends cannot drift.
 */
export const CATALOG_WORKFLOW_RUN = 'catalog.workflow-run';

export interface CatalogWorkflowRunInput {
  workflowId: string;
  /**
   * The version the run was started against.
   *
   * Carried rather than looked up, so that a graph edited between the start and
   * the first node fails loudly at the node instead of quietly executing half
   * of one graph and half of another.
   */
  workflowVersion: number;
  /** Carried purely so a run list reads as names rather than as UUIDs. */
  workflowName: string;
  /**
   * Which connector this run is attributed to — a real one when a connector
   * runs this workflow, and the workflow's own id when nothing does.
   */
  connectorId: string;
  principalId: string;
  /**
   * The operator's acknowledgement that this load is allowed to collapse.
   *
   * Carried here because the escape hatch had nowhere else to go. It reached
   * the row-count bound only through `ConnectorRunOptions.expectShrink` on
   * `POST connectors/:id/run` — and that route is gone, because a connector is
   * not something anybody authors or runs directly any more. Without this
   * field, removing the route would have removed the only way an operator can
   * re-drive a load the bound refused, which leaves them raising the bound in
   * policy instead: standing the guard down for every future load of that type
   * rather than for this one snapshot. That is the failure `EXPECT_SHRINK_LABEL`
   * exists to prevent, arrived at by deleting its only entrance.
   *
   * **A scheduled run must never set it**, exactly as before: `ConnectorScheduler`
   * builds this payload with no `expectShrink` field at all, because a cron
   * window is unattended and an acknowledgement that fires every night is the
   * bound switched off in a costume. The route for a refused scheduled load is
   * still to look at the source and re-run it by hand, saying why.
   */
  expectShrink?: string;
}

export interface CatalogWorkflowRunOutput {
  runRowId: string;
  status: 'succeeded' | 'failed';
  fetched: number;
  written: number;
}

/**
 * How long one workflow run may take before the engine gives up on it.
 *
 * A backstop for the mutex below rather than a performance knob: a run wedged
 * forever on a socket that never closes holds its connector's singleton slot
 * forever, and the visible symptom is a workflow that quietly stops running.
 */
const EXECUTION_TIMEOUT = process.env.CATALOG_WORKFLOW_RUN_TIMEOUT ?? '2h';

/**
 * A graph, compiled into durable steps: one per node, in dependency order.
 *
 * The body is the only place in this service that decides what a checkpoint is,
 * and the shape is deliberately flat — plan, then a step per node, then finish.
 * No child workflows: a child is the right tool when the sub-unit has its own
 * lifetime and its own retries, and a node has neither. It is one attempt at
 * one piece of work whose input is already durable.
 *
 * **What crosses each boundary is ids and counters.** The refs handed to a node
 * name the stages its inputs wrote — `{runId, nodeId, batches, rowCount}` — and
 * the rows themselves stay in the stage store. That is what makes a ten-node
 * graph cost ten small checkpoints instead of ten copies of the dataset.
 *
 * `singleton` is what stops two workers running one connector's graph twice:
 * the engine serializes runs sharing a key, so a second window waits
 * (suspended, costing nothing) rather than racing the first into the same
 * target type. Note the limit of it — admission is scoped per workflow *name*
 * as well as per key, so this serializes runs of this workflow only, which is
 * sufficient because a connector runs its graph through exactly one of the two
 * workflows: the scheduler picks by `connector.workflowId` and never both. And
 * the engine that enforces it is the one that *owns* the run, so it holds in
 * `own` mode and not in `attach`, where a convention-resolved registration
 * carries none of this metadata.
 *
 * `maxQueueDepth: 1` is the other half: a graph that reliably takes longer than
 * its own cron period would otherwise queue one waiting run per window, of
 * loads whose data is stale by the time they run. One may wait; the rest are
 * refused at `start`.
 */
@Workflow({
  name: CATALOG_WORKFLOW_RUN,
  version: '1',
  tags: ['catalog', 'workflow'],
  singleton: { key: workflowMutexKey, maxQueueDepth: 1 },
  executionTimeout: EXECUTION_TIMEOUT,
})
@Injectable()
export class CatalogWorkflowRunWorkflow {
  constructor(
    private readonly steps: WorkflowRunSteps,
    // Only for the bookkeeping helpers — `record` and the empty progress. The
    // service is not touched for anything that reaches a database from here:
    // every side effect in this body goes through a step, which is what makes
    // the body replayable.
    private readonly runner: WorkflowRunnerService,
  ) {}

  async run(ctx: WorkflowCtx, input: CatalogWorkflowRunInput): Promise<CatalogWorkflowRunOutput> {
    // The durable run id *is* the snapshot id and the key the stages are
    // written under. Deterministic across replay by definition — it is this
    // run's identity — so a recovered run rejoins the snapshot and the staged
    // rows it had already started.
    const snapshotId = ctx.runId;

    const plan = await ctx.step(this.steps.plan, {
      workflowId: input.workflowId,
      workflowVersion: input.workflowVersion,
      snapshotId,
      connectorId: input.connectorId,
      principalId: input.principalId,
    });

    const progress = this.runner.emptyProgress();

    for (let index = 0; index < plan.order.length; index += 1) {
      const entry = plan.order[index];
      try {
        const output = await ctx.step(this.steps.runNode, {
          workflowId: input.workflowId,
          workflowVersion: plan.workflowVersion,
          runId: snapshotId,
          nodeId: entry.nodeId,
          principalId: input.principalId,
          // Handed to every node and read by exactly one of them. Carrying it
          // per node rather than resolving it at the sink is what keeps the
          // body replayable: the sink step must be a pure function of its
          // checkpointed input, and a sink that went looking for the run's
          // options would be a database read whose answer can change between
          // the first attempt and the replay.
          expectShrink: input.expectShrink,
          // In edge order, because that is the order `plan.order[].inputs`
          // preserved from the graph's edge array — never the iteration order
          // of `progress.stages`, which is keyed by node id and knows nothing
          // about the wiring. What a merge receives depends on this, and it is
          // part of the graph's fingerprint.
          inputs: stageRefsFor(entry.inputs, progress.stages, snapshotId),
        });
        // The kind comes off the plan, which is a checkpoint. Loading the graph
        // here to find it would be a database read inside a workflow body — the
        // one thing a replayable body must not do, because the answer can
        // change between the first run and the replay.
        this.runner.record(progress, { id: entry.nodeId, kind: entry.kind }, output);
      } catch (error) {
        // **A suspension is not a failure.** `ctx.step` dispatches and then
        // suspends the run by throwing a control-flow signal — that is how a
        // durable body gives up its thread while the worker runs the step — so
        // a bare `catch` around it treats every single step as having failed on
        // its first turn. The symptom is not a wrong error message: the catch
        // records the failure, dispatches the finish step, and the finish step
        // lands at the position the *next node* will occupy on the resumed
        // turn, so the run then dies of non-determinism two nodes later with a
        // message about the workflow having changed. Rethrown untouched and
        // first, before anything is recorded.
        if (isWorkflowControlFlowSignal(error)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        this.runner.recordFailure(progress, entry.nodeId, message);
        for (const later of plan.order.slice(index + 1)) {
          // Everything downstream is `skipped`, not `failed`: it did not run,
          // and recording nothing at all would read the same as a node nobody
          // has looked at yet.
          progress.outcomes[later.nodeId] = { status: 'skipped', rows: 0 };
        }
        // Recorded through a step, so the failure survives this process dying
        // the moment after it happened — and then rethrown, because a step (or
        // a workflow) that returns is one that succeeded, and a scheduled load
        // that silently "succeeds" while loading nothing is the failure mode
        // this whole feature exists to remove.
        await ctx.step(this.steps.finish, {
          runRowId: plan.runRowId,
          snapshotId,
          workflowId: input.workflowId,
          workflowName: input.workflowName,
          connectorId: input.connectorId,
          principalId: input.principalId,
          targetType: plan.targetType,
          status: 'failed',
          fetched: progress.fetched,
          written: progress.written,
          logs: progress.logs,
          error: `Node "${entry.name}" (${entry.nodeId}) failed: ${message}`,
          nodeOutcomes: progress.outcomes,
        });
        throw error;
      }
    }

    await ctx.step(this.steps.finish, {
      runRowId: plan.runRowId,
      snapshotId,
      workflowId: input.workflowId,
      workflowName: input.workflowName,
      connectorId: input.connectorId,
      principalId: input.principalId,
      targetType: plan.targetType,
      status: 'succeeded',
      fetched: progress.fetched,
      written: progress.written,
      logs: progress.logs,
      nodeOutcomes: progress.outcomes,
    });

    return {
      runRowId: plan.runRowId,
      status: 'succeeded',
      fetched: progress.fetched,
      written: progress.written,
    };
  }
}

/**
 * The mutex key, derived from the input the engine hands back as `unknown`.
 *
 * It throws rather than falling back. A key that quietly degraded to a constant
 * would serialize every workflow in the deployment behind one another, and the
 * symptom — loads mysteriously taking turns — names nothing that would lead
 * anybody here.
 *
 * Keyed on the connector rather than on the workflow: two connectors running
 * one graph into one type is exactly the case that must not overlap, and the
 * connector id is what a scheduled window is derived from.
 */
function workflowMutexKey(input: unknown): string {
  if (input !== null && typeof input === 'object') {
    const connectorId = Reflect.get(input, 'connectorId');
    if (typeof connectorId === 'string' && connectorId.length > 0) {
      return `catalog.connector:${connectorId}`;
    }
  }
  throw new Error(
    `${CATALOG_WORKFLOW_RUN} was started without a connectorId. There is nothing to serialize on, so this run has no honest mutex key.`,
  );
}
