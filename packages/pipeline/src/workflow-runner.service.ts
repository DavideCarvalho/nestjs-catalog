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
  type WorkflowExecutionMode,
  type WorkflowNodeKind,
  type WorkflowNodeOutcome,
  type WorkflowNodeStepInput,
  type WorkflowNodeStepOutput,
  type WorkflowSinkNode,
  type WorkflowSourceNode,
  type WorkflowStageRef,
  type WorkflowTransformNode,
  emitCatalog,
  supportsWorkflowStages,
  supportsWorkflows,
  workflowRunOrder,
} from '@dudousxd/nestjs-catalog';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
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
}

/** What the planning step hands the durable workflow body. Ids and counters. */
export interface WorkflowPlanResult {
  /** The `catalog_connector_run` row this execution reports into. */
  runRowId: string;
  workflowVersion: number;
  /** The type the sink commits, for the run's own events and logging. */
  targetType: string;
  order: WorkflowPlanEntry[];
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
   * Idempotent by `(connectorId, snapshotId)`, because this is the first thing
   * a durable run does and a durable step that fails *after* its side effect
   * is retried: without the check, a planning step that opened a row and then
   * lost its result would leave one abandoned `running` row per attempt, and
   * the run list would report a load that never happened.
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

    const run = await this.beginRun({
      workflow,
      connectorId: input.connectorId,
      principalId: input.principalId,
      snapshotId: input.snapshotId,
      mode: input.mode,
    });

    return {
      runRowId: run.id,
      workflowVersion: workflow.version,
      targetType: workflow.targetType,
      // `workflowRunOrder` rather than a second traversal here: it enforces the
      // same wiring rules `validateWorkflow` does, and two implementations of
      // one rule is how a graph that validated comes out executing differently.
      order: workflowRunOrder(workflow).map((entry) => ({
        nodeId: entry.node.id,
        name: entry.node.name,
        kind: entry.node.kind,
        inputs: entry.inputs,
      })),
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
      return this.runTransform(node, input, startedAt);
    }
    return this.runSink(node, workflow, input, startedAt);
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
  }): Promise<ConnectorRun> {
    const { workflow, connectorId, principalId, snapshotId } = input;
    const order = workflowRunOrder(workflow);
    const run = await this.beginRun({
      workflow,
      connectorId,
      principalId,
      snapshotId,
      mode: 'inline',
    });

    const progress: NodeProgress = {
      outcomes: {},
      stages: new Map(),
      logs: [],
      fetched: 0,
      written: 0,
    };

    for (let index = 0; index < order.length; index += 1) {
      const entry = order[index];
      try {
        const output = await this.executeNode({
          workflowId: workflow.id,
          workflowVersion: workflow.version,
          runId: snapshotId,
          nodeId: entry.node.id,
          principalId,
          inputs: stageRefsFor(entry.inputs, progress.stages, snapshotId),
        });
        this.record(progress, entry.node, output);
      } catch (error) {
        const message = say(error);
        this.recordFailure(progress, entry.node.id, message);
        for (const later of order.slice(index + 1)) {
          // `skipped`, not `failed`. Without the distinction a ten-node graph
          // that died at node seven records three nodes with no entry at all,
          // which reads exactly like three nodes nobody has looked at yet.
          progress.outcomes[later.node.id] = { status: 'skipped', rows: 0 };
        }
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
          error: `Node "${entry.node.name}" (${entry.node.id}) failed: ${message}`,
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
    if (node.kind === 'source') progress.fetched += output.rows;
    if (output.committed) progress.written = output.rows;
  }

  recordFailure(progress: NodeProgress, nodeId: string, error: string): void {
    progress.outcomes[nodeId] = { status: 'failed', rows: 0, error };
  }

  emptyProgress(): NodeProgress {
    return {
      outcomes: {},
      stages: new Map(),
      logs: [],
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

  /** The run row for a snapshot, if this connector already has one. */
  async findRun(connectorId: string, snapshotId: string): Promise<ConnectorRun | undefined> {
    const runs = await this.requireStore().listRuns(connectorId, 50);
    return runs.find((run) => run.snapshotId === snapshotId);
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

  private async beginRun(input: {
    workflow: CatalogWorkflow;
    connectorId: string;
    principalId: string;
    snapshotId: string;
    mode: WorkflowExecutionMode;
  }): Promise<ConnectorRun> {
    const store = this.requireStore();
    const existing = await this.findRun(input.connectorId, input.snapshotId);
    if (existing) return existing;

    // Best effort, and before the run rather than after: the sweep reads and
    // writes the same store the run is about to use, and doing it at the end
    // would mean a run that crashed never cleaned anything up.
    await this.sweepAbandonedStages(input.connectorId, input.snapshotId);

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

    return run;
  }

  /**
   * Collect the staged rows of runs nobody is going to resume.
   *
   * Bounded on both axes — the last fifty runs of this connector, and only
   * those that failed longer ago than the retention window — so it costs one
   * query and cannot turn a load into a table scan. Failures inside it are
   * swallowed deliberately: a housekeeping problem must never be the reason a
   * load did not happen.
   */
  private async sweepAbandonedStages(connectorId: string, keepSnapshotId: string): Promise<void> {
    try {
      const store = this.requireStore();
      const cutoff = Date.now() - STAGE_RETENTION_MS;
      const runs = await store.listRuns(connectorId, 50);
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
    const { connector, owner } = await this.sourceConnector(node);

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
    const result = await this.transforms.run(transform, records);
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
    const labels = { source: 'workflow', workflow: workflow.name };
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
   */
  private async sourceConnector(
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

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function say(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
