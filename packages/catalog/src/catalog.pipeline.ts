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
import { CATALOG_REVISION_LIMIT, type CatalogRevision } from './catalog.workspace';

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
 * How the bytes behind a `file` or `s3` connector are read as records.
 *
 * A list rather than a loose string, for the reason {@link CONNECTOR_KINDS} is
 * one: this used to be compared against string literals in the parser and
 * spelled out again in a dropdown, and the two had no way to disagree loudly.
 * The parser's chain also *ended* in JSON, so a format it did not recognise was
 * not refused — it was read as JSON, and a spreadsheet handed to `JSON.parse`
 * fails with a syntax error that names a byte offset rather than the format.
 *
 * `xlsx` is the odd one and is named for what it is: the only member whose
 * payload is binary. The other three are text, and everything that reads them
 * decodes the bytes first. Anything deciding something *per format* narrows
 * against this and answers {@link unreachableSourceFormat}.
 */
export const SOURCE_FORMATS = [
  /** Delimited text with a header row. The delimiter is configurable. */
  'csv',
  /** One JSON value per line. */
  'ndjson',
  /** A JSON document, optionally with the array nested in an envelope. */
  'json',
  /**
   * A spreadsheet workbook — binary, and the only member that is.
   *
   * Named for the modern extension, but the reader identifies the container
   * from its own bytes, so the legacy `.xls` and the macro-enabled `.xlsm` are
   * this format too rather than three names for one decision.
   */
  'xlsx',
] as const;

export type SourceFormat = (typeof SOURCE_FORMATS)[number];

/** Same reason as {@link isConnectorKind}: one list, no second copy to drift. */
export function isSourceFormat(value: unknown): value is SourceFormat {
  return SOURCE_FORMATS.some((format) => format === value);
}

/**
 * The format that never compiles quietly.
 *
 * The {@link unreachableNodeKind} of formats, and it exists for the same reason:
 * a member added to {@link SOURCE_FORMATS} without a branch in the parser should
 * be a type error naming the file, not a connector that offers a format in a
 * dropdown and then reads the file as JSON.
 *
 * It throws as well as failing to compile, because a connector config is JSON
 * that outlives the build that wrote it: a `format` stored by a newer deployment
 * and read by an older one is possible, and falling back to a default for it
 * would be exactly the silent path this closes.
 */
export function unreachableSourceFormat(format: never, where: string): never {
  throw new Error(
    `${where} does not handle a source format of ${JSON.stringify(format)}. The format list and every decision made per format are meant to move together.`,
  );
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
   * The body of a function over one batch. It receives `records` and
   * `context`, and returns the rows to store.
   *
   * A batch rather than a record at a time: a transform that needs to look up,
   * deduplicate or aggregate cannot do it one row at a time, and paying one
   * process spawn per record would make any real load unusable.
   *
   * `context` is a {@link CatalogCodeContext} — the run, the node, the counts
   * of what fed it, and the environment variables this deployment admits.
   * Second rather than first, so that every transform written before it existed
   * still runs: the harness supplies the parameter, and code that never names
   * it is unaffected.
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
    options?: { timeoutMs?: number; context?: CatalogCodeContext },
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

/**
 * The number in {@link CatalogCodeContext.contract}.
 *
 * Its own version, separate from {@link WORKFLOW_CALL_CONTRACT}, because the
 * two travel to different places for different reasons — a call envelope
 * crosses to another SDK over the durable wire, a code context crosses to a
 * child process this repository spawned — and a transform written against one
 * has to be able to say which it read.
 */
export const CODE_CONTEXT_CONTRACT = 1;

/**
 * The second argument every code-bearing node's code is handed.
 *
 * ## Why this exists at all
 *
 * A transform is a function over a batch, and a batch is not the whole of what
 * the code needs to know. It needs the credential for the API it enriches
 * against; it needs to say which run it belongs to when it logs; and — the case
 * that motivated this — a conditional node's predicate has no `records` at all
 * and still has to answer "did the source return anything", which is the guard
 * that stops an empty snapshot being committed over live data.
 *
 * ## Why it is not `process.env`
 *
 * The obvious answer to "code needs environment variables" is to stop trimming
 * the child's environment. It is the wrong one, and this repository has already
 * argued the case in `secret-env-allowlist.ts`: a `secretEnvVar` is chosen by
 * whoever writes the connector, so `process.env[name]` with nothing in between
 * let anyone holding `catalog:write` on one narrow object type read the host
 * application's own `DATABASE_URL`. Transform code is *the same principal by a
 * shorter route* — it is a string that principal saved, and it can print
 * whatever it reads into `logs`, which land in the run record and are served at
 * `catalog:read`.
 *
 * So {@link env} is the allow-listed environment and nothing else: the same
 * policy, the same two levers, the same boot warning. One rule across the
 * product rather than a second one that quietly undoes the first. What the
 * child's *own* `process.env` holds is unchanged — still `{PATH, NODE_ENV}` —
 * and the admitted values arrive as data on stdin instead.
 *
 * ## Replay
 *
 * Everything here is plain JSON, and everything except {@link env} and
 * {@link environment} is derived from a durable step's checkpointed input: the
 * run id, the node, the graph's version and the stage handles are byte-
 * identical on every attempt and on every replay. Those two are reads of
 * pod-local state, which for a transform is harmless — a transform runs inside
 * a step whose *output* is checkpointed, so replay returns the answer rather
 * than re-running the code — and for a predicate evaluated in a workflow body
 * is not. A caller in that position must resolve the context inside a step and
 * let the checkpoint carry it, so that a redeploy between the original run and
 * the replay cannot move the branch. The shape is JSON precisely so that it can
 * be.
 */
export interface CatalogCodeContext {
  /** {@link CODE_CONTEXT_CONTRACT} at the time the code ran. */
  contract: number;
  /**
   * The run this code belongs to, which is also the snapshot id.
   *
   * Absent means there is no run: the editor's try pane executes code against
   * sample records and stores nothing. Anything derived from this — an
   * idempotency key, a filename — should refuse rather than invent one, and the
   * absence is the signal that lets it.
   */
  runId?: string;
  /** The graph, when the code is a node in one. Absent for a connector's single transform. */
  workflow?: { id: string; name: string; version: number };
  /** The node, when the code is a node. Absent for a connector's single transform. */
  node?: { id: string; name: string };
  /** The connector, when the code runs as a connector's transform rather than in a graph. */
  connectorId?: string;
  /**
   * The host's name for this copy of the world — `dev`, `prod` — when the host
   * declared one.
   *
   * Nothing in the catalog can work this out for itself: a process may serve
   * several environments and the choice arrives per request, so the only
   * honest source is the host saying so. Present because branching on a named
   * environment is legible in a way that sniffing a variable is not, and absent
   * whenever the host stayed silent, which is a different thing from `dev`.
   */
  environment?: string;
  /**
   * How many records reached this code.
   *
   * Redundant with `records.length` for a transform and the whole payload for a
   * predicate, which has no records. Stated as one number because the line a
   * predicate is written to hold is "did anything arrive", and making that a
   * sum over {@link inputs} invites `inputs[0].rowCount`, which is wrong the
   * moment somebody draws a second edge.
   */
  rowCount: number;
  /**
   * Per inbound edge, in edge order — handles and counts, never the rows.
   *
   * The same {@link WorkflowStageRef} the call node hands a callee, deliberately
   * rather than a second vocabulary for the same fact. Empty outside a graph.
   */
  inputs: WorkflowStageRef[];
  /**
   * The environment variables this deployment admits, and only those.
   *
   * Filtered by the credential allow-list — see `secret-env-allowlist.ts` — so
   * a name nobody admitted is not here, and an empty object is the ordinary
   * answer on a deployment that has declared no policy. The run's logs say
   * which it was.
   */
  env: Record<string, string>;
}

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

/**
 * Why a `skipped` node did not run, when there is more to say than "the run
 * stopped".
 *
 * **One entry, and the omission is the point.** `skipped` already meant one
 * thing before branches existed — the run failed upstream and never reached
 * this node — and every outcome ever stored records that meaning by *not*
 * carrying a reason. Adding `run-stopped` to this list would not describe those
 * rows, it would leave them describing an unknown reason, so the pre-existing
 * meaning stays the absent one and this names only the new fact: the node is on
 * a branch an {@link WorkflowIfNode} did not take.
 *
 * The distinction is not cosmetic. A sink skipped by a branch **committed
 * nothing and left the live snapshot alone**, which is a correct, successful
 * outcome; a sink skipped by a failure is part of a load that went wrong. A run
 * panel that rendered both as "did not run" would answer "why is there no data
 * in X" with the same shrug in both cases.
 */
export const WORKFLOW_SKIP_REASONS = ['branch-not-taken'] as const;

export type WorkflowSkipReason = (typeof WORKFLOW_SKIP_REASONS)[number];

/** Same reason as {@link isConnectorKind}: one list, no second copy to drift. */
export function isWorkflowSkipReason(value: unknown): value is WorkflowSkipReason {
  return WORKFLOW_SKIP_REASONS.some((reason) => reason === value);
}

/** What one node did during a run. Small by construction — counters, not rows. */
export interface WorkflowNodeOutcome {
  /**
   * `skipped` exists for the nodes downstream of a failure. Without it, a
   * ten-node graph that died at node seven records three nodes with no entry at
   * all, which reads the same as three nodes nobody has looked at yet.
   *
   * It now carries a second, legitimate meaning as well — a node on the branch
   * an `if` did not take — and {@link skippedBecause} is what tells the two
   * apart.
   */
  status: 'succeeded' | 'failed' | 'skipped';
  /** Rows this node produced, or committed if it is the sink. */
  rows: number;
  /**
   * Rows this node was *given*, for a node whose whole purpose is that the two
   * numbers differ. Set by {@link WorkflowFilterNode} and absent everywhere else.
   *
   * Two numbers rather than a `dropped` counter, because `dropped` is
   * `rowsIn - rows` and a third stored number is a third thing that can
   * disagree with the other two. A run panel subtracts.
   *
   * Optional, so an outcome written before filters existed reads back as what it
   * is — a node that never reported an input count — rather than as one that
   * received nothing. Absent and zero are different facts here, and conflating
   * them would make every historical transform look like it dropped everything.
   */
  rowsIn?: number;
  /** For a transform node: which version of its code ran. */
  transformVersion?: number;
  /**
   * For an {@link WorkflowIfNode}: the branch this run took.
   *
   * **Written once, on the first evaluation, and read back on every replay.**
   * This is the record the durable path replays from rather than re-evaluating:
   * a predicate reads the environment, and an environment is pod-local, so a
   * replay landing on another pod could otherwise take the other branch halfway
   * through a run and load through a shape nobody chose. See
   * `WorkflowRunnerService.runIf`.
   *
   * It is also the answer to "why did nothing load into X", which is the
   * question a branch makes askable and nothing else on a run can answer.
   */
  branch?: WorkflowBranchLabel;
  /** See {@link WORKFLOW_SKIP_REASONS}. Absent means the run stopped short. */
  skippedBecause?: WorkflowSkipReason;
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
 * - **filter** — *this entry used to be a rejection, and it is worth leaving the
 *   reversal visible rather than editing the history out.* The argument was that
 *   a transform whose code returns a subset already filters, so the kind bought
 *   a second way to drop rows and a second place to look when rows went missing.
 *   That argument is sound about *code* and it is the reason
 *   {@link WorkflowFilterNode} does not take any: what changed is that the
 *   predicate is a **closed structure** rather than a body, and a closed
 *   structure can be read by something other than a JavaScript engine. Only a
 *   declarative predicate can be translated into a `WHERE` and pushed into the
 *   query the source already runs, and that is not a micro-optimisation — a
 *   transform filtering `obj_pribuybuylistdetail` reads all 7,637,391 rows off
 *   disk, over the network, and into JS objects of ~80 properties each before
 *   anything decides they were unwanted. See {@link WorkflowFilterNode} for what
 *   is actually built today (an in-memory, per-batch pass) and for where the
 *   pushdown seam is, which is a promise about a shape rather than a claim about
 *   a measurement.
 * - **branch / split (unconditional)** — already expressible, and still is: a
 *   node with two outbound edges is read by both successors, each of which
 *   filters differently. There is nothing for an *unconditional* split to do.
 *   {@link WorkflowIfNode} is the conditional one, and it earns its kind by
 *   doing something no wiring can express — deciding that one of those
 *   successors, and everything only it feeds, does not run at all.
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
  /** Sends the rows down one of its outbound branches. See {@link WorkflowIfNode}. */
  'if',
  /** Drops the rows that fail a declarative test. See {@link WorkflowFilterNode}. */
  'filter',
] as const;

export type WorkflowNodeKind = (typeof WORKFLOW_NODE_KINDS)[number];

/** Same reason as {@link isConnectorKind}: one list, no second copy to drift. */
export function isWorkflowNodeKind(value: unknown): value is WorkflowNodeKind {
  return WORKFLOW_NODE_KINDS.some((kind) => kind === value);
}

/**
 * The kind that never compiles quietly.
 *
 * Every place that decides something *per kind* ends in a call to this, so a
 * kind added to {@link WORKFLOW_NODE_KINDS} without a branch there is a type
 * error naming the file rather than a graph that saves, validates, draws and
 * then does the wrong thing. This codebase has been bitten by exactly that
 * shape — a `toGraph` branch forgetting a field, a node-kind map missing a kind
 * — and the fix each time was to make the omission impossible rather than to
 * remember harder.
 *
 * It throws as well as failing to compile, because the narrowing that reaches
 * it is over data that arrives as JSON: a node whose `kind` passed
 * {@link isWorkflowNodeKind} in an older build and reaches a newer one is
 * possible, and returning a default for it would be the silent path this exists
 * to close.
 */
export function unreachableNodeKind(node: never, where: string): never {
  // Takes either the node or its kind, because the call sites differ: a
  // narrowing chain over a union hands it the node, while one over the kind
  // string — which is what a boundary reading JSON has before it has a node —
  // hands it the string.
  const kind = typeof node === 'string' ? node : Reflect.get(Object(node), 'kind');
  throw new Error(
    `${where} does not handle a workflow node of kind ${JSON.stringify(kind)}. The kind list and every decision made per kind are meant to move together.`,
  );
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
   *
   * A position is in the units {@link WORKFLOW_NODE_WIDTH} is measured in, and
   * anything **generating** one should space it with {@link workflowColumnX} and
   * {@link workflowRowY} rather than by picking a number.
   */
  position?: { x: number; y: number };
}

/**
 * How big a node is on the canvas, and therefore how far apart two of them have
 * to be.
 *
 * ## Why the server owns a number about pixels
 *
 * Because the server *writes positions*. `adoptConnector` lays a connector out
 * as a graph, and anything else that mints a graph without a person drawing it —
 * a promotion, a template, a script — has the same job. A writer that does not
 * know how wide a node is can only guess, and the guess was wrong: adoption used
 * to place columns 220 apart against a node 224 wide, so every adopted graph
 * drew each box overlapping the next by four pixels. Nothing was stacked and
 * nothing was missing, so it read as boxes glued together rather than as a bug,
 * and it survived until somebody opened thirteen of them.
 *
 * The fix is not a bigger number. 220 was not too small, it was **derived from
 * nothing** — it had no relationship to the width it was supposed to clear, so
 * it was only ever correct by luck and would go wrong again the next time the
 * node's styling changed. These constants are the relationship, stated once, in
 * the one package both the writer and the canvas already depend on.
 *
 * ## What pins them to the drawing
 *
 * {@link WORKFLOW_NODE_WIDTH} is not a description of the node — it is the
 * *source of* the node's width. `WorkflowNodeBody` in
 * `@dudousxd/nestjs-catalog-react` sets its own width from this constant rather
 * than from a Tailwind class, so the two cannot drift: changing this changes the
 * box, and there is no second number to forget.
 */
export const WORKFLOW_NODE_WIDTH = 224;

/** How tall a node is. The other half of {@link WORKFLOW_NODE_WIDTH}'s contract. */
export const WORKFLOW_NODE_HEIGHT = 80;

/**
 * Clear space between one column and the next, on top of the node's own width.
 *
 * Wide enough for the edge between two nodes to be read as a line with a
 * direction rather than as a join. This is the part that is taste; the width it
 * is added to is not.
 */
export const WORKFLOW_COLUMN_GAP = 96;

/** Clear space between two nodes sharing a column. */
export const WORKFLOW_ROW_GAP = 32;

/**
 * The x of the nth column, counting from zero.
 *
 * Every generator of a layout goes through this rather than multiplying by a
 * literal, which is what makes "columns never overlap" a property of one
 * function instead of a coincidence repeated at each call site.
 */
export function workflowColumnX(column: number): number {
  return column * (WORKFLOW_NODE_WIDTH + WORKFLOW_COLUMN_GAP);
}

/** The y of the nth row within a column, counting from zero. */
export function workflowRowY(row: number): number {
  return row * (WORKFLOW_NODE_HEIGHT + WORKFLOW_ROW_GAP);
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
export interface WorkflowSourceNode extends WorkflowNodeBase, ReusableNodeRef {
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
  /**
   * Which version of that code to run. Absent follows the latest.
   *
   * ## The claim this field exists to make true
   *
   * The line above says a shared transform is "versioned once and fixed once",
   * and until this field there was nothing here to fix it *to*. A transform node
   * named a `transformId` and nothing else, `runTransform` resolved it with
   * `getTransform`, and `getTransform` answers with whatever is in the row
   * today. So editing a transform changed every graph that referenced it, at
   * once, with nothing in anybody else's diff and nothing in their run history
   * to explain the change — the graph's fingerprint does not move (see
   * `workflowGraphHash`, which excludes the transform's version on purpose and
   * still does) so there is not even a new graph version to look at.
   *
   * That was survivable only because almost nothing was shared. It stops being
   * survivable the moment reusable nodes make sharing the point, which is why
   * this landed with them rather than after them.
   *
   * The precedent is {@link WorkflowCallNode.callVersion}, whose docblock makes
   * the same argument about somebody else's workflow: the version is authored,
   * and a run that would have used a different one is refused rather than
   * quietly run. This is that rule pointed at code stored in the same database.
   *
   * ## Why absent is allowed to mean "latest" rather than being backfilled
   *
   * Because that is what every graph already in a deployment means, exactly, and
   * a backfill would be a behaviour change dressed as a migration. Pinning the
   * live version at upgrade time freezes graphs whose authors have been relying
   * on edits reaching them; pinning nothing but *refusing* an unpinned node
   * stops every scheduled load on the deployment. Both are an upgrade that
   * changes what runs, and neither is a decision this package gets to make for
   * somebody. So absent keeps meaning precisely what it has always meant, and
   * the repair is that following is now a **stated** position with a pinned
   * alternative beside it, rather than the only position and an unstated one.
   *
   * What does change is that it is no longer silent: `describeTransformPin`
   * turns either state into a sentence a screen can render, so "this follows
   * whatever that code becomes" is something the author is told rather than
   * something they find out.
   *
   * ## What a pin costs
   *
   * A pinned version is resolved out of `catalog_revision`, which is bounded per
   * subject (`CATALOG_REVISION_LIMIT`). A pin to a version that has been evicted
   * cannot be honoured, and the run fails saying so rather than falling back to
   * the latest — a pin nobody could check is not a pin, which is the sentence
   * `WorkflowRunSteps.checkCall` already stands on.
   */
  transformVersion?: number;
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
export interface WorkflowSinkNode extends WorkflowNodeBase, ReusableNodeRef {
  kind: 'sink';
  /**
   * Which object type the rows become.
   *
   * Stays on the node even when the node is an instance of a reusable one, and
   * that is the one field a reusable body may **not** move under a graph. See
   * {@link ReusableNodeRef} — the write grants a graph was checked against are
   * checked against this string, so a reusable sink that could repoint it would
   * be a way to write a type the author was never granted.
   */
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
 * The kinds of test an {@link WorkflowIfNode} can make.
 *
 * A second predicate shape was always going to arrive — the note on
 * {@link WorkflowIfNode} says so about `code` — and the shape it arrives into is
 * the decision worth arguing about, because the alternative was to keep both
 * tests' fields flat on the node and mark them optional. That version types a
 * gate as "an env var, maybe, and a threshold, maybe": a node carrying both is
 * representable, a node carrying neither is representable, and every reader has
 * to invent its own rule for which one wins. It is the same mistake the note on
 * {@link WorkflowNode} refuses for node kinds, one level down.
 *
 * So the predicate is a union with a discriminant of its own, and every decision
 * made per predicate kind ends in {@link unreachablePredicateKind} — a third
 * shape is then a build failure listing the files that have to answer for it,
 * rather than a gate that saves, draws, and quietly always takes the `else`.
 */
export const WORKFLOW_PREDICATE_KINDS = [
  /** Reads a variable where the load runs. See {@link WorkflowEnvPredicate}. */
  'env',
  /** Counts the rows handed to the gate. See {@link WorkflowRowCountPredicate}. */
  'rowCount',
] as const;

export type WorkflowPredicateKind = (typeof WORKFLOW_PREDICATE_KINDS)[number];

/** Same reason as {@link isConnectorKind}: one list, no second copy to drift. */
export function isWorkflowPredicateKind(value: unknown): value is WorkflowPredicateKind {
  return WORKFLOW_PREDICATE_KINDS.some((kind) => kind === value);
}

/**
 * {@link unreachableNodeKind}, one level down, and for the identical reason.
 *
 * Every branch over {@link WorkflowIfPredicate} ends here, so a predicate kind
 * added to the list without a rule for hashing it, validating it or evaluating
 * it is a type error naming the file — not a graph that runs and decides
 * something nobody authored. It throws as well, because predicates arrive as
 * JSON out of a column and a build older than the data is a thing that happens.
 */
export function unreachablePredicateKind(predicate: never, where: string): never {
  const kind = typeof predicate === 'string' ? predicate : Reflect.get(Object(predicate), 'kind');
  throw new Error(
    `${where} does not handle an if-node predicate of kind ${JSON.stringify(kind)}. The predicate kinds and every decision made per kind are meant to move together.`,
  );
}

/**
 * Tests a variable on the machine that runs the load.
 *
 * The original predicate, and the one the node was built for: a deployment that
 * has a ClickHouse has its URL and one that does not has nothing. It names the
 * variable and never its value — see the note on {@link WorkflowIfNode} for why
 * that is a safety property rather than a convenience.
 */
export interface WorkflowEnvPredicate {
  kind: 'env';
  /**
   * The name of the environment variable to read on the machine that runs the
   * node. **The name, never the value** — nothing about a credential is stored
   * in a catalog.
   */
  envVar: string;
  /**
   * What it has to equal for the `then` branch to be taken.
   *
   * Absent means "is it set to anything non-empty", which is the ClickHouse
   * case: a deployment that has one has the URL, a deployment that does not has
   * nothing. Present means an exact string comparison, which is the
   * `DEPLOY_ENV = local` case.
   */
  equals?: string;
}

/**
 * Tests how many rows reached the gate.
 *
 * ## The case
 *
 * "Only run the sink if the source returned anything." A nightly export that
 * comes back empty because the upstream system is mid-maintenance is not a
 * failure — nothing is broken, there is simply nothing to load — but committing
 * it repoints the live view of a type at an empty snapshot, and the run reports
 * success while doing it. A gate in front of the sink turns that into a skip,
 * and a skipped node is never executed, so nothing commits. That is the same
 * guarantee the `else` branch already gives, pointed at the case that actually
 * happens.
 *
 * ## Which rows
 *
 * The ones on the single inbound edge. `validateWorkflow` refuses a gate with
 * more than one (`if-needs-one-input`) and refuses one with none as unreachable,
 * so "how many rows" has exactly one answer — and it is the count on the very
 * {@link WorkflowStageRef} the gate hands on, so the number tested and the rows
 * carried cannot disagree.
 *
 * ## Where the number comes from, which is the replay argument
 *
 * `WorkflowStageRef.rowCount`, off {@link WorkflowNodeStepInput.inputs}, which
 * is part of the step's checkpointed input and was itself produced by an
 * upstream step's checkpointed output. Nothing counts rows at evaluation time
 * and nothing reads the stage store: a resumed run on another pod sees the same
 * number the first attempt saw, and the branch it produced is read back off
 * {@link WorkflowNodeStepOutput.branch} anyway.
 *
 * ## Why a threshold and not "greater than zero"
 *
 * `atLeast: 1` *is* "did anything arrive", so the common case costs nothing to
 * express — and "a full export is never under ten thousand rows, so treat a
 * hundred as a broken upstream rather than as data" is the next thing anybody
 * asks for, and it would otherwise need a second predicate kind for one integer.
 *
 * One comparison and one direction, deliberately. `atMost`, `equals` and a
 * chosen operator were all considered and are all the same mistake the node's
 * own `negate` flag would have been: the inverse test is already expressible by
 * swapping which successor is on `then` and which is on `else`, and two ways to
 * say one thing is two places to look when a load takes the branch nobody
 * expected.
 */
export interface WorkflowRowCountPredicate {
  kind: 'rowCount';
  /**
   * How many rows have to reach the gate for the `then` branch to be taken.
   *
   * A whole number of at least one, and `validateWorkflow` says so. Zero is
   * refused rather than treated as "always" because it is a gate that can only
   * ever answer one way — the `else` subtree would never run on any deployment,
   * which is the silent half-graph this node's whole design is arranged against.
   */
  atLeast: number;
}

/**
 * What an `if` node tests. See {@link WORKFLOW_PREDICATE_KINDS}.
 */
export type WorkflowIfPredicate = WorkflowEnvPredicate | WorkflowRowCountPredicate;

/**
 * Narrow a stored predicate, for the same reason {@link isWorkflowNode} narrows
 * a stored node: it arrives as JSON out of a column, and a gate read back
 * without its test is a gate that has to invent one.
 *
 * A row count that is not a whole number — `NaN` from a JSON round trip of an
 * unparsed field, an `Infinity` that serialised as `null` — is refused rather
 * than kept, because every comparison against it is false and the symptom is a
 * `then` branch that silently never runs again.
 */
export function isWorkflowIfPredicate(value: unknown): value is WorkflowIfPredicate {
  if (typeof value !== 'object' || value === null) return false;
  const kind = Reflect.get(value, 'kind');
  if (!isWorkflowPredicateKind(kind)) return false;
  if (kind === 'env') {
    // The variable name is required and its expected value is not, exactly as
    // the type says: an absent `equals` is the "is it set at all" test, so a
    // stored predicate without one is complete rather than half-narrowed.
    const equals = Reflect.get(value, 'equals');
    return (
      typeof Reflect.get(value, 'envVar') === 'string' &&
      (equals === undefined || typeof equals === 'string')
    );
  }
  if (kind === 'rowCount') {
    const atLeast = Reflect.get(value, 'atLeast');
    return typeof atLeast === 'number' && Number.isInteger(atLeast) && atLeast >= 0;
  }
  return isWorkflowPredicateKindUnhandled(kind);
}

/** The narrowing counterpart of {@link unreachablePredicateKind}. */
function isWorkflowPredicateKindUnhandled(kind: never): false {
  void kind;
  return false;
}

/**
 * Sends the rows down one of its two outbound branches, and skips the other.
 *
 * The node the maintainer asked for, and the reason it is a node rather than a
 * flag on an edge: a deployment that has a ClickHouse and a deployment that does
 * not are the *same graph*, and the difference between them is one decision made
 * at run time. Modelling it as two workflows means two things to keep in step;
 * modelling it as an edge flag means the decision has nowhere to be recorded and
 * nothing on the canvas to open.
 *
 * ## What it does to the rows: nothing
 *
 * An `if` is a gate, not a stage. It passes its input through untouched — its
 * output ref *is* its input's ref — so a branch costs no copy of the dataset and
 * no second write into the stage store. That is also why it takes **exactly one
 * inbound edge**: a node hands its successors one {@link WorkflowStageRef}, so a
 * gate fed by two inputs could only either copy the rows to merge them (paying
 * for the whole dataset to make a decision that reads none of it) or silently
 * drop one. Merging is what a transform is for; put one in front.
 *
 * That holds for {@link WorkflowRowCountPredicate} too, which is the one
 * predicate that sounds like it reads the data and does not: the count it tests
 * is the number already written on the {@link WorkflowStageRef} it was handed,
 * so a gate still touches no rows — and with one inbound edge there is exactly
 * one count for "how many rows" to mean.
 *
 * ## The predicate is declarative, and that is the safety property
 *
 * It is one of {@link WORKFLOW_PREDICATE_KINDS} — a variable's name, or a count
 * off a checkpoint — and never a value and never code. Three reasons, in order
 * of how much they cost to get wrong:
 *
 * 1. **Replay.** The durable engine replays a run, possibly on another pod. A
 *    predicate is by definition the thing whose answer decides which half of the
 *    graph exists, so an answer that can differ between the run and its replay
 *    is a run that loads through a shape nobody chose — and it would show up as
 *    a non-determinism error two nodes later, naming neither the branch nor the
 *    variable. The outcome is therefore recorded on first evaluation
 *    ({@link WorkflowNodeOutcome.branch}) and read back afterwards, and the
 *    declarative form is what keeps that record small enough to be a checkpoint.
 *    Both predicate kinds are answerable from what a step was handed:
 *    {@link WorkflowRowCountPredicate} reads a number that arrived on the step's
 *    own checkpointed input rather than counting anything.
 * 2. **A predicate is not a place for a secret.** A name is stored; a value
 *    never is. This is the same rule {@link WorkflowSourceNode.secretEnvVar}
 *    follows and for the same reason.
 * 3. **Code would need a context to read, and this node does not own it.** What
 *    code-bearing nodes may see — allow-listed variables, a `catalog` object —
 *    is a question being answered elsewhere. A `code` predicate is additive the
 *    day it lands: it becomes another member of {@link WorkflowIfPredicate}, and
 *    everything that reads a branch reads it off the recorded outcome exactly as
 *    it does now.
 *
 * To invert the test, swap which successor is on `then` and which is on `else`.
 * There is deliberately no `negate` flag: two ways to say one thing is two
 * places to look when a load takes the branch you did not expect.
 */
export interface WorkflowIfNode extends WorkflowNodeBase {
  kind: 'if';
  /**
   * What it tests. A union rather than a field per test — see
   * {@link WORKFLOW_PREDICATE_KINDS} for why that is the whole point.
   */
  predicate: WorkflowIfPredicate;
}

/* ---------------------------------------------------------------------------
 * The filter node, and the predicate language it drops rows by.
 * ------------------------------------------------------------------------- */

/**
 * The shapes a {@link WorkflowFilterPredicate} can take.
 *
 * Two leaf kinds plus a presence test plus two ways to combine them, and the
 * list is closed for the same reason {@link WORKFLOW_PREDICATE_KINDS} is: every
 * decision made per kind ends in {@link unreachableFilterPredicateKind}, so a
 * sixth shape is a build failure naming the files that owe it an answer rather
 * than a filter that saves, draws, and quietly keeps everything.
 *
 * **There is deliberately no `not`.** Every leaf carries its own inverse
 * ({@link WORKFLOW_FILTER_OPERATORS} pairs each operator with one, `oneOf` has
 * `notIn`, `present` has `isNotNull`) and `all`/`any` are duals, so De Morgan
 * already writes any negation with the kinds here. A `not` node would be a
 * second spelling of every predicate — two shapes to read when a load comes out
 * short, and a UI with a checkbox nobody agrees on the placement of. The one
 * case it does not cover is stated on {@link workflowFilterMatches}: a value the
 * test cannot compare fails *both* a form and its inverse, on purpose.
 *
 * **There is deliberately no free-form expression and no code.** That is the
 * whole argument for the node existing — see {@link WorkflowFilterNode}.
 */
export const WORKFLOW_FILTER_PREDICATE_KINDS = [
  /** One column against one value. See {@link WorkflowFilterComparison}. */
  'compare',
  /** One column against a list. See {@link WorkflowFilterOneOf}. */
  'oneOf',
  /** Whether a column has a value at all. See {@link WorkflowFilterPresence}. */
  'present',
  /** Every child holds. See {@link WorkflowFilterGroup}. */
  'all',
  /** At least one child holds. See {@link WorkflowFilterGroup}. */
  'any',
] as const;

export type WorkflowFilterPredicateKind = (typeof WORKFLOW_FILTER_PREDICATE_KINDS)[number];

/** Same reason as {@link isConnectorKind}: one list, no second copy to drift. */
export function isWorkflowFilterPredicateKind(
  value: unknown,
): value is WorkflowFilterPredicateKind {
  return WORKFLOW_FILTER_PREDICATE_KINDS.some((kind) => kind === value);
}

/**
 * {@link unreachablePredicateKind}, for the filter language, and for the
 * identical reason.
 *
 * It throws as well as failing to compile: a predicate arrives as JSON out of a
 * column, so a graph saved by a newer build and read by an older one is a thing
 * that happens, and returning a default for a shape this build has no rule for
 * would mean silently keeping — or silently dropping — every row.
 */
export function unreachableFilterPredicateKind(predicate: never, where: string): never {
  const kind = typeof predicate === 'string' ? predicate : Reflect.get(Object(predicate), 'kind');
  throw new Error(
    `${where} does not handle a filter predicate of kind ${JSON.stringify(kind)}. The predicate kinds and every decision made per kind are meant to move together.`,
  );
}

/**
 * What a {@link WorkflowFilterComparison} does with its column and its value.
 *
 * Ten, in five inverse pairs, and the pairing is the reason there is no `not`
 * kind. Each one has an obvious single-expression form in both dialects this
 * repository speaks, which is not a coincidence — it is the constraint the list
 * was chosen under, so that the day a predicate is pushed into a source query
 * the translation is a `switch` and not a design.
 *
 * The omissions, since a closed list is only defensible if they are:
 *
 * - **`between`** — `all` of a `greaterThanOrEqual` and a `lessThanOrEqual`, in
 *   one more click and with no second shape to validate, hash and translate.
 * - **`endsWith`** — asked for far less than the other two, and unlike them it
 *   has no index that could ever serve it in either dialect, so offering it in a
 *   palette would advertise something that is a full scan by construction.
 *   `contains` covers it at the same cost.
 * - **regular expressions** — the dialects disagree about the syntax, the
 *   engines disagree about the semantics, and a predicate whose meaning depends
 *   on which database answered it is a predicate that cannot be pushed down
 *   without changing what the load returns. That is the one property this list
 *   exists to hold.
 * - **case-insensitive variants** — collation is a property of the column in
 *   both dialects, so a `equalsIgnoreCase` evaluated in memory and the same
 *   predicate evaluated in a `WHERE` would legitimately disagree. Normalise in a
 *   transform, where the disagreement is visible.
 */
export const WORKFLOW_FILTER_OPERATORS = [
  'equals',
  'notEquals',
  'greaterThan',
  'lessThanOrEqual',
  'greaterThanOrEqual',
  'lessThan',
  'contains',
  'notContains',
  'startsWith',
  'notStartsWith',
] as const;

export type WorkflowFilterOperator = (typeof WORKFLOW_FILTER_OPERATORS)[number];

/** Same reason as {@link isConnectorKind}: one list, no second copy to drift. */
export function isWorkflowFilterOperator(value: unknown): value is WorkflowFilterOperator {
  return WORKFLOW_FILTER_OPERATORS.some((operator) => operator === value);
}

/**
 * {@link unreachableFilterPredicateKind}, one level further down.
 *
 * An operator added to the list without a rule for evaluating it, describing it
 * or hashing it is a type error naming the file — not a comparison that silently
 * answers false for every row, which is a filter that drops the whole dataset
 * and reports success.
 */
export function unreachableFilterOperator(operator: never, where: string): never {
  throw new Error(
    `${where} does not handle the filter operator ${JSON.stringify(operator)}. The operator list and every decision made per operator are meant to move together.`,
  );
}

/**
 * What a predicate may be compared against.
 *
 * Three scalars and nothing else. No `null` — {@link WorkflowFilterPresence} is
 * how absence is tested, and folding it in here would make `equals: null` and
 * `isNull` two spellings of one question with different answers under the
 * three-valued logic on {@link workflowFilterMatches}. No object and no array —
 * an array is {@link WorkflowFilterOneOf.values}, and an object compared with
 * `===` never matches anything a source produced.
 *
 * **Dates are strings.** A source hands back whatever its driver decoded, and a
 * catalog that tried to parse dates here would have to pick a format, get it
 * wrong for one dialect, and produce a comparison that silently ordered rows
 * differently from the `WHERE` this predicate is meant to become. ISO-8601
 * strings sort correctly under `<` and under every SQL collation, which is why
 * `boundStatement` already compares watermarks as text.
 */
export type WorkflowFilterValue = string | number | boolean;

/** Whether a stored value is one this language can compare against. */
export function isWorkflowFilterValue(value: unknown): value is WorkflowFilterValue {
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  // `NaN` and the infinities are refused rather than kept: every comparison
  // against `NaN` is false, so a predicate holding one is a filter that drops
  // every row while looking perfectly well configured, and `Infinity` does not
  // survive a JSON round trip at all — it comes back as `null`.
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The column names a predicate may name.
 *
 * **The same pattern `boundStatement` requires of a watermark column**, and that
 * is the point rather than a coincidence: an identifier cannot be bound by any
 * driver, so pushing a predicate into a query means quoting the column into the
 * SQL, and a name carrying a quote, a dot or a space is refused rather than
 * escaped. Requiring it *now*, while the predicate is only ever evaluated in
 * memory, is what stops a graph being authored today that could never be pushed
 * down tomorrow.
 *
 * The cost, and it is real: a source whose column is called `Part Number` cannot
 * be filtered directly. Rename it in a transform first — which is a node that
 * already exists and whose output is a column this can name.
 */
export const WORKFLOW_FILTER_COLUMN_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * How deep `all`/`any` may nest.
 *
 * A bound rather than a trust, because a predicate arrives as JSON out of a
 * column and every function that walks one is recursive: a graph carrying a
 * thousand-deep tree would be a stack overflow inside a durable step rather than
 * a refusal naming the node. Six is past anything a person builds in a form and
 * far short of anything that costs a frame to walk.
 */
export const WORKFLOW_FILTER_MAX_DEPTH = 6;

/**
 * How many values one {@link WorkflowFilterOneOf} may list.
 *
 * Bounded because the list travels in the graph, into the graph fingerprint, and
 * eventually into an `IN (...)` — and past a few hundred entries all three of
 * those stop being reasonable and the thing being expressed is a join against
 * another dataset rather than a filter. Wire that dataset in as a second source
 * and join it in a transform, which is the node that can.
 */
export const WORKFLOW_FILTER_MAX_VALUES = 500;

/** One column against one value. The leaf almost every filter is made of. */
export interface WorkflowFilterComparison {
  kind: 'compare';
  /** A bare column name. See {@link WORKFLOW_FILTER_COLUMN_PATTERN}. */
  column: string;
  operator: WorkflowFilterOperator;
  value: WorkflowFilterValue;
}

/**
 * One column against a list of values.
 *
 * Its own kind rather than an `equals` whose value is allowed to be an array,
 * because that shape makes `value` mean two things and every reader has to test
 * which — the flat-optional-fields mistake {@link WORKFLOW_PREDICATE_KINDS}
 * argues against, one level down again. It also has no honest single spelling in
 * SQL as a comparison: `IN (…)` takes a parenthesised list and one bound
 * parameter per entry.
 */
export interface WorkflowFilterOneOf {
  kind: 'oneOf';
  column: string;
  /** `notIn` rather than a `negated` flag, so the two read alike in a palette. */
  operator: 'in' | 'notIn';
  /** At most {@link WORKFLOW_FILTER_MAX_VALUES}, and never empty. */
  values: WorkflowFilterValue[];
}

/**
 * Whether a column has a value at all.
 *
 * The one test the other two cannot express, and the reason they cannot is the
 * three-valued logic on {@link workflowFilterMatches}: every `compare` and every
 * `oneOf` is false when the column is null, *including the inverses*, exactly as
 * a `WHERE` would answer. So "the ones with no delivery date" has to be its own
 * shape or it would be unaskable.
 */
export interface WorkflowFilterPresence {
  kind: 'present';
  column: string;
  operator: 'isNull' | 'isNotNull';
}

/**
 * What `all` and `any` share, which is everything except the word.
 *
 * **An empty group is refused**, by `validateWorkflow`, by
 * {@link isWorkflowFilterPredicate} and at the HTTP boundary. It is not a
 * pedantic refusal: `all` of nothing is vacuously true, so it keeps every row
 * and the filter does nothing; `any` of nothing is vacuously false, so it drops
 * every row and the load comes out empty. Both are silent, both are reached by
 * deleting the last condition in a form, and they are opposite catastrophes.
 */
interface WorkflowFilterGroupBase {
  /** Never empty. Nested no deeper than {@link WORKFLOW_FILTER_MAX_DEPTH}. */
  children: WorkflowFilterPredicate[];
}

/**
 * Every child holds.
 *
 * Two interfaces rather than one carrying `kind: 'all' | 'any'`, which was
 * written first and does not work: TypeScript will not remove a union member
 * from the union when its discriminant is itself a union of literals and the two
 * are tested separately, so `unreachableFilterPredicateKind` at the end of every
 * `switch`-by-`if` chain stopped compiling — which is to say the exhaustiveness
 * this whole file is arranged around was silently unavailable for these two
 * kinds. Two declarations over a shared base costs one line and buys the
 * property back.
 */
export interface WorkflowFilterAll extends WorkflowFilterGroupBase {
  kind: 'all';
}

/** At least one child holds. Two declarations, for the reason on {@link WorkflowFilterAll}. */
export interface WorkflowFilterAny extends WorkflowFilterGroupBase {
  kind: 'any';
}

export type WorkflowFilterGroup = WorkflowFilterAll | WorkflowFilterAny;

/** What a filter node tests. See {@link WORKFLOW_FILTER_PREDICATE_KINDS}. */
export type WorkflowFilterPredicate =
  | WorkflowFilterComparison
  | WorkflowFilterOneOf
  | WorkflowFilterPresence
  | WorkflowFilterAll
  | WorkflowFilterAny;

/**
 * Narrow a stored filter predicate, refusing rather than repairing.
 *
 * The same contract {@link isWorkflowIfPredicate} has and for a sharper version
 * of the same reason: a gate read back without its test picks a branch nobody
 * authored, and a *filter* read back without its test decides which rows exist.
 * Repairing a broken predicate — dropping an unreadable child out of an `all`,
 * say — would silently widen or narrow what a load publishes, which is precisely
 * the failure the node is built to make visible.
 *
 * Depth is carried rather than tracked globally so that the bound is on the
 * *tree*, not on how many predicates have been checked: two sibling branches
 * five deep are fine, and one branch seven deep is not.
 */
export function isWorkflowFilterPredicate(
  value: unknown,
  depth = 0,
): value is WorkflowFilterPredicate {
  if (depth > WORKFLOW_FILTER_MAX_DEPTH) return false;
  if (typeof value !== 'object' || value === null) return false;
  const kind = Reflect.get(value, 'kind');
  if (!isWorkflowFilterPredicateKind(kind)) return false;

  if (kind === 'all' || kind === 'any') {
    const children = Reflect.get(value, 'children');
    if (!Array.isArray(children) || children.length === 0) return false;
    return children.every((child) => isWorkflowFilterPredicate(child, depth + 1));
  }

  const column = Reflect.get(value, 'column');
  if (typeof column !== 'string' || !WORKFLOW_FILTER_COLUMN_PATTERN.test(column)) return false;
  return isFilterLeaf(value, kind);
}

/**
 * The half of {@link isWorkflowFilterPredicate} that is about one condition.
 *
 * Split off because the two halves have nothing to do with each other: above is
 * a tree walk with a depth bound, and this is three shapes checked field by
 * field. Reached only with the column already accepted, which is why it does not
 * check one.
 */
function isFilterLeaf(
  value: object,
  kind: Exclude<WorkflowFilterPredicateKind, 'all' | 'any'>,
): boolean {
  const operator = Reflect.get(value, 'operator');
  if (kind === 'present') {
    return operator === 'isNull' || operator === 'isNotNull';
  }
  if (kind === 'oneOf') {
    const values = Reflect.get(value, 'values');
    if (operator !== 'in' && operator !== 'notIn') return false;
    return (
      Array.isArray(values) &&
      values.length > 0 &&
      values.length <= WORKFLOW_FILTER_MAX_VALUES &&
      values.every((entry) => isWorkflowFilterValue(entry))
    );
  }
  if (kind === 'compare') {
    return isWorkflowFilterOperator(operator) && isWorkflowFilterValue(Reflect.get(value, 'value'));
  }
  return isWorkflowFilterPredicateKindUnhandled(kind);
}

/** The narrowing counterpart of {@link unreachableFilterPredicateKind}. */
function isWorkflowFilterPredicateKindUnhandled(kind: never): false {
  void kind;
  return false;
}

/**
 * Whether one row passes a predicate.
 *
 * Pure, allocation-free on the common path, and in core rather than in the
 * runner so that the console can describe — and one day preview — exactly what
 * the load will do, from the same function that does it. It is called once per
 * row, so everything about it is arranged to be cheap: no closures built per
 * row, no array built per row, and `note` is optional so a caller that does not
 * want the diagnostics pays nothing for them.
 *
 * ## Null is unknown, and unknown does not pass
 *
 * A column that is `null`, `undefined`, or simply absent from the row fails
 * **every** `compare` and **every** `oneOf`, *including the negative forms*.
 * `status notEquals "CLOSED"` does not pass a row with no status.
 *
 * That is SQL's three-valued logic rather than JavaScript's, and it is chosen
 * deliberately over the more intuitive JS answer for one reason: this predicate
 * is meant to become a `WHERE`, and the day it does, the database will answer
 * this way. A filter that kept those rows in memory and dropped them once pushed
 * down would be a performance change that quietly altered what a type contains —
 * which is the one thing a pushdown must never be able to do. {@link
 * WorkflowFilterPresence} is how absence is tested on purpose.
 *
 * ## A value it cannot compare fails both a test and its inverse
 *
 * `qty greaterThan 10` against a `qty` holding `"n/a"` is not false because the
 * string is small; there is no ordering between a string and a number that any
 * two systems would agree on. Rather than invent one, the leaf answers false and
 * calls `note` with the column, and the runner turns those counts into a line on
 * the run: *"12,431 rows held a value in `qty` the test could not compare."*
 *
 * A row nothing can judge is therefore dropped rather than kept. That is the
 * direction with a backstop — the sink's row-count bound sees the shrink, and a
 * full sink refuses to commit nothing at all — whereas keeping unjudged rows
 * would publish them into the type with nothing anywhere to notice.
 */
export function workflowFilterMatches(
  predicate: WorkflowFilterPredicate,
  row: Record<string, unknown>,
  note?: (column: string) => void,
): boolean {
  if (predicate.kind === 'all' || predicate.kind === 'any') {
    // One loop for both, because they differ only in which answer is decisive:
    // an `all` stops at the first false and an `any` stops at the first true.
    //
    // **Short-circuiting is why `note` may under-count**, and that is the right
    // trade rather than an accident: an `any` that matched on its first child
    // never looks at the second, so a value it could not have compared there is
    // not reported. Evaluating every child to make the diagnostics complete
    // would run every comparison against every row for a count nobody acts on
    // per row — and this function is called seven million times.
    const decisive = predicate.kind === 'any';
    for (const child of predicate.children) {
      if (workflowFilterMatches(child, row, note) === decisive) return decisive;
    }
    return !decisive;
  }
  return matchFilterLeaf(predicate, row, note);
}

/** One condition against one row. Split from the recursion above, which is all it is. */
function matchFilterLeaf(
  predicate: WorkflowFilterComparison | WorkflowFilterOneOf | WorkflowFilterPresence,
  row: Record<string, unknown>,
  note: ((column: string) => void) | undefined,
): boolean {
  // `Object.hasOwn` rather than a bare index, because `row` is somebody else's
  // record and a column named `constructor` would otherwise reach up the
  // prototype chain and compare against a function.
  const held = Object.hasOwn(row, predicate.column)
    ? Reflect.get(row, predicate.column)
    : undefined;

  if (predicate.kind === 'present') {
    const missing = held === null || held === undefined;
    return predicate.operator === 'isNull' ? missing : !missing;
  }
  // Three-valued logic — see the docblock above. Not noted, because an absent
  // value is an ordinary fact about data rather than a predicate that does not
  // fit it.
  if (held === null || held === undefined) return false;
  if (predicate.kind === 'oneOf') return matchFilterList(predicate, held, note);
  if (predicate.kind === 'compare') return compareFilterValue(predicate, held, note);
  return unreachableFilterPredicateKind(predicate, 'workflowFilterMatches');
}

/** One `IN`/`NOT IN`, over a value already known to be present. */
function matchFilterList(
  predicate: WorkflowFilterOneOf,
  held: unknown,
  note: ((column: string) => void) | undefined,
): boolean {
  if (!isWorkflowFilterValue(held)) {
    note?.(predicate.column);
    return false;
  }
  const found = predicate.values.includes(held);
  return predicate.operator === 'in' ? found : !found;
}

/**
 * One leaf comparison, with the type rules written out once.
 *
 * Split from {@link workflowFilterMatches} so the recursion above stays readable
 * and so the ten operators are answered in one place that ends in
 * {@link unreachableFilterOperator}.
 */
function compareFilterValue(
  predicate: WorkflowFilterComparison,
  held: unknown,
  note: ((column: string) => void) | undefined,
): boolean {
  const operator = predicate.operator;
  const wanted = predicate.value;

  if (operator === 'equals' || operator === 'notEquals') {
    // Same type or nothing. `"5" === 5` is false in JavaScript and `'5' = 5` is
    // *true* in MySQL, so a cross-type equality is precisely a comparison whose
    // answer would change under pushdown — reported rather than picked.
    if (typeof held !== typeof wanted) {
      note?.(predicate.column);
      return false;
    }
    return operator === 'equals' ? held === wanted : held !== wanted;
  }

  if (
    operator === 'greaterThan' ||
    operator === 'greaterThanOrEqual' ||
    operator === 'lessThan' ||
    operator === 'lessThanOrEqual'
  ) {
    // Ordered types only, and both sides the same one. Booleans are excluded on
    // purpose: `true > false` is an answer JavaScript will give and no reader of
    // a filter ever meant to ask for.
    const ordered =
      (typeof held === 'number' && typeof wanted === 'number') ||
      (typeof held === 'string' && typeof wanted === 'string');
    if (!ordered) {
      note?.(predicate.column);
      return false;
    }
    return orderedHolds(operator, held, wanted);
  }

  // The four string tests. A non-string on either side is not coerced: coercing
  // would make `contains` match the digits of a number, which is a full scan
  // producing rows nobody asked for rather than a comparison.
  if (typeof held !== 'string' || typeof wanted !== 'string') {
    note?.(predicate.column);
    return false;
  }
  return textHolds(operator, held, wanted);
}

/**
 * The four string tests, over two values already known to be strings.
 *
 * Split out for the same reason {@link orderedHolds} is: the type rule and the
 * comparison are separate concerns, and keeping them in one function put a
 * chain of ten operators and three type rules into one place the linter would
 * not hold in one head — which is a fair description of how a comparison ends up
 * silently answering the wrong way.
 */
function textHolds(
  operator: 'contains' | 'notContains' | 'startsWith' | 'notStartsWith',
  held: string,
  wanted: string,
): boolean {
  if (operator === 'contains') return held.includes(wanted);
  if (operator === 'notContains') return !held.includes(wanted);
  if (operator === 'startsWith') return held.startsWith(wanted);
  if (operator === 'notStartsWith') return !held.startsWith(wanted);
  return unreachableFilterOperator(operator, 'workflowFilterMatches');
}

/**
 * The four orderings, over two values already known to be the same ordered type.
 *
 * Its own function so the type check above and the comparison here are separate
 * concerns rather than one branch doing both. Generic over the pair so that
 * `held` and `wanted` are compared as the *same* type — the signature is what
 * stops a future edit passing a string and a number to `>`, which is the exact
 * silent coercion the caller went to trouble to rule out.
 */
function orderedHolds<T extends number | string>(
  operator: 'greaterThan' | 'greaterThanOrEqual' | 'lessThan' | 'lessThanOrEqual',
  held: T,
  wanted: T,
): boolean {
  if (operator === 'greaterThan') return held > wanted;
  if (operator === 'greaterThanOrEqual') return held >= wanted;
  if (operator === 'lessThan') return held < wanted;
  return held <= wanted;
}

/**
 * Drops the rows that fail a declarative test, and reports how many.
 *
 * ## Why this is a node and not a transform that returns a subset
 *
 * A transform can already filter, so the kind has to earn itself. Three reasons,
 * in increasing order of how much they decide the shape:
 *
 * 1. **It is legible on the canvas.** "Keep the open orders" is readable from
 *    the box; the same rule inside a transform is readable only by opening the
 *    code, and only by somebody who can read the language it is written in.
 * 2. **Its effect is reportable.** A filter records rows in *and* rows out
 *    ({@link WorkflowNodeOutcome.rowsIn}), so a run panel can say what was
 *    dropped. A transform records one number, and a transform that quietly
 *    started dropping 90% of its input looks exactly like a source that got
 *    smaller. A filter whose effect is invisible is how data goes missing.
 * 3. **Only a declarative predicate can be pushed into the source.** This is the
 *    one that fixes the design. Arbitrary code cannot be translated to SQL, so a
 *    code filter is *always* the expensive path: every row is read off disk, sent
 *    over the network and turned into a JS object before anything decides it was
 *    unwanted. A closed structure of column, operator and value can become a
 *    `WHERE`, and then the rows are never read at all.
 *
 * ## Where it runs today, and where it does not yet
 *
 * **Today: in memory, one staged batch at a time, always.** The predicate is
 * shaped so it *could* be pushed into a SQL source's query, and it is not, and
 * saying so plainly is better than implying a win that has not been measured.
 * What stands in the way is not the predicate — `boundStatement` in
 * `sources.ts` already wraps an author's SQL in `SELECT * FROM (…) WHERE …`
 * with a quoted identifier and a bound parameter, which is exactly the mechanism
 * a pushdown would reuse — but the fetcher contract: `SourceFetcher` receives a
 * connector, a secret, a watermark and a mode, and knows nothing about the
 * graph, while the runner that *does* know the graph dispatches by connector
 * kind alone. Threading a graph-derived predicate through that also drags in the
 * schema-discovery path, which shares `sqlTarget`.
 *
 * There is a second reason, and it is the more interesting one: a pushed-down
 * filter **cannot honestly report rows in**. The rows it dropped were never
 * fetched, so "7,637,391 in, 96,204 out" would become "96,204 in, 96,204 out,
 * nothing dropped" — reason 2 above, deleted by reason 3. Recovering the number
 * means a second `COUNT(*)` over the unfiltered query, which is the scan the
 * pushdown existed to avoid. Whichever way that is resolved, it is a decision
 * about what a run reports and not a refactor, so it belongs in the change that
 * makes the move rather than in a field added speculatively here.
 *
 * The seam is therefore one marked place in `WorkflowRunnerService.runFilter`
 * rather than an unused translator sitting in this file waiting to rot.
 *
 * ## The trap this node had to be designed against: {@link narrows}
 *
 * Dropping a filter onto an existing `source → sink` wire replaces the published
 * snapshot of that type with a subset — and every part of the run reports
 * success, because from the run's point of view everything did succeed. See
 * {@link narrows} for how the graph is made to tell that apart from filtering to
 * derive something new, and why it cannot be told apart structurally.
 */
export interface WorkflowFilterNode extends WorkflowNodeBase {
  kind: 'filter';
  /**
   * What a row has to satisfy to pass. See
   * {@link WORKFLOW_FILTER_PREDICATE_KINDS}.
   */
  predicate: WorkflowFilterPredicate;
  /**
   * The object types whose published snapshot this filter is acknowledged to
   * narrow.
   *
   * ## The two intentions, and why the graph cannot tell them apart
   *
   * Filtering to **derive a new type** — `source → filter → sink(OpenOrders)` —
   * and filtering before **recommitting the same type** —
   * `source → filter → sink(PriBuy)`, where `PriBuy` was until this morning the
   * whole table — are *structurally identical graphs*. The only thing that
   * differs is what the type on the sink already means to everybody reading it,
   * and there is nothing in the nodes or the edges that knows that. Any rule
   * claiming to distinguish them from the shape alone would be inventing a
   * signal, and would then either refuse the safe case or wave the dangerous one
   * through.
   *
   * So the graph makes the author **name the types**, and that naming is the
   * whole mechanism: typing `OpenOrders` is a different act from typing
   * `PriBuy`, and nobody types the second one by accident. What makes it a
   * safeguard rather than a checkbox is that it is *required exactly where it
   * matters and refused everywhere else*, both checked by `validateWorkflow`:
   *
   * - It must list **every** full-mode sink this filter stands in front of *on
   *   every path* — that is, every sink whose entire snapshot would be a subset
   *   because of this node. Removing the node would make that sink unreachable;
   *   see `workflowNarrowedTypes`, which is the one implementation both the
   *   validator and the console call.
   * - It must list **nothing else**. A type named here that this filter does not
   *   in fact narrow is refused, for the reason a branch label on a plain wire
   *   is: an acknowledgement nothing reads is worse than none, because it is
   *   drawn.
   *
   * A filter on one of several paths into a sink narrows nothing — other rows
   * still reach it — and a filter in front of an incremental sink narrows
   * nothing either, because an incremental commit merges into what is already
   * there rather than replacing it. Neither has anything to declare, and neither
   * may declare it.
   *
   * The consequence is the intended one: dragging a filter onto a working
   * `source → sink` wire produces a graph that **will not save** until somebody
   * writes down the name of the type they are about to shrink. It is in the
   * graph fingerprint, so acknowledging it is a new version of the graph.
   *
   * The run-time backstop is unchanged and still the last word: the sink's
   * row-count bound (`maxShrink`) refuses a commit that loses more of the served
   * snapshot than the type allows, whatever this field says.
   */
  narrows?: string[];
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
  | WorkflowCallNode
  | WorkflowIfNode
  | WorkflowFilterNode;

/* --- reusable nodes ------------------------------------------------------ */

/**
 * The node kinds that can be saved once and used in several graphs.
 *
 * Source and sink, and the reason is that those two are the only kinds whose
 * *composition* is worth a name. A connection is already a shared object, and it
 * answers "which database" — but nobody reaches for "the warehouse" when they
 * draw a graph, they reach for "the nightly MVR pull from the warehouse", which
 * is the connection **plus** the query, plus whether it reads everything or only
 * what changed, plus what the thing is called. That composition had nowhere to
 * live, so it was retyped per graph and the fourteenth copy was the one with the
 * typo in the `WHERE` clause.
 *
 * A transform is deliberately **not** here, and that is not an omission: a
 * transform is already a stored object referenced by id
 * ({@link WorkflowTransformNode.transformId}), so a reusable transform node
 * would be a second way to say the same thing. What it was missing is a version
 * pin, which is {@link WorkflowTransformNode.transformVersion}, not this.
 *
 * `call`, `if` and `filter` are not here either, and the record below is where
 * each of them says so — see {@link NODE_KIND_IS_REUSABLE}.
 */
export const REUSABLE_NODE_KINDS = ['source', 'sink'] as const;

export type ReusableNodeKind = (typeof REUSABLE_NODE_KINDS)[number];

/** Same reason as {@link isConnectorKind}: one list, no second copy to drift. */
export function isReusableNodeKind(value: unknown): value is ReusableNodeKind {
  return REUSABLE_NODE_KINDS.some((kind) => kind === value);
}

/**
 * Whether each node kind may be saved as a reusable node.
 *
 * A record over every kind rather than a shorter list of the two that can,
 * because this codebase keeps being bitten by hand-maintained lists going quiet
 * — most recently the add-node row that shipped the `filter` node with no way to
 * create it. A kind added to {@link WORKFLOW_NODE_KINDS} without an entry here
 * is a type error in this file naming the decision it has not made.
 *
 * The second `satisfies` is the other half of the same guard, in the other
 * direction: anything named in {@link REUSABLE_NODE_KINDS} has to be `true`
 * here, so the list and this table cannot come apart. Adding `'filter'` to that
 * list without a `ReusableFilterBody` therefore fails to compile twice — once
 * here, and once at every narrowing over {@link ReusableNodeBody}.
 *
 * Why each `false`:
 *
 * - `transform` — already a reference to a stored object. See
 *   {@link REUSABLE_NODE_KINDS}.
 * - `call` — already a reference to somebody else's registered workflow, pinned
 *   by name and version. There is nothing left to name.
 * - `if` and `filter` — a predicate is *about* the rows in front of it. A gate
 *   saved under a name and dropped into another graph tests a column that graph
 *   may not have, and a filter is worse: {@link WorkflowFilterNode.narrows} is
 *   an acknowledgement about *this* graph's sinks, so a shared one would carry
 *   somebody else's acknowledgement into a graph they never saw.
 */
export const NODE_KIND_IS_REUSABLE = {
  source: true,
  transform: false,
  sink: true,
  call: false,
  if: false,
  filter: false,
} as const satisfies Record<WorkflowNodeKind, boolean> & Record<ReusableNodeKind, true>;

/** Whether this kind can be saved as a reusable node. Reads {@link NODE_KIND_IS_REUSABLE}. */
export function nodeKindIsReusable(kind: WorkflowNodeKind): boolean {
  return NODE_KIND_IS_REUSABLE[kind];
}

/**
 * What a node carries when it is an instance of a reusable one.
 *
 * ## By reference, and that is the whole feature
 *
 * The cheap version of "save this node" copies its fields into the next graph
 * and forgets where they came from. It is cheaper in every way except the one
 * that was asked for: "quantos workflows tão usando quais nós" is unanswerable
 * about a copy, because after the copy there is nothing left that says the two
 * nodes are the same node. So the id stays on the node, `GET
 * reusable-nodes/:id/workflows` counts by it, and the count is exact rather than
 * a guess at which configurations look alike.
 *
 * ## The fields stay on the node as well, and are not the authority
 *
 * A source node that names a reusable node still carries its own `sourceKind`,
 * `config` and the rest. That is a **cache**, not a copy — the identical
 * arrangement `toGraph` already documents for a source that names a connector:
 * the fields are kept so that `validateWorkflow` stays pure and the canvas can
 * draw the node without a round trip, and execution re-reads the stored object,
 * so an edit takes effect on the next run.
 *
 * ## Which is exactly why {@link version} exists
 *
 * "An edit takes effect on the next run" is the useful behaviour and the
 * dangerous one, and which of the two it is depends on whether the person
 * editing knows who else is downstream. So the reference states its position:
 *
 * - **absent** — follows the latest. What a connector reference has always
 *   meant, and the right default for "the warehouse pull" that four graphs
 *   share and all four want fixed at once.
 * - **present** — pinned. The reusable node may move on and this graph does not,
 *   until somebody edits *this* graph, which is a new version of it with a diff
 *   to read.
 *
 * Both are in the graph fingerprint, so changing position is an edit; neither is
 * silent, which was the whole complaint. This is the same rule
 * {@link WorkflowTransformNode.transformVersion} states for transforms, and it
 * is stated twice on purpose rather than shared: they are two different stored
 * objects and a reader arriving at either should not have to find the other.
 */
export interface ReusableNodeRef {
  /**
   * The reusable node this is an instance of, or absent for a node configured
   * in place. Both remain first-class, indefinitely: a one-off source is not a
   * failure to reuse something.
   */
  useId?: string;
  /** The pinned version of that reusable node. Absent follows the latest. */
  useVersion?: number;
}

/**
 * The part of a source node that is worth saving under a name.
 *
 * Everything a source needs to read, and nothing that belongs to the graph it
 * sits in. Absent here, on purpose: `id`, which has to be unique within one
 * graph and is also a durable step name, and `position`, which is where somebody
 * dragged the box on one canvas.
 *
 * `name` is absent too, and that is the less obvious one. A reusable node has a
 * name — it is how "flip db sink" is a thing anybody can ask for — but it lives
 * on {@link CatalogReusableNode} rather than in the body, because a graph is
 * allowed to call its instance something else. Folding the name in would rename
 * every node in every graph the moment somebody tidied up the library's naming,
 * and a node's name is documented as cosmetic precisely so that it is nobody
 * else's business.
 */
export interface ReusableSourceBody {
  kind: 'source';
  sourceKind: ConnectorKind;
  connectionId?: string;
  config: Record<string, unknown>;
  secretEnvVar?: string;
  mode?: 'full' | 'incremental';
}

/**
 * The part of a sink node that is worth saving under a name.
 *
 * `targetType` is in here, so "the Mvr full reload" is a thing that can be named
 * — and it is also the field {@link applyReusableNode} refuses to move under a
 * graph that already committed to a different one. Both are true at once and
 * they are not in tension: a graph adopting this body *takes* the type at the
 * moment it is saved, and is grant-checked for it then. What may not happen is
 * the type changing afterwards, under a graph whose author is not looking, into
 * one they were never granted.
 */
export interface ReusableSinkBody {
  kind: 'sink';
  targetType: string;
  mode?: 'full' | 'incremental';
}

export type ReusableNodeBody = ReusableSourceBody | ReusableSinkBody;

/**
 * {@link unreachableNodeKind}, for reusable bodies, and for the identical
 * reason: every branch over {@link ReusableNodeBody} ends here, so a body added
 * to the union without a rule for folding it onto a node is a type error naming
 * the file rather than a graph that saves and then runs a node nobody
 * configured. It throws as well, because these arrive as JSON out of a column.
 */
export function unreachableReusableNodeKind(body: never, where: string): never {
  const kind = typeof body === 'string' ? body : Reflect.get(Object(body), 'kind');
  throw new Error(
    `${where} does not handle a reusable node body of kind ${JSON.stringify(kind)}. The reusable kinds and every decision made per kind are meant to move together.`,
  );
}

/**
 * A node body saved once, under a name, and used from several graphs.
 *
 * Versioned exactly as a {@link CatalogTransform} is, and archived in the same
 * `catalog_revision` table under its own subject — one table, one retention
 * rule, which is the argument `RevisionRow` already makes for holding transforms
 * and saved queries together. That is what makes
 * {@link ReusableNodeRef.version} resolvable rather than merely a number: a
 * graph pinned to v2 can still be handed v2's body after v3 exists.
 *
 * There is no library screen and there is deliberately not going to be one. A
 * reusable node is offered where a node is added and its usage count is shown on
 * the node itself, because the number changes a decision exactly at the moment
 * somebody is about to change something four other graphs depend on — which is
 * not a moment they spend on a listing page.
 */
export interface CatalogReusableNode {
  id: string;
  /**
   * What people ask for it by — "flip db sink". Unique across reusable nodes,
   * enforced in the store, because two of them called the same thing is a
   * picker that cannot be used.
   */
  name: string;
  description?: string;
  /** Which node kind this stands for. Redundant with `body.kind` and indexed. */
  kind: ReusableNodeKind;
  body: ReusableNodeBody;
  /**
   * Counts saves that changed the **body**, exactly as a transform's counts
   * saves that changed the code: renaming a reusable node is not a new version
   * of it, and inflating the number would make a pin to it meaningless.
   */
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * How many graphs use a reusable node, and which.
 *
 * Shaped after `GET connections/:id/workflows`, which answers the same question
 * for a connection, because an operator asking either is about to do the same
 * thing: change something and want to know who is downstream. A count on its own
 * would be a number to be alarmed by; the list is what makes it actionable.
 */
export interface CatalogReusableNodeUse {
  workflowId: string;
  workflowName: string;
  status: WorkflowStatus;
  /** The node within that graph, and the position its reference states. */
  nodeId: string;
  nodeName: string;
  /** The pinned version, or absent for a reference that follows the latest. */
  pinnedVersion?: number;
}

/**
 * Fold a reusable body onto the node that references it.
 *
 * The one implementation, called by the store when a graph is saved and by the
 * runner when one is executed, so the node a canvas draws and the node that runs
 * cannot describe different reads. Pure, and it takes the body rather than
 * fetching one, for the reason `validateWorkflow` is pure: this file is imported
 * by the browser entry point.
 *
 * ## What it refuses
 *
 * A sink body whose `targetType` differs from the one already on the node. That
 * is not a tidiness check — it is the same shape as `WorkflowRunSteps.checkCall`
 * and it is load-bearing for the same reason. A graph's sinks are checked
 * against the author's write grants (`assertMayWriteTypes`) using the type on
 * the node, at save time. If a reusable body could repoint that afterwards, then
 * editing a shared sink would write into a type that nobody with access to this
 * graph was ever granted — and it would do it on a schedule, with the graph's
 * own diff showing nothing. So the disagreement fails, naming both types, and
 * the repair is that the referencing graph is re-saved and re-checked.
 *
 * A mismatched *kind* is refused for the plainer reason that there is nothing
 * sensible to do with it: a sink body on a source node is a reference somebody
 * repointed at the wrong object, and folding half of it in would produce a node
 * that is neither.
 */
export function applyReusableNode(node: WorkflowNode, body: ReusableNodeBody): WorkflowNode {
  if (body.kind === 'source') {
    if (node.kind !== 'source') {
      throw new Error(reusableKindMismatch(node, body.kind));
    }
    return {
      ...node,
      sourceKind: body.sourceKind,
      connectionId: body.connectionId,
      config: body.config,
      secretEnvVar: body.secretEnvVar,
      mode: body.mode,
    };
  }
  if (body.kind === 'sink') {
    if (node.kind !== 'sink') {
      throw new Error(reusableKindMismatch(node, body.kind));
    }
    if (node.targetType.length > 0 && node.targetType !== body.targetType) {
      throw new Error(
        `Sink "${node.name}" (${node.id}) commits ${node.targetType}, and the reusable node it uses now commits ${body.targetType}. A graph is checked against the types its sinks write at the moment it is saved, so a shared sink is not allowed to repoint one afterwards — that would write into a type nobody here was granted. Re-save this graph to adopt ${body.targetType}, which checks the grants again, or pin this node to the version that still commits ${node.targetType}.`,
      );
    }
    return { ...node, targetType: body.targetType, mode: body.mode };
  }
  return unreachableReusableNodeKind(body, 'applyReusableNode');
}

function reusableKindMismatch(node: WorkflowNode, bodyKind: ReusableNodeKind): string {
  return `Node "${node.name}" (${node.id}) is a ${node.kind} node and the reusable node it names is a ${bodyKind}. A reference that changed kind under a graph would leave a node that is neither, so this is refused rather than half-applied.`;
}

/** Whether a stored value is a reusable body this build can execute. */
export function isReusableNodeBody(value: unknown): value is ReusableNodeBody {
  if (typeof value !== 'object' || value === null) return false;
  const kind = Reflect.get(value, 'kind');
  if (kind === 'source') {
    const config = Reflect.get(value, 'config');
    return (
      isConnectorKind(Reflect.get(value, 'sourceKind')) &&
      typeof config === 'object' &&
      config !== null &&
      !Array.isArray(config)
    );
  }
  if (kind === 'sink') {
    const targetType = Reflect.get(value, 'targetType');
    return typeof targetType === 'string' && targetType.length > 0;
  }
  // Refused rather than defaulted, exactly as `isWorkflowNode` refuses a kind it
  // does not know: a body read back as something this build has no rule for
  // would be folded onto a node as nothing at all, and the node would then run
  // whatever was cached on it while claiming to be an instance of the library's.
  return false;
}

/**
 * The body a node is currently carrying, ready to be saved under a name.
 *
 * The other direction of {@link applyReusableNode}, and the reason
 * save-as-reusable cannot silently deep-copy: this is what gets stored, the node
 * keeps a `useId` pointing at it, and nothing anywhere duplicates a graph.
 *
 * Answers `undefined` for a kind that cannot be reusable rather than throwing,
 * because the caller is a route answering a person who pressed a button on a
 * node — {@link nodeKindIsReusable} is what a screen asks before offering it,
 * and the route repeats the question rather than trusting the screen asked.
 */
export function reusableNodeBodyOf(node: WorkflowNode): ReusableNodeBody | undefined {
  if (node.kind === 'source') {
    return {
      kind: 'source',
      sourceKind: node.sourceKind,
      connectionId: node.connectionId,
      config: node.config,
      secretEnvVar: node.secretEnvVar,
      mode: node.mode,
    };
  }
  if (node.kind === 'sink') {
    return { kind: 'sink', targetType: node.targetType, mode: node.mode };
  }
  return undefined;
}

/**
 * What a node's version discipline is, as a sentence a screen can render.
 *
 * Here rather than in the console for the reason `describeDurability`'s siblings
 * are: a screen that worked out its own wording would eventually describe
 * "follows the latest" as though it were a pin, which is the misunderstanding
 * this whole field exists to remove. One sentence, one place, and the console
 * renders it.
 */
export interface VersionPinCopy {
  pinned: boolean;
  label: string;
  detail: string;
}

export function describeVersionPin(version: number | undefined, subject: string): VersionPinCopy {
  if (version === undefined) {
    return {
      pinned: false,
      label: 'follows the latest',
      detail: `This node runs whatever ${subject} says today. An edit to it reaches this graph on the next run, with no new version of this graph and nothing in its diff — which is what you want when the point is that everybody moves together, and is worth pinning against when it is not.`,
    };
  }
  return {
    pinned: true,
    label: `pinned to v${version}`,
    detail: `This node runs v${version} of ${subject} and stays there while it is edited elsewhere. Moving to a newer version is an edit to this graph, so it has a diff and a version of its own. A pin to a version that has been superseded more than ${CATALOG_REVISION_LIMIT} times can no longer be produced, and the run fails saying so rather than quietly using the latest.`,
  };
}

/**
 * The same question about a whole graph: does it follow its latest save, or does
 * it run a version somebody chose?
 *
 * Shares {@link VersionPinCopy} and its two labels with
 * {@link describeVersionPin} deliberately. A console that said "pinned to v6"
 * about a transform node and invented different words for a graph would be two
 * vocabularies for one idea, and the reader would have to work out whether they
 * meant the same thing — which is the confusion the whole notion of a pin exists
 * to remove.
 *
 * The *detail* differs, and only where the facts do. Two of them:
 *
 * - A node's pin can outlive the revision it names, because `catalog_revision`
 *   is capped. A graph's cannot: releases are never evicted, precisely because
 *   the one a live pointer names is the graph production is running. So this
 *   copy makes no eviction caveat, and must not acquire one.
 * - Following the latest is *cheap* for a node — everybody moves together, which
 *   is often the point. For a graph it means editing is deploying, which is the
 *   hazard this field was added to remove. So the unpinned sentence here is a
 *   warning where the node's is a trade-off.
 */
export function describeLiveVersion(workflow: CatalogWorkflow): VersionPinCopy {
  if (workflow.liveVersion === undefined) {
    return {
      pinned: false,
      label: 'follows the latest',
      detail: `This graph runs whatever its latest save holds, currently v${workflow.version}. Editing it is therefore the same act as deploying it: the next scheduled window runs what was last saved, with nobody having decided that it should. Releasing a version and setting it live is what separates the two.`,
    };
  }
  return {
    pinned: true,
    label: `running v${workflow.liveVersion}`,
    detail:
      workflow.liveVersion === workflow.version
        ? `This graph runs the released v${workflow.liveVersion}, which is also its latest save. Editing it from here changes nothing about what runs until a new version is released and set live.`
        : `This graph runs the released v${workflow.liveVersion} while its latest save is v${workflow.version}. The edits since then are stored and are not running; setting a newer release live is what deploys them, and setting an older one live is a rollback.`,
  };
}

/**
 * Which side of an {@link WorkflowIfNode} a wire leaves by.
 *
 * **Two closed values rather than free-form labels**, which was the other design
 * and is worse in the one way that matters here: an unlabelled branch is a
 * branch that never runs, and a *misspelled* branch is one too. With a free
 * string, `thn` is a subtree that silently never executes and a graph that
 * validates perfectly; with these, it is refused at the boundary and is a type
 * error in the console. The failure a branch introduces is "nothing loaded and
 * nothing complained", so the vocabulary is the place to make it impossible.
 *
 * An N-way `switch` node was considered and is deliberately not this: it would
 * have to carry its own case list plus a default, the cases would have to be
 * validated against the labels, and an unmatched value would need a rule. That
 * is a different node, and it can be added later without changing this one —
 * because a boolean question is what a predicate answers, and an `if` is exactly
 * the shape of a boolean question.
 */
export const WORKFLOW_BRANCH_LABELS = ['then', 'else'] as const;

export type WorkflowBranchLabel = (typeof WORKFLOW_BRANCH_LABELS)[number];

/** Same reason as {@link isConnectorKind}: one list, no second copy to drift. */
export function isWorkflowBranchLabel(value: unknown): value is WorkflowBranchLabel {
  return WORKFLOW_BRANCH_LABELS.some((label) => label === value);
}

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
  /**
   * Which branch of an {@link WorkflowIfNode} this wire leaves by.
   *
   * **Optional, and absent on every edge that existed before branches did.** An
   * edge with no label is a plain wire that always carries rows when its source
   * ran — which is what every stored edge is, so nothing about an existing graph
   * changes, including its fingerprint. The label is *required* on an edge
   * leaving an `if` and *refused* on any other, both by `validateWorkflow`: a
   * label on a wire nothing branches at would look like a decision and be
   * ignored, and an unlabelled wire out of an `if` has no branch to belong to.
   *
   * Several wires may share a label. An `if` whose `then` side fans out to two
   * nodes is ordinary fan-out that happens to be conditional; what is refused is
   * two wires between the *same pair*, which was already refused as a duplicate.
   */
  branch?: WorkflowBranchLabel;
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
   * Which released version a run of this graph gets when nobody names one.
   *
   * **Absent means follow the latest**, which is what every graph in every
   * deployment does today and what every existing graph keeps doing until
   * somebody points this at something. Absence is a real answer rather than a
   * state waiting to be filled in — the same stance {@link WorkflowCallNode}
   * takes from the other side, where a call that named no version would run
   * whichever one is registered when the load happens.
   *
   * Present, it names a {@link CatalogWorkflowRelease} — and from that moment
   * **editing this graph stops being deploying it**. A save bumps
   * {@link version} as it always did; the next scheduled window still runs the
   * released version this names, because a cron tick that executed whatever the
   * canvas happened to hold is a deploy nobody performed. Moving it is
   * {@link CatalogWorkflowReleaseStore.setLiveWorkflowVersion}, which is a
   * deliberate act by a named principal, and moving it *backwards* is the whole
   * of rollback.
   *
   * ## Why this is a column here and not a row in an environments table
   *
   * Because the row is already per-environment. Environments in this catalog are
   * physically isolated — one database each, see `catalog.environment.ts` — so
   * this `catalog_workflow` row exists once per environment already, and a
   * second dimension keyed on the environment id would be a table whose every
   * query filtered on a constant. The environment is the connection, and it has
   * been since environments were added.
   *
   * That is also why the field is not called `productionVersion`. "Production"
   * in this catalog is the *name of an environment* — see `CatalogEnvironment`
   * in `catalog.environment.ts` — so a column called that, on a row which
   * already lives inside exactly one environment, would read as naming a
   * different one.
   *
   * ## Why it does not cross a promotion
   *
   * `planPromotion` is explicit that version numbers do not cross: a version
   * counts edits made in the environment it lives in, so dev's v7 and
   * production's v7 are unrelated numbers. A pointer *to* a version inherits
   * that argument whole — carrying this field would point the target's live
   * pointer at whatever its own seventh edit happened to be. So
   * `PromotableWorkflow` does not carry it, and a promoted graph arrives
   * following the latest, exactly as a newly created one does.
   */
  liveVersion?: number;
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
  /**
   * Which branch an `if` node took, for an `if` node.
   *
   * **On the step's output, which is the whole mechanism.** A step's output is
   * what the durable engine checkpoints and hands back on replay without running
   * the step again, so putting the evaluated branch here means the decision is
   * made exactly once, in the run's own history, and every later turn reads the
   * recorded one. A body that asked the predicate itself would be re-evaluating
   * a pod-local fact on a pod that may not be the same one.
   */
  branch?: WorkflowBranchLabel;
  rows: number;
  /**
   * What a {@link WorkflowFilterNode} was handed, against `rows` above, which is
   * what it passed on. See {@link WorkflowNodeOutcome.rowsIn}: it travels on the
   * step's output so that a replayed node reports the same drop the first
   * attempt did, rather than reporting nothing because it was not re-run.
   */
  rowsIn?: number;
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
 * ## What this used to say, and what changed
 *
 * This shape was declared with nothing producing it, because a picker needs a
 * list and no list existed. The durable engine could answer
 * `workflowBody(name, version)` for the process asking and nothing more, and a
 * missing body is ambiguous by construction: it equally means "not registered",
 * "registered through `registerRemote` against another SDK", or "a group
 * resolved by convention against a live worker". A list inferred from that
 * would have omitted precisely the cross-SDK workflows this node exists to
 * call, and would have omitted them silently.
 *
 * `@dudousxd/nestjs-durable-core` **0.65.0** closed that with
 * `WorkflowEngine.announcedWorkflows()`: live workers publish what they can
 * execute on the worker-descriptor keyspace, and every pod folds the same
 * published statements, so the answer no longer depends on which replica
 * served the request. That is what fills this shape now — see
 * `WorkflowLauncher.callableWorkflows` in `@dudousxd/nestjs-catalog-pipeline`
 * for the adapter, and keep three properties of the aggregate in mind, because
 * every field below exists to carry one of them:
 *
 * - **It is what is runnable, not what is known about.** The announcer is
 *   always the process that CONSUMES the queue, so a `registerRemote` entry is
 *   never announced by the engine that declared it. An operator running bodies
 *   inline with no queue announces nothing at all — its workflows are real and
 *   startable, and simply not in this list.
 * - **It is a snapshot.** An announcement lives on a descriptor key with the
 *   worker-heartbeat TTL, so a worker that dies takes its entries with it
 *   within about one beat. Nothing built on this should be cached past that,
 *   and nothing should present it as authoritative-forever.
 * - **Disagreements are kept, not merged.** Two live workers may claim the same
 *   `name@version` from different groups. The aggregate refuses to pick a
 *   winner, and so does this shape: see {@link disagreements}.
 *
 * One entry per **version**, never per name — a picker that listed names and
 * resolved the version for you would undo the pin the call node exists for.
 */
export interface CallableWorkflowRef {
  name: string;
  /**
   * The version to pin, and **absent is a real answer**.
   *
   * A worker that has not been upgraded announces a bare name with no version
   * and no group. Silence is not a claim, so no version is invented for it from
   * another announcer's — and an entry without one cannot satisfy the pin, which
   * is why {@link callableWorkflowBlock} refuses it rather than letting a picker
   * offer a name that would run whatever is newest on the day it runs.
   */
  version?: string;
  /** What it does, if the deployment publishes one. Shown beside the name. */
  description?: string;
  /**
   * The worker group its turns are dispatched to, when the live announcers
   * agree on exactly one. The signal that says "this one's body is not in this
   * process" — a Python workflow, or a separate TS worker — which is precisely
   * what a caller cannot otherwise tell from a missing body.
   *
   * Absent means either nobody stated one or the announcers disagree, and those
   * two are not the same: the second puts a `group` entry in
   * {@link disagreements} and the first does not.
   */
  group?: string;
  /**
   * How many live workers announce it. `1` is a single point of failure, and it
   * is never `0` — an entry exists only because somebody announced it.
   */
  workers?: number;
  /**
   * The axes the live announcers do not agree on, empty or absent when they
   * speak with one voice. Carried rather than resolved: the registry refuses to
   * guess and so does everything downstream of it.
   */
  disagreements?: CallableWorkflowDisagreement[];
}

/**
 * One axis on which the live announcers of a workflow differ.
 *
 * Mirrors the durable engine's own `Disagreement` rather than re-deriving it,
 * and `values` holds every distinct **declared** value: an announcer that stated
 * nothing on the axis contributes nothing, because silence is not a claim.
 */
export interface CallableWorkflowDisagreement {
  axis: 'group' | 'origin' | 'requires';
  values: string[];
}

/**
 * Why an announced entry must not be committed onto a call node, or `undefined`
 * when it can be.
 *
 * Pure and exported from the browser entry point as well as this one, for the
 * reason {@link validateWorkflow} is: the canvas that greys the option out and
 * anything server-side that reasons about the same list must apply *the same*
 * rule. A picker with its own copy of it is a picker that eventually offers
 * something the rest of the system considers unusable.
 *
 * Two refusals, and they are refusals rather than warnings because in both cases
 * committing the entry would write a node whose meaning nobody can state:
 *
 * - `no-version` — an un-upgraded worker announced a bare name. The call node's
 *   whole point is the pin; a node holding a name and no version follows
 *   whatever gets deployed next, which is the failure the version field exists
 *   to prevent. The name is still perfectly typeable by hand *with* a version
 *   the author knows, so this refuses the one-click commit and not the workflow.
 * - `ambiguous-group` — two live workers claim this exact `name@version` from
 *   different groups. Two groups means two queues, and nothing here can know
 *   which one a run would land on, so the two bodies may not even be the same
 *   code. Picking one on the author's behalf would be acting on a claim nobody
 *   made.
 *
 * A disagreement on `origin` or `requires` is deliberately **not** a refusal. It
 * is worth showing — two packages declaring one name is a mess somebody should
 * clean up — but it does not change which queue the run goes to, and refusing on
 * it would block a pin that is otherwise exactly determined.
 */
export interface CallableWorkflowBlock {
  code: 'no-version' | 'ambiguous-group';
  /** A full sentence, addressed to whoever is looking at the picker. */
  message: string;
}

export function callableWorkflowBlock(ref: CallableWorkflowRef): CallableWorkflowBlock | undefined {
  const version = typeof ref.version === 'string' ? ref.version.trim() : '';
  if (version.length === 0) {
    return {
      code: 'no-version',
      message: `A live worker announces "${ref.name}" without saying which version it runs, which is what a worker announces before it has been upgraded to publish its registrations in full. A name with no version cannot be pinned, so this cannot be chosen — type the name and the version you mean.`,
    };
  }
  const groups = ref.disagreements?.find((entry) => entry.axis === 'group')?.values ?? [];
  if (groups.length > 1) {
    return {
      code: 'ambiguous-group',
      message: `Live workers announce ${ref.name}@${version} from ${groups.length} different groups (${groups.join(', ')}), so nothing can say which queue a run would be dispatched to — or whether the two are even the same code. This cannot be chosen until the deployment stops claiming it twice.`,
    };
  }
  return undefined;
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
  'if-not-named',
  'if-threshold-invalid',
  'if-needs-one-input',
  'branch-not-labelled',
  'branch-on-plain-edge',
  'filter-predicate-invalid',
  'filter-narrows-unacknowledged',
  'filter-narrows-nothing',
  /**
   * A version pin that is not a version — `0`, `2.5`, `"3"`, `-1`.
   *
   * One code for both pins, because they are one mistake: a threshold that
   * cannot name a version can only ever fail to resolve, and it fails inside a
   * durable step halfway through a load rather than on the canvas. The same
   * argument `if-threshold-invalid` makes one field along.
   */
  'version-pin-invalid',
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
  checkBranches(edges, byId, issues);
  checkFilterNarrowing({ nodes, edges }, originators, outgoing, issues);

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
    // Exactly one, not "at least one". A gate hands its successors the ref of
    // the stage it was given rather than staging a copy — see `WorkflowIfNode`
    // — and one output ref cannot name two inputs, so a second inbound edge
    // would be silently dropped. Zero is caught by `unreachable` instead, which
    // points at the same fix with the better message.
    if (node.kind === 'if' && (incoming.get(node.id)?.length ?? 0) > 1) {
      issues.push({
        code: 'if-needs-one-input',
        nodeIds: [node.id],
        message: `If "${node.name}" (${node.id}) has ${incoming.get(node.id)?.length} inbound edges, and it can only carry one through. An if node is a gate: it passes the rows it is given straight down whichever branch it takes, so it has one output to hand on and cannot merge. Wire those inputs into a transform and gate the transform instead.`,
      });
    }
    const unconfigured = nodeIsUnconfigured(node);
    if (unconfigured) issues.push(unconfigured);
    checkVersionPins(node, issues);
  }
}

/**
 * Every version pin on this node names a version that could exist.
 *
 * Both pins in one place, because they are one rule and splitting it is how one
 * of the two ends up accepting `0`. Checked here rather than only at the HTTP
 * boundary because `validateWorkflow` is what the canvas runs, so this is the
 * difference between a refusal on the screen where the number was typed and a
 * 400 after pressing Save.
 *
 * A pin has to be a whole number of at least one, matching what a version
 * actually is: {@link CatalogTransform.version} and
 * {@link CatalogReusableNode.version} both start at 1 and count up in ones.
 * `"3"` — which is what an unparsed form field sends — is refused rather than
 * coerced, for the reason `if-threshold-invalid` refuses it: a pin that no
 * stored version can equal resolves to nothing, and it does so inside a durable
 * step in the middle of a load.
 *
 * A `useVersion` with no `useId` is caught here too, as an invalid pin rather
 * than as its own code: it pins a reference that does not exist, so the number
 * can never be looked up.
 */
function checkVersionPins(node: WorkflowNode, issues: WorkflowValidationIssue[]): void {
  if (node.kind === 'transform') {
    const invalid = badPin(node.transformVersion);
    if (invalid) {
      issues.push({
        code: 'version-pin-invalid',
        nodeIds: [node.id],
        message: `Transform node "${node.name}" (${node.id}) is pinned to version ${invalid} of its code, and a version is a whole number of at least 1. Leave it unset for the node to follow the latest.`,
      });
    }
    return;
  }
  if (!nodeKindIsReusable(node.kind)) return;
  // Narrowed off the union rather than read off `node` with a property check,
  // so a kind that becomes reusable without gaining the fields is a type error
  // here and not a check that silently passes.
  if (node.kind !== 'source' && node.kind !== 'sink') return;
  const invalid = badPin(node.useVersion);
  if (invalid) {
    issues.push({
      code: 'version-pin-invalid',
      nodeIds: [node.id],
      message: `Node "${node.name}" (${node.id}) is pinned to version ${invalid} of the reusable node it uses, and a version is a whole number of at least 1. Leave it unset for the node to follow the latest.`,
    });
    return;
  }
  if (node.useVersion !== undefined && node.useId === undefined) {
    issues.push({
      code: 'version-pin-invalid',
      nodeIds: [node.id],
      message: `Node "${node.name}" (${node.id}) is pinned to version ${node.useVersion} but names no reusable node, so there is nothing for that version to be a version of.`,
    });
  }
}

/** The offending value, rendered, or `undefined` when the pin is fine or absent. */
function badPin(version: number | undefined): string | undefined {
  if (version === undefined) return undefined;
  if (typeof version === 'number' && Number.isInteger(version) && version >= 1) return undefined;
  return JSON.stringify(version);
}

/**
 * Every wire out of an `if` names a branch, and no other wire does.
 *
 * Both halves, because the two failures are opposite and both are silent. An
 * unlabelled wire out of an `if` belongs to no branch, so nothing would ever
 * take it and the subtree behind it would be skipped on every run of every
 * deployment — a graph that draws correctly and quietly does half its work. A
 * label on a wire whose source does not branch is the reverse: a decision
 * somebody wrote down that nothing reads, which is worse than no decision
 * because the canvas draws it.
 *
 * Run after the structural checks, so `byId` has every endpoint and this cannot
 * report a wire whose real problem is that it points at a node that was deleted.
 */
function checkBranches(
  edges: readonly WorkflowEdge[],
  byId: ReadonlyMap<string, WorkflowNode>,
  issues: WorkflowValidationIssue[],
): void {
  for (const edge of edges) {
    const from = byId.get(edge.from);
    if (!from) continue;
    if (from.kind === 'if' && edge.branch === undefined) {
      issues.push({
        code: 'branch-not-labelled',
        nodeIds: [edge.from, edge.to],
        message: `The wire from "${from.name}" (${from.id}) to "${byId.get(edge.to)?.name ?? edge.to}" does not say which branch it is on. Every wire out of an if node belongs to "then" or to "else", because that is what decides whether it runs — an unlabelled one would never be taken, and everything only it feeds would be skipped on every run with nothing to say why.`,
      });
      continue;
    }
    if (from.kind !== 'if' && edge.branch !== undefined) {
      issues.push({
        code: 'branch-on-plain-edge',
        nodeIds: [edge.from, edge.to],
        message: `The wire from "${from.name}" (${from.id}) is labelled "${edge.branch}", but "${from.name}" is a ${from.kind} node and does not branch. A label nothing decides on is a decision that is drawn and never read; remove it, or put an if node where the choice is meant to be made.`,
      });
    }
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
  if (node.kind === 'if') return ifIsUnconfigured(node);
  if (node.kind === 'filter') return filterIsUnconfigured(node);
  return undefined;
}

/**
 * A filter whose test cannot decide anything.
 *
 * The whole predicate, checked by the same guard that reads one back out of a
 * database, rather than a field-by-field re-implementation here. That is not
 * only tidiness: the failures it catches are all *silent* ones and they point in
 * opposite directions — an empty `all` keeps every row so the filter does
 * nothing, an empty `any` drops every row so the load comes out empty, and a
 * predicate whose operator this build does not recognise would do neither
 * because {@link workflowFilterMatches} throws inside a step. A canvas has to
 * say so before any of that.
 */
function filterIsUnconfigured(node: WorkflowFilterNode): WorkflowValidationIssue | undefined {
  if (isWorkflowFilterPredicate(node.predicate)) return undefined;
  return {
    code: 'filter-predicate-invalid',
    nodeIds: [node.id],
    message: `Filter "${node.name}" (${node.id}) has no test this service can run. A filter tests bare column names (letters, digits and underscore, starting with a letter or underscore) against plain values, combined with "all" and "any"; a group has to have at least one condition in it, a list at least one value and no more than ${WORKFLOW_FILTER_MAX_VALUES}, and the whole tree may nest ${WORKFLOW_FILTER_MAX_DEPTH} deep. An empty "all" keeps every row and an empty "any" drops every row, which is why neither is stored.`,
  };
}

/**
 * That every filter names the published types it narrows, and names no others.
 *
 * See {@link WorkflowFilterNode.narrows} for the argument. This is the rule
 * that turns dragging a filter onto a working `source → sink` wire into a graph
 * that refuses to save until somebody writes down the name of the type they are
 * about to shrink.
 *
 * Run after the structural checks and after the cycle check would have returned,
 * so the reachability walks below are over a graph that has both ends and no
 * loop.
 */
function checkFilterNarrowing(
  graph: WorkflowGraph,
  originators: readonly WorkflowNode[],
  outgoing: ReadonlyMap<string, string[]>,
  issues: WorkflowValidationIssue[],
): void {
  const rootIds = originators.map((one) => one.id);
  for (const node of graph.nodes) {
    if (node.kind !== 'filter') continue;
    const required = workflowNarrowedTypes(graph, node.id, {
      originators: rootIds,
      outgoing,
    }).sort();
    const declared = [...new Set(node.narrows ?? [])].sort();

    const missing = required.filter((type) => !declared.includes(type));
    if (missing.length > 0) issues.push(filterNarrowsUnacknowledged(node, missing));

    const spurious = declared.filter((type) => !required.includes(type));
    if (spurious.length > 0) issues.push(filterNarrowsNothing(node, spurious));
  }
}

/** The refusal that stops a filter quietly shrinking a type somebody else reads. */
function filterNarrowsUnacknowledged(
  node: WorkflowFilterNode,
  missing: readonly string[],
): WorkflowValidationIssue {
  const one = missing.length === 1;
  return {
    code: 'filter-narrows-unacknowledged',
    nodeIds: [node.id],
    message: `Filter "${node.name}" (${node.id}) is the only thing feeding the sink that commits ${listTypes(missing)}, and that sink replaces the whole snapshot. So whatever this filter drops disappears from ${one ? 'that type' : 'those types'} the moment this graph runs — and the run reports success, because from its point of view nothing went wrong. If that is what you mean, acknowledge it on the node by naming ${one ? 'the type' : 'the types'}. If you meant to build something new out of a subset, point the sink at a different object type; if you meant to add rows rather than replace them, set the sink to incremental.`,
  };
}

/** The opposite refusal: an acknowledgement the graph no longer backs up. */
function filterNarrowsNothing(
  node: WorkflowFilterNode,
  spurious: readonly string[],
): WorkflowValidationIssue {
  const one = spurious.length === 1;
  return {
    code: 'filter-narrows-nothing',
    nodeIds: [node.id],
    message: `Filter "${node.name}" (${node.id}) says it narrows ${listTypes(spurious)}, and it does not: nothing it drops is missing from ${one ? 'that snapshot' : 'those snapshots'}, either because rows also reach the sink by another path or because the sink merges rather than replaces. An acknowledgement that nothing reads is worse than none, because the canvas draws it and the next reader believes it.`,
  };
}

/** `"A"`, `"A" and "B"`, `"A", "B" and "C"` — for a message, not for a machine. */
function listTypes(types: readonly string[]): string {
  const quoted = types.map((type) => `"${type}"`);
  if (quoted.length <= 1) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/**
 * The object types whose whole published snapshot a node stands in front of.
 *
 * A sink is in this list when it commits in `full` mode — replacing what is
 * served rather than merging into it — **and** removing the named node would
 * make it unreachable from everything that originates rows. That second half is
 * the load-bearing one: a filter on one of two paths into a sink narrows
 * nothing, because the other path still delivers, and a rule that ignored it
 * would demand an acknowledgement for a graph where nothing is lost.
 *
 * Removal-reachability rather than a dominator algorithm, deliberately. The
 * graphs here are a screenful of boxes, this runs once per filter node, and the
 * cheaper version would be a second, subtler implementation of "does this node
 * decide whether that one runs" living next to `checkReachability` — which is
 * exactly the kind of duplication that eventually disagrees with the walk the
 * rest of this file does.
 *
 * Exported because the console needs the same answer to offer the right
 * acknowledgements, and a canvas that computed its own would offer a set the
 * server then refuses.
 *
 * `precomputed` exists only so the validator, which has already built the
 * adjacency it needs, does not build it twice per filter node. Callers outside
 * this file pass a graph and nothing else.
 */
export function workflowNarrowedTypes(
  graph: WorkflowGraph,
  nodeId: string,
  precomputed?: { originators: string[]; outgoing: ReadonlyMap<string, string[]> },
): string[] {
  const nodes = graph.nodes ?? [];
  const outgoing = precomputed?.outgoing ?? buildAdjacency(nodes, graph.edges ?? []).outgoing;
  const originators =
    precomputed?.originators ?? nodes.filter((node) => originatesRows(node)).map((node) => node.id);

  // Everything still reachable once this node is taken out. A source that *is*
  // the node cannot originate anything, which falls out of the filter below
  // rather than needing its own case.
  const roots = originators.filter((id) => id !== nodeId);
  const reachableWithout = walk(roots, stripNode(outgoing, nodeId));

  const types: string[] = [];
  for (const node of nodes) {
    if (!narrowedByRemoval(node, reachableWithout)) continue;
    const type = node.targetType.trim();
    if (type.length > 0 && !types.includes(type)) types.push(type);
  }
  return types;
}

/**
 * Whether this node is a full-mode sink that the removed node was the only way
 * to reach.
 *
 * A sink with no explicit mode is a **full** sink — the same default `runSink`
 * applies, read the same way here, because a graph that validated under one
 * meaning of the absent field and ran under the other is precisely the failure
 * this whole check exists to prevent.
 */
function narrowedByRemoval(
  node: WorkflowNode,
  reachableWithout: ReadonlySet<string>,
): node is WorkflowSinkNode {
  if (node.kind !== 'sink') return false;
  if ((node.mode ?? 'full') === 'incremental') return false;
  return !reachableWithout.has(node.id);
}

/** The same adjacency with one node's outgoing edges cut, leaving the original alone. */
function stripNode(outgoing: ReadonlyMap<string, string[]>, nodeId: string): Map<string, string[]> {
  const without = new Map<string, string[]>();
  for (const [from, targets] of outgoing) {
    if (from === nodeId) continue;
    without.set(
      from,
      targets.filter((to) => to !== nodeId),
    );
  }
  return without;
}

/**
 * A gate whose test cannot decide anything.
 *
 * The third of the same mistake {@link nodeIsUnconfigured} describes, once per
 * predicate kind, because "unconfigured" means something different for each and
 * a single check would have to pick one. Both refusals exist for one reason: a
 * gate that cannot really choose still picks a branch, and whichever it picks is
 * a decision the graph appears to make and nobody authored — with half the
 * pipeline silently not running as the only symptom.
 */
function ifIsUnconfigured(node: WorkflowIfNode): WorkflowValidationIssue | undefined {
  const predicate = node.predicate;
  if (predicate.kind === 'env') {
    if (predicate.envVar.trim().length > 0) return undefined;
    return {
      code: 'if-not-named',
      nodeIds: [node.id],
      message: `If "${node.name}" (${node.id}) names no environment variable, so there is nothing for it to decide on. It reads the *name* of a variable on the machine that runs the load — that is how a graph tells a deployment with a ClickHouse apart from one without.`,
    };
  }
  if (predicate.kind === 'rowCount') {
    // At least one, so both answers are reachable. A threshold of zero is
    // satisfied by every run including an empty one, so the `else` subtree would
    // never execute on any deployment — the silent half-graph, arrived at by
    // typing a number rather than by mislabelling a wire.
    if (Number.isInteger(predicate.atLeast) && predicate.atLeast >= 1) return undefined;
    return {
      code: 'if-threshold-invalid',
      nodeIds: [node.id],
      message: `If "${node.name}" (${node.id}) branches on a row count of ${JSON.stringify(predicate.atLeast)}, and a threshold has to be a whole number of at least 1. "At least 1" is the "did anything arrive at all" test; 0 would be satisfied by every run, so the else branch — and everything only it feeds — would never run on any deployment.`,
    };
  }
  return unreachablePredicateKind(predicate, 'validateWorkflow');
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
export function workflowRunOrder(graph: WorkflowGraph): WorkflowRunOrderEntry[] {
  const issues = validateWorkflow(graph);
  if (issues.length > 0) {
    throw new Error(
      `Refusing to order an invalid workflow: ${issues.map((issue) => issue.message).join(' ')}`,
    );
  }

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const labels = branchLabels(graph.edges);
  // The same adjacency the validator walks, from the same builder. Two copies of
  // "what is wired into what" is exactly how a graph that validated comes out
  // executing differently, which is the thing this function's contract rules out.
  const { outgoing, incoming } = buildAdjacency(graph.nodes, graph.edges);
  const indegree = new Map(
    graph.nodes.map((node) => [node.id, incoming.get(node.id)?.length ?? 0]),
  );

  const ready = graph.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const order: WorkflowRunOrderEntry[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) break;
    const node = byId.get(id);
    if (!node) continue;
    // Edge order, not node order: this is the array a merge reads its inputs
    // from, and it is part of the fingerprint precisely because it is visible in
    // the output. `buildAdjacency` fills `incoming` by walking the edges in
    // order, so that is what this already is.
    const inputs = [...(incoming.get(id) ?? [])];
    order.push({ node, inputs, inputBranches: labelsInto(id, inputs, labels) });
    for (const next of outgoing.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }
  return order;
}

/** One position in the order: which node, what feeds it, and on which branches. */
export interface WorkflowRunOrderEntry {
  node: WorkflowNode;
  /** Upstream node ids, in inbound-edge order. */
  inputs: string[];
  /**
   * The branch label of each inbound edge that has one, keyed by the upstream
   * node id.
   *
   * A record rather than an array positionally aligned with {@link inputs},
   * which was the obvious shape and is unsafe for one specific reason: this
   * travels through a durable checkpoint as JSON, and `JSON.stringify` turns an
   * `undefined` hole in an array into `null`. A plain wire would come back from
   * a replay as `null` rather than absent, `null !== 'then'` would be false, and
   * the node would be treated as dead — the graph would silently stop running
   * half of itself on resumed runs only. A key that is simply not there
   * round-trips exactly. The key is unique because duplicate edges are refused.
   */
  inputBranches: Record<string, WorkflowBranchLabel>;
}

/** Every labelled wire, keyed by the pair it joins. */
function branchLabels(edges: readonly WorkflowEdge[]): Map<string, WorkflowBranchLabel> {
  const labels = new Map<string, WorkflowBranchLabel>();
  for (const edge of edges) {
    if (edge.branch === undefined) continue;
    labels.set(`${edge.from}\0${edge.to}`, edge.branch);
  }
  return labels;
}

/** The labels on the wires into one node, with the unlabelled ones left out. */
function labelsInto(
  to: string,
  inputs: readonly string[],
  labels: ReadonlyMap<string, WorkflowBranchLabel>,
): Record<string, WorkflowBranchLabel> {
  const into: Record<string, WorkflowBranchLabel> = {};
  for (const from of inputs) {
    const label = labels.get(`${from}\0${to}`);
    if (label !== undefined) into[from] = label;
  }
  return into;
}

/**
 * Whether a node runs, given what the nodes before it did.
 *
 * ## The rule
 *
 * A node runs when **at least one wire into it is live**, where a wire is live
 * if its source ran and — when the wire carries a branch label — the source is
 * an `if` that took that branch. A node with no inbound wires always runs, which
 * is every source and every originating call.
 *
 * ## Why the obvious rule is wrong
 *
 * The naive version is "mark everything downstream of the untaken edge as
 * skipped", and it is wrong on the shape branches are most often drawn in:
 *
 * ```
 *      ┌ then → A ┐
 * if ──┤          ├→ C → sink
 *      └ else → B ┘
 * ```
 *
 * `C` is downstream of `B`. Take the `then` branch and the naive rule walks from
 * the untaken `else` edge, reaches `B`, reaches `C`, and skips it — so the sink
 * never runs and the load silently commits nothing, on a graph whose whole
 * purpose was that both branches converge. Reachability from the **taken** edges
 * gets it right: `C` is reached through `A`, so it runs, and `B` — reached only
 * through the untaken edge — does not. `C` then sees an empty stage ref for `B`,
 * which is exactly what `stageRefsFor` already does for an upstream that
 * produced nothing, so the positions a merge reads stay aligned with the wires
 * that were drawn.
 *
 * It is evaluated incrementally rather than as a graph walk because the answers
 * arrive as the run goes: `workflowRunOrder` is topological, so by the time a
 * node is reached every node feeding it has an outcome. That also means this
 * reads **only** what was recorded — no predicate is re-evaluated here, which is
 * the property the whole branch feature rests on.
 */
export function workflowNodeRuns(
  entry: {
    inputs: readonly string[];
    inputBranches?: Readonly<Record<string, WorkflowBranchLabel>>;
  },
  outcomes: Readonly<Record<string, WorkflowNodeOutcome>>,
): boolean {
  if (entry.inputs.length === 0) return true;
  return entry.inputs.some((from) => {
    const upstream = outcomes[from];
    // Anything other than a clean success means this wire carried nothing: a
    // skipped upstream is not on a live path, and a failed one aborts the run
    // before this is ever asked.
    if (upstream?.status !== 'succeeded') return false;
    const label = entry.inputBranches?.[from];
    // A plain wire. Live because its source ran, which is what every graph
    // drawn before branches existed relies on.
    if (label === undefined) return true;
    return upstream.branch === label;
  });
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
  // The branch is appended only when there is one, so every edge drawn before
  // branches existed hashes to exactly the string it always did. Adding a graph
  // to this file must not renumber the versions of graphs that did not change.
  const edges = graph.edges.map((edge) =>
    edge.branch === undefined
      ? `${edge.from}>${edge.to}`
      : `${edge.from}>${edge.to}:${edge.branch}`,
  );
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
      // Appended only when there is a reference, exactly as `edge.branch` above
      // is appended only when there is a label, and for the same reason: adding
      // reusable nodes to this file must not renumber the version of a single
      // graph that did not change. Every source drawn before they existed
      // hashes to the string it always did.
      ...canonicalReuse(node),
    ]);
  }
  if (node.kind === 'transform') {
    // The transform's *version as stored* is deliberately not in here, and that
    // has not changed: editing a transform is recorded as a new transform
    // version, and folding it in would bump every graph that references it,
    // which would claim the wiring changed when it did not.
    //
    // What IS in here is the *pin* — which is the opposite choice for the
    // opposite reason, and the same one `call` makes one branch down. Moving a
    // node from v3 to v5, or off a pin onto the latest, changes what the load
    // runs as surely as rewiring it does, and is a decision somebody made in
    // this graph. Appended rather than always present, so an unpinned node —
    // which is every transform node in every deployment today — hashes to
    // exactly the string it always did.
    return node.transformVersion === undefined
      ? JSON.stringify([node.id, node.kind, node.transformId])
      : JSON.stringify([node.id, node.kind, node.transformId, node.transformVersion]);
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
  if (node.kind === 'if') {
    return JSON.stringify([node.id, node.kind, ...canonicalPredicate(node.predicate)]);
  }
  if (node.kind === 'filter') {
    // `narrows` is in here as well as the predicate, and that is a decision
    // rather than completeness. It changes nothing about what the node computes
    // — but it is the acknowledgement that a published type is about to become a
    // subset, and a run that happened before anybody acknowledged that must stay
    // distinguishable from one that happened after. Sorted, so ticking the same
    // two boxes in the other order is not an edit.
    return JSON.stringify([
      node.id,
      node.kind,
      canonicalFilterPredicate(node.predicate),
      [...(node.narrows ?? [])].sort(),
    ]);
  }
  if (node.kind === 'sink') {
    return JSON.stringify([
      node.id,
      node.kind,
      node.targetType,
      node.mode ?? 'full',
      ...canonicalReuse(node),
    ]);
  }
  return unreachableNodeKind(node, 'workflowGraphHash');
}

/**
 * The reusable reference, as zero, one or two trailing hash components.
 *
 * Zero when there is no reference, which is what makes this additive: every
 * graph stored before reusable nodes existed produces the same canonical string
 * it always did, so no version is renumbered by a deployment picking up this
 * release. One when the reference follows the latest. Two when it is pinned.
 *
 * "Follows the latest" and "pinned to v1" hash differently, and they must:
 * moving a node off a pin is a real change to what it will run next month, and a
 * fingerprint that could not see it would let somebody unpin a shared sink with
 * no version bump and no diff — which is precisely the silence this feature was
 * built to end.
 */
function canonicalReuse(node: ReusableNodeRef): unknown[] {
  if (node.useId === undefined) return [];
  return node.useVersion === undefined ? [node.useId] : [node.useId, node.useVersion];
}

/**
 * The parts of a predicate that decide which branch runs.
 *
 * The kind leads, so the two tests can never canonicalise to the same string —
 * a gate switched from "is CLICKHOUSE_URL set" to "did 1 row arrive" is a
 * different pipeline on every deployment, and a hash that missed it would leave
 * two runs claiming the same graph version while having taken different halves
 * of it.
 */
function canonicalPredicate(predicate: WorkflowIfPredicate): unknown[] {
  if (predicate.kind === 'env') {
    // Both halves, because both decide which branch runs. `equals` being absent
    // is a *different* test from `equals` being the empty string — "set to
    // anything" against "set to nothing" — so the two must not fold together.
    return [predicate.kind, predicate.envVar, predicate.equals ?? null];
  }
  if (predicate.kind === 'rowCount') {
    return [predicate.kind, predicate.atLeast];
  }
  return unreachablePredicateKind(predicate, 'workflowGraphHash');
}

/**
 * The parts of a filter predicate that decide which rows survive.
 *
 * Which is all of them, so this is a faithful canonicalisation rather than a
 * selection — every field of every kind changes what a load publishes. What it
 * adds over `JSON.stringify` of the predicate is order-independence where order
 * is meaningless and order-*dependence* where it is not: the children of an
 * `all` are sorted, because `A and B` and `B and A` are the same filter and a
 * canvas that rewrites the array must not look like an edit; the `values` of a
 * `oneOf` are sorted for the same reason. The kind and the operator lead, so no
 * two shapes can canonicalise to the same string.
 *
 * `values` is deliberately *not* deduplicated. A duplicate changes nothing about
 * the result, but removing one here would make the hash disagree with what is
 * stored, and the fingerprint is meant to answer "is this the same graph" rather
 * than "is this an equivalent graph".
 */
function canonicalFilterPredicate(predicate: WorkflowFilterPredicate): string {
  if (predicate.kind === 'all' || predicate.kind === 'any') {
    return JSON.stringify([
      predicate.kind,
      predicate.children.map((child) => canonicalFilterPredicate(child)).sort(),
    ]);
  }
  if (predicate.kind === 'oneOf') {
    return JSON.stringify([
      predicate.kind,
      predicate.column,
      predicate.operator,
      [...predicate.values].map((value) => JSON.stringify(value)).sort(),
    ]);
  }
  if (predicate.kind === 'present') {
    return JSON.stringify([predicate.kind, predicate.column, predicate.operator]);
  }
  if (predicate.kind === 'compare') {
    return JSON.stringify([predicate.kind, predicate.column, predicate.operator, predicate.value]);
  }
  return unreachableFilterPredicateKind(predicate, 'workflowGraphHash');
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
  const kind = Reflect.get(value, 'kind');
  if (!isWorkflowNodeKind(kind)) return false;
  // Everything every kind carries, checked once before the narrowing below
  // rather than inside the branches that could carry it. See {@link hasNodeBase}.
  if (!hasNodeBase(value)) return false;
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
  if (kind === 'if') {
    // The predicate in full, refused rather than defaulted: a gate read back
    // without a test it recognises would have to invent one, and inventing one
    // means half the graph runs on a decision nobody made.
    return isWorkflowIfPredicate(Reflect.get(value, 'predicate'));
  }
  if (kind === 'filter') {
    return isNarrowsList(Reflect.get(value, 'narrows'))
      ? isWorkflowFilterPredicate(Reflect.get(value, 'predicate'))
      : false;
  }
  if (kind === 'source') {
    const sourceKind = Reflect.get(value, 'sourceKind');
    const config = Reflect.get(value, 'config');
    return isConnectorKind(sourceKind) && typeof config === 'object' && config !== null;
  }
  return isWorkflowNodeKindUnhandled(kind);
}

/**
 * Whether a stored `narrows` is one this build can read.
 *
 * Checked as strictly as the predicate beside it, and it has to be:
 * {@link WorkflowFilterNode.narrows} is what stands between "filter into the
 * type that already exists" and a published snapshot quietly becoming a subset.
 * A value that is not a list of strings is refused rather than dropped, because
 * dropping it turns a graph somebody acknowledged into one that never was — and
 * `validateWorkflow` would then refuse it with a message about a field they did
 * fill in.
 *
 * Absent is accepted, because that is what every filter narrowing nothing looks
 * like and what every node stored before this field existed is.
 */
function isNarrowsList(value: unknown): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.every((type) => typeof type === 'string');
}

/**
 * A version pin as it comes back out of a JSON column: absent, or a whole number
 * of at least one.
 *
 * The same rule {@link checkVersionPins} states, applied at the read boundary,
 * because the two answer different questions about the same field. The validator
 * tells an author their graph will not run; this decides whether a graph stored
 * by some other build can be read at all. Absent is accepted and always will be
 * — it is what every node written before pins existed carries, and it means
 * "follows the latest", which is exactly what those nodes have always done.
 */
function isOptionalVersion(value: unknown): boolean {
  if (value === undefined) return true;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * Everything every node kind carries, whatever kind it is: its identity, and
 * the things it points at outside itself.
 *
 * Checked once, before {@link isWorkflowNode} narrows per kind, rather than in
 * the branches that could carry each field. The references are declared on two
 * members of the union and a node arriving as JSON does not respect that, so a
 * single check is both cheaper and stricter than two — and a kind that becomes
 * reusable later inherits it rather than having to remember it.
 *
 * A pin read back as `"3"` or as `0` names no stored version, and the resolution
 * happens inside a durable step in the middle of a load. So it is refused where
 * a graph is read out of a column rather than surviving as far as the run that
 * cannot honour it.
 */
function hasNodeBase(value: object): boolean {
  if (typeof Reflect.get(value, 'id') !== 'string') return false;
  if (typeof Reflect.get(value, 'name') !== 'string') return false;
  if (!isOptionalVersion(Reflect.get(value, 'transformVersion'))) return false;
  if (!isOptionalVersion(Reflect.get(value, 'useVersion'))) return false;
  const useId = Reflect.get(value, 'useId');
  return useId === undefined || typeof useId === 'string';
}

/**
 * The narrowing counterpart of {@link unreachableNodeKind}.
 *
 * A guard cannot take a `never` — `kind` here is a string that
 * {@link isWorkflowNodeKind} already accepted — so exhaustiveness is bought by
 * assigning it to one, which is the compile error a new kind has to answer, and
 * refusing the value at run time, which is what a build that skipped this file
 * would do to a node it has no rule for.
 */
function isWorkflowNodeKindUnhandled(kind: never): false {
  void kind;
  return false;
}

export function isWorkflowEdge(value: unknown): value is WorkflowEdge {
  if (typeof value !== 'object' || value === null) return false;
  // A `branch` that is present and unrecognised is refused rather than dropped,
  // for the reason `isWorkflowNode` refuses an unknown node: an edge silently
  // read back without its label is a wire that stops belonging to a branch, and
  // everything behind it stops running with nothing to point at.
  const branch = Reflect.get(value, 'branch');
  if (branch !== undefined && !isWorkflowBranchLabel(branch)) return false;
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
 * One version of a graph, kept exactly as it was, because somebody said so.
 *
 * ## The archive `CatalogWorkflow` argues against, and why this is not it
 *
 * {@link CatalogWorkflow} states plainly that a graph is not revisioned, and the
 * decisive reason it gives is the counter: {@link CatalogWorkflow.version} is
 * bumped on **draft** edits by design, so archiving one body per version would
 * store every autosave of a canvas somebody is still dragging boxes around on —
 * and under a bounded archive that noise would evict the versions that actually
 * ran. **That argument is correct and nothing here weakens it.** It is an
 * argument against archiving *saves*, and this archives *releases*: a release is
 * minted only by `releaseWorkflow`, which is a route a person presses, and a
 * canvas autosave does not reach it. So the counter stays cheap to inflate, the
 * archive stays keyed on a deliberate act, and the two now compose because they
 * are counting different things.
 *
 * The second half of that docblock — that a graph is a structure and a line
 * differ over serialised JSON would report a dragged box as a change — is also
 * untouched. This is not a diff feature. It stores the graph so a version can be
 * *run*, and diffing graphs remains a graph problem deserving a screen that
 * draws one.
 *
 * ## Why not `catalog_revision`, which already archives versioned bodies
 *
 * Two reasons, and the second is the one that decides it.
 *
 * `CatalogRevision.body` is text a person typed — a transform's code, a saved
 * query's SQL — and every route over it is built to render text. A graph is
 * nodes and edges, and folding it into that column would put JSON nobody wrote
 * in front of a differ built for source.
 *
 * The one that decides it is {@link CATALOG_REVISION_LIMIT}. That cap is right
 * for code, for the reason its own docblock gives: revisions grow with how often
 * somebody edits, which nobody meters. A release does not grow that way — it
 * grows with how often somebody deliberately ships — and, crucially, a release
 * is the thing a live pointer names. An eviction rule over this table could
 * delete the graph that production is *currently running*, turning
 * {@link CatalogWorkflow.liveVersion} into a pin nothing can honour and stopping
 * a working pipeline on a retention policy. **So releases are never evicted.**
 * That makes this an unbounded table, which this codebase is careful about — and
 * it earns it on the same test `catalog_audit_event` and `catalog_connector_run`
 * pass: one row per thing a person deliberately did, at a rate an operator can
 * read off their own change process.
 *
 * ## Immutable, and there is no route that removes one
 *
 * Nothing edits a release and nothing deletes one. That is the strongest form of
 * "refuse to delete the version that is live": there is no operation to refuse.
 * The one exception is {@link CatalogWorkflowStore.deleteWorkflow}, which takes
 * the graph, its connector and its whole run history — releases go with it,
 * because nothing survives that could still name one. (The opposite call is made
 * for a transform, whose revisions outlive it precisely *because* runs that ran
 * them survive.)
 */
export interface CatalogWorkflowRelease {
  /**
   * `{workflowId}:{version}`, derived rather than random.
   *
   * The same construction `revisionKey` uses in the MikroORM store and for the
   * same property: releasing the same version twice cannot append a second copy,
   * because the second write would collide with the first rather than land
   * beside it.
   */
  id: string;
  workflowId: string;
  /**
   * The {@link CatalogWorkflow.version} this release IS.
   *
   * The same number, not a parallel sequence. A release sequence of its own was
   * the alternative and it is worse in the one place it matters: a run records
   * `workflowVersion`, so a second numbering would mean a run naming "v3" and an
   * operator reading "release 3" could be two different graphs, which is exactly
   * the ambiguity the edit counter was made cheap to avoid.
   */
  version: number;
  /** Fingerprint of the graph as released. See {@link workflowGraphHash}. */
  graphHash: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** The type the sink committed at this version. */
  targetType: string;
  /** Whatever the releaser wanted to say about it. */
  notes?: string;
  releasedBy: string;
  releasedAt: string;
}

/**
 * Minting releases, and pointing at one.
 *
 * Its own interface mixed in optionally, for the reason {@link
 * CatalogWorkflowStore} is: a store written against the previous shape must keep
 * compiling, and "this deployment cannot hold releases" has to be a sentence a
 * UI can say rather than a method missing at run time.
 *
 * The split from `CatalogWorkflowStore` is not only compatibility. These four
 * are the only members in this file that can change *what a cron executes*
 * without touching a graph, and keeping them behind their own predicate means a
 * store can hold graphs without acquiring that power by accident.
 */
export interface CatalogWorkflowReleaseStore {
  /**
   * Freeze the graph as it currently stands, under its current version.
   *
   * **The only thing that mints one.** Not `saveWorkflow`, which is the autosave
   * this whole feature exists to stop being a deploy; not `publishWorkflow`,
   * which is idempotent and is called by a promotion apply — a release minted as
   * a side effect of promoting configuration into an environment would be a
   * release nobody in that environment chose.
   *
   * Refuses a draft, for the reason `WORKFLOW_STATUSES` already gives about what
   * a connector may point at and what a promotion may carry: what gets shipped
   * should be something a person declared finished.
   *
   * **Idempotent per version.** Releasing a graph whose current version is
   * already released answers with the existing release rather than minting a
   * second or overwriting its notes — the graph has not changed, so a second
   * release would be a record of an event that did not happen, and re-attributing
   * the first one would erase who actually shipped it.
   */
  releaseWorkflow(
    id: string,
    releasedBy: string,
    options?: { notes?: string },
  ): Promise<CatalogWorkflowRelease>;
  /** Newest first. */
  listWorkflowReleases(id: string): Promise<CatalogWorkflowRelease[]>;
  /**
   * The graph as it was at a released version, or `undefined`.
   *
   * `undefined` for a version that was never released as much as for a workflow
   * that does not exist, and callers must treat the two the same way: **fail,
   * never fall back to the latest.** Running the current graph because the named
   * one could not be produced is precisely the substitution a pin is written
   * down to prevent.
   *
   * Answers with a whole {@link CatalogWorkflow} rather than the bare release,
   * because that is what a run needs: the released graph, carried on the row's
   * present identity. The graph fields — nodes, edges, `targetType`,
   * `graphHash`, `version` — come from the release. The operational ones —
   * `name`, `status`, `schedule`, `enabled`, `liveVersion` — come from the row
   * as it is now, because they are not part of what was released. A cron somebody
   * changed this morning applies to the version that is live, not to whatever
   * cron was on the row the day it was released.
   */
  getWorkflowAt(id: string, version: number): Promise<CatalogWorkflow | undefined>;
  /**
   * Point {@link CatalogWorkflow.liveVersion} at a released version — or clear it.
   *
   * One method for going live, for rolling back and for going back to following
   * the latest, because they are one act with a different argument. Rollback in
   * particular is not a separate mechanism to build and test: it is this call
   * with a smaller number, and it works because the older graph is still stored.
   *
   * Refuses a version with no release behind it, naming what there is. A pointer
   * accepted at a number nothing can produce would be a pipeline that stops at
   * its next window, discovered by a load failing rather than by the person who
   * typed it.
   *
   * `undefined` clears the pointer and takes the graph back to following the
   * latest. Allowed rather than refused — it is the state every graph in every
   * deployment is in, so refusing would strand anything that ever went live —
   * and stated as a decision because it hands back exactly the hazard the
   * pointer removes: from that moment, saving the graph changes what the next
   * window runs.
   */
  setLiveWorkflowVersion(
    id: string,
    version: number | undefined,
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
 * Whether this store can mint a release and be pointed at one.
 *
 * All four asked for by name, for the reason `supportsWorkflows` asks for
 * `publishWorkflow` and `saveWorkflowSchedule` by name rather than assuming they
 * arrive together: a store with the mint and not the pointer would narrow
 * cleanly here, let somebody release a graph, and then fail on the call that was
 * supposed to make it run.
 *
 * {@link getWorkflowAt} is the one whose absence is least visible and most
 * expensive. A store that could hold a `liveVersion` and not resolve it would
 * point a scheduled load at a version it cannot produce — and the only place
 * that shows up is a cron window that stops firing.
 */
export function supportsWorkflowReleases(
  store: CatalogPipelineStore,
): store is CatalogPipelineStore & CatalogWorkflowReleaseStore {
  return (
    typeof store.releaseWorkflow === 'function' &&
    typeof store.listWorkflowReleases === 'function' &&
    typeof store.getWorkflowAt === 'function' &&
    typeof store.setLiveWorkflowVersion === 'function'
  );
}

/**
 * Which version of this graph a run gets when the caller names none.
 *
 * The one implementation of "follow the latest unless something is live", shared
 * by the scheduler and by the manual run route so the two cannot disagree about
 * what a cron does and what the button next to it does. That divergence is not
 * hypothetical: the schedule used to live on the connector and on the workflow
 * at once, and the whole of `ConnectorScheduler`'s docblock is about what it
 * cost to have two copies of one answer.
 *
 * Not a fallback in the defensive sense. `liveVersion` absent is a stated
 * position — this graph follows its head — and this function is where that
 * position is turned into a number, not where a missing value is patched over.
 */
export function liveWorkflowVersion(workflow: CatalogWorkflow): number {
  return workflow.liveVersion ?? workflow.version;
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

/**
 * Whether this store can produce one particular version of a transform's code.
 *
 * Separate from {@link supportsTransformRevisions}, and not implied by it: one
 * answers "can a screen show the history", the other "can a run honour a pin".
 * A store could reasonably have the first and not the second, and folding them
 * together would let a graph be saved with a pin this deployment cannot resolve
 * — discovered mid-load rather than at the moment the pin was set.
 */
export function supportsTransformPins(
  store: CatalogPipelineStore,
): store is CatalogPipelineStore & Required<Pick<CatalogPipelineStore, 'getTransformAt'>> {
  return typeof store.getTransformAt === 'function';
}

/**
 * The four reads and two writes a reusable node needs, as one derived type.
 *
 * `Required<Pick<...>>` rather than a second interface, which is the lesson
 * {@link CatalogLoadExpectationStore} records: these are optional members OF the
 * pipeline store, so writing them out again here would be a copy that can drift.
 */
export type CatalogReusableNodeStore = Required<
  Pick<
    CatalogPipelineStore,
    | 'listReusableNodes'
    | 'getReusableNode'
    | 'getReusableNodeAt'
    | 'saveReusableNode'
    | 'deleteReusableNode'
    | 'reusableNodeUses'
  >
>;

/**
 * Whether this store can hold reusable nodes.
 *
 * All six, and never a subset. A store with `getReusableNode` but no
 * `reusableNodeUses` could serve a picker and could not answer the question the
 * feature exists for — and the shape of that failure is a console offering to
 * share a node while being unable to say who already depends on it, which is
 * worse than not offering at all.
 */
export function supportsReusableNodes(
  store: CatalogPipelineStore,
): store is CatalogPipelineStore & CatalogReusableNodeStore {
  return (
    typeof store.listReusableNodes === 'function' &&
    typeof store.getReusableNode === 'function' &&
    typeof store.getReusableNodeAt === 'function' &&
    typeof store.saveReusableNode === 'function' &&
    typeof store.deleteReusableNode === 'function' &&
    typeof store.reusableNodeUses === 'function'
  );
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
    Partial<CatalogWorkflowReleaseStore>,
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
   * The code at one particular version, which is what a pin resolves through.
   *
   * Separate from {@link listTransformRevisions} rather than left to a caller
   * filtering that list, and the difference is the whole point: this is on the
   * hot path of every pinned transform node of every run, and reading up to
   * {@link CATALOG_REVISION_LIMIT} whole code bodies to keep one of them is a
   * cost paid per node per run. It is also a different answer — the list falls
   * back to a synthesised head for a subject that predates the revision table,
   * and this must not, because "the only version we can produce is the current
   * one" is exactly the case a pin needs to be told about rather than handed.
   *
   * `undefined` means the version cannot be produced: it predates the archive,
   * or it has fallen off the far end of the per-subject cap. The runner turns
   * that into a failed node rather than a fall-back to the latest, which is the
   * same stand `WorkflowRunSteps.checkCall` takes — a pin nobody could check is
   * not a pin.
   *
   * **Optional**, mixed in exactly as its neighbour above is and for the same
   * reason. {@link supportsTransformPins} is how a caller asks; a store without
   * it can still run graphs, and a graph with a pinned node is refused there
   * with a sentence rather than by a method that is missing at run time.
   */
  getTransformAt?(id: string, version: number): Promise<CatalogTransform | undefined>;

  /**
   * Node bodies saved under a name and used from several graphs.
   *
   * **Optional**, mixed in for the reason every optional member here is: a store
   * written against the previous shape of this interface still satisfies it, and
   * a purely additive feature must not turn that into a compile error — or,
   * worse, into a run-time discovery, since the `supports*` probes narrow
   * structurally. {@link supportsReusableNodes} is how a caller asks.
   *
   * A deployment whose store implements none of these behaves exactly as it does
   * today: every node is configured in place, which is what they all are.
   */
  listReusableNodes?(): Promise<CatalogReusableNode[]>;
  getReusableNode?(id: string): Promise<CatalogReusableNode | undefined>;
  /**
   * The body at one particular version, for a reference that pinned one.
   *
   * The sibling of {@link getTransformAt}, with the same contract and the same
   * `undefined`: a version the archive can no longer produce is reported as
   * absent and never substituted with the latest.
   */
  getReusableNodeAt?(id: string, version: number): Promise<CatalogReusableNode | undefined>;
  /**
   * Bumps {@link CatalogReusableNode.version} when the **body** changed, and
   * archives it, exactly as {@link saveTransform} does for code.
   *
   * Editing a reusable node that other graphs pin therefore creates a new
   * version rather than refusing. Refusing was the other candidate and it is the
   * wrong one: this is the only editor there is, so a refusal would strand
   * whoever owns the node the moment anybody else pinned it, and would make
   * pinning a way to take something hostage. Creating a version costs the pinned
   * graphs nothing — they resolve through the archive and keep running the body
   * they named — and what the editor gets instead of a refusal is the count of
   * who is downstream, at the moment they are about to press save.
   */
  saveReusableNode?(
    input: Pick<CatalogReusableNode, 'name' | 'body'> & { id?: string; description?: string },
    createdBy: string,
  ): Promise<CatalogReusableNode>;
  /**
   * Refuses while any graph still references it.
   *
   * The same refusal {@link deleteConnection} makes and for the same reason:
   * deleting one out from under its graphs turns every one of them into a load
   * that fails at run time, discovered on a schedule rather than at the moment
   * somebody decided.
   */
  deleteReusableNode?(id: string): Promise<boolean>;
  /**
   * Which graphs use a reusable node, and at which node within each.
   *
   * On the store rather than derived in a controller from `listWorkflows`,
   * unlike `connections/:id/workflows` which does exactly that. The difference
   * is that this number is rendered *beside every entry of a picker*, so
   * deriving it would mean parsing every graph in the deployment once per
   * reusable node offered. A store can answer it from the rows it holds.
   */
  reusableNodeUses?(id: string): Promise<CatalogReusableNodeUse[]>;

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

/**
 * What a redacted password reads as, on the wire.
 *
 * Declared here rather than in `@dudousxd/nestjs-catalog-pipeline`, where the
 * redaction itself lives, because this literal is not an implementation detail
 * of the redaction: it is part of what `GET pipeline/connections` answers, and
 * a browser is the audience it was invented for. A form that lets somebody
 * paste an address has to be able to recognise the string it was shown — a
 * `url` whose password is exactly this came out of a read, and posting it back
 * as a NEW connection stores the word "REDACTED" as the password. There is no
 * stored row behind a create for `restoreRedactedSecrets` to put the real one
 * back from, so nothing downstream can catch it: the row saves, and the failure
 * arrives at the first scheduled load as an authentication error against a
 * password nobody typed.
 *
 * The pipeline package re-exports this rather than declaring its own, so the
 * two halves cannot drift. A fixed literal rather than a run of asterisks, so
 * it is greppable in a bug report and cannot be mistaken for a password
 * somebody actually chose.
 */
export const REDACTED_SECRET = 'REDACTED';

/** What checking a connection found. */
export interface ConnectionCheck {
  ok: boolean;
  /** What was reached, in words — a server version, a bucket, a status code. */
  detail: string;
  elapsedMs: number;
  error?: string;
}
