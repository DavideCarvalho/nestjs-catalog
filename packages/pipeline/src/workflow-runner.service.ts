import { randomUUID } from 'node:crypto';
import {
  CATALOG_PIPELINE_STORE,
  type CatalogConnector,
  type CatalogPipelineStore,
  type CatalogStageStore,
  type CatalogWorkflow,
  type CatalogWorkflowStore,
  type ConnectorRun,
  SubprocessTransformRunner,
  type WorkflowBranchLabel,
  type WorkflowCallOutput,
  type WorkflowExecutionMode,
  type WorkflowIfNode,
  type WorkflowNodeKind,
  type WorkflowNodeOutcome,
  type WorkflowNodeStepInput,
  type WorkflowNodeStepOutput,
  type WorkflowSinkNode,
  type WorkflowSourceNode,
  type WorkflowStageRef,
  type WorkflowTransformNode,
  emitCatalog,
  readWorkflowCallOutput,
  supportsWorkflowStages,
  supportsWorkflows,
  unreachableNodeKind,
  workflowNodeRuns,
  workflowRunOrder,
} from '@dudousxd/nestjs-catalog';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { closeAbandonedAttempts } from './abandoned-runs';
import {
  CATALOG_PIPELINE_ENVIRONMENT,
  type CatalogEnvironmentNameResolver,
  allowlistedCodeEnv,
  codeContext,
  namedEnvironment,
} from './code-context';
import { EXPECT_SHRINK_LABEL } from './load-expectations';
import { PublishService } from './publish.service';
import { redactLines, redactSecrets, safeLogLines } from './run-logs';
import {
  type FetchResult,
  SOURCES,
  applyConnection,
  resolveSecret,
  toBufferedFetchResult,
} from './sources';

/**
 * Re-exported from where it now lives.
 *
 * `capLines` moved into `run-logs.ts` when the connector runner turned out to
 * need it too — it had a line cap and no character cap, which is half a bound —
 * and it sits there beside the redaction it has to be composed with in a
 * particular order. The name stays reachable from this module because it is part
 * of this package's published surface and because a host importing it should not
 * have to care that the file underneath it changed.
 */
export { capLines } from './run-logs';

/**
 * The same size the single-transform connector runner uses, and deliberately
 * the same constant rather than a second opinion about what a batch is: staged
 * batches and published batches are numbered the same way, and two different
 * sizes would make "batch 3" mean two things depending on which half of a run
 * you were reading.
 */
const BATCH_SIZE = 500;

/**
 * How much of a node's logging survives into a checkpoint, on both axes.
 *
 * Both, and that is the point. Capping the number of lines alone is what this
 * service shipped first and it is not enough: a transform that logs one line
 * naming every record it received put a 9.8KB string into a step's output
 * checkpoint, and from there into the finish step's input as well — measured on
 * a 1,200-row load, and it grows with the data, which is exactly the property a
 * step boundary must not have. Logs are the one non-counter allowed across a
 * boundary because they are what an operator reads when a node misbehaves, and
 * the price of keeping them is that both dimensions are bounded.
 *
 * The character bound itself lives in `run-logs.ts` now, as `capLines`' default,
 * because the connector runner needs the same number and two files each holding
 * an opinion about how long a log line may be is how they stop agreeing.
 */
const LOG_LINES_PER_NODE = 20;
/** And the run as a whole, which is what the finish step carries. */
const LOG_LINES_PER_RUN = 200;

/**
 * How far past a node's last written batch the stale-tail sweep will look
 * before giving up.
 *
 * A bound rather than a `while (true)`, because the loop's terminating
 * condition is "the store has nothing at this batch number" and a store that
 * answered wrongly — or a node id that somehow collided — would spin forever
 * inside a durable step that is already holding a lease. Five thousand batches
 * is two and a half million staged rows past the end of the current attempt,
 * which is far more than a previous attempt could plausibly have got through
 * before failing, and hitting it is a bug rather than a big load.
 */
const STALE_TAIL_LIMIT = 5_000;

/**
 * How long a failed run's staged rows are kept before a later run of the same
 * connector sweeps them.
 *
 * Not zero, and that is the whole point: staged rows are the only record of
 * what a failed graph actually produced at each node, and dropping them at the
 * moment of failure deletes the evidence of the failure. Not forever either —
 * they are intermediate data nothing reads once the run is given up on.
 */
const STAGE_RETENTION_MS = positiveInt(process.env.CATALOG_STAGE_RETENTION_MS, 24 * 60 * 60 * 1000);

/**
 * How many of a connector's recent runs one run of it looks back over.
 *
 * One number and one read, feeding both of the housekeeping rules a run does on
 * its way in — {@link WorkflowRunnerService.sweepAbandonedStages}, which drops
 * the staged rows of runs nobody will resume, and `closeAbandonedAttempts`,
 * which writes an outcome onto attempts at *this* snapshot that never recorded
 * one. Two reads would be two answers to "which runs were there", taken
 * milliseconds apart, and the two rules would then be reasoning about different
 * sets of rows while sharing a docblock that says they are not.
 */
const RUN_SCAN_LIMIT = 50;

/**
 * What the run has learned so far.
 *
 * Shared between the two executors rather than reimplemented in each, because
 * this is where a run's counters and its per-node record come from and two
 * copies of that arithmetic would let the same graph report different numbers
 * depending on which executor happened to run it.
 */
export interface NodeProgress {
  outcomes: Record<string, WorkflowNodeOutcome>;
  stages: Map<string, WorkflowStageRef>;
  logs: string[];
  fetched: number;
  written: number;
}

/** One entry of the plan: which node, and which nodes feed it, in edge order. */
export interface WorkflowPlanEntry {
  nodeId: string;
  /** What a person calls it, so a failure can name the box on the canvas. */
  name: string;
  /**
   * Carried in the plan rather than looked up per node, because the durable
   * workflow body must not read a database — a body that did would produce a
   * different answer on replay. Three strings per node is what that costs.
   */
  kind: WorkflowNodeKind;
  /** Upstream node ids **in edge order** — see `workflowRunOrder`. */
  inputs: string[];
  /**
   * The branch label on each inbound edge that has one, keyed by upstream id.
   *
   * On the plan for the reason `kind` is: deciding whether a node runs must not
   * read the database, because the answer would be re-derived from a graph that
   * may have been edited since. See `workflowNodeRuns` for the rule, and
   * `WorkflowRunOrderEntry.inputBranches` for why it is a record and not an
   * array.
   *
   * Optional so that a run whose plan was checkpointed before branches existed
   * replays through here. An absent map means every wire is plain, which is
   * exactly what those graphs are.
   */
  inputBranches?: Record<string, WorkflowBranchLabel>;
  /**
   * The object type a sink node commits, and absent on every other kind.
   *
   * Here so that a skipped sink can say *what* it did not commit. "Nothing
   * loaded into Mvr because the else branch was not taken" is the sentence the
   * whole feature has to be able to produce, and a plan entry that knew only the
   * node's name could not produce it.
   */
  commits?: string;
  /**
   * Present on a `call` node, and only there: which workflow it hands off to.
   *
   * On the plan for the same reason `kind` is. The workflow body is what makes
   * the child call — `ctx.child` is a decision recorded in the run's history,
   * and a step cannot make one — so the body needs the name, the version and
   * the parameters, and reading them out of the database from a body is the one
   * thing a replayable body must not do. The plan is a checkpoint, so a graph
   * repointed at another version between two nodes cannot change what a
   * half-finished run calls.
   */
  call?: WorkflowCallTarget;
}

/** What a `call` node was authored to call. See {@link WorkflowPlanEntry.call}. */
export interface WorkflowCallTarget {
  name: string;
  version: string;
  config: Record<string, unknown>;
}

/** What the planning step hands the durable workflow body. Ids and counters. */
export interface WorkflowPlanResult {
  /** The `catalog_connector_run` row this execution reports into. */
  runRowId: string;
  workflowVersion: number;
  /** The type the sink commits, for the run's own events and logging. */
  targetType: string;
  order: WorkflowPlanEntry[];
  /**
   * What opening this run had to say about the ones before it — today, one line
   * per attempt at this snapshot that was found still marked `running` and was
   * closed. Empty for the overwhelming majority of runs.
   *
   * Carried on the plan rather than written to the run row directly, because the
   * row this run reports into is opened by this very step and finished by a
   * later one: a line written here would be overwritten by the finish step's
   * `logs`. Going through the checkpoint also makes it survive a replay, which
   * is the case that matters — the fact being recorded is precisely that a
   * previous attempt did not survive.
   *
   * Bounded by the number of attempts at one snapshot, which the engine's retry
   * count bounds, so this cannot grow with the data the way a node's logging
   * can. Optional so that a run whose plan was checkpointed by an older build
   * replays without a field it never wrote.
   */
  notes?: string[];
}

/** What finishing a run needs. Bounded by the node count, never by the data. */
export interface WorkflowFinishInput {
  runRowId: string;
  snapshotId: string;
  workflowId: string;
  workflowName: string;
  connectorId: string;
  principalId: string;
  targetType: string;
  status: 'succeeded' | 'failed';
  fetched: number;
  written: number;
  logs: string[];
  error?: string;
  nodeOutcomes: Record<string, WorkflowNodeOutcome>;
}

/**
 * Executing a workflow graph: one node at a time, rows on the side.
 *
 * This service is the *body* of a workflow run and knows nothing about how it
 * was scheduled. There are two callers and they differ only in what wraps each
 * node:
 *
 * - the durable path calls {@link plan}, then {@link executeNode} once per node
 *   from inside a `@Step`, then {@link finish} — so each node has a checkpoint
 *   and a ten-node graph that fails at node seven resumes at node seven;
 * - the inline path calls {@link runInline}, which is the same loop in one
 *   process with no checkpoints at all.
 *
 * Keeping one implementation of a node is the point. Two would mean a graph
 * that behaves differently depending on whether a Redis was reachable when it
 * started, and the difference would only ever be discovered by a load coming
 * out wrong.
 *
 * **Nothing large crosses a node boundary.** A node's output is a
 * {@link WorkflowStageRef} — four scalars — and the rows live in the stage
 * store addressed by `(runId, nodeId, batch)`. That is measured rather than
 * tasteful: `durable_step_checkpoints` persists each step's input and output as
 * JSON, so a contract that passed rows would write the whole intermediate
 * dataset into the durable store once per node and read it all back on every
 * replay.
 *
 * The sink is the only node that writes into a type, and it publishes through
 * the *same* `appendRowsAsSystem`/`commitAsSystem` pair the single-transform
 * connector uses, with the same `_batch` numbering. A workflow run is still a
 * snapshot load; there is still exactly one way rows arrive.
 */
@Injectable()
export class WorkflowRunnerService {
  private readonly logger = new Logger(WorkflowRunnerService.name);

  constructor(
    @Inject(CATALOG_PIPELINE_STORE)
    private readonly pipeline: CatalogPipelineStore,
    private readonly transforms: SubprocessTransformRunner,
    private readonly publish: PublishService,
    /**
     * Last, and optional, so that every caller constructing this by hand — the
     * specs, a host wiring it outside `forRoot` — keeps compiling. A host that
     * has not declared an environment name has not got one, and
     * `context.environment` is absent rather than guessed.
     */
    @Optional()
    @Inject(CATALOG_PIPELINE_ENVIRONMENT)
    private readonly environmentName?: CatalogEnvironmentNameResolver,
  ) {}

  /**
   * The store, narrowed to one that can actually hold a graph and its rows.
   *
   * Checked rather than assumed, and checked by asking for the methods the way
   * `supportsWorkflows` does: `CatalogPipelineStore` declares both mixins as
   * optional so that a store written before workflows existed still compiles,
   * which means "this deployment cannot run workflows" is a sentence somebody
   * has to be able to read rather than a `TypeError` halfway through a load.
   */
  requireStore(): CatalogPipelineStore & CatalogWorkflowStore & CatalogStageStore {
    const store = this.pipeline;
    if (!supportsWorkflows(store)) {
      throw new BadRequestException(
        'The pipeline store configured here cannot hold workflows, so there is no graph to run.',
      );
    }
    if (!supportsWorkflowStages(store)) {
      throw new BadRequestException(
        'The pipeline store configured here cannot stage rows between nodes, so a workflow could only ever run its first node.',
      );
    }
    return store;
  }

  /** The graph, or a refusal naming the id. */
  async requireWorkflow(id: string): Promise<CatalogWorkflow> {
    const workflow = await this.requireStore().getWorkflow(id);
    if (!workflow) throw new NotFoundException(`No workflow ${id}`);
    return workflow;
  }

  /**
   * Which connector a run of this workflow is attributed to.
   *
   * A run row needs a connector id, and a workflow run started from the canvas
   * has no connector at all. Rather than invent a nullable column, the workflow
   * stands in for itself: `connectorId` holds the workflow id, `listRuns` still
   * groups the runs of one thing, and no row claims to belong to a connector
   * that does not exist. When exactly one connector *does* run this workflow,
   * that connector is the honest answer — its `lastRunStatus` is what the
   * console shows, and a manual run that left it stale would be a lie.
   */
  async attributionFor(workflow: CatalogWorkflow): Promise<string> {
    const using = await this.requireStore().connectorsUsingWorkflow(workflow.id);
    return using.length === 1 ? using[0].id : workflow.id;
  }

  /**
   * Open the run row and work out the order.
   *
   * **One row per attempt, and an attempt that left one open is closed by the
   * one that follows it.** This step used to adopt an existing `running` row at
   * the same snapshot instead of opening its own, so that a planning step which
   * committed `startRun` and then lost its result would not leave a row per
   * attempt. That answered the multiplicity and left the silence: the adopting
   * attempt wrote its own outcome over the row, and nothing anywhere said that
   * an earlier attempt had vanished — which is the single failure
   * `closeAbandonedAttempts` exists to end, arrived at from the other side. Now
   * the earlier row is closed, with the message saying what that state means and
   * where the engine's half of it is recorded, and this attempt opens its own.
   * A run list that reports "a load that never happened" is exactly right when
   * the row says which load and why it never happened.
   *
   * The two limits of the scan hold here unchanged and are worth reading on
   * {@link closeAbandonedAttempts} before trusting this: the last attempt of a
   * series is closed by nothing *on this rule*, and an attempt still alive
   * elsewhere may write its own outcome over ours — which is correct, since it
   * is the one that knows. The first of those is what `AbandonedRunReconciler`
   * answers, from the other direction: a durable run that dies without ever
   * reaching its finish step is never followed by another attempt at its
   * snapshot, so its row is closed by asking the engine whether the run is
   * alive rather than by waiting for a `plan` that will not come.
   */
  async plan(input: {
    workflowId: string;
    workflowVersion: number;
    snapshotId: string;
    connectorId: string;
    principalId: string;
    mode: WorkflowExecutionMode;
  }): Promise<WorkflowPlanResult> {
    const workflow = await this.requireWorkflow(input.workflowId);
    this.assertSameGraph(workflow, input.workflowVersion);

    const opened = await this.beginRun({
      workflow,
      connectorId: input.connectorId,
      principalId: input.principalId,
      snapshotId: input.snapshotId,
      mode: input.mode,
    });

    return {
      runRowId: opened.run.id,
      workflowVersion: workflow.version,
      targetType: workflow.targetType,
      notes: opened.notes,
      order: workflowPlanEntries(workflow),
    };
  }

  /**
   * Run one node.
   *
   * The unit of resumption, and it is a node rather than a node-and-batch on
   * purpose: a node is where user code runs and therefore where a run fails,
   * and a checkpoint per batch would multiply the durable store's write volume
   * by the size of the data to buy a finer restart of the one thing that is
   * already cheap to repeat.
   */
  async executeNode(input: WorkflowNodeStepInput): Promise<WorkflowNodeStepOutput> {
    const startedAt = Date.now();
    const workflow = await this.requireWorkflow(input.workflowId);
    this.assertSameGraph(workflow, input.workflowVersion);

    const node = workflow.nodes.find((candidate) => candidate.id === input.nodeId);
    if (!node) {
      throw new NotFoundException(
        `Workflow "${workflow.name}" has no node ${input.nodeId}. The graph was edited while this run was in flight, and finishing it would load data through a shape nobody chose.`,
      );
    }

    // A discriminated union, so this is narrowing rather than a cast — which is
    // exactly why the node kinds are modelled as one.
    if (node.kind === 'source') {
      return this.runSource(node, input, startedAt);
    }
    if (node.kind === 'transform') {
      return this.runTransform(node, workflow, input, startedAt);
    }
    if (node.kind === 'if') {
      return this.runIf(node, input, startedAt);
    }
    if (node.kind === 'call') {
      // Not executable from here, and refused rather than approximated.
      //
      // A call node runs as a tracked child of the durable run, which is a
      // decision the *workflow body* records in the run's history — `ctx.child`
      // — and a step has no ctx to record one with. The alternative on offer
      // was to start a detached run from inside this step and poll it, and that
      // is a worse thing than an unsupported node: the run would not be a child
      // of anything, so cancelling the parent would leave it running, the
      // parent would burn a worker slot polling, and none of it would appear in
      // the run tree. So the durable path branches in the body (see
      // `CatalogWorkflowRunWorkflow.run`) and the inline path says this.
      throw new BadRequestException(
        `Node "${node.name}" (${node.id}) calls the workflow "${node.callName}@${node.callVersion}", which runs as a durable child run — and this run has no durable engine to start one with. Point this deployment at a durable engine, or replace the call with a transform.`,
      );
    }
    if (node.kind === 'sink') {
      return this.runSink(node, workflow, input, startedAt);
    }
    return unreachableNodeKind(node, 'WorkflowRunnerService.executeNode');
  }

  /**
   * A finished child call, in the shape the rest of the run accounts in.
   *
   * Here rather than in the workflow body because it is arithmetic and
   * narrowing, and the body is where the *decisions* live: the body starts the
   * child and awaits it, and hands the answer here to be turned into the same
   * `{nodeId, output, rows, logs}` every other node produces. That is what lets
   * `record` treat a call node like any other and keeps one accounting of a
   * run's numbers rather than two.
   *
   * Pure, and it must stay pure: the durable body calls it, and anything
   * reaching a database from there would be a read on the replay path.
   */
  callOutput(input: {
    nodeId: string;
    nodeName: string;
    runId: string;
    target: WorkflowCallTarget;
    childRunId: string;
    /** Whatever the child returned. Narrowed here, never trusted. */
    result: unknown;
    elapsedMs: number;
  }): WorkflowNodeStepOutput {
    const called = `${input.target.name}@${input.target.version}`;
    let staged: WorkflowCallOutput | undefined;
    try {
      staged = readWorkflowCallOutput(input.result);
    } catch (error) {
      // Rethrown with the call on the front of it. `readWorkflowCallOutput`
      // knows what it saw and nothing about whose graph saw it, and a message
      // that names neither the node nor the workflow sends its reader to the
      // wrong repository.
      throw new BadRequestException(
        `Call node "${input.nodeName}" (${input.nodeId}) ran ${called} as child run ${input.childRunId}, and cannot read what it returned. ${say(error)}`,
      );
    }

    const logs = staged
      ? [
          `Called ${called} as child run ${input.childRunId}; it staged ${staged.rowCount} rows in ${staged.batches} batches.`,
        ]
      : [
          // Said out loud on every call that produced nothing, because the
          // alternative is a node that reports zero rows with no explanation —
          // and "the workflow I called returned nothing to read" and "the
          // workflow I called is broken" would look identical.
          `Called ${called} as child run ${input.childRunId}; it returned nothing this graph can read rows from, so this node passes on 0 rows.`,
        ];

    return {
      nodeId: input.nodeId,
      output: {
        runId: input.runId,
        nodeId: input.nodeId,
        batches: staged?.batches ?? 0,
        rowCount: staged?.rowCount ?? 0,
      },
      rows: staged?.rowCount ?? 0,
      elapsedMs: input.elapsedMs,
      logs: safeLogLines(logs, LOG_LINES_PER_NODE),
    };
  }

  /**
   * The whole graph, in this process, with no checkpoints.
   *
   * A real execution mode rather than a degraded one: the sink still commits
   * atomically and the rows still arrive through the publish protocol. What is
   * missing is resumption — a failure at node seven re-runs node one — and the
   * run records `executionMode: "inline"` so that nobody reading it later is
   * left to infer which it was from whatever `CATALOG_DURABLE` happens to say
   * on the day they look.
   */
  async runInline(input: {
    workflow: CatalogWorkflow;
    connectorId: string;
    principalId: string;
    snapshotId: string;
    /**
     * Carried on the inline path as well as the durable one, and that symmetry
     * is load-bearing rather than tidy. Which path a run takes is decided by
     * whether a `WorkflowEngine` happened to resolve in this process — so an
     * acknowledgement honoured only on the durable path would mean an operator's
     * re-run was refused or allowed depending on deployment topology they cannot
     * see, and the two would be told apart only by the load failing.
     */
    expectShrink?: string;
  }): Promise<ConnectorRun> {
    const { workflow, connectorId, principalId, snapshotId } = input;
    // The same plan the durable path checkpoints, built by the same function.
    // See `workflowPlanEntries`.
    const order = workflowPlanEntries(workflow);
    const opened = await this.beginRun({
      workflow,
      connectorId,
      principalId,
      snapshotId,
      mode: 'inline',
    });
    const run = opened.run;

    // Seeded with whatever opening the run had to say about the attempts before
    // it, so the closing of an abandoned one is readable off the run that did
    // the closing and not only off the row that was closed. The durable path
    // seeds the same lines from the plan step's checkpoint.
    const progress = this.emptyProgress(opened.notes);

    for (let index = 0; index < order.length; index += 1) {
      const entry = order[index];
      // Asked before the node is touched, and answered purely from what earlier
      // nodes recorded — see `workflowNodeRuns`, which is also where the reason
      // the naive "skip every descendant" rule is wrong is written down. A node
      // that is not on a live path is recorded as skipped and **not executed**,
      // which is the only mechanism keeping a skipped sink from committing: the
      // sink is not a sink that ran and found nothing, it is a sink that was
      // never called, so nothing repoints the live view.
      if (this.skipUnlessLive(progress, entry, order)) continue;
      try {
        const output = await this.executeNode({
          workflowId: workflow.id,
          workflowVersion: workflow.version,
          runId: snapshotId,
          nodeId: entry.nodeId,
          principalId,
          inputs: stageRefsFor(entry.inputs, progress.stages, snapshotId),
          expectShrink: input.expectShrink,
        });
        this.record(progress, { id: entry.nodeId, kind: entry.kind }, output);
      } catch (error) {
        const message = say(error);
        this.recordFailure(progress, entry.nodeId, message);
        this.strandRemaining(progress, order, index);
        return this.finish({
          runRowId: run.id,
          snapshotId,
          workflowId: workflow.id,
          workflowName: workflow.name,
          connectorId,
          principalId,
          targetType: workflow.targetType,
          status: 'failed',
          fetched: progress.fetched,
          written: progress.written,
          logs: progress.logs,
          error: `Node "${entry.name}" (${entry.nodeId}) failed: ${message}`,
          nodeOutcomes: progress.outcomes,
        });
      }
    }

    return this.finish({
      runRowId: run.id,
      snapshotId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      connectorId,
      principalId,
      targetType: workflow.targetType,
      status: 'succeeded',
      fetched: progress.fetched,
      written: progress.written,
      logs: progress.logs,
      nodeOutcomes: progress.outcomes,
    });
  }

  /**
   * Fold one node's output into the run so far.
   *
   * Exported through the service rather than written twice, because the durable
   * workflow body accumulates exactly the same way — and an accounting that
   * drifted between the two modes would make the same graph report different
   * numbers depending on whether Redis was up.
   */
  record(
    progress: NodeProgress,
    node: { id: string; kind: WorkflowNodeKind },
    output: WorkflowNodeStepOutput,
  ): void {
    if (output.output) progress.stages.set(node.id, output.output);
    progress.outcomes[node.id] = {
      status: 'succeeded',
      rows: output.rows,
      transformVersion: output.transformVersion,
      // The one field on an outcome that is a *decision* rather than a
      // measurement, and the reason it travels this way: it came off the step's
      // output, which the durable engine checkpointed, so a replay folds the
      // recorded branch back in rather than asking the predicate again.
      branch: output.branch,
      elapsedMs: output.elapsedMs,
    };
    // Bounded and redacted here rather than only at the store, because these
    // lines travel into the finish step's *input* checkpoint on the durable
    // path. A cap applied only on the way into the database would leave the
    // durable store holding what the database refused, and the same is true of
    // the redaction: `durable_step_checkpoints` is a second copy of every log
    // line a node produced, and it is not covered by anything at the HTTP
    // boundary. The node paths already redact what they return, so this is the
    // second of two passes and does nothing on a well-behaved one — which is
    // exactly why `redactSecrets` had to be idempotent.
    progress.logs = safeLogLines([...progress.logs, ...output.logs], LOG_LINES_PER_RUN);
    // What a *source* read is what "fetched" has always meant on a run, and a
    // graph with two sources fetched the sum of both.
    //
    // A `call` node is deliberately not counted here even when it originates
    // the graph's rows. `fetched` is this service's own statement about what it
    // read out of a system, and a called workflow's rows arrive already staged
    // by somebody else's code — folding them in would make a number that means
    // "what the catalog fetched" quietly mean "what reached the graph". The
    // rows are on the node's own outcome, where the run panel reads them.
    if (node.kind === 'source') progress.fetched += output.rows;
    if (output.committed) progress.written = output.rows;
  }

  recordFailure(progress: NodeProgress, nodeId: string, error: string): void {
    progress.outcomes[nodeId] = { status: 'failed', rows: 0, error };
  }

  /**
   * Skip a node that no live branch reaches, and say so; or report that it runs.
   *
   * The one place either executor decides this. Both loops ask it at the top of
   * every node and neither of them re-derives the rule, because the durable body
   * and the inline loop skipping different sets would be a graph that loads
   * different data depending on whether a Redis was reachable — the exact
   * property {@link WorkflowRunnerService} exists to hold.
   *
   * Pure, and it must stay pure: the durable body calls it, so anything reaching
   * a database from here would be a read on the replay path.
   */
  skipUnlessLive(
    progress: NodeProgress,
    entry: WorkflowPlanEntry,
    order: readonly WorkflowPlanEntry[],
  ): boolean {
    if (workflowNodeRuns(entry, progress.outcomes)) return false;
    this.recordBranchSkip(progress, entry, branchSkipReason(entry, order, progress.outcomes));
    return true;
  }

  /**
   * Mark everything after a failed node as never having run.
   *
   * `skipped`, not `failed`: a ten-node graph that died at node seven records
   * three nodes with no entry at all otherwise, which reads exactly like three
   * nodes nobody has looked at yet.
   *
   * **No `skippedBecause`**, and that is the load-bearing omission. Absent is the
   * meaning `skipped` has always had — the run stopped short — and every outcome
   * stored before branches existed records it that way. Writing a reason here
   * would relabel a broken run as a branch, which is the single confusion the
   * field exists to remove.
   *
   * Shared by both executors, like everything else on this service that writes
   * into `progress`, and extracted from them for the same reason: it is the same
   * loop twice, and the durable body's copy of it was the one that pushed that
   * method past what the linter will hold in one head.
   */
  strandRemaining(
    progress: NodeProgress,
    order: readonly WorkflowPlanEntry[],
    afterIndex: number,
  ): void {
    for (const later of order.slice(afterIndex + 1)) {
      progress.outcomes[later.nodeId] = { status: 'skipped', rows: 0 };
    }
  }

  /**
   * Write down that a node was never reached because a branch was not taken.
   *
   * **Not the same thing as the skip a failure produces.** A node skipped by a
   * branch is part of a run that is going perfectly well; a node skipped by a
   * failure is downstream of something broken. `skippedBecause` is what tells a
   * run panel — and anybody reading the stored outcomes — which it is looking at.
   *
   * A **sink** additionally says so in the run's own log, because that is where
   * somebody looks when a type they expected to be refreshed was not. A sink
   * that never ran committed nothing, which means the snapshot that was live
   * before this run is still live and still serving; that is the correct
   * outcome, and it is indistinguishable from a silent bug unless it is stated.
   */
  private recordBranchSkip(
    progress: NodeProgress,
    entry: WorkflowPlanEntry,
    because: string,
  ): void {
    progress.outcomes[entry.nodeId] = {
      status: 'skipped',
      rows: 0,
      skippedBecause: 'branch-not-taken',
    };
    if (entry.kind !== 'sink') return;
    progress.logs = safeLogLines(
      [
        ...progress.logs,
        `Sink "${entry.name}" (${entry.nodeId}) did not run: ${because}. Nothing was committed${
          entry.commits ? ` for ${entry.commits}` : ''
        }, so whatever snapshot was live before this run is still live and still serving. This is not a failure — an empty snapshot committed here is what would have destroyed it.`,
      ],
      LOG_LINES_PER_RUN,
    );
  }

  /**
   * A run that has learned nothing yet — except, sometimes, what it had to say
   * about the attempt before it.
   *
   * `logs` is a parameter rather than something the two callers append
   * afterwards because both of them are the *start* of a run's log and the order
   * of those lines is what somebody reads a failed run in: a note about a
   * closed attempt belongs above the first node's output, not wherever the
   * caller happened to remember to push it.
   */
  emptyProgress(logs: string[] = []): NodeProgress {
    return {
      outcomes: {},
      stages: new Map(),
      logs: [...logs],
      fetched: 0,
      written: 0,
    };
  }

  /**
   * Close the run row, and only now drop what it staged.
   *
   * The ordering is the load-bearing part. Staged rows are dropped **after a
   * successful run and never after a failed one**, for two reasons that point
   * the same way: a durable retry resumes onto the stages the earlier nodes
   * already wrote, so dropping them on failure would turn "resumes at node
   * seven" into "starts again at node one with its inputs deleted"; and the
   * stages are the only record of what each node actually produced, so dropping
   * them at the moment of failure destroys the evidence of the failure. What
   * eventually collects them is {@link sweepAbandonedStages}, on a later run of
   * the same connector, once nobody is going to resume this one.
   */
  async finish(input: WorkflowFinishInput): Promise<ConnectorRun> {
    const store = this.requireStore();
    const logs = [...input.logs];

    if (input.status === 'succeeded') {
      try {
        const dropped = await store.dropStages(input.snapshotId);
        if (dropped > 0) {
          logs.push(`Dropped ${dropped} staged batches; the rows are committed.`);
        }
      } catch (error) {
        // A run that loaded and committed correctly must not be reported as
        // failed because the cleanup of its scratch space did not work. The
        // stages are addressed by run id and the sweep will find them again.
        logs.push(`Could not drop staged rows: ${say(error)}.`);
      }
    }

    // The last boundary before both readable sinks, and the only one that sees
    // all three carriers at once. `GET pipeline/runs` serves `logs`, `error` and
    // `nodeOutcomes` at `catalog:read`; `GET catalog/events` serves the payload
    // below at the same scope. A source URL reaches every one of them by a
    // different route — `runInline` wraps the node's message into `error`, a
    // node's own logging arrives through `record`, and `recordFailure` puts the
    // raw message on the outcome — so redacting at any one of those three would
    // have left the other two.
    const readable = redactLines(logs);
    const error = input.error === undefined ? undefined : redactSecrets(input.error);
    const nodeOutcomes = redactOutcomes(input.nodeOutcomes);

    emitCatalog('connector.run.finished', {
      connectorId: input.connectorId,
      connectorName: input.workflowName,
      typeName: input.targetType,
      snapshotId: input.snapshotId,
      principalId: input.principalId,
      status: input.status,
      fetched: input.fetched,
      written: input.written,
      error,
    });

    const finished = await store.finishRun(input.runRowId, {
      status: input.status,
      fetched: input.fetched,
      written: input.written,
      logs: readable,
      error,
      nodeOutcomes,
    });

    if (input.status === 'succeeded') {
      this.logger.log(
        `${input.workflowName}: ${input.fetched} fetched, ${input.written} written as ${input.snapshotId}`,
      );
    } else {
      // The unredacted one, and only here. A process log is read by whoever
      // operates the deployment; the three fields above are read by anybody
      // holding the softest scope in the system. That split is what keeps this a
      // redaction rather than a deletion.
      this.logger.warn(`${input.workflowName} failed: ${input.error}`);
    }

    if (finished) return finished;
    throw new NotFoundException(`Run ${input.runRowId} disappeared while it was being finished.`);
  }

  /**
   * The run row for a snapshot — the one that is still being written, or failing
   * that the one that recorded an outcome most recently.
   *
   * **A snapshot can carry more than one row**, and that is why this is four
   * lines rather than a `find`. An attempt that left its row at `running` is
   * closed by the attempt that follows it — see {@link plan} — so a snapshot
   * whose first attempt was abandoned holds a closed row *and* the row of the
   * attempt that closed it. Both are honest history; only one of them is the
   * answer to "how is this load going". `listRuns` orders by `startedAt`, whose
   * stored precision is seconds, so two rows opened moments apart can tie and
   * the first match would be whichever the database happened to return —
   * meaning `awaitRun` could report the abandoned attempt's failure as the
   * outcome of the run that had just replaced it.
   *
   * Preferring `running` answers the poll while a load is in flight; preferring
   * the latest `finishedAt` answers it afterwards, and that is the one field
   * that genuinely orders two attempts at the same snapshot — the closing of an
   * abandoned row happens strictly before the run that closed it can finish.
   */
  async findRun(connectorId: string, snapshotId: string): Promise<ConnectorRun | undefined> {
    const runs = await this.requireStore().listRuns(connectorId, RUN_SCAN_LIMIT);
    const matching = runs.filter((run) => run.snapshotId === snapshotId);
    const live = matching.find((run) => run.status === 'running');
    if (live) return live;
    return matching.reduce<ConnectorRun | undefined>(
      (latest, run) =>
        latest === undefined || finishedOrder(run) > finishedOrder(latest) ? run : latest,
      undefined,
    );
  }

  /* --------------------------------------------------------------------- */

  /**
   * The graph this run started on is the graph it finishes on.
   *
   * A workflow keeps only its latest shape, so an edit between two nodes of a
   * run would silently execute half of one graph and half of another — and the
   * run row would name a single version for both halves. Refusing is the only
   * honest option: the load is abandoned, the stages are kept, and the run says
   * which version it expected.
   */
  private assertSameGraph(workflow: CatalogWorkflow, version: number): void {
    if (workflow.version === version) return;
    throw new BadRequestException(
      `Workflow "${workflow.name}" is now v${workflow.version}; this run started on v${version}. A run must not execute half of one graph and half of another, so it stops here rather than loading something nobody drew.`,
    );
  }

  /**
   * Open this attempt's run row, having first dealt with what earlier ones left.
   *
   * The two rules below are different rules and they stay different — one is
   * about rows and the other about staged data — but they read **one** list.
   * See {@link RUN_SCAN_LIMIT}: two reads are two answers to which runs there
   * were, and rules that disagree about what they looked at are how the pair
   * eventually contradict each other.
   *
   * They are also not redundant, which is worth stating because the names
   * suggest it. `sweepAbandonedStages` takes runs that *failed*, at *other*
   * snapshots, longer ago than the retention window, and drops the rows they
   * staged. `closeAbandonedAttempts` takes runs still marked `running`, at *this*
   * snapshot, whatever their age, and writes them an outcome. Disjoint on every
   * clause. What they do share is a boundary: staged rows are only ever
   * collected from a run that *failed*, so a row abandoned at `running` used to
   * keep its stages for good. Closing it is what makes them collectable, one
   * retention window later, by the sweep.
   */
  private async beginRun(input: {
    workflow: CatalogWorkflow;
    connectorId: string;
    principalId: string;
    snapshotId: string;
    mode: WorkflowExecutionMode;
  }): Promise<{ run: ConnectorRun; notes: string[] }> {
    const store = this.requireStore();

    // Both best effort, and before the run rather than after: they read and
    // write the same store the run is about to use, and doing it at the end
    // would mean a run that crashed never cleaned anything up.
    const recent = await this.recentRuns(input.connectorId);
    const notes = await closeAbandonedAttempts(
      store,
      {
        // The workflow's name, which is the name this path already puts on the
        // run's events — a message naming a connector id nobody authored would
        // send a reader looking for an object that is not there any more.
        name: input.workflow.name,
        connectorId: input.connectorId,
        snapshotId: input.snapshotId,
        runs: recent,
      },
      this.logger,
    );
    await this.sweepAbandonedStages(recent, input.snapshotId);

    const run = await store.startRun({
      connectorId: input.connectorId,
      snapshotId: input.snapshotId,
      principalId: input.principalId,
      // Recorded at the start, all four of them. A run that dies hard enough
      // never to reach `finishRun` is precisely the one whose graph somebody
      // will need to identify, and `executionMode` is a fact about this run
      // rather than a reading of what the configuration says today.
      workflowId: input.workflow.id,
      workflowVersion: input.workflow.version,
      graphHash: input.workflow.graphHash,
      executionMode: input.mode,
    });

    emitCatalog('connector.run.started', {
      connectorId: input.connectorId,
      connectorName: input.workflow.name,
      typeName: input.workflow.targetType,
      snapshotId: input.snapshotId,
      principalId: input.principalId,
    });

    return { run, notes };
  }

  /**
   * This connector's recent runs, or nothing at all.
   *
   * The one read both housekeeping rules work from, and guarded here rather
   * than inside each of them: a store that cannot answer must leave the load in
   * front of it alone, and an empty list is what "there is nothing I can say
   * about earlier runs" looks like to both rules without either needing a second
   * code path for it.
   */
  private async recentRuns(connectorId: string): Promise<ConnectorRun[]> {
    try {
      return await this.requireStore().listRuns(connectorId, RUN_SCAN_LIMIT);
    } catch (error) {
      this.logger.warn(`Could not read the recent runs of ${connectorId}: ${say(error)}`);
      return [];
    }
  }

  /**
   * Collect the staged rows of runs nobody is going to resume.
   *
   * Bounded on both axes — the last {@link RUN_SCAN_LIMIT} runs of this
   * connector, and only those that failed longer ago than the retention window
   * — so it costs no query of its own and cannot turn a load into a table scan.
   * Failures inside it are swallowed deliberately: a housekeeping problem must
   * never be the reason a load did not happen.
   *
   * **`failed`, and not `running`.** A run still marked `running` may be one; a
   * run that is genuinely in flight and whose stages this dropped would lose its
   * own inputs mid-graph. That is why the pair in {@link beginRun} is two rules
   * — the other one is what turns an abandoned `running` row into a `failed`
   * one, at which point this can collect it a retention window later.
   */
  private async sweepAbandonedStages(runs: ConnectorRun[], keepSnapshotId: string): Promise<void> {
    try {
      const store = this.requireStore();
      const cutoff = Date.now() - STAGE_RETENTION_MS;
      for (const run of runs) {
        if (run.snapshotId === keepSnapshotId) continue;
        if (run.status !== 'failed') continue;
        const finishedAt = Date.parse(run.finishedAt ?? run.startedAt);
        if (!Number.isFinite(finishedAt) || finishedAt > cutoff) continue;
        const dropped = await store.dropStages(run.snapshotId);
        if (dropped > 0) {
          this.logger.log(
            `Dropped ${dropped} staged batches left by failed run ${run.snapshotId}.`,
          );
        }
      }
    } catch (error) {
      this.logger.warn(`Could not sweep abandoned stages: ${say(error)}`);
    }
  }

  /* --- the three node kinds ------------------------------------------- */

  private async runSource(
    node: WorkflowSourceNode,
    input: WorkflowNodeStepInput,
    startedAt: number,
  ): Promise<WorkflowNodeStepOutput> {
    const logs: string[] = [];
    const { connector, owner } = await this.resolveSourceNode(node);

    // A watermark belongs to the connector the node reads through, keyed by
    // node id: two nodes reading the same connector are two different reads and
    // one flat blob would let them overwrite each other. A node configured
    // inline has no connector and therefore nowhere to keep one, which is why
    // it cannot run incrementally — said out loud rather than silently ignored.
    const state = nodeState(owner, node.id);
    const wanted = node.mode === 'incremental' ? 'incremental' : 'full';
    const mode = wanted === 'incremental' && owner ? 'incremental' : 'full';
    if (wanted === 'incremental' && !owner) {
      logs.push(
        `"${node.name}" asks to read incrementally but is configured inline, so it has nowhere to keep a watermark and read everything instead.`,
      );
    }

    const fetcher = SOURCES[connector.kind];
    if (!fetcher) {
      throw new BadRequestException(
        `Source "${node.name}" is a ${connector.kind} source and there is no fetcher for that kind. The kind list and the fetcher map are meant to move together.`,
      );
    }

    // Buffered, and it stays buffered. A source node stages its whole output
    // before any downstream node reads a row of it — `stage` below is one write
    // of `rows` — so a streamed read would arrive here and be turned back into an
    // array a few lines later with nothing gained. The single-connector runner is
    // where streaming pays, because there the next node IS the batch write. If
    // this ever stages incrementally, this is the line to change.
    const result: FetchResult = await toBufferedFetchResult(
      await fetcher({
        connector,
        secret: resolveSecret(connector),
        state: state.committed,
        mode,
      }),
    );

    // Records that are not objects cannot be staged as rows, and dropping them
    // silently is how a load comes out short with nothing to explain it. The
    // single-transform runner applies the same filter for the same reason.
    const rows = result.records.filter(isRowRecord);
    const dropped = result.records.length - rows.length;
    logs.push(
      `Fetched ${result.records.length} records from ${connector.kind}${
        dropped > 0 ? `, ${dropped} of which were not objects and were dropped` : ''
      }.`,
    );
    // Emphatically not an error. A source with nothing to read is an ordinary
    // outcome — the sink decides what to do about a load that produced nothing,
    // because the sink is the only node that can see the whole graph's output.
    if (rows.length === 0) {
      logs.push(`"${node.name}" read nothing this run.`);
    }

    const output = await this.stage(input.runId, node.id, rows, logs);

    // Written as *pending*, never as the watermark itself. Advancing it here
    // would promise never to read those records again on behalf of a run that
    // has not committed anything yet, and a failure at the next node would then
    // skip data nobody stored. The sink promotes it, after the commit.
    if (result.state && owner) {
      await this.requireStore().saveConnectorState(owner.id, {
        ...(owner.state ?? {}),
        [node.id]: { ...state.raw, pending: result.state },
      });
      logs.push(
        `Staged a new watermark for "${node.name}" (${Object.keys(result.state).join(', ')}); it is promoted only if this run commits.`,
      );
    }

    return {
      nodeId: node.id,
      output,
      rows: rows.length,
      elapsedMs: Date.now() - startedAt,
      logs: safeLogLines(logs, LOG_LINES_PER_NODE),
    };
  }

  private async runTransform(
    node: WorkflowTransformNode,
    workflow: CatalogWorkflow,
    input: WorkflowNodeStepInput,
    startedAt: number,
  ): Promise<WorkflowNodeStepOutput> {
    const logs: string[] = [];
    const transform = await this.requireStore().getTransform(node.transformId);
    if (!transform) {
      throw new NotFoundException(
        `Node "${node.name}" runs transform ${node.transformId}, which is gone. A node pointing at code that no longer exists must fail rather than pass its input through under a shape nobody chose.`,
      );
    }

    // Everything at once, because that is the transform contract: the code is a
    // function over a batch of records precisely so that it can deduplicate,
    // aggregate and join, none of which can be done a row at a time. The whole
    // of a node's input is therefore in this process's heap while it runs —
    // the same property the single-transform runner has always had.
    const records = await this.readInputs(input.inputs);

    // Resolved here, in the step, rather than anywhere the workflow body could
    // reach. `env` and `environment` are the only two reads in the context that
    // could answer differently after a redeploy, and inside a step they are
    // covered by the step's own checkpoint: a replay returns the recorded
    // output and never re-runs the code. See `code-context.ts` on why a
    // predicate evaluated in a body does not get that for free.
    const admitted = allowlistedCodeEnv();
    logs.push(...admitted.notes);

    const result = await this.transforms.run(transform, records, {
      context: codeContext({
        runId: input.runId,
        workflow: { id: workflow.id, name: workflow.name, version: input.workflowVersion },
        node: { id: node.id, name: node.name },
        environment: namedEnvironment(this.environmentName),
        rowCount: records.length,
        // The step's own input, which is the graph's inbound edges in order —
        // the same handles the call node hands a callee, and the same ones a
        // conditional's predicate will read to ask whether anything arrived.
        inputs: input.inputs,
        env: admitted.env,
      }),
    });
    logs.push(
      `Transform "${transform.name}" v${transform.version} turned ${records.length} records into ${result.rows.length} rows in ${result.elapsedMs}ms.`,
      ...result.logs,
    );

    const output = await this.stage(input.runId, node.id, result.rows, logs);
    return {
      nodeId: node.id,
      output,
      transformVersion: transform.version,
      rows: result.rows.length,
      elapsedMs: Date.now() - startedAt,
      logs: safeLogLines(logs, LOG_LINES_PER_NODE),
    };
  }

  /**
   * Decide which branch runs, once, and hand the rows straight on.
   *
   * ## Three things it deliberately does not do
   *
   * It does not **read the rows**. The output it returns is the ref of the stage
   * its input already occupies, so a gate costs no copy of the dataset and the
   * successors on the taken branch read the upstream node's batches directly.
   * (`validateWorkflow` guarantees exactly one inbound edge; the empty ref below
   * is for a graph that reached here without one, which would be a bug in the
   * validator rather than a shape to support.)
   *
   * It does not **skip anything itself**. Which nodes are skipped is decided by
   * the two loops that walk the plan, from the branch recorded here, using one
   * shared rule (`workflowNodeRuns`). A node that also worked out the skip set
   * would be a second implementation of it, and the two would eventually
   * disagree about a diamond.
   *
   * It does not **re-decide on a replay**. This method is only ever reached
   * inside a durable step or inline, and a durable step's output is
   * checkpointed: a resumed run reads the branch back out of its own history and
   * never arrives here again. That is what makes it safe for the predicate to
   * read something as pod-local as an environment variable.
   *
   * ## The seam
   *
   * `readPredicateEnv` is the single point where this node touches the
   * environment. A richer context for code-bearing nodes — an allow-list, a
   * `catalog` object — is being built elsewhere; when it lands, that function is
   * what it replaces, and everything else here is unaffected because the
   * decision is recorded rather than recomputed.
   */
  private async runIf(
    node: WorkflowIfNode,
    input: WorkflowNodeStepInput,
    startedAt: number,
  ): Promise<WorkflowNodeStepOutput> {
    const name = node.envVar.trim();
    if (name.length === 0) {
      // A graph that validated cannot reach this, so reaching it means the
      // graph was edited under the run or stored by something that skipped the
      // validator. Guessing a branch would be a decision nobody authored.
      throw new BadRequestException(
        `If node "${node.name}" (${node.id}) names no environment variable, so there is nothing for it to decide on and no honest branch to take.`,
      );
    }

    const value = readPredicateEnv(name);
    const matched =
      node.equals === undefined ? value !== undefined && value.length > 0 : value === node.equals;
    const branch: WorkflowBranchLabel = matched ? 'then' : 'else';

    // Says what was tested and what was found, and never the value itself: a
    // variable holding a ClickHouse URL holds a password, and a run log is read
    // at `catalog:read`. "set" and "not set" is the whole of what decided this.
    const tested =
      node.equals === undefined
        ? `${name} is ${value !== undefined && value.length > 0 ? 'set' : 'not set'}`
        : `${name} ${value === node.equals ? 'matches' : 'does not match'} the expected value`;
    const passed = input.inputs[0];

    return {
      nodeId: node.id,
      // The input's ref, unchanged. Its `nodeId` names the upstream node, which
      // is where the rows actually are — this node stages nothing.
      output: passed ?? { runId: input.runId, nodeId: node.id, batches: 0, rowCount: 0 },
      branch,
      rows: passed?.rowCount ?? 0,
      elapsedMs: Date.now() - startedAt,
      logs: safeLogLines(
        [
          `"${node.name}" checked the deployment: ${tested}, so the "${branch}" branch runs and everything reached only through "${matched ? 'else' : 'then'}" is skipped. This decision is recorded on the run and replayed rather than asked again.`,
        ],
        LOG_LINES_PER_NODE,
      ),
    };
  }

  /**
   * The only node that writes, and the only node that commits.
   *
   * It publishes through `appendRowsAsSystem` and `commitAsSystem` — the same
   * pair the single-transform connector uses, with the same numbered batches —
   * so a workflow run is a snapshot load like any other and there is one way
   * rows arrive rather than two to keep in agreement.
   */
  private async runSink(
    node: WorkflowSinkNode,
    workflow: CatalogWorkflow,
    input: WorkflowNodeStepInput,
    startedAt: number,
  ): Promise<WorkflowNodeStepOutput> {
    const logs: string[] = [];
    const store = this.requireStore();
    const labels = sinkLabels(workflow.name, input.expectShrink);
    if (labels[EXPECT_SHRINK_LABEL]) {
      // Said in the run's own log, because the label lives on the snapshot and
      // nobody reads a snapshot's labels while wondering why a load was allowed
      // through. Read back off the labels rather than off the input, so the line
      // and the snapshot cannot disagree about what was acknowledged.
      logs.push(
        `This load is allowed to lose rows: ${labels[EXPECT_SHRINK_LABEL]} — the row-count bound stands down for this snapshot only.`,
      );
    }
    const incremental = node.mode === 'incremental';

    // The batch number is a position in the ordered list of the stages this
    // node reads, and never a running count of the batches that had rows. That
    // makes it a pure function of `input.inputs`, which is checkpointed — so a
    // retried sink writes the *same* batch numbers over the same snapshot and
    // each one replaces itself, rather than shifting by one and leaving the
    // previous attempt's tail behind in the committed data.
    let batch = 0;
    let written = 0;
    for (const ref of input.inputs) {
      for (let number = 1; number <= ref.batches; number += 1) {
        batch += 1;
        const rows = await store.readStage({
          runId: input.runId,
          nodeId: ref.nodeId,
          batch: number,
        });
        if (rows.length === 0) continue;
        const result = await this.publish.appendRowsAsSystem(
          input.principalId,
          node.targetType,
          input.runId,
          rows,
          labels,
          batch,
        );
        written += result.written;
      }
    }

    // A full load that produced nothing must not commit. The snapshot model
    // repoints the live view at whatever was committed, so an empty full
    // snapshot deletes a good dataset — and the source being briefly empty, or
    // a transform quietly returning `[]`, is exactly how that happens. An
    // incremental load producing nothing is a different fact entirely: the
    // carry-forward below turns "nothing changed" into the complete dataset.
    if (written === 0 && !incremental) {
      throw new BadRequestException(
        `Nothing reached the sink "${node.name}", so there is nothing to commit for ${node.targetType}. Committing an empty snapshot would repoint the live view at no rows, so this run stops instead and leaves the previous snapshot serving.`,
      );
    }

    if (incremental) {
      // After the last batch and before the commit, exactly where the
      // single-transform runner puts it: the merge is decided against the rows
      // present when it runs, and the store refuses to commit a snapshot whose
      // batches arrived after its merge.
      const merged = await this.publish.carryForwardAsSystem(
        input.principalId,
        node.targetType,
        input.runId,
        labels,
      );
      logs.push(
        merged.from
          ? `Carried ${merged.carried} unchanged rows forward from snapshot ${merged.from}; ${merged.total} rows in this snapshot.`
          : `Nothing committed for ${node.targetType} yet, so this run stands as the whole dataset (${merged.total} rows).`,
      );
    }

    const ref = await this.publish.commitAsSystem(input.principalId, node.targetType, input.runId);
    logs.push(
      `Committed snapshot ${input.runId}: ${ref.rowCount} rows, ${written} of them from this run.`,
    );

    await this.promoteWatermarks(workflow, logs);

    return {
      nodeId: node.id,
      committed: { snapshotId: input.runId, rowCount: ref.rowCount },
      // What this node wrote, not what the snapshot holds. For an incremental
      // load the two differ by everything that did not change, and reporting
      // the dataset's size as the node's output would make a small delta look
      // like a full reload.
      rows: written,
      elapsedMs: Date.now() - startedAt,
      logs: safeLogLines(logs, LOG_LINES_PER_NODE),
    };
  }

  /* --- the pieces the three kinds share -------------------------------- */

  /**
   * Write a node's rows into the stage store, and clear whatever a longer
   * previous attempt left behind.
   *
   * The write itself is idempotent per `(runId, nodeId, batch)`, so a retried
   * node replaces its own batches rather than doubling them. What that does
   * *not* cover is a re-run that is **shorter** than the attempt before it — a
   * source that fetched ten batches and died, then fetched two — which leaves
   * batches three to ten sitting in the stage under this node's name. The
   * downstream node reads `1..batches` from the returned ref and would not see
   * them, so this is not a wrong answer today; it is orphaned data that the
   * next thing to read a stage by iteration would silently include. The
   * warehouse store hit the same shape in `carryForward` and answers it the
   * same way: delete unconditionally before writing, so a second call replaces
   * rather than adds.
   *
   * The tail is emptied rather than deleted because {@link CatalogStageStore}
   * has no per-batch delete — `dropStages` takes a whole run, and calling it
   * here would delete this attempt's own work along with the previous one's.
   * An emptied batch costs one row holding `[]` until the run's stages are
   * dropped, which is the cheapest honest thing available.
   */
  private async stage(
    runId: string,
    nodeId: string,
    rows: Array<Record<string, unknown>>,
    logs: string[],
  ): Promise<WorkflowStageRef> {
    const store = this.requireStore();
    let batches = 0;
    for (let index = 0; index < rows.length; index += BATCH_SIZE) {
      batches += 1;
      await store.writeStage({
        runId,
        nodeId,
        batch: batches,
        rows: rows.slice(index, index + BATCH_SIZE),
      });
    }

    let cleared = 0;
    for (let batch = batches + 1; batch <= batches + STALE_TAIL_LIMIT; batch += 1) {
      const stale = await store.readStage({ runId, nodeId, batch });
      if (stale.length === 0) break;
      await store.writeStage({ runId, nodeId, batch, rows: [] });
      cleared += 1;
    }
    if (cleared > 0) {
      logs.push(
        `Cleared ${cleared} stale staged batches left by an earlier, longer attempt at this node.`,
      );
    }

    return { runId, nodeId, batches, rowCount: rows.length };
  }

  /**
   * Read a node's inputs, concatenated **in edge order**.
   *
   * The order comes from `input.inputs`, which the plan built from the graph's
   * edge array, and not from the iteration order of anything keyed by node id.
   * That order is what a merge sees, it is part of the graph fingerprint, and
   * getting it from a `Map` would make what a join produces depend on insertion
   * order rather than on what somebody drew.
   */
  private async readInputs(inputs: WorkflowStageRef[]): Promise<Array<Record<string, unknown>>> {
    const store = this.requireStore();
    const records: Array<Record<string, unknown>> = [];
    for (const ref of inputs) {
      for (let batch = 1; batch <= ref.batches; batch += 1) {
        records.push(
          ...(await store.readStage({
            runId: ref.runId,
            nodeId: ref.nodeId,
            batch,
          })),
        );
      }
    }
    return records;
  }

  /**
   * What a source node actually reads through.
   *
   * A node may name a connector, in which case the connector is the authority
   * for the address and the credential and is resolved *now* rather than at the
   * time the graph was drawn — the same rule `applyConnection` follows for a
   * named connection, and for the same reason: an edited connector has to take
   * effect on the next run, which is the whole point of naming it once. The
   * node's own config still wins key by key, so a graph can narrow one
   * connector's query without a second connector to manage.
   *
   * A node that names nothing carries its own configuration, and the value
   * built here is a plain description of a source rather than a row that
   * exists: the fetchers take a connector shape, and inventing one is cheaper
   * than a second fetcher interface that means the same thing.
   *
   * **Public, because schema discovery resolves through it too.** That is not
   * convenience — it is the property `schema-discovery.ts` claims in its own
   * docblock and could not previously keep: "the read is the same read a run
   * does, through the same fetcher". A second resolution written for the
   * discovery route would fold a connection in slightly differently the first
   * time either side was edited, and the symptom would be a discovery that
   * described a source the load never touches. One method, both callers.
   */
  async resolveSourceNode(
    node: WorkflowSourceNode,
  ): Promise<{ connector: CatalogConnector; owner?: CatalogConnector }> {
    const store = this.requireStore();
    const named = node.config.connectorId;
    const now = new Date().toISOString();

    if (typeof named === 'string' && named.length > 0) {
      const owner = await store.getConnector(named);
      if (!owner) {
        throw new NotFoundException(
          `Source "${node.name}" reads through connector ${named}, which no longer exists. Point it at one that does rather than letting it load from a half-configured source.`,
        );
      }
      const connection = owner.connectionId
        ? await store.getConnection(owner.connectionId)
        : undefined;
      if (owner.connectionId && !connection) {
        throw new NotFoundException(
          `Connector "${owner.name}" reads through a connection that no longer exists (${owner.connectionId}).`,
        );
      }
      const resolved = applyConnection(owner, connection);
      const { connectorId: _ignored, ...overrides } = node.config;
      return {
        connector: {
          ...resolved,
          config: { ...resolved.config, ...overrides },
          secretEnvVar: node.secretEnvVar ?? resolved.secretEnvVar,
        },
        owner,
      };
    }

    const connection = node.connectionId ? await store.getConnection(node.connectionId) : undefined;
    if (node.connectionId && !connection) {
      throw new NotFoundException(
        `Source "${node.name}" reads through a connection that no longer exists (${node.connectionId}).`,
      );
    }
    const inline: CatalogConnector = {
      id: node.id,
      name: node.name,
      kind: node.sourceKind,
      targetType: '',
      config: node.config,
      connectionId: node.connectionId,
      secretEnvVar: node.secretEnvVar,
      mode: node.mode,
      enabled: true,
      createdBy: 'workflow',
      createdAt: now,
      updatedAt: now,
    };
    return { connector: applyConnection(inline, connection) };
  }

  /**
   * Turn every source node's pending watermark into its committed one.
   *
   * After the commit and nowhere else. A watermark is a promise never to read
   * those records again, and a promise made by a run that had not yet committed
   * is how the next run starts after data nobody stored.
   */
  private async promoteWatermarks(workflow: CatalogWorkflow, logs: string[]): Promise<void> {
    const store = this.requireStore();
    for (const node of workflow.nodes) {
      if (node.kind !== 'source') continue;
      const named = node.config.connectorId;
      if (typeof named !== 'string' || named.length === 0) continue;
      const owner = await store.getConnector(named);
      if (!owner) continue;
      const state = nodeState(owner, node.id);
      if (!state.pending) continue;
      await store.saveConnectorState(owner.id, {
        ...(owner.state ?? {}),
        [node.id]: { committed: state.pending },
      });
      logs.push(
        `Advanced the watermark for "${node.name}": ${Object.keys(state.pending).join(', ')}.`,
      );
    }
  }
}

/**
 * The graph, flattened into the plan both executors iterate.
 *
 * One derivation, two callers, for the reason the docblock on
 * {@link WorkflowRunnerService} gives about node execution: the durable path
 * checkpoints this and the inline path holds it in memory, and two mappings of a
 * graph into a plan would let the same workflow run in a different order, or
 * skip a different set of nodes, depending on whether a Redis was reachable.
 *
 * `workflowRunOrder` rather than a traversal here: it enforces the same wiring
 * rules `validateWorkflow` does, and two implementations of one rule is how a
 * graph that validated comes out executing differently.
 */
export function workflowPlanEntries(workflow: CatalogWorkflow): WorkflowPlanEntry[] {
  return workflowRunOrder(workflow).map((entry) => ({
    nodeId: entry.node.id,
    name: entry.node.name,
    kind: entry.node.kind,
    inputs: entry.inputs,
    inputBranches: entry.inputBranches,
    commits: entry.node.kind === 'sink' ? entry.node.targetType : undefined,
    call:
      entry.node.kind === 'call'
        ? {
            name: entry.node.callName,
            version: entry.node.callVersion,
            config: entry.node.config,
          }
        : undefined,
  }));
}

/**
 * The refs a node reads, in the order its inbound edges appear.
 *
 * A node whose upstream produced nothing gets an empty ref rather than being
 * left out, so the positions a merge sees stay aligned with the edges that were
 * drawn — dropping it would silently shift every later input by one.
 */
export function stageRefsFor(
  inputs: string[],
  stages: Map<string, WorkflowStageRef>,
  runId: string,
): WorkflowStageRef[] {
  return inputs.map((nodeId) => stages.get(nodeId) ?? { runId, nodeId, batches: 0, rowCount: 0 });
}

/**
 * What an `if` node's predicate reads, and the one impure read in the branch.
 *
 * One function, one line, and a name worth grepping for, because this is the
 * only place in the workflow runner that consults the process environment on
 * behalf of something an author typed.
 *
 * ## Where it is called from, which is the whole safety argument
 *
 * From `runIf`, and `runIf` is only ever reached from `executeNode` — which the
 * durable path calls **inside a step** (`WorkflowRunSteps.runNode`) and the
 * inline path calls in one process with no replay to worry about. A step's
 * output is checkpointed, so the branch this decides is written into the run's
 * history once and handed back verbatim on every later turn. The workflow body
 * never calls this and never evaluates a predicate: it reads
 * `progress.outcomes[...].branch`, which came off that checkpoint. A body that
 * asked the environment itself would be a body whose control flow depends on
 * which pod it woke up on, and the engine would report it as non-determinism
 * two nodes later, naming neither the branch nor the variable.
 *
 * ## Why this does *not* go through the code allow-list
 *
 * `@dudousxd/nestjs-catalog`'s `CatalogCodeContext` bounds what **user code**
 * may see, with an allow-list that admits nothing by default. A predicate is not
 * user code, and routing it through that list would be worse rather than safer:
 * branching on whether a ClickHouse exists means testing the variable that holds
 * its URL, and that URL holds a password — so allow-listing it would put a
 * credential in reach of every transform in the deployment in order to answer a
 * yes/no question that never needed the value at all.
 *
 * What is true instead, and is what makes that defensible: the value never
 * leaves this module. `runIf` reduces it to "set"/"not set" or "matches"/"does
 * not match" and records only that, so nothing derived from a credential reaches
 * a run log, a checkpoint, or the run panel. A predicate has strictly less reach
 * than a transform, and is bounded by construction rather than by a list.
 *
 * When a `code` predicate is eventually wanted — a real one, running user code —
 * it is a second shape on `WorkflowIfNode` and it *does* belong under the
 * allow-list, resolved into a `CatalogCodeContext` inside this same step so the
 * checkpoint carries it. Nothing about how a branch is recorded, propagated or
 * replayed would change, because none of that reads the predicate.
 */
function readPredicateEnv(name: string): string | undefined {
  return process.env[name];
}

/**
 * Why this node is being skipped, in words, for the run's log.
 *
 * Derived from the recorded outcomes rather than from the graph, so it says what
 * actually happened on *this* run — and so it stays available on the durable
 * path, where the body has the plan and the outcomes and no graph at all.
 *
 * It names the gate whose decision cut this node off. With several gates it
 * names the first one found among this node's own feeders, which is the nearest
 * one and therefore the one somebody would look at first; a chain of them still
 * leads there one hop at a time. Falling back to a plain sentence rather than to
 * nothing: a node can also be cut off by a feeder that was itself skipped, and
 * "an earlier branch" is the honest description of that.
 */
function branchSkipReason(
  entry: WorkflowPlanEntry,
  order: readonly WorkflowPlanEntry[],
  outcomes: Readonly<Record<string, WorkflowNodeOutcome>>,
): string {
  for (const from of entry.inputs) {
    const label = entry.inputBranches?.[from];
    const upstream = outcomes[from];
    if (label === undefined || upstream?.status !== 'succeeded') continue;
    if (upstream.branch === label) continue;
    const gate = order.find((candidate) => candidate.nodeId === from);
    return `"${gate?.name ?? from}" took its "${upstream.branch}" branch, and this is on its "${label}" branch`;
  }
  return 'nothing on a branch that ran feeds it';
}

/** A fresh snapshot id for a run nobody supplied one for. */
export function newSnapshotId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/**
 * Whether a fetched record can be stored as a row.
 *
 * A predicate rather than a cast: these values came out of a source or out of
 * user code and can be anything at all, and an array stored as a row produces
 * columns named after its indices.
 */
function isRowRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One node's slice of a connector's state, narrowed rather than trusted. */
function nodeState(
  connector: CatalogConnector | undefined,
  nodeId: string,
): {
  raw: Record<string, unknown>;
  committed: Record<string, unknown>;
  pending?: Record<string, unknown>;
} {
  const slice = connector?.state?.[nodeId];
  if (typeof slice !== 'object' || slice === null || Array.isArray(slice)) {
    return { raw: {}, committed: {} };
  }
  const raw: Record<string, unknown> = { ...slice };
  const committed = raw.committed;
  const pending = raw.pending;
  return {
    raw,
    committed: isRowRecord(committed) ? committed : {},
    pending: isRowRecord(pending) ? pending : undefined,
  };
}

/**
 * Every node outcome with its `error` redacted, and every other field untouched.
 *
 * Rebuilt rather than mutated, because `input.nodeOutcomes` on the durable path
 * is the object the finish step was handed as its checkpointed input — editing
 * it in place would edit what a replay reads back, so a second attempt would
 * redact an already-redacted string and, more to the point, the step's recorded
 * input would stop matching what the engine actually delivered.
 *
 * The counters and the status are left alone deliberately: they are the part of
 * a failed node an operator reads first, and there is no credential in a row
 * count.
 */
function redactOutcomes(
  outcomes: Record<string, WorkflowNodeOutcome>,
): Record<string, WorkflowNodeOutcome> {
  const redacted: Record<string, WorkflowNodeOutcome> = {};
  for (const [nodeId, outcome] of Object.entries(outcomes)) {
    redacted[nodeId] =
      outcome.error === undefined ? outcome : { ...outcome, error: redactSecrets(outcome.error) };
  }
  return redacted;
}

/**
 * What every write of one sink is labelled with.
 *
 * The sibling of `labelsFor` in `connector-runner.service.ts`, and it refuses a
 * blank reason for exactly the same reason that one does: the reason is the
 * whole value of the acknowledgement — it is stored in the snapshot's labels and
 * is the only answer anybody has in six months to "why was this load allowed to
 * lose most of the data?".
 *
 * Built once per sink and used by both writes in it — the batches and the
 * incremental carry-forward — because the store creates the snapshot row from
 * whichever reaches it first. An acknowledgement attached to only one of them
 * would land or not depending on whether this run happened to stage any rows,
 * which is precisely the intermittent failure the connector runner's version
 * documents.
 *
 * `BadRequestException` rather than a refusal further out, and here rather than
 * only at the route, because this method is reached from the durable step as
 * well as from the controller: a rule that lived in one of them would be a rule
 * the other does not have.
 */
function sinkLabels(workflowName: string, expectShrink?: string): Record<string, string> {
  const labels: Record<string, string> = { source: 'workflow', workflow: workflowName };
  if (expectShrink === undefined) return labels;

  const because = expectShrink.trim();
  if (because.length === 0) {
    throw new BadRequestException(
      `This run of "${workflowName}" was told to expect a shrink and given no reason for it. The reason is what makes the acknowledgement worth anything: it is stored in the snapshot's labels and is the only answer anybody will have in six months to "why was this load allowed to lose most of the data?". Say what happened at the source — a truncation, a migration, a base being cut — or drop the acknowledgement and let the bound decide.`,
    );
  }
  labels[EXPECT_SHRINK_LABEL] = because;
  return labels;
}

/**
 * When a run recorded its outcome, as something two rows can be compared on.
 *
 * A run with no `finishedAt` has not recorded one, and falling back to
 * `startedAt` would let an attempt that is merely *older* outrank the one that
 * actually finished last. `-Infinity` says "this never finished" and loses to
 * anything that did, which is what {@link WorkflowRunnerService.findRun} is
 * asking. An unparseable timestamp goes the same way rather than becoming
 * `NaN`, which loses every comparison it appears in and would make the answer
 * depend on the order the rows arrived.
 */
function finishedOrder(run: ConnectorRun): number {
  if (run.finishedAt === undefined) return Number.NEGATIVE_INFINITY;
  const at = Date.parse(run.finishedAt);
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function say(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
