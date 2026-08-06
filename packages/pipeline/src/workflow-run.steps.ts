import type { WorkflowNodeStepInput, WorkflowNodeStepOutput } from '@dudousxd/nestjs-catalog';
import { Step, WorkflowEngine } from '@dudousxd/nestjs-durable';
import { FatalError, type StepLogger } from '@dudousxd/nestjs-durable-core';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
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
export const WORKFLOW_CALL_CHECK_STEP = 'catalog.workflow.call-check';

export interface WorkflowPlanStepInput {
  workflowId: string;
  workflowVersion: number;
  /** The durable run id, which is also the snapshot and the stage key. */
  snapshotId: string;
  connectorId: string;
  principalId: string;
}

/** What {@link WorkflowRunSteps.checkCall} needs to say which pin was broken. */
export interface WorkflowCallCheckInput {
  childRunId: string;
  /** Both carried so the refusal names the box on the canvas, not an id. */
  nodeId: string;
  nodeName: string;
  callName: string;
  /** The version the node pinned. */
  callVersion: string;
}

/**
 * What the check saw.
 *
 * `started: false` means there is no run row yet — see the note on
 * {@link WorkflowRunSteps.checkCall} for why that is reported rather than
 * thrown. A `true` with no `version` is impossible by construction; the field
 * is there so a run's history records what was checked and not merely that
 * something was.
 */
export interface WorkflowCallCheckResult {
  started: boolean;
  version?: string;
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
    // Only {@link checkCall} touches it, and only to read a run row and cancel
    // one. Optional for the same reason `WorkflowLauncher` has it optional —
    // `CATALOG_DURABLE=off` provides no engine and a catalog with no call nodes
    // must still boot — and the one step that needs it refuses rather than
    // proceeding unchecked.
    @Optional() private readonly engine?: WorkflowEngine,
  ) {}

  /**
   * Open the run row and work out the order.
   *
   * Retried quickly rather than in minutes: nothing here reaches a source, so
   * the only failures it can have are the store being briefly unavailable. A
   * retry that follows an attempt which committed `startRun` and then lost its
   * result is exactly the case `WorkflowRunnerService.plan` closes the earlier
   * row for, which is why it is *this* step that has anything to report below.
   */
  @Step({
    name: WORKFLOW_PLAN_STEP,
    retries: 3,
    backoff: 'exp',
    backoffMs: 5_000,
    jitter: true,
  })
  async plan(input: WorkflowPlanStepInput, log?: StepLogger): Promise<WorkflowPlanResult> {
    const plan = await this.guard(() =>
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
    // On the step as well as on the run row, the way `runNode` puts a node's
    // own lines on both. Whoever is looking at a durable run whose earlier
    // attempt vanished is looking at the engine's tables already — telling them
    // there that a row was closed, and why, saves the hop to a second table to
    // find out what the engine's own `attempts` column meant.
    for (const line of plan.notes ?? []) log?.warn(line);
    return plan;
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
   * Is the child that was just started the version the node pinned?
   *
   * ## Why this step exists at all
   *
   * Because the engine has no way to start a *particular* version.
   * `engine.start(name, …)` resolves `latest.get(name)` and takes no version
   * argument; a version is honoured only on **resume**, where a run continues
   * on the version it began on. `ctx.child` therefore starts whatever is
   * newest, and a node that recorded a version and did nothing else would be
   * decoration on a promise nobody keeps.
   *
   * What *is* available is the truth after the fact: the run row carries
   * `workflowVersion`, set at start and never changed. So the pin is enforced
   * by observing it and refusing — the child is cancelled and the node fails,
   * naming both versions. Called immediately after `ctx.startChild` and before
   * the join, so in the ordinary case this lands while the child is still
   * getting going, long before it has finished doing anything.
   *
   * **The honest limit**: a child of the wrong version is *stopped*, not
   * *prevented*. Between the start and this check it has had a moment to run,
   * and a workflow whose first act is a side effect will have performed it.
   * Nothing this side of a version argument on `start` can close that, and
   * pretending otherwise in a docblock would be worse than the gap.
   *
   * ## Why a missing run row is not a failure here
   *
   * `startChildDeferred` starts the child on a microtask *and delivers a
   * refused start to the parent as a failed child*. So "no run row" is what a
   * refusal looks like from here — an unregistered name, an input the callee's
   * `validateInput` rejected, or its singleton queue being full — and every one
   * of those has a real message attached that only the join can see. Throwing
   * here would replace all of them with "no run row", so this reports
   * `started: false` and lets the join say what actually happened. The body
   * then re-runs this step after the join, which is what closes the gap for a
   * child whose row merely arrived late.
   */
  @Step({
    name: WORKFLOW_CALL_CHECK_STEP,
    // Short and few: the row either exists within a second of the start or the
    // start was refused, and retrying a refusal is waiting for nothing.
    retries: 3,
    backoff: 'exp',
    backoffMs: 1_000,
    backoffMaxMs: 5_000,
    jitter: true,
  })
  async checkCall(input: WorkflowCallCheckInput): Promise<WorkflowCallCheckResult> {
    // `getRun` is checked, not assumed. The `WorkflowEngine` token does not
    // always resolve to an engine with a store behind it: a thin/tenant worker
    // gets a start-only facade under the same token, whose `getRun` does not
    // exist and whose `cancel` throws. Calling it would be a `TypeError` inside
    // a step, which reads as a bug in this package rather than as the
    // deployment fact it is.
    if (!this.engine || typeof this.engine.getRun !== 'function') {
      // Refused rather than waved through, and this is the one place in this
      // package that fails for want of an engine. `WorkflowLauncher.durability`
      // reports what it observed instead of asserting — it can afford to,
      // because the consequence of being wrong is a run that is slower to
      // recover. Here the consequence of being wrong is a load that ran
      // somebody else's newer code while its own graph said otherwise, and
      // "unchecked" and "checked and fine" must not read the same.
      throw new UnrunnableWorkflowError(
        `Call node "${input.nodeName}" (${input.nodeId}) pins ${input.callName}@${input.callVersion}, and the process running ${WORKFLOW_CALL_CHECK_STEP} has no durable engine it can read a run from. A pin nobody checked is not a pin, so this run stops rather than using whichever version happened to start.`,
      );
    }

    const run = await this.engine.getRun(input.childRunId);
    if (!run) return { started: false };

    const started = typeof run.workflowVersion === 'string' ? run.workflowVersion : '';
    if (started === input.callVersion) return { started: true, version: started };

    // Cancelled before the refusal is thrown, and best-effort: the run is being
    // failed either way, and a cancel that could not be delivered must not turn
    // "you got the wrong version" into a message about the cancel.
    let stopped = 'it was cancelled';
    try {
      await this.engine.cancel(input.childRunId);
    } catch (error) {
      stopped = `it could not be cancelled (${describe(error)}) and may still be running`;
    }
    throw new UnrunnableWorkflowError(
      `Call node "${input.nodeName}" (${input.nodeId}) pins ${input.callName}@${input.callVersion}, but this deployment started ${input.callName}@${started || 'an unnamed version'} as child run ${input.childRunId} — the engine always starts the newest registered version. The load stops here and ${stopped}. Either register the pinned version alongside the newer one, or repoint the node, which is an edit to this graph and a new version of it.`,
    );
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
