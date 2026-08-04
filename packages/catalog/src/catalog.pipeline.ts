/**
 * Getting data in: where it comes from, and what turns it into rows.
 *
 * The shape NiFi and Airflow both settle on — a source, a transform, a sink —
 * with the sink fixed, because the sink is the whole point of a catalog. What
 * is deliberately *not* here is a scheduler: the durable engine already
 * schedules, retries and checkpoints, and writing a second one would mean two
 * systems each believing they decide when a load runs.
 */

/**
 * Where a connector pulls from.
 *
 * Deliberately a short list. Every kind here is one this service can actually
 * execute — a kind that exists in the type and throws at run time is worse than
 * one that is absent, because the first looks supported in a dropdown.
 */
export const CONNECTOR_KINDS = [
  /** A JSON endpoint. */
  'http',
  /** A SQL database, by connection URL. Read-only by construction. */
  'sql',
  /** A file: local path, or anything `fetch` can GET — CSV, NDJSON, JSON. */
  'file',
  /** An object store bucket and prefix — S3, MinIO, anything S3-compatible. */
  's3',
  /** Records pasted into the config. For trying a transform against real shapes. */
  'inline',
] as const;

export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

/**
 * The type is derived from the list, not written beside it.
 *
 * A second hand-maintained copy of these names is the bug this shape exists to
 * prevent: a store that narrows a database string against its own stale array
 * and falls back to a default turns "the kind you chose" into "the kind that
 * happened to be first", and the resulting failure names the wrong source
 * entirely. Anything narrowing a stored value narrows against *this*.
 */
export function isConnectorKind(value: unknown): value is ConnectorKind {
  return CONNECTOR_KINDS.some((kind) => kind === value);
}

export interface CatalogConnector {
  id: string;
  name: string;
  description?: string;
  kind: ConnectorKind;
  /** Which object type its records become. */
  targetType: string;
  /**
   * Source configuration. Never credentials — those are referenced by the name
   * of an environment variable, so the catalog stores the *name* of a secret
   * and never the secret.
   */
  config: Record<string, unknown>;
  /**
   * The named connection this reads through, if it uses one.
   *
   * When set, the connection supplies the address and the credential and the
   * connector's own `config` carries only what is specific to this load — the
   * query, the prefix, the path. Inline configuration stays supported because a
   * one-off source does not deserve a second object to manage.
   */
  connectionId?: string;
  /** Env var holding the credential, if the source needs one. */
  secretEnvVar?: string;
  /** The transform that turns source records into rows of `targetType`. */
  transformId?: string;
  /**
   * The workflow that turns source records into rows of `targetType`, when one
   * transform is not enough.
   *
   * Mutually exclusive with {@link transformId}, and the store refuses a
   * connector that sets both: two answers to "what shapes this data" means the
   * runner picks one, and which one it picked is invisible until the load comes
   * out wrong. A connector with a `transformId` and no `workflowId` behaves
   * exactly as it did before workflows existed.
   *
   * When this is set, the connector's own `kind`, `config`, `connectionId` and
   * `secretEnvVar` are **not read**: the workflow's source nodes say where the
   * data comes from, and letting the connector also say would be two authorities
   * for one question. `targetType` stays meaningful and is kept equal to the
   * workflow's sink type by {@link CatalogPipelineStore.saveConnector}, so every
   * existing "which connectors write this type" answer keeps working.
   *
   * `state` keeps its meaning too, but is keyed by node id when a workflow runs:
   * a graph with two sources has two watermarks, and one flat blob would let
   * them overwrite each other.
   */
  workflowId?: string;
  /** Cron-ish, interpreted by whatever schedules it. Empty means manual only. */
  schedule?: string;
  /**
   * Whether a run replaces the dataset or adds to it.
   *
   * `full` is the default and the one the snapshot model is shaped for: a run
   * reads everything, writes a complete snapshot, and the commit repoints the
   * view atomically. `incremental` reads only what changed since the last run
   * and carries the rest forward, which is cheaper but needs the source to
   * offer a watermark and the type to have a primary key to merge on.
   *
   * **`incremental` is blind to deletes, and that is structural rather than a
   * gap in any particular fetcher.** A run asks its source for what changed
   * since a watermark; a row physically removed from the source never changes
   * again, so it is never returned again, so the carry-forward copies it into
   * every subsequent snapshot indefinitely. Nothing goes wrong at any single
   * step — the catalog simply never finds out, and every count and dashboard
   * built on the type is quietly wrong from then on.
   *
   * Because that failure is silent, the pipeline **refuses an incremental load
   * of a type for which no reconciliation strategy has been declared**: a full
   * read on an interval, a source that soft-deletes where the watermark can see
   * it, or an explicit "stale rows are acceptable here, because …". The
   * declaration is per object type and lives in the host's
   * `CATALOG_LOAD_EXPECTATIONS` (see `load-expectations.ts` in
   * `@dudousxd/nestjs-catalog-pipeline`), because it is a statement about the
   * data rather than about the connector reading it — the same type loaded by a
   * workflow sink or by an application POSTing to the publish API has exactly
   * the same problem.
   */
  mode?: 'full' | 'incremental';
  /**
   * Where the last run got to. Written by the runner, never by a person.
   *
   * Separate from `config` on purpose: config is authored and reviewed, state
   * is a consequence. Mixing them means a person editing a connector can
   * silently rewind or skip data, and a diff of the config stops meaning what
   * somebody decided.
   */
  state?: Record<string, unknown>;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastRunStatus?: 'succeeded' | 'failed' | 'running';
}

/**
 * TypeScript is Node's own type stripping, so it costs no compiler and no build
 * step — and types are erased, never checked. A transform with a wrong type
 * still runs; the editor's try pane is what catches it.
 */
export const TRANSFORM_LANGUAGES = ['javascript', 'typescript', 'python'] as const;

export type TransformLanguage = (typeof TRANSFORM_LANGUAGES)[number];

/** Same reason as {@link isConnectorKind}: one list, no second copy to drift. */
export function isTransformLanguage(value: unknown): value is TransformLanguage {
  return TRANSFORM_LANGUAGES.some((language) => language === value);
}

/**
 * User code that maps a source record to a row.
 *
 * Versioned, because a load that produced surprising numbers is investigated
 * afterwards, and "which code ran" is the first question. Bumping the version
 * on every change costs a row and answers it.
 */
export interface CatalogTransform {
  id: string;
  name: string;
  description?: string;
  language: TransformLanguage;
  /**
   * The body of a function over one batch. It receives `records` and returns
   * the rows to store.
   *
   * A batch rather than a record at a time: a transform that needs to look up,
   * deduplicate or aggregate cannot do it one row at a time, and paying one
   * process spawn per record would make any real load unusable.
   */
  code: string;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface TransformResult {
  rows: Array<Record<string, unknown>>;
  /** Anything the code logged. Surfaced in the run, never in the rows. */
  logs: string[];
  elapsedMs: number;
}

/**
 * Runs user code.
 *
 * An interface because the isolation a deployment needs is a deployment
 * decision. The bundled runner spawns a child process with a timeout and no
 * inherited environment, which stops an accident — an infinite loop, a stray
 * `process.env.DATABASE_PASSWORD` — but it is **not a security boundary**
 * against code written to escape one. A catalog that accepts transforms from
 * people who are not already trusted with the database needs a container or a
 * sandboxed runtime, and this interface is where that gets plugged in.
 */
export interface TransformRunner {
  run(
    transform: Pick<CatalogTransform, 'language' | 'code'>,
    records: unknown[],
    options?: { timeoutMs?: number },
  ): Promise<TransformResult>;
  /** Languages this runner can actually execute in this environment. */
  available(): Promise<TransformLanguage[]>;
  /**
   * Python libraries importable here, if the runner can tell.
   *
   * Reported rather than assumed: "pandas is available" is a property of the
   * image, and a UI that promises it on an image without it turns a deployment
   * difference into a traceback the transform's author cannot act on.
   */
  pythonPackages?(): Promise<string[]>;
}

export const TRANSFORM_RUNNER = Symbol('TRANSFORM_RUNNER');

export interface ConnectorRun {
  id: string;
  connectorId: string;
  /** The snapshot this run wrote, which is also the durable run id. */
  snapshotId: string;
  principalId: string;
  status: 'running' | 'succeeded' | 'failed';
  fetched: number;
  written: number;
  logs: string[];
  error?: string;
  startedAt: string;
  finishedAt?: string;
  /** Which transform version ran, so a surprising load can be traced to code. */
  transformVersion?: number;

  /** Which workflow ran, when the connector delegated to one. */
  workflowId?: string;
  /**
   * Which *version* of it ran.
   *
   * The same question `transformVersion` answers, asked of the graph. A
   * workflow keeps only its latest shape — exactly as a transform keeps only
   * its latest code — so this number is what connects a run to the graph that
   * produced it, and the only way to know a graph has changed since.
   */
  workflowVersion?: number;
  /**
   * The fingerprint of the graph at that version.
   *
   * Recorded beside the version rather than instead of it, because a version
   * number is only unique within one catalog database. A workflow promoted from
   * dev to production carries its own numbering, so two runs in two
   * environments can both say "version 4" and mean different graphs; the hash
   * cannot. Cheap enough that not storing it would be the only reason to face
   * that question later with nothing to answer it.
   */
  graphHash?: string;
  /**
   * How this run actually executed — checkpointed per node, or not.
   *
   * A fact about what happened, not a setting. A deployment with
   * `CATALOG_DURABLE=off` still runs workflows; it simply restarts them from
   * the first node when they fail, and a run list that did not say so would let
   * an operator believe a ten-node graph resumed at node seven when it did not.
   */
  executionMode?: WorkflowExecutionMode;
  /**
   * What each node did, keyed by node id.
   *
   * One JSON column rather than a `failedNodeId` scalar plus a version map,
   * because both questions asked of a failed run — "where did it stop" and
   * "which code ran up to there" — are answered by the same per-node record,
   * and two half-answers can disagree. Bounded by the node count, never by the
   * row count: no rows are ever put in here.
   */
  nodeOutcomes?: Record<string, WorkflowNodeOutcome>;
}

/** What one node did during a run. Small by construction — counters, not rows. */
export interface WorkflowNodeOutcome {
  /**
   * `skipped` exists for the nodes downstream of a failure. Without it, a
   * ten-node graph that died at node seven records three nodes with no entry at
   * all, which reads the same as three nodes nobody has looked at yet.
   */
  status: 'succeeded' | 'failed' | 'skipped';
  /** Rows this node produced, or committed if it is the sink. */
  rows: number;
  /** For a transform node: which version of its code ran. */
  transformVersion?: number;
  elapsedMs?: number;
  error?: string;
}

/* ---------------------------------------------------------------------------
 * Workflows: a graph of steps that ends in exactly one commit.
 *
 * **Why "workflow" and not "flow".** `FlowView` in the React package is
 * deliberately *derived* lineage: it reconstructs who fed what from the audit
 * trail, on the argument that the graph is whatever the publishers actually
 * did, which is more truthful than a diagram someone has to remember to update.
 * This is the opposite object — authored by a person, executed as written, and
 * wrong the moment it disagrees with intent rather than with history. Sharing
 * the word would put a screen called "Flow" that infers and a screen called
 * "Flow" that declares next to each other in the same console, and the first
 * question every reader would ask is which one is real.
 *
 * "Workflow" is the word the rest of this ecosystem already uses for authored,
 * ordered, resumable work — `@dudousxd/nestjs-durable` calls its unit a
 * workflow and its parts steps — and that agreement is earned rather than
 * borrowed: when durable is available a catalog workflow *is* compiled into a
 * durable workflow, one step per node. "Pipeline" was the other candidate and
 * is already taken by this file's subject as a whole (`CatalogPipelineStore`
 * holds connectors, transforms and connections), so it would have named both
 * the container and one thing inside it.
 * ------------------------------------------------------------------------- */

/**
 * What a node can be.
 *
 * Three kinds, and they are exactly the three verbs the existing connector
 * runner already performs in sequence: fetch, transform, publish. Nothing here
 * is a kind this service cannot execute, which is the same rule
 * {@link CONNECTOR_KINDS} follows — a kind that exists in the type and throws
 * at run time is worse than one that is absent, because the first looks
 * supported in a palette.
 *
 * The kinds that were considered and rejected, since a small vocabulary is only
 * defensible if the omissions are:
 *
 * - **filter** — a transform whose code returns a subset of what it was given.
 *   It needs no new execution path, only a different body, and adding the kind
 *   would mean two ways to drop rows and two places to look when rows go
 *   missing.
 * - **branch / split** — already expressible: a node with two outbound edges is
 *   read by both successors, each of which filters differently. There is
 *   nothing for a branch node to *do*.
 * - **merge / join** — a node with several inbound edges receives its inputs
 *   concatenated in edge order (see {@link WorkflowEdge}). A keyed join is then
 *   ordinary code inside the transform, which can already see every record.
 *   A `merge` kind would have had to carry a strategy field whose values the
 *   runner would have to implement one by one, and an unimplemented strategy in
 *   a dropdown is the failure this list exists to avoid.
 */
export const WORKFLOW_NODE_KINDS = [
  /** Reads records out of a system. The roots of the graph. */
  'source',
  /** Runs a {@link CatalogTransform} over what it is given. */
  'transform',
  /** Writes into an object type and commits. Exactly one per workflow. */
  'sink',
] as const;

export type WorkflowNodeKind = (typeof WORKFLOW_NODE_KINDS)[number];

/** Same reason as {@link isConnectorKind}: one list, no second copy to drift. */
export function isWorkflowNodeKind(value: unknown): value is WorkflowNodeKind {
  return WORKFLOW_NODE_KINDS.some((kind) => kind === value);
}

/**
 * The longest a node id may be, and the alphabet it may use.
 *
 * Constrained rather than free-form for two concrete reasons. A node id becomes
 * the name of a durable step, and durable step names are how a replay finds the
 * checkpoint it already wrote — a step renamed between runs re-executes work
 * that was already done. And staged rows are addressed by a key built from the
 * run id, the node id and the batch number, so a node id containing the
 * separator would let one node read another's rows.
 */
export const WORKFLOW_NODE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

interface WorkflowNodeBase {
  /** Unique within the workflow. Also the durable step name. */
  id: string;
  /** What a person calls it. Cosmetic: changing it does not bump the version. */
  name: string;
  /**
   * Where the canvas drew it.
   *
   * Persisted even though it changes nothing about execution, because a layout
   * a person arranged and the server then forgot is a canvas that loses work.
   * Excluded from the graph fingerprint for the same reason a rename is: moving
   * a box is not a new version of the graph.
   */
  position?: { x: number; y: number };
}

/**
 * Reads records out of a system.
 *
 * Carries the same vocabulary a connector does — a kind, an optional named
 * connection, a config, the *name* of an env var holding the credential — and
 * for the same reason {@link CatalogConnection} does: a source and a connector
 * reaching the same system must agree about what they are talking to, and two
 * vocabularies would let them disagree. Credentials stay out of the catalog
 * here exactly as they do everywhere else.
 */
export interface WorkflowSourceNode extends WorkflowNodeBase {
  kind: 'source';
  /** Named `sourceKind` rather than `kind`, which the union already uses. */
  sourceKind: ConnectorKind;
  connectionId?: string;
  config: Record<string, unknown>;
  secretEnvVar?: string;
  /**
   * Whether this source reads everything or only what changed. Per node,
   * because a graph can perfectly well enrich a full pull against an
   * incrementally-read lookup table.
   */
  mode?: 'full' | 'incremental';
}

/** Runs user code over the rows its inbound edges carry. */
export interface WorkflowTransformNode extends WorkflowNodeBase {
  kind: 'transform';
  /**
   * The transform to run. A reference rather than inline code, so one piece of
   * logic used at three points in a graph is versioned once and fixed once.
   */
  transformId: string;
}

/**
 * Writes into an object type and commits.
 *
 * There is exactly one of these per workflow, and that is the load-bearing
 * decision of this whole model rather than a simplification. A workflow writing
 * both `Mvr` and `Subwo` makes "commit" ambiguous — both atomically, or one
 * succeeding while the other fails — which is the distributed-transaction
 * problem, and answering it is not something a catalog should take on to buy a
 * convenience that two workflows already provide. Branching inside the graph
 * stays fully supported; every path simply has to arrive here.
 */
export interface WorkflowSinkNode extends WorkflowNodeBase {
  kind: 'sink';
  /** Which object type the rows become. */
  targetType: string;
  /**
   * Whether the commit replaces the dataset or merges into it. Exactly the
   * meaning {@link CatalogConnector.mode} has, at the node that actually does
   * the committing.
   */
  mode?: 'full' | 'incremental';
}

/**
 * A discriminated union, so narrowing a node is `node.kind === "sink"` and
 * never a type assertion. This is why the kind list is not simply a string on
 * one node shape with every field optional: that shape lets a source node carry
 * a `transformId` and nothing catches it.
 */
export type WorkflowNode = WorkflowSourceNode | WorkflowTransformNode | WorkflowSinkNode;

/**
 * One wire.
 *
 * No id of its own: duplicate edges are refused, so `from` and `to` together
 * already identify a wire, and an id would be a second identity that a canvas
 * could let drift from the pair that actually matters.
 *
 * **Order is meaningful.** A node with several inbound edges receives its
 * inputs in the order those edges appear in {@link CatalogWorkflow.edges}, and
 * that order is what the transform sees. It is preserved rather than sorted, and
 * it is part of the graph fingerprint: swapping two inputs to a join changes
 * what the load produces, so it is a new version of the graph.
 */
export interface WorkflowEdge {
  from: string;
  to: string;
}

/** Just the executable part of a workflow, for validating a canvas draft. */
export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/**
 * An authored graph of steps ending in one commit.
 *
 * Versioned the way {@link CatalogTransform} is, and for the same question: a
 * load that produced surprising numbers is investigated afterwards, and "what
 * ran" is the first thing asked. For a single-transform connector that means
 * the code; for a workflow it means the code *and* the wiring, so both the
 * graph version and the per-node transform versions are recorded on the run.
 *
 * Like a transform, only the latest shape is kept. Storing every past graph was
 * the alternative and was rejected for consistency: transforms already answer
 * "which code ran" with a number and no history, and a model where the graph is
 * fully recoverable but the code inside it is not would give false confidence in
 * an audit. The limitation is real and worth stating plainly — an edited graph
 * cannot be reconstructed from an old run, only identified as different.
 */
export interface CatalogWorkflow {
  id: string;
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** Bumped whenever the graph's behaviour changes. Never on a rename or a move. */
  version: number;
  /** Fingerprint of the graph at this version. See {@link workflowGraphHash}. */
  graphHash: string;
  /**
   * The type the sink writes.
   *
   * Derived from the sink node and stored beside it anyway, which is normally a
   * smell. It is safe here precisely because validation guarantees exactly one
   * sink, so the two cannot disagree, and it buys the two things a JSON column
   * cannot: "which workflows write this type" as a query, and a cheap check when
   * a connector claims to write something else.
   */
  targetType: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * How a workflow run is executed here.
 *
 * `CATALOG_DURABLE` is `own`, `attach` or `off`, so a deployment may genuinely
 * have no engine, and the model must not pretend otherwise. A workflow that
 * appeared checkpointed and was not would be the same silent no-op this codebase
 * already had to remove once, when connectors carried a `schedule` field that
 * nothing read for months.
 */
export const WORKFLOW_EXECUTION_MODES = [
  /**
   * Each node is a durable step. A ten-node graph that fails at node seven
   * resumes at node seven, because the six before it have checkpoints.
   */
  'durable',
  /**
   * The whole graph runs inside one call. It still runs, and it still commits
   * atomically at the sink — but a failure at node seven re-runs node one.
   */
  'inline',
] as const;

export type WorkflowExecutionMode = (typeof WORKFLOW_EXECUTION_MODES)[number];

export function isWorkflowExecutionMode(value: unknown): value is WorkflowExecutionMode {
  return WORKFLOW_EXECUTION_MODES.some((mode) => mode === value);
}

/**
 * What this deployment can actually do with a workflow, in words a UI can print.
 *
 * Reported by the host rather than stored on the workflow, because it is a
 * property of the pods that are running, not of the graph: the same workflow is
 * checkpointed on a worker with `CATALOG_DURABLE=own` and not on an API pod with
 * it off. A console that says "resumes where it failed" on a deployment that
 * cannot is worse than one that says nothing.
 */
export interface CatalogWorkflowCapabilities {
  mode: WorkflowExecutionMode;
  /** Why. Something like `CATALOG_DURABLE=off on this pod, so runs restart.` */
  detail: string;
}

/**
 * A handle to rows a node produced. **This is the only thing that crosses a
 * step boundary.**
 *
 * Not a style preference — a measurement. `durable_step_checkpoints` persists
 * each step's input and output as JSON, so a node contract that passed rows
 * would write the entire intermediate dataset into the durable store once per
 * node, ten times over for a ten-node graph, and a replay would then read it all
 * back. The existing connector step already gets this right by returning
 * `{ runId, fetched, written }` — counters, not data — and this keeps that
 * property while adding chaining.
 *
 * Every field here is O(1) in the size of the dataset. There is deliberately no
 * column list, no sample and no schema: all three grow with the data or with the
 * source's shape, and all three are recoverable by reading the stage itself.
 *
 * The rows live in the stage store ({@link CatalogStageStore}), addressed by
 * `(runId, nodeId, batch)` — the same `(snapshot, batch)` addressing the
 * warehouse already uses, and idempotent for the same reason: a retried step
 * re-sends its batches and each one replaces itself rather than appending a
 * second copy.
 */
export interface WorkflowStageRef {
  runId: string;
  nodeId: string;
  /** Batches written, numbered 1..`batches`. Zero means the node produced nothing. */
  batches: number;
  rowCount: number;
}

/** What a node step receives. Ids and handles; never rows. */
export interface WorkflowNodeStepInput {
  workflowId: string;
  workflowVersion: number;
  /** The connector run this belongs to, which is also the snapshot id. */
  runId: string;
  nodeId: string;
  principalId: string;
  /**
   * The stages this node reads, in the order its inbound edges appear in the
   * graph. Empty for a source node, which reads from a system instead.
   */
  inputs: WorkflowStageRef[];
}

/** What a node step returns. Also ids and counters. */
export interface WorkflowNodeStepOutput {
  nodeId: string;
  /**
   * Where this node put its rows, for its successors to read. Absent on a sink,
   * which commits instead of staging.
   */
  output?: WorkflowStageRef;
  /** A sink's commit: the snapshot that became live, and its total row count. */
  committed?: { snapshotId: string; rowCount: number };
  /** Which transform version ran, for a transform node. */
  transformVersion?: number;
  rows: number;
  elapsedMs: number;
  /**
   * The one thing here that is not a counter, and the one exception worth
   * making: logs are what an operator reads when a node misbehaves, and a
   * checkpoint that dropped them would send them back to re-running the load to
   * find out what it said. Bounded on both axes — a caller must cap the count
   * and the line length before returning, the way the connector runner already
   * caps at fifty lines.
   */
  logs: string[];
}

/** Every way a graph can be refused. Exported so a canvas can key off the code. */
export const WORKFLOW_ISSUE_CODES = [
  'empty',
  'invalid-node-id',
  'duplicate-node-id',
  'edge-endpoint-missing',
  'self-edge',
  'duplicate-edge',
  'cycle',
  'no-source',
  'source-has-input',
  'no-sink',
  'duplicate-sink-type',
  'sink-has-output',
  'unreachable',
  'dead-end',
  'transform-not-named',
] as const;

export type WorkflowIssueCode = (typeof WORKFLOW_ISSUE_CODES)[number];

export interface WorkflowValidationIssue {
  code: WorkflowIssueCode;
  /**
   * The nodes this is about. Always populated except for the whole-graph
   * issues, because "this workflow is invalid" is not something anyone can act
   * on — the message has to name the box to go and look at.
   */
  nodeIds: string[];
  /** Already a full sentence, addressed to whoever drew the graph. */
  message: string;
}

/**
 * Everything that makes a graph unrunnable, in one pure function.
 *
 * Pure and dependency-free on purpose, and exported from the browser entry point
 * as well as the server one, so the canvas and the store run *the same*
 * validator. A canvas that validates against its own copy of these rules and a
 * server that validates against another is a canvas that eventually lies —
 * either by refusing something the server would accept, or, far worse, by
 * accepting something the server then rejects at run time, halfway through a
 * load. The server still calls this itself: shared code is not the same as
 * trusted input, and the store must refuse a graph that arrived by curl.
 *
 * Structural problems are reported alone. Reachability computed over edges that
 * point at nodes which do not exist produces a second page of consequences, and
 * burying the one real problem under them is how a validation message stops
 * being read.
 */
export function validateWorkflow(graph: WorkflowGraph): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];

  if (nodes.length === 0) {
    return [
      {
        code: 'empty',
        nodeIds: [],
        message:
          'This workflow has no nodes. Running it would commit an empty snapshot over whatever is live, so it is refused rather than saved as something that looks runnable.',
      },
    ];
  }

  const byId = collectNodesById(nodes, issues);
  checkEdges(edges, byId, issues);

  // Reachability and cycles are only meaningful once the graph is structurally
  // sound. See the note on this function.
  if (issues.length > 0) return issues;

  const { outgoing, incoming } = buildAdjacency(nodes, edges);
  const sources = nodes.filter((node) => node.kind === 'source');
  const sinks = nodes.filter((node): node is WorkflowSinkNode => node.kind === 'sink');

  checkNodeWiring(nodes, incoming, outgoing, issues);
  checkEndpoints(sources, sinks, issues);

  const looped = findCycle(nodes, incoming, outgoing);
  if (looped) {
    issues.push({
      code: 'cycle',
      nodeIds: looped,
      message: `These nodes form a cycle: ${looped.join(' → ')}. A graph that loops has no order to run in and no point at which the load is finished, so it is refused rather than run until something times out.`,
    });
    // Reachability over a cyclic graph reports nodes as unreachable that are
    // only unreachable *because* of the cycle, which points at the wrong boxes.
    return issues;
  }

  checkReachability(nodes, sources, sinks, incoming, outgoing, issues);

  return issues;
}

/**
 * Index the nodes by id, reporting the ids that cannot be used as one.
 *
 * A node with an unusable id is still indexed, deliberately. Leaving it out
 * would make every edge touching it report a *missing node* as well, which
 * sends the reader looking for a node they can see on the canvas. One problem,
 * one message.
 */
function collectNodesById(
  nodes: readonly WorkflowNode[],
  issues: WorkflowValidationIssue[],
): Map<string, WorkflowNode> {
  const byId = new Map<string, WorkflowNode>();

  for (const node of nodes) {
    if (!WORKFLOW_NODE_ID_PATTERN.test(node.id)) {
      issues.push({
        code: 'invalid-node-id',
        nodeIds: [node.id],
        message: `Node id "${node.id}" is not usable. Ids may be 1-64 characters of letters, digits, underscore or hyphen: the id becomes a durable step name and part of the key its staged rows are stored under, and neither can carry arbitrary text safely.`,
      });
    }
    if (byId.has(node.id)) {
      issues.push({
        code: 'duplicate-node-id',
        nodeIds: [node.id],
        message: `Two nodes share the id "${node.id}". Edges name nodes by id, so a duplicate makes every wire touching it ambiguous.`,
      });
      continue;
    }
    byId.set(node.id, node);
  }

  return byId;
}

/** Wires that name a node which is not there, loop back on themselves, or repeat. */
function checkEdges(
  edges: readonly WorkflowEdge[],
  byId: ReadonlyMap<string, WorkflowNode>,
  issues: WorkflowValidationIssue[],
): void {
  const seenEdges = new Set<string>();

  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) {
      const missing = byId.has(edge.from) ? edge.to : edge.from;
      issues.push({
        code: 'edge-endpoint-missing',
        nodeIds: [edge.from, edge.to],
        message: `The edge "${edge.from}" → "${edge.to}" names node "${missing}", which is not in this workflow. It was most likely deleted while the wire stayed behind.`,
      });
      continue;
    }
    if (edge.from === edge.to) {
      issues.push({
        code: 'self-edge',
        nodeIds: [edge.from],
        message: `Node "${edge.from}" is wired to itself, which has no order to run in.`,
      });
      continue;
    }
    const key = `${edge.from}\0${edge.to}`;
    if (seenEdges.has(key)) {
      issues.push({
        code: 'duplicate-edge',
        nodeIds: [edge.from, edge.to],
        message: `Node "${edge.from}" is wired into "${edge.to}" twice, so "${edge.to}" would receive the same rows twice and silently double its input.`,
      });
      continue;
    }
    seenEdges.add(key);
  }
}

/** Both directions of the edge list, with an entry for every node. */
function buildAdjacency(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): { outgoing: Map<string, string[]>; incoming: Map<string, string[]> } {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();

  for (const node of nodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
  }
  for (const edge of edges) {
    outgoing.get(edge.from)?.push(edge.to);
    incoming.get(edge.to)?.push(edge.from);
  }

  return { outgoing, incoming };
}

/** What each kind of node may and may not have wired to it. */
function checkNodeWiring(
  nodes: readonly WorkflowNode[],
  incoming: ReadonlyMap<string, string[]>,
  outgoing: ReadonlyMap<string, string[]>,
  issues: WorkflowValidationIssue[],
): void {
  for (const node of nodes) {
    if (node.kind === 'source' && (incoming.get(node.id)?.length ?? 0) > 0) {
      issues.push({
        code: 'source-has-input',
        nodeIds: [node.id],
        message: `Source "${node.name}" (${node.id}) has an inbound edge. A source reads from a system, not from another node; wire that node into a transform instead.`,
      });
    }
    if (node.kind === 'sink' && (outgoing.get(node.id)?.length ?? 0) > 0) {
      issues.push({
        code: 'sink-has-output',
        nodeIds: [node.id],
        message: `Sink "${node.name}" (${node.id}) has an outbound edge. The sink commits the snapshot, so nothing can run after it.`,
      });
    }
    if (node.kind === 'transform' && node.transformId.length === 0) {
      issues.push({
        code: 'transform-not-named',
        nodeIds: [node.id],
        message: `Transform node "${node.name}" (${node.id}) names no transform, so there is no code for it to run.`,
      });
    }
  }
}

/**
 * That the graph has both ends, and that no two sinks claim the same type.
 *
 * Several sinks are allowed, and the reason is the point of having a graph at
 * all: one expensive read feeding several outputs. Forbidding it would mean
 * pulling the same ten million rows twice to derive two types from them.
 *
 * What is refused is two sinks writing the *same* type. Each sink commits its
 * own type independently — there is no distributed transaction here and the
 * model does not pretend otherwise — but two snapshots of one type in one run
 * leaves nothing to say which of them the readers should get.
 */
function checkEndpoints(
  sources: readonly WorkflowNode[],
  sinks: readonly WorkflowSinkNode[],
  issues: WorkflowValidationIssue[],
): void {
  if (sources.length === 0) {
    issues.push({
      code: 'no-source',
      nodeIds: [],
      message:
        'This workflow has no source node, so nothing would ever be read and the sink would commit an empty snapshot.',
    });
  }

  if (sinks.length === 0) {
    issues.push({
      code: 'no-sink',
      nodeIds: [],
      message:
        'This workflow has no sink node. A workflow ends at a sink, because the sink is what writes and commits — without one the graph computes rows and throws them away.',
    });
  }

  const byTargetType = new Map<string, WorkflowSinkNode[]>();
  for (const sink of sinks) {
    const sharing = byTargetType.get(sink.targetType) ?? [];
    sharing.push(sink);
    byTargetType.set(sink.targetType, sharing);
  }
  for (const [targetType, sharing] of byTargetType) {
    if (sharing.length < 2) continue;
    issues.push({
      code: 'duplicate-sink-type',
      nodeIds: sharing.map((sink) => sink.id),
      message: `${sharing
        .map((sink) => `"${sink.name}" (${sink.id})`)
        .join(
          ' and ',
        )} both commit ${targetType}. Two snapshots of one type in a single run leaves nothing to say which one readers should get — wire these branches into one sink, or send them to different types.`,
    });
  }
}

/**
 * The nodes actually on a cycle, or nothing if the graph is acyclic.
 *
 * Kahn's algorithm: whatever is left with a non-zero in-degree after the queue
 * drains is on one.
 */
function findCycle(
  nodes: readonly WorkflowNode[],
  incoming: ReadonlyMap<string, string[]>,
  outgoing: ReadonlyMap<string, string[]>,
): string[] | undefined {
  const indegree = new Map<string, number>();
  for (const node of nodes) {
    indegree.set(node.id, incoming.get(node.id)?.length ?? 0);
  }
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((n) => n.id);
  const ordered: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    ordered.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  if (ordered.length === nodes.length) return undefined;

  const leftover = new Set(
    nodes.filter((node) => !ordered.includes(node.id)).map((node) => node.id),
  );
  return [...peelTails(leftover, outgoing)];
}

/**
 * Strip the nodes that are merely stuck behind a loop, leaving the loop itself.
 *
 * What Kahn's algorithm leaves behind is the cycle *plus* everything downstream
 * of it, because those never had their in-degree resolved either. Naming all of
 * it would point at nodes that are perfectly well wired and merely waiting on
 * the loop, and a message that names the wrong node is worse than a vague one.
 * Removing nodes with no outgoing edge *inside the set*, repeatedly, strips
 * exactly those tails: a node on the cycle always has one.
 *
 * Mutates and returns the set it was given, which is a local built for this.
 */
function peelTails(leftover: Set<string>, outgoing: ReadonlyMap<string, string[]>): Set<string> {
  for (let peeled = true; peeled; ) {
    peeled = false;
    for (const id of leftover) {
      const continues = (outgoing.get(id) ?? []).some((next) => leftover.has(next));
      if (continues) continue;
      leftover.delete(id);
      peeled = true;
    }
  }
  return leftover;
}

/** Nodes that no source reaches, and nodes that reach no sink. */
function checkReachability(
  nodes: readonly WorkflowNode[],
  sources: readonly WorkflowNode[],
  sinks: readonly WorkflowSinkNode[],
  incoming: Map<string, string[]>,
  outgoing: Map<string, string[]>,
  issues: WorkflowValidationIssue[],
): void {
  const reachableFromSources = walk(
    sources.map((node) => node.id),
    outgoing,
  );
  const reachesASink = walk(
    sinks.map((sink) => sink.id),
    incoming,
  );

  for (const node of nodes) {
    if (sources.length > 0 && !reachableFromSources.has(node.id)) {
      issues.push({
        code: 'unreachable',
        nodeIds: [node.id],
        message: `Node "${node.name}" (${node.id}) is not reachable from any source, so it would never run. Wire a source into it or delete it — a node on the canvas that silently does nothing is the thing this check exists to prevent.`,
      });
      continue;
    }
    if (sinks.length > 0 && !reachesASink.has(node.id)) {
      issues.push({
        code: 'dead-end',
        nodeIds: [node.id],
        message: `Node "${node.name}" (${node.id}) leads nowhere: nothing it produces reaches the sink, so it would be computed and thrown away. Every path has to end at the sink.`,
      });
    }
  }
}

/** Breadth-first reachability over one adjacency map. */
function walk(roots: string[], adjacency: Map<string, string[]>): Set<string> {
  const seen = new Set<string>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    for (const next of adjacency.get(id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/**
 * The order the nodes run in, and the inputs each one gets.
 *
 * Here rather than in the runner because the wiring rules — a node runs after
 * everything wired into it, and receives its inputs in edge order — are the same
 * rules {@link validateWorkflow} enforces, and two implementations of one rule
 * is how a graph that validated comes out executing differently.
 *
 * Throws on an invalid graph rather than returning a best effort. A partial
 * order over a broken graph is a load that half-happens, which is harder to
 * recover from than one that never started.
 */
export function workflowRunOrder(
  graph: WorkflowGraph,
): Array<{ node: WorkflowNode; inputs: string[] }> {
  const issues = validateWorkflow(graph);
  if (issues.length > 0) {
    throw new Error(
      `Refusing to order an invalid workflow: ${issues.map((issue) => issue.message).join(' ')}`,
    );
  }

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  // The same adjacency the validator walks, from the same builder. Two copies of
  // "what is wired into what" is exactly how a graph that validated comes out
  // executing differently, which is the thing this function's contract rules out.
  const { outgoing, incoming } = buildAdjacency(graph.nodes, graph.edges);
  const indegree = new Map(
    graph.nodes.map((node) => [node.id, incoming.get(node.id)?.length ?? 0]),
  );

  const ready = graph.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const order: Array<{ node: WorkflowNode; inputs: string[] }> = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) break;
    const node = byId.get(id);
    if (!node) continue;
    // Edge order, not node order: this is the array a merge reads its inputs
    // from, and it is part of the fingerprint precisely because it is visible in
    // the output. `buildAdjacency` fills `incoming` by walking the edges in
    // order, so that is what this already is.
    order.push({ node, inputs: [...(incoming.get(id) ?? [])] });
    for (const next of outgoing.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }
  return order;
}

/**
 * A stable fingerprint of what a graph *does*.
 *
 * Behaviour only: node ids, kinds, the configuration each kind executes on, and
 * the edges in their order. Names and canvas positions are excluded, so moving a
 * box or fixing a typo in a label does not bump the version — the same rule
 * `saveTransform` already applies when it bumps only on a code change, and for
 * the same reason. A version number inflated by cosmetic edits is useless for
 * the one question it exists to answer.
 *
 * Nodes are sorted by id because their array order changes nothing; edges are
 * deliberately *not* sorted, because their order decides what a node with
 * several inputs receives.
 *
 * FNV-1a rather than a hash from `node:crypto`: this file is imported by the
 * browser entry point, and it is change detection rather than a security
 * primitive — nobody is defending against a chosen-collision attack on their own
 * canvas. Two passes with different offsets are concatenated, which is enough
 * spread that an accidental collision between two graphs of one workflow is not
 * a thing to plan for.
 */
export function workflowGraphHash(graph: WorkflowGraph): string {
  const nodes = [...graph.nodes]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((node) => canonicalNode(node));
  const edges = graph.edges.map((edge) => `${edge.from}>${edge.to}`);
  const canonical = JSON.stringify({ nodes, edges });
  return `${fnv1a(canonical, 0x811c9dc5)}${fnv1a(canonical, 0x01000193)}`;
}

/** The parts of a node that change what a run produces. */
function canonicalNode(node: WorkflowNode): string {
  if (node.kind === 'source') {
    return JSON.stringify([
      node.id,
      node.kind,
      node.sourceKind,
      node.connectionId ?? '',
      node.secretEnvVar ?? '',
      node.mode ?? 'full',
      // Sorted keys, so a canvas that rewrites the object in a different order
      // does not look like an edit.
      sortedEntries(node.config),
    ]);
  }
  if (node.kind === 'transform') {
    // The transform's *version* is deliberately not in here. Editing a
    // transform is already recorded as a new transform version, and folding it
    // in would bump every graph that references it — which would say the wiring
    // changed when it did not.
    return JSON.stringify([node.id, node.kind, node.transformId]);
  }
  return JSON.stringify([node.id, node.kind, node.targetType, node.mode ?? 'full']);
}

function sortedEntries(config: Record<string, unknown>): Array<[string, unknown]> {
  return Object.keys(config)
    .sort()
    .map((key) => [key, config[key]]);
}

function fnv1a(input: string, offset: number): string {
  let hash = offset;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    // The 32-bit FNV prime, by shifts rather than multiplication, so the result
    // stays inside a 32-bit integer instead of drifting through float precision.
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    hash >>>= 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Narrow a stored node, loudly.
 *
 * Used when reading a graph back out of a JSON column, and it throws rather than
 * skipping what it does not recognise for a reason specific to graphs: dropping
 * an unknown node silently changes what the workflow does — the surrounding
 * edges then point at nothing, or worse, the graph still validates and simply
 * omits a step — and a load that quietly ran nine of ten nodes is far harder to
 * notice than one that refused to start.
 */
export function isWorkflowNode(value: unknown): value is WorkflowNode {
  if (typeof value !== 'object' || value === null) return false;
  const id = Reflect.get(value, 'id');
  const name = Reflect.get(value, 'name');
  const kind = Reflect.get(value, 'kind');
  if (typeof id !== 'string' || typeof name !== 'string') return false;
  if (!isWorkflowNodeKind(kind)) return false;
  if (kind === 'transform') {
    return typeof Reflect.get(value, 'transformId') === 'string';
  }
  if (kind === 'sink') {
    return typeof Reflect.get(value, 'targetType') === 'string';
  }
  const sourceKind = Reflect.get(value, 'sourceKind');
  const config = Reflect.get(value, 'config');
  return isConnectorKind(sourceKind) && typeof config === 'object' && config !== null;
}

export function isWorkflowEdge(value: unknown): value is WorkflowEdge {
  if (typeof value !== 'object' || value === null) return false;
  return (
    typeof Reflect.get(value, 'from') === 'string' && typeof Reflect.get(value, 'to') === 'string'
  );
}

/**
 * Holding and serving workflows.
 *
 * Its own interface, mixed into {@link CatalogPipelineStore} as optional
 * members, because a store may legitimately not have these — the routing proxy
 * in the MikroORM package and any store written against the previous shape of
 * this interface both implement `CatalogPipelineStore` today, and turning that
 * into a compile error would be a breaking change for a feature that is
 * additive. {@link supportsWorkflows} is how a caller asks, and "this deployment
 * cannot hold workflows" is then a sentence a UI can say rather than a method
 * that is missing at run time.
 */
export interface CatalogWorkflowStore {
  listWorkflows(): Promise<CatalogWorkflow[]>;
  getWorkflow(id: string): Promise<CatalogWorkflow | undefined>;
  /**
   * Validates before it writes, and refuses naming the node.
   *
   * `version`, `graphHash` and `targetType` are not inputs: the first two are
   * derived from the graph and the third from the sink, and accepting them from
   * a caller would let a client claim a version it did not produce.
   */
  saveWorkflow(
    input: Pick<CatalogWorkflow, 'name' | 'nodes' | 'edges'> & {
      id?: string;
      description?: string;
    },
    createdBy: string,
  ): Promise<CatalogWorkflow>;
  /** Refuses while any connector still runs it. */
  deleteWorkflow(id: string): Promise<boolean>;
  /** Which connectors run it. Named, so a refusal can say. */
  connectorsUsingWorkflow(id: string): Promise<CatalogConnector[]>;
}

/**
 * Where the rows between two nodes actually sit.
 *
 * Separate from {@link CatalogWorkflowStore} because they are different kinds of
 * thing — one holds authored metadata, the other holds a run's intermediate
 * data — and a deployment could reasonably keep the second somewhere the first
 * is not, a columnar store or object storage rather than the catalog database.
 *
 * The rows cannot simply be staged in the target type's own table, which was the
 * first thing tried: that table has the columns the *type* declares, and an
 * intermediate node's rows are mid-transformation and generally have others. A
 * write there would drop them, and the load would come out missing fields that
 * the transform demonstrably produced.
 */
export interface CatalogStageStore {
  /**
   * Idempotent per `(runId, nodeId, batch)`, exactly like the warehouse's own
   * `write`. A retried durable step re-sends its batches and each one replaces
   * itself, so a retry cannot double a node's output.
   */
  writeStage(input: {
    runId: string;
    nodeId: string;
    /** 1-based, matching the batch numbering the connector runner already uses. */
    batch: number;
    rows: Array<Record<string, unknown>>;
  }): Promise<{ written: number }>;
  /** One batch at a time, so reading a stage never means holding all of it. */
  readStage(ref: {
    runId: string;
    nodeId: string;
    batch: number;
  }): Promise<Array<Record<string, unknown>>>;
  /**
   * Drop everything a run staged. Called after the sink commits, and after a
   * failed run has been given up on — intermediate rows are worth keeping only
   * as long as something might still resume onto them.
   */
  dropStages(runId: string): Promise<number>;
}

/**
 * Whether this store can hold workflows at all.
 *
 * Checks the methods rather than a flag, the same way {@link isPipelineStore}
 * does, because a flag is a claim and a method is the thing itself.
 */
export function supportsWorkflows(
  store: CatalogPipelineStore,
): store is CatalogPipelineStore & CatalogWorkflowStore {
  return (
    typeof store.listWorkflows === 'function' &&
    typeof store.getWorkflow === 'function' &&
    typeof store.saveWorkflow === 'function'
  );
}

export function supportsWorkflowStages(
  store: CatalogPipelineStore,
): store is CatalogPipelineStore & CatalogStageStore {
  return typeof store.writeStage === 'function' && typeof store.readStage === 'function';
}

export interface CatalogPipelineStore
  extends Partial<CatalogWorkflowStore>,
    Partial<CatalogStageStore> {
  listConnectors(): Promise<CatalogConnector[]>;
  getConnector(id: string): Promise<CatalogConnector | undefined>;
  saveConnector(
    input: Omit<CatalogConnector, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'> & { id?: string },
    createdBy: string,
  ): Promise<CatalogConnector>;
  deleteConnector(id: string): Promise<boolean>;
  /**
   * Record where a run got to.
   *
   * Its own method rather than part of `saveConnector`, so advancing a
   * watermark can never carry an accidental edit to the query beside it.
   */
  saveConnectorState(id: string, state: Record<string, unknown>): Promise<void>;

  listConnections(): Promise<CatalogConnection[]>;
  getConnection(id: string): Promise<CatalogConnection | undefined>;
  saveConnection(
    input: Omit<CatalogConnection, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'> & {
      id?: string;
    },
    createdBy: string,
  ): Promise<CatalogConnection>;
  /**
   * Refuses while any connector still reads through it.
   *
   * Deleting one out from under its connectors would turn every one of them
   * into a load that fails at run time with a missing address, discovered on a
   * schedule rather than at the moment somebody decided.
   */
  deleteConnection(id: string): Promise<boolean>;
  recordConnectionCheck(id: string, check: ConnectionCheck): Promise<void>;
  /** Which connectors read through a connection. Named, so a refusal can say. */
  connectorsUsingConnection(id: string): Promise<CatalogConnector[]>;

  listTransforms(): Promise<CatalogTransform[]>;
  getTransform(id: string): Promise<CatalogTransform | undefined>;
  saveTransform(
    input: Pick<CatalogTransform, 'name' | 'language' | 'code'> & {
      id?: string;
      description?: string;
    },
    createdBy: string,
  ): Promise<CatalogTransform>;
  deleteTransform(id: string): Promise<boolean>;

  startRun(input: {
    connectorId: string;
    snapshotId: string;
    principalId: string;
    /**
     * Which graph is about to run, and how.
     *
     * Recorded at the *start* rather than at the finish, deliberately. A run
     * that crashes hard enough never to reach `finishRun` still has to be
     * traceable to the graph that was running, and a run row that only learns
     * which workflow it was on the way out is exactly the row that will be
     * missing it for the failure somebody is investigating. All optional, so a
     * single-transform connector calls this precisely as it did before.
     */
    workflowId?: string;
    workflowVersion?: number;
    graphHash?: string;
    executionMode?: WorkflowExecutionMode;
  }): Promise<ConnectorRun>;
  finishRun(
    id: string,
    outcome: Partial<
      Pick<
        ConnectorRun,
        'status' | 'fetched' | 'written' | 'logs' | 'error' | 'transformVersion' | 'nodeOutcomes'
      >
    >,
  ): Promise<ConnectorRun | undefined>;
  listRuns(connectorId?: string, limit?: number): Promise<ConnectorRun[]>;
}

export const CATALOG_PIPELINE_STORE = Symbol('CATALOG_PIPELINE_STORE');

export function isPipelineStore(store: unknown): store is CatalogPipelineStore {
  return (
    typeof store === 'object' &&
    store !== null &&
    typeof Reflect.get(store, 'listConnectors') === 'function'
  );
}

/**
 * A source somebody can reach, named once and reused.
 *
 * Connectors used to carry their own URL and their own credential reference, so
 * five connectors reading one database held five copies of the same
 * configuration and moving that database meant editing five rows — with no way
 * to find them, and no way to test the connection except by running a load.
 *
 * This is the shape Airflow calls a Connection and NiFi a Controller Service,
 * and it is worth the extra concept for one reason above the rest: it gives
 * "who reaches this system, and with whose credential" a single place to be
 * answered.
 *
 * Credentials stay out of it, exactly as before. What is stored is the *name*
 * of an environment variable, so a leaked catalog database gives away the shape
 * of an integration rather than the keys to it. Encrypting a secret at rest
 * here would mean owning a master key, its rotation and its blast radius, which
 * is a larger promise than this service should make.
 */
export interface CatalogConnection {
  id: string;
  name: string;
  description?: string;
  /**
   * Which kind of source it reaches.
   *
   * Deliberately the same vocabulary a connector uses: a connection to a
   * database and a connector reading from one must agree about what they are
   * talking to, and two vocabularies would let them disagree.
   */
  kind: ConnectorKind;
  /** Everything but the credential — host, bucket, endpoint, region. */
  config: Record<string, unknown>;
  /** Env var holding the credential, if reaching it needs one. */
  secretEnvVar?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** When it was last reached successfully, if it ever has been. */
  lastCheckedAt?: string;
  lastCheckOk?: boolean;
  lastCheckError?: string;
}

/** What checking a connection found. */
export interface ConnectionCheck {
  ok: boolean;
  /** What was reached, in words — a server version, a bucket, a status code. */
  detail: string;
  elapsedMs: number;
  error?: string;
}
