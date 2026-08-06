/**
 * Getting data in: where it comes from, and what turns it into rows.
 *
 * The shape NiFi and Airflow both settle on — a source, a transform, a sink —
 * with the sink fixed, because the sink is the whole point of a catalog. What
 * is deliberately *not* here is a scheduler: the durable engine already
 * schedules, retries and checkpoints, and writing a second one would mean two
 * systems each believing they decide when a load runs.
 */

// The revision shape is declared beside the audit trail rather than here,
// because it is one shape over two subjects — a transform's code and a saved
// query's SQL — and neither of them owns it. This is a type-only import, and the
// edge only ever points this way: `catalog.workspace.ts` knows nothing about
// pipelines.
import type { CatalogRevision } from './catalog.workspace';

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

/**
 * What a published workflow runs as. **Not an authored object.**
 *
 * This used to be the thing somebody created: a screen, a `POST connectors`, a
 * kind and a config and a schedule typed into a form. It is not that any more,
 * and every route that let anybody make one directly has been removed. A
 * connector is now minted by {@link CatalogWorkflowStore.publishWorkflow} and
 * exists for the four jobs a graph cannot do for itself:
 *
 * - **It is the mutex key.** `singleton: { key: connectorMutexKey }` on the
 *   durable workflow serialises runs per connector id, which is what stops two
 *   workers loading one type at once.
 * - **It is the run's owner.** `ConnectorRun.connectorId` is how `listRuns`
 *   groups a history, so a stable id across edits of the graph is what makes
 *   "what has this pipeline done" answerable at all.
 * - **It holds the watermark.** `state`, keyed by source-node id — see
 *   {@link CatalogConnector.state}.
 * - **It answers "which connectors write this type".** `targetType` is kept
 *   equal to the workflow's sink type, so that query keeps working.
 *
 * Everything else on it is derived. `kind`, `config`, `connectionId` and
 * `secretEnvVar` are **not read** on a connector that has a `workflowId`, and
 * every connector has one now; they survive only because a row adopted from
 * before this change still carries what it was configured with, and throwing
 * that away would destroy the evidence of what a load used to do.
 *
 * The reason for keeping a record at all rather than running graphs directly is
 * that all four jobs above need an identity that outlives an edit. A graph's
 * version changes when anybody drags a node; the thing a run belongs to must
 * not.
 */
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
   * The graph this connector runs. **The only thing that says what it does.**
   *
   * Optional in the type and mandatory in practice: `publishWorkflow` sets it on
   * every connector it mints, and adoption sets it on every connector that
   * predates this change. It stays optional here because a store read must be
   * able to represent a row written before adoption ran without asserting
   * something about it that is not yet true — narrowing this to `string` would
   * turn "we have not migrated yet" into a type error at the read.
   *
   * Mutually exclusive with {@link transformId}, and the store refuses a
   * connector that sets both: two answers to "what shapes this data" means the
   * runner picks one, and which one it picked is invisible until the load comes
   * out wrong.
   *
   * When this is set the connector's own `kind`, `config`, `connectionId` and
   * `secretEnvVar` are **not read**: the workflow's source nodes say where the
   * data comes from, and letting the connector also say would be two
   * authorities for one question. `targetType` is kept equal to the workflow's
   * sink type, so every existing "which connectors write this type" answer
   * keeps working.
   */
  workflowId?: string;
  /**
   * A **copy** of {@link CatalogWorkflow.schedule}, and nothing reads it.
   *
   * Kept, and kept honest by the store, for exactly one reason: it is the
   * evidence of what a connector was doing before its schedule moved onto the
   * graph. The authority is the workflow, {@link CatalogWorkflowStore} writes
   * this from there on every publish, and the scheduler deliberately does not
   * consult it — see the note on `ConnectorScheduler`, which used to read this
   * field and now reads workflows, because a second copy of a column is how the
   * two come to disagree the first time somebody edits one.
   */
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
   *
   * **Keyed by source-node id**, because a graph with two sources has two
   * watermarks and one flat blob would let them overwrite each other. A
   * connector adopted from before workflows existed had a flat blob, and
   * adoption re-keys it under the id of the single source node it was wrapped
   * into — losing that would make the first run after an upgrade re-read an
   * incremental source from the beginning.
   */
  state?: Record<string, unknown>;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastRunStatus?: 'succeeded' | 'failed' | 'running';
}

// ---------------------------------------------------------------------------
// Load expectations: the shapes here, the policy functions in the pipeline
// package.
//
// The split is the same one `CatalogConnector` above already lives under. These
// four are *data* — they are stored, served over HTTP, rendered in a console and
// now written by an operator — and the store package has to name them to persist
// them. It depends on this package and deliberately not on
// `@dudousxd/nestjs-catalog-pipeline`, so shapes it must name cannot live there.
//
// What did NOT move: `CATALOG_LOAD_EXPECTATIONS`, `DEFAULT_ROW_COUNT_BOUND`,
// `EXPECT_SHRINK_LABEL`, `CARRIED_FROM_LABEL`, `expectationFor`,
// `rowCountBoundFor`, `refuseUndeclaredDeletes`, `refuseStaleReconciliation`,
// `refuseRowCountDrift` and `LoadExpectationError`. They are the enforcement, they
// stay pure and synchronous, and they stay in `pipeline/src/load-expectations.ts`
// — which re-exports the four below, so every existing import keeps working. The
// `{@link}`s in the docblocks that follow therefore point across that boundary on
// purpose: the reasoning was written as one argument and is kept as one.
// ---------------------------------------------------------------------------

/**
 * What a load has to be true of before it is allowed to become the data
 * everybody reads.
 *
 * Two failures live here, and they are the same failure seen from two ends: a
 * load that is *fresh and wrong*. Every signal this catalog publishes about a
 * type — `lastCommittedAt`, the age badge on the Model screen, a green run in
 * the runs list — reports on whether a load HAPPENED. None of them reports on
 * whether what it loaded resembles the dataset it replaced, and a snapshot
 * commit is atomic, so the moment a wrong load commits it is indistinguishable
 * from a right one until somebody counts rows by hand.
 *
 * - **Deletes.** An incremental connector asks its source for what changed
 *   since a watermark. A row physically removed from the source never changes
 *   again, so it is never returned again, so `carryForward` copies it into
 *   every subsequent snapshot forever. The catalog does not go wrong at any
 *   point; it simply never finds out. See {@link DeleteReconciliation}.
 * - **Collapse.** A source-side filter change, a broken `WHERE`, a partial
 *   outage: the connector returns 12 rows where it returned 40,000, the
 *   snapshot commits, and the freshness signals all say healthy — correctly,
 *   because it IS fresh. See {@link RowCountBound}.
 *
 * **Why a policy object and not a column on the connector.** Both facts are
 * statements about a *type*, not about the reader of a source. "It is
 * acceptable that `Employee` accumulates rows deleted upstream" and "`Employee`
 * must never lose half its rows in one load" stay true whether the rows arrive
 * from a connector, from a workflow sink, or from an application POSTing to the
 * publish API — and all three of those paths end at the same two methods on
 * `PublishService`, which is where these are enforced. A per-connector field
 * would have covered one of the three and would have had to be checked in three
 * places to cover the rest.
 *
 * The second reason is who should be able to change it. Accepting that a
 * dataset silently accumulates deleted rows is not a checkbox decision; it is
 * the kind of thing that should appear in a diff with a reason attached, which
 * is why {@link DeleteReconciliation} makes the reason a required field.
 */
export interface CatalogLoadExpectations {
  /** Applied to every type that has no entry of its own. */
  default?: LoadExpectation;
  /**
   * Keyed by object type name. Merged OVER {@link default} field by field, so a
   * host can set one house-wide row-count bound and still say something about
   * deletes for the three types that are loaded incrementally.
   */
  byType?: Record<string, LoadExpectation>;
}

export interface LoadExpectation {
  /**
   * How deletions at the source reach this type. **Absent means the load is
   * refused**, which is the whole mechanism — see {@link
   * refuseUndeclaredDeletes}.
   */
  deletes?: DeleteReconciliation;
  /**
   * How far one load may move this type's row count. Merged over
   * {@link DEFAULT_ROW_COUNT_BOUND}, so a host that only wants to raise
   * `maxShrink` writes exactly that one field.
   */
  rowCount?: Partial<RowCountBound>;
}

/**
 * How a type that is loaded incrementally learns about rows that were deleted.
 *
 * Three answers, and the honest thing to say about them up front is that only
 * one is *policed*. What this file enforces is that somebody chose one and
 * wrote down why — because the state being prevented is nobody having thought
 * about it at all, and that state is invisible by construction.
 *
 * The fourth answer, tombstones off a change feed, is the correct one and is
 * deliberately not here. It needs the source to publish a delete stream, the
 * catalog to hold a delete log per type, and the merge to apply it — which is
 * a larger machine than the problem justifies today, and adding a strategy name
 * that nothing implements would be exactly the dropdown-with-a-lie this
 * codebase refuses everywhere else.
 */
export type DeleteReconciliation =
  /**
   * Nothing reconciles them, and that is a decision somebody made.
   *
   * The legitimate cases are real and common: an append-only ledger where rows
   * are never removed, a source that only ever soft-retires records by changing
   * a status the transform can see, or a dataset where a handful of stale rows
   * is genuinely cheaper than a nightly full read. What is not legitimate is
   * arriving here by default, which is why {@link because} cannot be omitted.
   */
  | { strategy: 'accepted'; because: string }
  /**
   * The source marks a deletion instead of performing one, and the watermark
   * therefore sees it — a `deleted_at` that moves, a status column that flips —
   * so the deleted row arrives as an ordinary change and the transform drops it
   * or the type keeps it flagged.
   *
   * The strongest of the three, and the one that pushes a requirement onto a
   * source that may refuse it. Not verifiable from here: the catalog cannot
   * tell a source that soft-deletes from one that claims to, so this is a
   * declaration like the one above. It is a separate value anyway because the
   * two say completely different things to the next person who reads the
   * config, and collapsing them would lose that.
   */
  | { strategy: 'soft-deleted-at-source'; because: string; column?: string }
  /**
   * Full reads reconcile, incremental reads fill the gaps between them.
   *
   * The interval is the trade-off, and it is stated in time rather than in runs
   * because "reconciled daily" is what anybody actually means and because the
   * only thing the catalog can count is the snapshots a store chooses to
   * report, which is a window of unknown depth. {@link refuseStaleReconciliation}
   * makes the interval real: once the newest full load of the type is older
   * than `withinMs`, incremental loads of it stop committing.
   */
  | { strategy: 'periodic-full-reload'; because: string; withinMs: number };

/**
 * How far a single load may move a type's row count before it is refused.
 *
 * **Asymmetric on purpose.** A type that doubles has usually had a good day —
 * a backfill landed, a new base was onboarded, a source finished catching up.
 * A type that loses 90% has almost never had a good day. Bounding both sides by
 * the same number would mean picking a growth bound loose enough to be useless
 * as a shrink bound, or a shrink bound tight enough to refuse every backfill.
 *
 * **Conditional on the store, and a host configuring this should know which
 * condition.** {@link refuseRowCountDrift} is pure and decides on two numbers;
 * somebody has to fetch them, and both come from members that are optional on
 * the store interface. Without `currentSnapshot` there is no served baseline;
 * without `listSnapshots`, or from a `listSnapshots` whose window does not
 * reach the snapshot about to be committed, there is no count for the pending
 * one. Either way the bound is not applied to that commit. That is the same
 * permissive-rather-than-punishing stance {@link CARRIED_FROM_LABEL} takes for
 * the same reason — an adapter that records less than the bundled one is not
 * the failure this file exists for — but it means a number written here is a
 * bound the store has to be able to measure, not one it is guaranteed to have.
 * `PublishService.assertRowCountIsPlausible` is where that is decided; a skip
 * that is not said out loud there is a bound believed to be on and off, which
 * is the one outcome neither this file nor that one may produce.
 */
export interface RowCountBound {
  /**
   * The largest fraction of the previously served snapshot a load may lose.
   * `0.5` refuses a load that comes back with less than half of what is live.
   */
  maxShrink: number;
  /**
   * The ratio above which growth is refused — `10` refuses a load ten times the
   * size of the previous one. **Absent means growth is never refused**, which is
   * the default, because the failure this file exists for is collapse and a
   * growth bound that fires on a legitimate backfill teaches people to raise
   * every bound in this object until none of them do anything.
   */
  maxGrowth?: number;
  /**
   * Below this many rows in the previously served snapshot, no ratio applies.
   *
   * A percentage of a small number is noise. A four-row lookup table dropping to
   * one is a 75% collapse and is also a Tuesday, and a bound that fires on it is
   * a bound somebody switches off — taking the forty-thousand-row types with it.
   */
  minRows: number;
}

/**
 * A per-type expectation as an operator set it, with who and when.
 *
 * The layer between a host's `byType` entry and its `default`. It exists because
 * the control the docblocks above argue for was never "it must be in code" —
 * it is that **somebody chose a strategy and wrote down why**, which needs
 * attribution and visibility rather than compilation. A host object gives the
 * reason a place to live and gives attribution to nobody: a `git blame` on a
 * deployment's wiring names whoever last reformatted the file. So the reason
 * arrives with the principal that set it and the instant they did, and the
 * declaration requirement is unchanged — {@link refuseUndeclaredDeletes} asks
 * the same question of a stored row as it does of a host one.
 *
 * The grain is still the type, and only the type. A connector, a workflow sink
 * and an application POSTing to the publish API all end at the same two
 * `PublishService` methods and all have the same delete problem, so a per-
 * connector or per-workflow row would give one dataset several answers to one
 * question — see {@link CatalogLoadExpectations}, which argues it at length and
 * is unaffected by this layer existing.
 *
 * Both policy fields are optional, and a row may carry either, both or neither:
 * precedence is resolved field by field, so an operator raising a shrink bound
 * says nothing about deletes and does not have to.
 */
export interface StoredLoadExpectation {
  typeName: string;
  deletes?: DeleteReconciliation;
  rowCount?: Partial<RowCountBound>;
  /** Principal id of whoever set it. */
  setBy: string;
  /** Actor id when a person was behind the principal — the audit's real subject. */
  setByActor?: string;
  /** ISO 8601. */
  setAt: string;
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
 *
 * The version used to be the *whole* answer, and it was half of one: it named
 * code that no longer existed anywhere, because one row per transform is
 * overwritten in place. Each version's code is now recorded as a
 * {@link CatalogRevision}, read through
 * {@link CatalogPipelineStore.listTransformRevisions}, so the number on a run
 * and the text it names are both retrievable. `version` still counts saves that
 * changed the code and nothing else — see `saveTransform`.
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
  /**
   * Anything the code logged. Surfaced in the run, never in the rows.
   *
   * "Anything the code logged" is meant literally, and in whichever language the
   * transform is written: `console.log` and its siblings in JavaScript and
   * TypeScript, `print` and anything written to `sys.stderr` in Python. A
   * transform author's first instinct for finding out what their code is doing
   * has to be the thing that works, because the alternative — an empty panel and
   * no explanation — reads as "my code never ran" rather than as "you used the
   * wrong function".
   *
   * In call order, with the channels interleaved rather than separated: a reader
   * is reconstructing a sequence, and two lists cannot be zipped back together.
   *
   * **Bounded, by the runner, before it is returned.** These are lines user code
   * chose and they cross a durable step boundary into the run record, so an
   * unbounded capture would make the size of a `finishRun` write a property of
   * somebody's source data. The bundled runner keeps the first 500 lines at
   * 2,000 characters each and appends a line saying how many it dropped — a
   * truncation nobody is told about is the same failure as a log nobody is told
   * about. Consumers cap again for display, more tightly.
   */
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
  /**
   * Which transform version ran, so a surprising load can be traced to code.
   *
   * Traced to the code itself, now, and not only to a number: the version this
   * names is the version of a {@link CatalogRevision}, so `transforms/:id/revisions`
   * answers with the body that produced these rows. Until that route existed
   * this field could only establish *that* the transform had been edited since.
   */
  transformVersion?: number;

  /** Which workflow ran, when the connector delegated to one. */
  workflowId?: string;
  /**
   * Which *version* of it ran.
   *
   * The same question `transformVersion` answers, asked of the graph — and no
   * longer answered as well, which is worth knowing before relying on it. A
   * workflow keeps only its latest shape (see {@link CatalogWorkflow} for why it
   * is excluded from revisions while a transform is not), so this number
   * connects a run to the graph that produced it and is the only way to know a
   * graph has changed since. It cannot produce the graph.
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
 * The first three are exactly the three verbs the existing connector runner
 * already performs in sequence: fetch, transform, publish. The fourth hands a
 * position in the graph to a durable workflow that already exists in the
 * deployment. Nothing here is a kind this service cannot execute, which is the
 * same rule {@link CONNECTOR_KINDS} follows — a kind that exists in the type
 * and throws at run time is worse than one that is absent, because the first
 * looks supported in a palette.
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
 * - **call a durable *step*** — the sibling of {@link WorkflowCallNode} that
 *   somebody will eventually come looking for, and it cannot be built. A
 *   durable step has no global identity: it is dispatched by a routing name
 *   that a worker subscribes to, and within a run it is addressed by its `seq`
 *   — a position in one workflow's history. There is no "run step X" entry
 *   point on the engine to call, no lifecycle of its own to await, and nothing
 *   to cancel. A workflow is the smallest thing that is addressable from
 *   outside a run, which is why `call` names one and not a step. If a step is
 *   what you want, the thing to call is a one-step workflow wrapping it.
 */
export const WORKFLOW_NODE_KINDS = [
  /** Reads records out of a system. The roots of the graph. */
  'source',
  /** Runs a {@link CatalogTransform} over what it is given. */
  'transform',
  /** Writes into an object type and commits. Exactly one per workflow. */
  'sink',
  /** Hands this position to an existing durable workflow. See {@link WorkflowCallNode}. */
  'call',
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
 * Hands this position in the graph to a durable workflow that already exists.
 *
 * The node the canvas cannot write the body of: the work happens in a workflow
 * somebody else registered, possibly in another SDK, and this node is the wire
 * from a graph to it. It runs as a **tracked child run** of the catalog's own
 * durable run — `ctx.startChild` then `ctx.child` — so the child has its own
 * lifetime, its own retries and its own history, and the catalog's run is
 * suspended at zero compute while it goes.
 *
 * ## Why the version is stored and not resolved
 *
 * A call names {@link callName} **and** {@link callVersion}, and the pair is
 * part of the graph fingerprint. Storing only the name would mean the person
 * who owns that workflow can change what your load does by registering a new
 * version — a behaviour change in your pipeline with nothing in your diff to
 * point at. So the version is authored, and a run that would have used a
 * different one is refused rather than silently run: see
 * `WorkflowRunSteps.checkCall`, which is where the pin is actually enforced,
 * and which documents exactly how strong the enforcement is.
 *
 * ## What crosses the boundary
 *
 * The same thing that crosses every other boundary here: **handles, never
 * rows.** The child receives a {@link WorkflowCallEnvelope} — the run id, this
 * node's id, and the {@link WorkflowStageRef}s of its inputs — and reads the
 * rows out of the stage store itself if it wants them. A child that produces
 * rows for the graph writes them into the stage store under *this node's* id
 * and returns their shape, which {@link readWorkflowCallOutput} narrows.
 *
 * There is no shared type between a catalog node and an arbitrary durable
 * workflow, and this model does not pretend there is. What it does instead is
 * make the mismatch loud: the envelope is one documented shape, the accepted
 * answers are two documented shapes, and anything else fails the node naming
 * the workflow, the version and the child run id.
 *
 * ## `config` is not a credential store
 *
 * Named `config` rather than `input` so it travels the same path a source
 * node's config does — sealed under `encryptCredentials`, refused in plaintext
 * without it — because a parameter bag that reaches a worker over a queue is
 * exactly the shape a password ends up in. Prefer naming an env var the callee
 * already reads.
 */
export interface WorkflowCallNode extends WorkflowNodeBase {
  kind: 'call';
  /**
   * The workflow's registered name, on the wire — the string `engine.start`
   * takes. A class reference is unavailable by construction: the point of this
   * node is calling something the catalog does not compile against, including a
   * body that lives in Python.
   */
  callName: string;
  /**
   * The registered **version**, as the durable engine spells it: a string, and
   * `'1'` for anything registered without one.
   *
   * Not to be confused with {@link CatalogWorkflow.version}, which counts edits
   * to *this* graph and is a number. This one identifies somebody else's code.
   */
  callVersion: string;
  /** Parameters the author typed, handed to the child under `input`. */
  config: Record<string, unknown>;
}

/**
 * A discriminated union, so narrowing a node is `node.kind === "sink"` and
 * never a type assertion. This is why the kind list is not simply a string on
 * one node shape with every field optional: that shape lets a source node carry
 * a `transformId` and nothing catches it.
 */
export type WorkflowNode =
  | WorkflowSourceNode
  | WorkflowTransformNode
  | WorkflowSinkNode
  | WorkflowCallNode;

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
 * **Only the latest shape is kept, and unlike a transform it is not
 * revisioned.** That asymmetry is a decision rather than an oversight, and this
 * is where somebody looking for the missing feature will look, so it is argued
 * here.
 *
 * A transform's code and a saved query's SQL are text a person typed, and
 * {@link CatalogRevision} archives text: two bodies, a line differ, done. A
 * graph is a structure. Its "body" would be JSON nobody wrote, and a text diff
 * over it is dominated by key order and canvas positions — it would report a
 * dragged box as a change to what the load does, which is the opposite of what
 * {@link workflowGraphHash} is careful to exclude. Diffing graphs is a graph
 * problem and deserves a screen that draws one, not a line differ pointed at
 * serialised nodes.
 *
 * The decisive reason is the counter. {@link version} is bumped on **draft**
 * edits deliberately — see the note on it — so that a run's `workflowVersion`
 * can never mean two different graphs. Archiving one body per version would
 * therefore store every autosave of a canvas somebody is still dragging boxes
 * around on, and under the per-subject cap that {@link CATALOG_REVISION_LIMIT}
 * imposes, that noise would evict the versions that actually ran. A counter
 * designed to be cheap to inflate and an archive designed to be bounded do not
 * compose; making them compose means keying the archive on behaviour rather than
 * on saves, which is what `graphHash` already is, and that is a different
 * feature from this one.
 *
 * So the limitation stays, stated plainly: an edited graph cannot be
 * reconstructed from an old run, only identified as different. A diff screen
 * answers for the code and the SQL and not for the wiring.
 */
/**
 * Whether this graph is still being drawn, or is something somebody declared
 * finished.
 *
 * The distinction exists because validation used to be the gate on *saving*, and
 * that made an unfinished graph unstorable: `saveWorkflow` refused anything
 * `validateWorkflow` had an issue with, so a canvas with one node on it could
 * not be written down at all and closing the tab lost it. Worse, it made the
 * canvas lie about ordinary work — clicking "+ Sink" produces a node that is
 * unreachable from any source and names no type, both true and both useless one
 * second after the click, because a just-added node is unwired by construction.
 *
 * So the gate moved rather than loosened. Validation is now the gate on
 * publishing, and the same `validateWorkflow` still decides — a draft is not a
 * graph that skipped the rules, it is a graph nobody has claimed is finished
 * yet. Everything that consumes a workflow asks for `ready`: a connector may
 * only point at one, and a promotion may only carry one. What crosses an
 * environment should be something a person declared done.
 */
export const WORKFLOW_STATUSES = [
  /**
   * Being drawn. Saves without validating, and cannot run, be scheduled, or be
   * promoted. An incomplete node here is the normal state rather than an alarm.
   */
  'draft',
  /**
   * Declared finished, and validated at the moment it was declared. This is the
   * only status a connector may point at and the only one a promotion carries.
   */
  'ready',
] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

/** Same reason as {@link isConnectorKind}: one list, no second copy to drift. */
export function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  return WORKFLOW_STATUSES.some((status) => status === value);
}

export interface CatalogWorkflow {
  id: string;
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** See {@link WORKFLOW_STATUSES}. A graph is `draft` until somebody publishes it. */
  status: WorkflowStatus;
  /**
   * Bumped whenever the graph's behaviour changes. Never on a rename or a move.
   *
   * Bumped on a **draft** edit too, which looks like exactly the inflation this
   * rule exists to prevent and is not. The counter's job is to make
   * {@link ConnectorRun.workflowVersion} answer "which shape ran": freezing it
   * while a graph is drafted would let a run recorded at v4 and a later run also
   * at v4 mean two different graphs, which is the one thing that field must
   * never do. Drafting therefore inflates a number nobody reads — cheap — rather
   * than making a number somebody does read ambiguous.
   */
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
  /**
   * Cron-ish, interpreted by whatever schedules it. Empty means manual only.
   *
   * **Authored here, on the graph, and nowhere else.** It used to live on the
   * connector, which was defensible while a connector was a thing somebody
   * created and is not now that one is minted: a schedule is a statement about
   * a pipeline, and the pipeline is the graph. The connector keeps a copy for
   * evidence — see {@link CatalogConnector.schedule} — and `ConnectorScheduler`
   * reads this field rather than that one, so there is one authority.
   *
   * Only a `ready` graph is scheduled. A draft carrying a cron is a load nobody
   * declared finished, and the scheduler says so out loud rather than skipping
   * it quietly; that silence is the exact shape of the incident this field's
   * predecessor caused.
   */
  schedule?: string;
  /**
   * Whether this graph runs at all.
   *
   * Both halves of the old `isScheduled` test now live on the workflow, because
   * splitting them across two rows is what made "my connector is enabled but
   * nothing runs" a question with two places to look. Defaults true: a graph
   * somebody went to the trouble of publishing is one they meant to run.
   */
  enabled: boolean;
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
  /**
   * The operator's reason for expecting this load to lose rows. Read only by
   * the sink, and absent on every scheduled run by construction.
   *
   * On the step input rather than fetched at the sink because a durable step
   * has to be a pure function of what was checkpointed — see the note where
   * this is passed in `CatalogWorkflowRunWorkflow`.
   */
  expectShrink?: string;
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

/**
 * The number in {@link WorkflowCallEnvelope.contract}.
 *
 * A version on the *shape the catalog sends*, separate from the version of the
 * workflow being called, because the two change for different reasons and a
 * callee written against one has to be able to say which. A callee that reads
 * this and does not recognise it should refuse rather than guess — a failed
 * child is a failed node with a name attached, and a guess is a load nobody can
 * account for.
 */
export const WORKFLOW_CALL_CONTRACT = 1;

/**
 * What a {@link WorkflowCallNode} hands its child.
 *
 * One documented shape, and the whole of what the catalog promises a callee.
 * Everything the catalog knows sits under `catalog`, and everything the author
 * typed sits under `input`, so a parameter called `runId` cannot ever shadow
 * the run id — which is the kind of collision that only shows up in production
 * on somebody else's graph.
 *
 * Handles, never rows: `inputs` names the stages this node's inbound edges
 * produced, in edge order, and the rows themselves stay in the stage store
 * addressed by `(runId, nodeId, batch)` — one row per batch, keyed
 * `runId#nodeId#batch`. A callee in another SDK reads them from there. Passing
 * the rows would write the whole intermediate dataset into
 * `durable_step_checkpoints` as the child's input, once per call and again on
 * every replay, which is the measurement {@link WorkflowStageRef} exists for.
 */
export interface WorkflowCallEnvelope {
  catalog: {
    /** {@link WORKFLOW_CALL_CONTRACT} at the time the call was made. */
    contract: number;
    /** The catalog run, which is also the snapshot id and the stage key. */
    runId: string;
    /** The calling node. Also the id any rows for the graph must be staged under. */
    nodeId: string;
    workflowId: string;
    /** The **graph's** version, not the callee's. See {@link WorkflowCallNode.callVersion}. */
    workflowVersion: number;
    principalId: string;
    /** The stages this node reads, in inbound-edge order. Empty for a call with no input. */
    inputs: WorkflowStageRef[];
  };
  /** {@link WorkflowCallNode.config}, verbatim. Opaque to the catalog. */
  input: Record<string, unknown>;
}

/** What a called workflow may say it staged. Both counts, or neither. */
export interface WorkflowCallOutput {
  /** Batches written under `(runId, nodeId, 1..batches)`. */
  batches: number;
  rowCount: number;
}

/**
 * Read a child's return value as staged rows — or as nothing, or refuse it.
 *
 * Three answers rather than two, because a call has two legitimate purposes and
 * they must not be confused with a bug:
 *
 * - `undefined` — the child returned nothing this graph can read rows from. A
 *   perfectly ordinary outcome for a workflow called for its effect, and the
 *   node reports zero rows, out loud, in its logs. It is not silently treated
 *   as success-with-data: a full sink that then receives nothing refuses to
 *   commit an empty snapshot, which is the loud end of this path.
 * - a {@link WorkflowCallOutput} — the child staged rows for this node.
 * - a **throw** — the child answered with `batches`/`rowCount` that are not
 *   usable counts. Half a contract is a bug in the callee, and reading it as
 *   "no rows" would turn that bug into a load that quietly came out short.
 *
 * The catalog cannot check any of this before the graph runs; there is no
 * schema for a workflow's output anywhere in the durable contract, and no way
 * to reach one if there were. So the check is here, at the one moment the
 * answer exists, and it names what it saw.
 */
export function readWorkflowCallOutput(value: unknown): WorkflowCallOutput | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const batches = Reflect.get(value, 'batches');
  const rowCount = Reflect.get(value, 'rowCount');
  if (batches === undefined && rowCount === undefined) return undefined;
  if (!isCount(batches) || !isCount(rowCount)) {
    throw new Error(
      `It answered with batches=${describeCount(batches)} and rowCount=${describeCount(
        rowCount,
      )}. A workflow that stages rows for a call node returns both as whole numbers of at least zero; returning one of them, or a value that is not a count, would leave this node to guess how much of the stage to read.`,
    );
  }
  return { batches, rowCount };
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function describeCount(value: unknown): string {
  return value === undefined ? 'nothing' : JSON.stringify(value);
}

/**
 * One workflow a call node could name.
 *
 * Declared here with nothing producing it yet, and that is deliberate rather
 * than premature: a picker needs a list, and **no such list exists**. The
 * durable engine can answer `workflowBody(name, version)` for the process
 * asking and nothing more — and a missing body is ambiguous, since it equally
 * means a body registered in another SDK through `registerRemote` or a group
 * resolved by convention against a live worker. Inferring the list from what
 * one pod happens to know would produce a picker that omits exactly the
 * cross-SDK workflows this node exists to call.
 *
 * So the node takes a name and a version as authored text today, and this is
 * the shape a canvas should be handed the day a deployment can announce its
 * registrations. One entry per **version**, never per name: a picker that
 * listed names and resolved the version for you would undo the pin.
 */
export interface CallableWorkflowRef {
  name: string;
  version: string;
  /** What it does, if the deployment publishes one. Shown beside the name. */
  description?: string;
  /**
   * The worker group its turns are dispatched to, when it has one. The signal
   * that says "this one's body is not in this process" — a Python workflow, or
   * a separate TS worker — which is precisely what a caller cannot otherwise
   * tell from a missing body.
   */
  group?: string;
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
  'call-not-named',
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
  const originators = nodes.filter(originatesRows);
  const sinks = nodes.filter((node): node is WorkflowSinkNode => node.kind === 'sink');

  checkNodeWiring(nodes, incoming, outgoing, issues);
  checkEndpoints(originators, sinks, issues);

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

  checkReachability(nodes, originators, sinks, incoming, outgoing, issues);

  return issues;
}

/**
 * Whether a node can produce rows without anything wired into it.
 *
 * A source obviously can. A **call** node can too, and this is the one rule the
 * `call` kind changes rather than extends: the workflow it hands off to may
 * itself read from a system, so a graph of `call → sink` is a real pipeline and
 * refusing it for having "no source" would be false. What is not weakened is
 * that a graph still needs *something* that originates rows and *something*
 * that commits them — a graph of transforms alone is still refused.
 *
 * Every call node counts, not only the ones with no inbound edge, and that is
 * the conservative direction: it makes this the root set for reachability too,
 * so a mid-graph call node cannot make everything downstream of it look
 * unreachable when its own upstream is fine.
 */
function originatesRows(node: WorkflowNode): boolean {
  return node.kind === 'source' || node.kind === 'call';
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
    const unconfigured = nodeIsUnconfigured(node);
    if (unconfigured) issues.push(unconfigured);
  }
}

/**
 * A node that names none of the thing it exists to run.
 *
 * The two kinds that point at something outside themselves — a transform at
 * stored code, a call at a registered workflow — and both are reported the same
 * way because they are the same mistake: a box on the canvas with nothing
 * behind it, which looks finished and fails at run time.
 */
function nodeIsUnconfigured(node: WorkflowNode): WorkflowValidationIssue | undefined {
  if (node.kind === 'transform' && node.transformId.length === 0) {
    return {
      code: 'transform-not-named',
      nodeIds: [node.id],
      message: `Transform node "${node.name}" (${node.id}) names no transform, so there is no code for it to run.`,
    };
  }
  if (node.kind === 'call') return callIsUnnamed(node);
  return undefined;
}

/**
 * A call that names half of what it needs, or nothing at all.
 *
 * Both halves, checked separately, because the version is the one people leave
 * blank: a call that named only a workflow would run whichever version happens
 * to be registered on the day the load runs, which is the single thing this
 * node is built not to do.
 */
function callIsUnnamed(node: WorkflowCallNode): WorkflowValidationIssue | undefined {
  if (node.callName.length > 0 && node.callVersion.length > 0) return undefined;
  return {
    code: 'call-not-named',
    nodeIds: [node.id],
    message: `Call node "${node.name}" (${node.id}) does not name ${
      node.callName.length === 0 ? 'a workflow to call' : 'a version of the workflow it calls'
    }. A call pins a name and a version together — without the version it would run whichever one is registered when the load happens, and somebody else's deploy would change what this graph does.`,
  };
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
  originators: readonly WorkflowNode[],
  sinks: readonly WorkflowSinkNode[],
  issues: WorkflowValidationIssue[],
): void {
  if (originators.length === 0) {
    issues.push({
      code: 'no-source',
      nodeIds: [],
      message:
        'This workflow has nothing that reads: no source node, and no call node handing off to a workflow that reads. Nothing would ever be fetched and the sink would commit an empty snapshot.',
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

/** Nodes that nothing reading reaches, and nodes that reach no sink. */
function checkReachability(
  nodes: readonly WorkflowNode[],
  originators: readonly WorkflowNode[],
  sinks: readonly WorkflowSinkNode[],
  incoming: Map<string, string[]>,
  outgoing: Map<string, string[]>,
  issues: WorkflowValidationIssue[],
): void {
  const reachableFromSources = walk(
    originators.map((node) => node.id),
    outgoing,
  );
  const reachesASink = walk(
    sinks.map((sink) => sink.id),
    incoming,
  );

  for (const node of nodes) {
    if (originators.length > 0 && !reachableFromSources.has(node.id)) {
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
  if (node.kind === 'call') {
    // The called version IS in here, and that is the opposite choice from a
    // transform above — for the reason the two differ. A transform's version is
    // this catalog's own record of an edit somebody made here; a call's version
    // is a different piece of code entirely. Repointing a node from `foo@1` to
    // `foo@2` changes what the load does as surely as rewiring it does, so it
    // is a new version of the graph and the run that used the old one stays
    // identifiable.
    return JSON.stringify([
      node.id,
      node.kind,
      node.callName,
      node.callVersion,
      sortedEntries(node.config),
    ]);
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
  if (kind === 'call') {
    // Both strings, and the config object, exactly as strictly as a source's:
    // a stored call node missing its version is a node that would run whatever
    // is registered today, which is the failure the pin exists to remove — and
    // a graph that half-narrows is a load that runs nine nodes of ten.
    const config = Reflect.get(value, 'config');
    return (
      typeof Reflect.get(value, 'callName') === 'string' &&
      typeof Reflect.get(value, 'callVersion') === 'string' &&
      typeof config === 'object' &&
      config !== null &&
      !Array.isArray(config)
    );
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
   * Writes. Validates only what it must.
   *
   * A **draft** is written without validating, which is the whole of the change
   * and the reason {@link WORKFLOW_STATUSES} exists: a graph you have not
   * finished has to be storable, or closing the tab loses it. A **ready**
   * workflow is still validated on every save, because it is the one that runs.
   *
   * `status` is not an input. A save cannot promote a draft to ready — that is
   * {@link publishWorkflow}, which exists so there is one place that validates
   * and one place that can explain why it refused. A save of an already-ready
   * workflow keeps it ready, and **refuses an edit that would make it invalid**
   * rather than quietly demoting it to draft. Demotion was the other option and
   * it is the one that loses a running pipeline silently: a connector may only
   * point at a ready graph, so a save that dropped the status would disable a
   * scheduled load with nothing said to anybody. Refusing puts the error in
   * front of the person who is editing, at the moment they edit. To park a
   * broken idea on a live graph, {@link unpublishWorkflow} it first — which
   * disables the connector it runs as, so the parking is visible rather than a
   * graph that is quietly still on a cron.
   *
   * `schedule` and `enabled` are not inputs either, and for a different reason
   * from the derived three: they are authored, but not *here*. See
   * {@link saveWorkflowSchedule} for why a cron must not ride along on an
   * autosave.
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
  /**
   * Declare a graph finished: validate it, and make it `ready`.
   *
   * A transition rather than a field on save, and the argument is that this is
   * the only shape with somewhere to put the refusal. "Ready" is a claim that
   * has to be checked, and a check that fails owes an explanation naming the
   * nodes — `validateWorkflow` produces exactly that, and a boolean field on a
   * save request has nowhere to return it that is not an error on an operation
   * the caller thought was about something else. It also makes the audit
   * question answerable: publishing is an act with an actor, and a field set in
   * passing during an autosave is not.
   *
   * Idempotent on an already-ready graph, because the honest answer to "publish
   * this thing that is published" is the graph, not an error.
   *
   * **Publishing is also what mints the connector.** That is the load-bearing
   * half of "the workflow is the only thing anybody authors": there is no
   * `POST connectors` any more, so this is the only way one comes into
   * existence. The minted row carries this workflow's id, its sink's type, its
   * schedule and its enabled flag, and it is the identity every later run,
   * watermark and mutex is keyed on — so publishing an already-published graph
   * must **update** that row rather than mint a second one, or a re-publish
   * would orphan a pipeline's entire history.
   */
  publishWorkflow(id: string, publishedBy: string): Promise<CatalogWorkflow>;
  /**
   * Take a graph back to `draft`, and stop what it was running.
   *
   * This used to refuse while any connector still ran the graph, on the reasoning
   * that unpublishing one out from under a schedule breaks a working load and the
   * operator should point those connectors elsewhere first. That reasoning
   * assumed a connector was an independently authored object that could be
   * pointed somewhere; it no longer is. A published graph now has exactly one
   * connector and it is this graph's own, so the old refusal would refuse
   * every unpublish there is — a rule that always fires is not a rule.
   *
   * So the cascade the old docblock argued against is now the correct behaviour,
   * and the thing it was protecting is protected differently: the connector is
   * **disabled, not deleted**. Its id, its run history and its watermark all
   * survive, so re-publishing resumes the same pipeline rather than starting a
   * new one, and nothing silently keeps running in the meantime.
   */
  unpublishWorkflow(id: string, unpublishedBy: string): Promise<CatalogWorkflow>;
  /**
   * Delete the graph and the connector it ran as.
   *
   * Cascading for the reason {@link unpublishWorkflow} gives — the connector is
   * this graph's own and there is nowhere else to point it — and destructive
   * here rather than disabling, because the graph is going too and a connector
   * whose workflow does not exist is precisely the dangling row this cascade
   * exists to avoid leaving behind.
   */
  deleteWorkflow(id: string): Promise<boolean>;
  /**
   * The connector this graph runs as, as a list.
   *
   * A list rather than an optional single value, because that is what it
   * honestly is: a store predating this change may hold several connectors
   * pointing at one graph, and answering with the first would hide the rest from
   * the operator who has to reconcile them. A graph published under the current
   * rules has exactly one.
   */
  connectorsUsingWorkflow(id: string): Promise<CatalogConnector[]>;
  /**
   * Set when this graph runs, and whether it runs.
   *
   * Its own method rather than fields on {@link saveWorkflow}, and for the
   * reason `saveConnectorState` is separate from `saveConnector`: a canvas
   * autosaves. A cron folded into the save every drag of a node passes through
   * is a cron that a stale editor tab can silently revert, and the symptom would
   * be a load that stopped running with a diff nobody made.
   *
   * Writes through to the minted connector's copy in the same call, so the two
   * cannot be observed disagreeing.
   */
  saveWorkflowSchedule(
    id: string,
    input: { schedule?: string; enabled?: boolean },
    changedBy: string,
  ): Promise<CatalogWorkflow>;
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
    typeof store.saveWorkflow === 'function' &&
    // Asked for by name like the rest, rather than assumed to come with
    // `saveWorkflow`. Promotion publishes what it saves, so a store that has the
    // save and not the transition would narrow cleanly here and then fail one
    // call later, in the middle of an apply that has already written types and
    // transforms into the target.
    typeof store.publishWorkflow === 'function' &&
    // Asked for by name for the same reason `publishWorkflow` is, and it earned
    // the place the hard way: a schedule authored on a graph is worthless if the
    // store cannot hold one, and a predicate that narrowed without checking
    // would let the schedule route resolve, accept a cron, and throw
    // "saveWorkflowSchedule is not a function" at the person who typed it. This
    // is the surface a scheduling incident already came through once.
    typeof store.saveWorkflowSchedule === 'function'
  );
}

/**
 * Whether this store keeps a transform's history.
 *
 * The method rather than a flag, exactly as {@link supportsWorkflows} argues: a
 * flag is a claim and a method is the thing itself.
 */
export function supportsTransformRevisions(
  store: CatalogPipelineStore,
): store is CatalogPipelineStore & Required<Pick<CatalogPipelineStore, 'listTransformRevisions'>> {
  return typeof store.listTransformRevisions === 'function';
}

export function supportsWorkflowStages(
  store: CatalogPipelineStore,
): store is CatalogPipelineStore & CatalogStageStore {
  return typeof store.writeStage === 'function' && typeof store.readStage === 'function';
}

/**
 * A store that really does hold operator-set expectations, all four members
 * present.
 *
 * Derived from {@link CatalogPipelineStore} rather than declared as a separate
 * interface the way {@link CatalogWorkflowStore} is, and the difference is not
 * stylistic: these four are optional members OF the pipeline store, so writing
 * them out a second time here would be a copy that can drift from the one the
 * signatures are read from. `CatalogWorkflowStore` predates that lesson and is
 * mixed in through `Partial<>`, which reaches the same place from the other
 * side.
 */
export type CatalogLoadExpectationStore = Required<
  Pick<
    CatalogPipelineStore,
    'listLoadExpectations' | 'getLoadExpectation' | 'saveLoadExpectation' | 'clearLoadExpectation'
  >
>;

/**
 * Whether an operator can set a load expectation on this deployment at all.
 *
 * The methods rather than a flag, the same argument as {@link supportsWorkflows}
 * — and all four of them by name rather than one standing in for the rest, for
 * that function's other reason: the write path and the read path are used at
 * different moments, so a store with the getter and not the setter would narrow
 * cleanly here and fail on the save, after the screen had already offered an
 * editor.
 *
 * A store that has none of them is not broken and is not second-class. It
 * behaves exactly as every store did before this existed: the host's
 * `CATALOG_LOAD_EXPECTATIONS` object is the only layer, which is a complete and
 * supported answer. What this probe buys is that the console can say "this
 * deployment's store cannot hold operator-set expectations" instead of offering
 * an editor whose save has nowhere to go.
 */
export function supportsLoadExpectations(
  store: CatalogPipelineStore,
): store is CatalogPipelineStore & CatalogLoadExpectationStore {
  return (
    typeof store.listLoadExpectations === 'function' &&
    typeof store.getLoadExpectation === 'function' &&
    typeof store.saveLoadExpectation === 'function' &&
    typeof store.clearLoadExpectation === 'function'
  );
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
  /**
   * Every version of this transform's code, newest first.
   *
   * **Optional**, mixed in for the same reason {@link CatalogWorkflowStore} is:
   * a store written against the previous shape of this interface still
   * implements it, and turning that into a compile error would be a breaking
   * change for an additive feature. {@link supportsTransformRevisions} is how a
   * caller asks, so a deployment whose store keeps no history gets a sentence
   * rather than a method that is missing at run time.
   *
   * The list is what makes `transformVersion` on a run mean something: the
   * revision whose {@link CatalogRevision.version} equals it holds the code that
   * produced those rows. Bounded — see {@link CATALOG_REVISION_LIMIT} for what
   * that bound costs.
   */
  listTransformRevisions?(id: string): Promise<CatalogRevision[]>;

  /**
   * Per-type load expectations as an operator set them.
   *
   * **Optional**, and here more deliberately than anywhere else in this
   * interface. `@dudousxd/nestjs-catalog-store-mikro-orm` is not the only
   * implementation — a host may have written its own against an earlier shape of
   * this file — and every one of them satisfies `CatalogPipelineStore` today.
   * Widening it with four required members would turn all of them into compile
   * errors for a feature that is purely additive, and, worse, would do it
   * *silently* to the ones checked structurally: `isPipelineStore` and the
   * `supports*` probes narrow on methods, so a store that no longer satisfies
   * the interface is discovered by a caller, at run time, rather than by a build.
   * {@link supportsLoadExpectations} is how a caller asks, and a store that
   * implements none of these behaves exactly as it does today — the host's
   * `CATALOG_LOAD_EXPECTATIONS` object is then the whole policy.
   *
   * These hold rows; they do not resolve them. Precedence — a host's `byType`
   * entry over a stored row over the host's `default`, field by field — is the
   * pipeline package's business, beside the enforcement functions that consume
   * it, and it stays pure and synchronous. A store that resolved would be a
   * second place the precedence is decided, which for a policy whose whole point
   * is "somebody decided this" is the one duplication that cannot be tolerated.
   */
  listLoadExpectations?(): Promise<StoredLoadExpectation[]>;
  getLoadExpectation?(typeName: string): Promise<StoredLoadExpectation | undefined>;
  /**
   * Upsert, keyed by type name, recording the principal and the instant.
   *
   * `setBy` and `setByActor` are arguments rather than fields on the
   * `expectation` for the reason `startRun` records attribution the way it does:
   * a caller cannot claim them. `setAt` is not an input at all — a stored
   * timestamp a client could choose is not an audit record.
   *
   * `setByActor` is the person behind the principal when there was one. The
   * write route requires a human, so in practice there always is; it is
   * separate from `setBy` because a principal is a key and an actor is a
   * subject, and the trail needs the second to answer "who decided this".
   */
  saveLoadExpectation?(
    typeName: string,
    expectation: Pick<StoredLoadExpectation, 'deletes' | 'rowCount'>,
    setBy: string,
    setByActor?: string,
  ): Promise<StoredLoadExpectation>;
  /**
   * Drop the stored row for a type. The host's layer is untouched, so a type the
   * deployment declared in code keeps that declaration.
   *
   * `false` means there was nothing stored, which is a fact a caller may report
   * and never an error.
   */
  clearLoadExpectation?(typeName: string): Promise<boolean>;

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
