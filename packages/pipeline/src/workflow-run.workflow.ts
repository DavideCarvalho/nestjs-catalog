import {
  WORKFLOW_CALL_CONTRACT,
  type WorkflowCallEnvelope,
  type WorkflowNodeStepOutput,
  type WorkflowStageRef,
} from '@dudousxd/nestjs-catalog';
import { Workflow } from '@dudousxd/nestjs-durable';
import { type WorkflowCtx, isWorkflowControlFlowSignal } from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';
import { WorkflowRunSteps } from './workflow-run.steps';
import {
  type WorkflowCallTarget,
  type WorkflowPlanEntry,
  type WorkflowPlanResult,
  WorkflowRunnerService,
  stageRefsFor,
} from './workflow-runner.service';

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
 * and the shape is deliberately flat — plan, then one unit of work per node,
 * then finish.
 *
 * A node is a **step** unless it is a `call`, and the split is the whole of the
 * rule: a child workflow is the right tool when the sub-unit has its own
 * lifetime, its own retries and its own history, and an ordinary node has none
 * of those — it is one attempt at one piece of work whose input is already
 * durable. A `call` node is precisely the case where the sub-unit *does* have
 * all three, because somebody else wrote and registered it. See
 * {@link CatalogWorkflowRunWorkflow.callWorkflow}.
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

    // Seeded from the plan's checkpoint, so a note about an attempt that was
    // found abandoned at this snapshot survives into this run's log — and
    // survives a replay, which is the case that matters: what is being recorded
    // is precisely that a previous attempt did not survive. `?? []` because a
    // run whose plan was checkpointed by a build before the field existed
    // replays through here.
    const progress = this.runner.emptyProgress(plan.notes ?? []);

    for (let index = 0; index < plan.order.length; index += 1) {
      const entry = plan.order[index];
      try {
        // In edge order, because that is the order `plan.order[].inputs`
        // preserved from the graph's edge array — never the iteration order of
        // `progress.stages`, which is keyed by node id and knows nothing about
        // the wiring. What a merge receives depends on this, and it is part of
        // the graph's fingerprint.
        const inputs = stageRefsFor(entry.inputs, progress.stages, snapshotId);
        const output = entry.call
          ? await this.callWorkflow(ctx, input, plan, entry, entry.call, inputs)
          : await ctx.step(this.steps.runNode, {
              workflowId: input.workflowId,
              workflowVersion: plan.workflowVersion,
              runId: snapshotId,
              nodeId: entry.nodeId,
              principalId: input.principalId,
              // Handed to every node and read by exactly one of them. Carrying
              // it per node rather than resolving it at the sink is what keeps
              // the body replayable: the sink step must be a pure function of
              // its checkpointed input, and a sink that went looking for the
              // run's options would be a database read whose answer can change
              // between the first attempt and the replay.
              //
              // Not on the call branch, and that is a statement rather than an
              // omission: the acknowledgement stands the row-count bound down
              // for one snapshot, the bound is applied by `runSink`, and a
              // `call` node is not a sink. Forwarding it into the envelope
              // would hand an arbitrary workflow an operator's one-time
              // acknowledgement to do whatever it liked with, and this graph
              // would have no way to know what that was.
              expectShrink: input.expectShrink,
              inputs,
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

  /**
   * One `call` node: another workflow, run as a tracked child of this run.
   *
   * In the body rather than in a step because that is the only place it can be.
   * `ctx.startChild`/`ctx.child` are *decisions* — they are written into this
   * run's history, so a replay reproduces the same call rather than making a
   * second one — and a step has no ctx to record a decision with. The cost is
   * that this method is workflow code and lives under workflow code's rule:
   * every value it branches on comes from the plan or from a checkpoint, and
   * nothing here reads a clock, an environment or a database.
   *
   * ## What the child gets, and what a hung one costs
   *
   * The envelope is built from the plan and the stage refs — handles, never
   * rows — and is byte-identical on every attempt, which is what makes
   * `startChild` idempotent by id.
   *
   * While the child runs, this run is `suspended` and costs nothing. It does
   * still hold its connector's singleton slot, and that is deliberate: the slot
   * exists to stop two loads of one connector overlapping, and a load waiting
   * on a child has not finished. The backstop is this workflow's own
   * `executionTimeout` — `sweepTimeouts` cancels `suspended` runs too, and
   * admission counts only runs that are `pending`/`running`/`suspended`, so a
   * child that hangs forever costs the connector one execution-timeout window
   * and not the slot itself.
   *
   * **What that sweep does not do is cascade.** It moves the run to `cancelled`
   * directly rather than through `engine.cancel`, so a child of a timed-out
   * parent is *orphaned* and keeps running. An explicit cancel — the dashboard,
   * `engine.cancel` — does cascade, recursively, through the `child:<id>`
   * waiter and the `signal:child:<id>` checkpoint. So: cancel the parent and
   * the child stops; let the parent time out and the child does not. Give a
   * called workflow its own `executionTimeout`; nothing on this side can bound
   * it, because `ctx.child` takes no deadline.
   *
   * ## Singletons belong to the callee, and are weaker across SDKs
   *
   * Calling a workflow does not lend it this one's serialisation. Whether two
   * loads calling the same workflow overlap is decided by *its* registration,
   * on the key *its* `singleton.key` computes from the envelope above — and by
   * the engine that owns the run. On the `attach`/convention path, which is
   * exactly how a cross-SDK body is reached, a synthesised registration carries
   * no singleton, no execution timeout and no input validation at all. A call
   * to a Python workflow may therefore run concurrently with itself however
   * carefully that workflow declared otherwise.
   *
   * ## The callee being busy is not a failure
   *
   * A singleton with `maxQueueDepth` **refuses** a start once its backlog is
   * full — the catalog's own two workflows do exactly this — and the refusal
   * arrives as a failed child. Three answers were available: fail the load,
   * skip the node, or wait. Skipping is out: a node that quietly produced
   * nothing is the silent no-op this whole service is built to avoid. Failing
   * outright would paint a load red for contention, which is not a fault and
   * clears itself. So it waits — {@link CALL_BUSY_ATTEMPTS} attempts, backing
   * off, suspended at zero compute — and fails only if the callee is still busy
   * at the end, with a message that says contention rather than breakage.
   *
   * Each attempt gets its **own** child id, and that is load-bearing rather
   * than tidy: `ctx.child` starts a child only when no run exists under the id,
   * so reusing an id whose run had already been created and settled would put
   * this run into a wait that nothing will ever signal.
   */
  private async callWorkflow(
    ctx: WorkflowCtx,
    input: CatalogWorkflowRunInput,
    plan: WorkflowPlanResult,
    entry: WorkflowPlanEntry,
    target: WorkflowCallTarget,
    inputs: WorkflowStageRef[],
  ): Promise<WorkflowNodeStepOutput> {
    const envelope = callEnvelope(ctx.runId, input, plan, entry, target, inputs);
    // `ctx.now` rather than `Date.now`: recorded once and replayed, so a
    // recovered run reports the elapsed time of the call and not of the replay.
    const startedAt = await ctx.now();

    for (let attempt = 0; ; attempt += 1) {
      const childRunId = `${ctx.runId}.call.${entry.nodeId}.${attempt}`;
      const check = {
        childRunId,
        nodeId: entry.nodeId,
        nodeName: entry.name,
        callName: target.name,
        callVersion: target.version,
      };

      await ctx.startChild(target.name, envelope, { childId: childRunId });
      // Before the join, so a wrong version is stopped while it is still
      // starting rather than after it has done a load's worth of work.
      const seen = await ctx.step(this.steps.checkCall, check);

      try {
        const result = await ctx.child<unknown>(target.name, envelope, { childId: childRunId });
        // The row was not there the first time and the child has now finished,
        // which means it did start and nothing has checked its version. The
        // pin is worth less late than early — the work is done — but it still
        // stops this run from *using* the output of a version nobody chose.
        if (!seen.started) await ctx.step(this.steps.checkCall, check);

        return this.runner.callOutput({
          nodeId: entry.nodeId,
          nodeName: entry.name,
          runId: ctx.runId,
          target,
          childRunId,
          result,
          elapsedMs: (await ctx.now()) - startedAt,
        });
      } catch (error) {
        // First and untouched, for the reason the loop in `run` gives: a
        // suspension is how a durable body gives up its thread, and treating
        // one as a failed call would retry a call that has not happened yet.
        if (isWorkflowControlFlowSignal(error)) throw error;

        const message = error instanceof Error ? error.message : String(error);
        if (isCalleeBusy(message) && attempt + 1 < CALL_BUSY_ATTEMPTS) {
          // Doubling, computed rather than read from anywhere, so the wait a
          // replay reproduces is the wait the run took.
          await ctx.sleep(CALL_BUSY_BACKOFF_MS * 2 ** attempt);
          continue;
        }
        throw new Error(describeCallFailure(target, childRunId, message));
      }
    }
  }
}

/**
 * The one shape a called workflow is handed.
 *
 * Built from the plan and the stage refs and nothing else, so it is byte-
 * identical on every attempt of a call and on every replay of the run — which
 * is what lets `startChild` be idempotent by id and what keeps the body free of
 * any read that could answer differently the second time.
 */
function callEnvelope(
  runId: string,
  input: CatalogWorkflowRunInput,
  plan: WorkflowPlanResult,
  entry: WorkflowPlanEntry,
  target: WorkflowCallTarget,
  inputs: WorkflowStageRef[],
): WorkflowCallEnvelope {
  return {
    catalog: {
      contract: WORKFLOW_CALL_CONTRACT,
      // The run id, the snapshot id and the stage key are one string here — so
      // a callee staging rows for this graph writes them where the next node
      // reads them, with nothing to correlate.
      runId,
      nodeId: entry.nodeId,
      workflowId: input.workflowId,
      workflowVersion: plan.workflowVersion,
      principalId: input.principalId,
      inputs,
    },
    input: target.config,
  };
}

/**
 * Why the call ended, told apart from what merely happened.
 *
 * Contention and breakage read identically on the wire — both arrive as a
 * failed child carrying a string — and they are entirely different things to be
 * told: one clears itself, the other needs somebody. So the sentence differs,
 * and both keep the engine's own words on the end of them so the claim is
 * checkable rather than this package's opinion.
 */
function describeCallFailure(
  target: WorkflowCallTarget,
  childRunId: string,
  message: string,
): string {
  const called = `${target.name}@${target.version}`;
  if (isCalleeBusy(message)) {
    return `${called} was busy on every one of ${CALL_BUSY_ATTEMPTS} attempts — something else is already running it and it admits one at a time. This is contention rather than a fault: run this load again when the other one has finished, or give the callee a deeper queue. The engine said: ${message}`;
  }
  return `${called} failed as child run ${childRunId}: ${message}`;
}

/**
 * How many times a call will re-start a callee that answered "busy".
 *
 * Five, with {@link CALL_BUSY_BACKOFF_MS} doubling between them — about seven
 * and a half minutes of waiting in total, all of it suspended. Sized against
 * the thing on the other side: a load that admits one run at a time is a load
 * of minutes, not hours, and a wait longer than this is better spent telling
 * somebody the two are contending than in silence. The parent's own
 * `executionTimeout` remains the outer bound either way.
 */
const CALL_BUSY_ATTEMPTS = 5;
const CALL_BUSY_BACKOFF_MS = 30_000;

/**
 * Whether a failed call is a busy callee rather than a broken one.
 *
 * By the text of the message, which is unpleasant and is what the wire offers.
 * A refused start is delivered to this run as a child completion carrying a
 * `string` — `startChildDeferred` stringifies the error before it crosses —
 * so the `SingletonQueueFullError` the engine threw arrives with its class,
 * its key and its `maxQueueDepth` flattened into prose. Matched on the part of
 * that sentence the engine composes itself rather than on the whole of it, so
 * a reworded suffix does not silently turn waiting back into failing.
 *
 * Wrong in the safe direction if it ever stops matching: the call fails
 * immediately with the engine's own words attached, which is the behaviour this
 * had before the wait existed.
 */
function isCalleeBusy(message: string): boolean {
  return message.includes('singleton queue for');
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
