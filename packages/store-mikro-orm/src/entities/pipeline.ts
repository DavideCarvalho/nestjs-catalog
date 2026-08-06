import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';

/** Where data comes from. */
@Entity({ tableName: 'catalog_connector' })
export class ConnectorRow {
  @PrimaryKey({ length: 64 })
  id!: string;

  @Property({ length: 255 })
  name!: string;

  @Property({ type: 'text', nullable: true })
  description?: string;

  @Property({ length: 32 })
  kind!: string;

  @Property({ length: 128 })
  targetType!: string;

  /**
   * Source configuration — a URL, a query, a path.
   *
   * Never a credential. What is stored is the *name* of an environment
   * variable, so a catalog database that leaks leaks the shape of the
   * integration rather than the keys to it.
   *
   * That was a promise this column could not keep on its own, and for SQL
   * sources it did not keep it: `fetchSql` reads `config.url`, and a connection
   * URL is a password with an address attached. It was persisted verbatim and
   * served verbatim to anything holding `catalog:read`.
   *
   * `MySqlPipelineStore.saveConnector` refuses a password-bearing URL that is
   * not already stored here, and the pipeline's read routes redact one out of
   * anything they serve. Rows written before either existed are still sitting
   * in this column — the redaction is what covers them.
   *
   * ## A value here may be a `SealedSecret` rather than a string
   *
   * With `encryptCredentials` on, the store seals credential-bearing values
   * through the host's vault before writing, so what sits here is `{ vault,
   * keyId, ciphertext }` and a database dump gives up nothing. **Both forms are
   * valid in this column, indefinitely.** No migration turns one into the
   * other: a plaintext row is sealed on its next save and not before, because a
   * read that reseals is a read that can fail a connector run for a bookkeeping
   * reason, and this row is read on the runner's hot path.
   *
   * Which is why the type stays `Record<string, unknown>` and why nothing
   * downstream needs to know. `MySqlPipelineStore` opens on the way out — every
   * read, whatever the flag currently says — so a caller sees the address it
   * always saw, and `isSealedSecret` is what tells the two forms apart.
   */
  @Property({ type: 'json' })
  config: Record<string, unknown> = {};

  @Property({ length: 128, nullable: true })
  secretEnvVar?: string;

  /**
   * Not a foreign key on purpose.
   *
   * A hard constraint would decide what happens to the connectors when a
   * connection goes — cascade deletes loads nobody meant to delete, and
   * SET NULL turns them into connectors pointing nowhere. The store refuses the
   * delete while anything still reads through it, which is the same protection
   * with an error message that can name the connectors.
   */
  @Property({ length: 64, nullable: true })
  connectionId?: string;

  @Property({ length: 64, nullable: true })
  transformId?: string;

  /**
   * The workflow this connector runs instead of a single transform.
   *
   * Not a foreign key, for the same reason `connectionId` is not: a cascade
   * would delete loads nobody meant to delete and a SET NULL would turn a
   * connector into one that shapes nothing and publishes raw records under a
   * type it does not match. The store refuses the delete while connectors still
   * run it, which is the same protection with a message that can name them.
   *
   * Never set at the same time as `transformId`. The store enforces it rather
   * than the schema, because a CHECK constraint's violation cannot explain which
   * of the two a person meant to keep.
   */
  @Property({ length: 64, nullable: true })
  workflowId?: string;

  @Property({ length: 64, nullable: true })
  schedule?: string;

  @Property({ length: 16, nullable: true })
  mode?: string;

  /**
   * Where the last run got to — a watermark, the keys already consumed.
   *
   * Its own column rather than a corner of `config`, because config is authored
   * and this is a consequence of running. Kept apart, editing a connector can
   * never silently rewind or skip data.
   */
  @Property({ type: 'json', nullable: true })
  state?: Record<string, unknown>;

  @Property()
  enabled = true;

  @Property({ length: 128 })
  createdBy!: string;

  @Property({ onCreate: () => new Date() })
  createdAt!: Date;

  @Property({ onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt!: Date;

  @Property({ nullable: true })
  lastRunAt?: Date;

  @Property({ length: 16, nullable: true })
  lastRunStatus?: string;
}

/**
 * User code that shapes stored data.
 *
 * **This row holds the current code.** One row per transform, overwritten in
 * place: `saveTransform` assigns the new code onto the existing row and
 * increments `version` when the code differs.
 *
 * The versions before it are kept, in `catalog_revision` — see `RevisionRow`.
 * That is new, and it is what the rest of this docblock used to say could not be
 * relied upon: `version` was an *identifier* and not an archive, so a run
 * recorded at v3 against a row at v5 answered "has this been edited since" and
 * could not produce v3. The console reinforced the opposite reading the whole
 * time, rendering a run as `code v3` — a version number that looked like a
 * reference to something retrievable. It is one now:
 * `GET pipeline/transforms/:id/revisions` returns the body of each version, and
 * the numbers are the same numbers.
 *
 * Two limits are worth carrying forward rather than quietly dropping. The
 * archive is **bounded** per transform (`CATALOG_REVISION_LIMIT`), so a transform
 * edited more times than that can no longer produce its earliest code — see the
 * constant for why a cap and what it costs. And a version whose text was
 * overwritten *before* this table existed is not recoverable by anything: the
 * store backfills the version that was live at upgrade time, out of this row,
 * and there is nothing anywhere to backfill the ones before it from.
 */
@Entity({ tableName: 'catalog_transform' })
export class TransformRow {
  @PrimaryKey({ length: 64 })
  id!: string;

  @Property({ length: 255 })
  name!: string;

  @Property({ type: 'text', nullable: true })
  description?: string;

  @Property({ length: 16 })
  language!: string;

  @Property({ type: 'text' })
  code!: string;

  @Property()
  version = 1;

  @Property({ length: 128 })
  createdBy!: string;

  @Property({ onCreate: () => new Date() })
  createdAt!: Date;

  @Property({ onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt!: Date;
}

/** One execution of a connector. */
@Entity({ tableName: 'catalog_connector_run' })
@Index({ properties: ['connectorId', 'startedAt'] })
export class ConnectorRunRow {
  @PrimaryKey({ length: 64 })
  id!: string;

  @Property({ length: 64 })
  connectorId!: string;

  /**
   * Also the snapshot this run wrote, and the durable run id when durable
   * scheduled it. One identifier across all three so a surprising number in a
   * dashboard can be traced back to the code that produced it without joining
   * anything.
   */
  @Property({ length: 128 })
  snapshotId!: string;

  @Property({ length: 128 })
  principalId!: string;

  @Property({ length: 16 })
  status = 'running';

  @Property()
  fetched = 0;

  @Property()
  written = 0;

  @Property({ type: 'json' })
  logs: string[] = [];

  @Property({ type: 'text', nullable: true })
  error?: string;

  /**
   * Which version of the transform this run executed.
   *
   * Enough to *recover* the code, which it was not until `catalog_revision`
   * existed: this number is a revision's version, so a console rendering `code
   * v3` can link to the body that produced these rows rather than merely naming
   * a version of something already overwritten. See {@link TransformRow}.
   *
   * The link can still come up empty in two cases, and both are honest ones: the
   * version predates the revision table, or it has fallen off the far end of the
   * per-transform cap. A reader that finds no revision for this number has
   * learned that the transform has changed since, which is what this field
   * always gave them.
   */
  @Property({ nullable: true })
  transformVersion?: number;

  /**
   * Which workflow ran, at which version, and with which graph.
   *
   * Written when the run starts, not when it finishes: a run that dies without
   * reaching `finishRun` is exactly the one whose graph somebody needs to
   * identify. The hash is stored beside the version because a version number is
   * only unique inside one catalog database, and a workflow promoted between
   * environments carries its own numbering.
   */
  @Property({ length: 64, nullable: true })
  workflowId?: string;

  @Property({ nullable: true })
  workflowVersion?: number;

  @Property({ length: 32, nullable: true })
  graphHash?: string;

  /**
   * `durable` or `inline` — whether this run was checkpointed per node.
   *
   * A record of what happened rather than a setting, so a console never has to
   * infer from a deployment's current configuration what an old run did. The
   * same workflow is checkpointed on a worker and not on a pod with
   * `CATALOG_DURABLE=off`, and a run list that claimed otherwise would tell an
   * operator a failed ten-node graph will resume where it stopped when it will
   * start again from the top.
   */
  @Property({ length: 16, nullable: true })
  executionMode?: string;

  /**
   * What each node did, keyed by node id: status, rows, transform version, and
   * the error if it was the one that failed.
   *
   * Bounded by the node count and never by the row count — no rows are ever put
   * in this column. That is the same rule the durable checkpoints follow, and it
   * is what keeps a ten-node graph over a million rows from writing the dataset
   * into the run history ten times.
   */
  @Property({ type: 'json', nullable: true })
  nodeOutcomes?: Record<string, unknown>;

  @Property({ onCreate: () => new Date() })
  startedAt!: Date;

  @Property({ nullable: true })
  finishedAt?: Date;
}

/**
 * An authored graph of steps that ends in one commit.
 *
 * Nodes and edges live in JSON columns rather than in two side tables. The
 * argument for tables would be referential integrity between an edge and a node,
 * but that integrity is not the interesting part: the checks that actually
 * matter — no cycles, one sink, nothing unreachable, nothing dead-ended — are
 * whole-graph properties no foreign key can express, so they are enforced in
 * `validateWorkflow` either way. Given that, splitting the graph across three
 * tables would buy a constraint that catches the least dangerous mistake while
 * making every read of a workflow a join and every save a diff.
 *
 * Versioned like a transform, and — since `catalog_revision` — no longer with
 * the same limitation as one. Only the latest graph is kept. A run records the
 * version and the hash it ran, so an edited graph can always be *identified* as
 * different, and not reconstructed.
 *
 * That asymmetry is deliberate: `CatalogWorkflow` in the catalog package argues
 * it, and the short version is that {@link version} is bumped on draft edits by
 * design, so archiving one body per version would fill a bounded table with
 * autosaves of a canvas somebody is still dragging boxes around on — evicting
 * the versions that ran.
 */
@Entity({ tableName: 'catalog_workflow' })
@Index({ properties: ['targetType'] })
export class WorkflowRow {
  @PrimaryKey({ length: 64 })
  id!: string;

  @Property({ length: 255 })
  name!: string;

  @Property({ type: 'text', nullable: true })
  description?: string;

  /**
   * Typed as `unknown[]` on purpose.
   *
   * MikroORM will hand back whatever the column holds, and declaring it as
   * `WorkflowNode[]` would make every read a silent, unchecked assertion. The
   * store narrows each element with `isWorkflowNode` and throws on anything it
   * does not recognise — dropping an unrecognised node instead would leave a
   * graph that still validates and quietly runs nine steps of ten.
   *
   * A **source** node's `config` is a credential-bearing config exactly like
   * {@link ConnectorRow.config} — `workflow-runner.service.ts` spreads it into a
   * synthesised connector, so `fetchSql` reads `config.url` from here too — and
   * it is refused, sealed and opened under the same rule and the same
   * predicate. `graphHash` is computed from the graph BEFORE sealing, so a
   * ciphertext that differs on every seal never registers as a new version.
   */
  @Property({ type: 'json' })
  nodes: unknown[] = [];

  /** Order matters: it is the order a node with several inputs receives them in. */
  @Property({ type: 'json' })
  edges: unknown[] = [];

  /**
   * `draft` or `ready`. Narrowed on read against `isWorkflowStatus`, never cast.
   *
   * **Defaulted to `ready`, and that is the migration decision rather than a
   * tidy default.** Every workflow already in a database got there through a
   * `saveWorkflow` that refused anything `validateWorkflow` objected to, so each
   * one is a graph that was valid at the moment it was written — which is
   * exactly what `ready` asserts. Defaulting the column to `draft` would be
   * cheaper to reason about and would silently stop every scheduled connector on
   * the deployment the moment the migration ran, because a connector may only
   * run a ready graph. A default that turns an upgrade into an outage is the
   * wrong default even when it is the conservative-looking one.
   *
   * New rows are written with an explicit status by the store, so this default
   * governs the backfill and nothing else.
   */
  @Property({ length: 16, default: 'ready' })
  status = 'ready';

  @Property()
  version = 1;

  /** Fingerprint of the graph's behaviour at this version. */
  @Property({ length: 32 })
  graphHash!: string;

  /**
   * The type the sink writes, lifted out of the JSON.
   *
   * Derived and stored, which is only safe because validation guarantees exactly
   * one sink. It earns its place by making "which workflows write this type" an
   * indexed query rather than a scan that parses every graph.
   */
  @Property({ length: 128 })
  targetType!: string;

  /**
   * When this graph runs. Nullable, and null means manual only.
   *
   * The column the schedule moved *to*. `ConnectorRow.schedule` still exists and
   * is still written, but as a copy for evidence — this is what
   * `ConnectorScheduler` parses. Keeping both and being explicit about which is
   * the authority is the point: the alternative, dropping the connector's copy,
   * would have thrown away the only record of when a connector belonging to no
   * graph fires, and those are exactly the rows no screen can show.
   */
  @Property({ length: 128, nullable: true })
  schedule?: string;

  /**
   * Whether this graph runs at all.
   *
   * **Defaulted to `true`, and that is the migration decision** — the same one
   * `status` above makes and for the same reason. Every workflow already in a
   * database was published by somebody who meant it to run; defaulting to
   * `false` would be the conservative-looking choice that turns an upgrade into
   * an outage, silently, on the deployment that has the most to lose.
   */
  @Property({ default: true })
  enabled = true;

  @Property({ length: 128 })
  createdBy!: string;

  @Property({ onCreate: () => new Date() })
  createdAt!: Date;

  @Property({ onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt!: Date;
}

/**
 * One batch of rows handed from one node to the next.
 *
 * This table exists so that *nothing but a reference* crosses a durable step
 * boundary. `durable_step_checkpoints` persists each step's input and output as
 * JSON, so a node contract that returned rows would write the whole intermediate
 * dataset into the durable store once per node — ten times over for a ten-node
 * graph — and a replay would read all of it back. Here the rows sit still and
 * the steps pass `(runId, nodeId, batches, rowCount)`.
 *
 * They cannot be staged in the target type's own `obj_*` table instead, which
 * was the first idea and the obvious one: that table has the columns the *type*
 * declares, and a mid-graph row generally has others. Writing it there would
 * drop them, and the load would come out missing fields the transform provably
 * produced.
 *
 * The primary key is derived rather than random — `runId#nodeId#batch` — so a
 * retried durable step re-sending its batches replaces them instead of appending
 * a second copy. That is the same idempotency the warehouse gets from
 * `(snapshot, batch)`, and it is why node ids are restricted to an alphabet that
 * cannot contain the separator.
 */
@Entity({ tableName: 'catalog_workflow_stage' })
@Index({ properties: ['runId'] })
export class WorkflowStageRow {
  @PrimaryKey({ length: 200 })
  id!: string;

  @Property({ length: 128 })
  runId!: string;

  @Property({ length: 64 })
  nodeId!: string;

  @Property()
  batch!: number;

  /**
   * The rows themselves. The only place in this model where rows are stored.
   *
   * `unknown` rather than `unknown[]`, because the column now holds either of
   * two encodings and one of them is not an array. Batches written before
   * `catalog.stage-encoding.ts` existed are a JSON array of row objects;
   * batches written since are a tagged object that names each key-set once
   * instead of once per row, which is half the bytes and therefore roughly half
   * the `INSERT`. Nothing reads this property directly — `encodeStageRows` and
   * `decodeStageRows` are the only two things that touch it, and the widened
   * type is what stops a caller from indexing it as an array and getting the
   * old shape's answer for the new one.
   *
   * The column type does not change, so no migration: a MySQL `JSON` column
   * takes an object as readily as an array, and the ~16,233 batches already in
   * the deployment stay exactly as they are and still read.
   */
  @Property({ type: 'json' })
  rows: unknown = [];

  @Property()
  rowCount = 0;

  @Property({ onCreate: () => new Date() })
  createdAt!: Date;
}

/**
 * A named, reusable way to reach a source.
 *
 * Its own table rather than a shape inside a connector's config, because the
 * question it exists to answer — which connectors reach this database, with
 * whose credential — cannot be asked of a value buried in five JSON columns.
 */
@Entity({ tableName: 'catalog_connection' })
@Unique({ properties: ['name'] })
export class ConnectionRow {
  @PrimaryKey({ length: 64 })
  id!: string;

  @Property({ length: 128 })
  name!: string;

  @Property({ length: 512, nullable: true })
  description?: string;

  @Property({ length: 32 })
  kind!: string;

  /**
   * Address and options. Never the credential — only the name of its env var.
   *
   * Enforced now rather than asserted: `MySqlPipelineStore.saveConnection`
   * refuses a password-bearing URL that is not already stored here, and
   * `GET pipeline/connections` redacts one on the way out. Before both,
   * `postgres://user:pass@host/db` sat in this column and was handed to every
   * caller holding `catalog:read`.
   *
   * Both of those protect a reader coming through the API and neither protects
   * a dump, a replica or a backup. With `encryptCredentials` on, a value here
   * may be a `SealedSecret` — `{ vault, keyId, ciphertext }` — instead of a
   * string; see {@link ConnectorRow.config}, which states the whole arrangement
   * and why the column holds both forms for as long as a deployment takes to
   * move over.
   */
  @Property({ type: 'json' })
  config: Record<string, unknown> = {};

  @Property({ length: 128, nullable: true })
  secretEnvVar?: string;

  @Property({ length: 128 })
  createdBy!: string;

  @Property({ onCreate: () => new Date() })
  createdAt!: Date;

  @Property({ onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt!: Date;

  /**
   * The last check, kept so the list can say which connections are known to
   * work without reaching every one of them on every page load.
   */
  @Property({ length: 3, nullable: true })
  lastCheckedAt?: Date;

  @Property({ nullable: true })
  lastCheckOk?: boolean;

  @Property({ length: 1024, nullable: true })
  lastCheckError?: string;
}

/**
 * What an operator declared about how one object type is allowed to load.
 *
 * The layer between a host's `CATALOG_LOAD_EXPECTATIONS.byType` entry and its
 * `default` — see `StoredLoadExpectation` in the catalog package for why the
 * policy grew a stored layer at all, and `CatalogLoadExpectations` for why the
 * grain is the type and nothing finer.
 *
 * ## Its own table, and not two columns on `ObjectTypeRow`
 *
 * The obvious cheaper shape is a pair of columns on `catalog_object_type`, and
 * it is wrong for two separate reasons.
 *
 * The first is ownership. Those rows are *published* — they arrive over the wire
 * from the application that owns the model, and `StoredCatalogRegistry` writes
 * them from that payload. An operator's decision written into a row a publisher
 * rewrites is a decision with a publisher-shaped hole in it.
 *
 * The second is that a type name is not required to have a row there yet. A
 * deployment can perfectly well want `Employee` locked down before the first
 * publish of `Employee` lands, and a policy that can only be set for types that
 * already exist is a policy that cannot be set in advance — which is the moment
 * it is most worth setting.
 *
 * ## New table, so the initialiser trap does not apply — and why that is said
 *
 * MikroORM's field initialisers run when *this process* constructs a row. They
 * do not run for rows a column predates: add a non-nullable property with a
 * TypeScript default to an existing entity and every row already in the table
 * still reads NULL, because `schema.update` adds the column and nothing
 * backfills it. Nothing here is exposed to that — this is a whole new table, so
 * every row in it is written by the store that owns it, after the columns
 * existed. It is written down because the next person adding a field to this
 * class is exposed to it, and by then the table will predate them.
 *
 * ## No `@Index`, deliberately
 *
 * Every access is by primary key (`getLoadExpectation`, `saveLoadExpectation`,
 * `clearLoadExpectation`) or a full read of a table bounded by the number of
 * object types (`listLoadExpectations`). There is nothing an index would serve.
 * That is worth stating rather than leaving as an absence, because an index
 * added here later would NOT reach a database that has already booted:
 * `fingerprintOf` in `schema.ts` hashes column names, types and nullability and
 * nothing else, so an index-only change leaves the marker unchanged and
 * `schema.update` is never called.
 */
@Entity({ tableName: 'catalog_load_expectation' })
export class LoadExpectationRow {
  /**
   * The object type name, and the primary key.
   *
   * One row per type by construction rather than by a unique index over a
   * surrogate id: two rows saying different things about how `Employee`
   * reconciles deletes is the state this table must not be able to reach, and a
   * key is the only version of that rule that cannot be forgotten by a caller.
   */
  @PrimaryKey({ length: 128 })
  typeName!: string;

  /**
   * The whole `DeleteReconciliation`, as JSON, or NULL when the operator said
   * nothing about deletes.
   *
   * JSON rather than `strategy` / `because` / `column` / `withinMs` columns, and
   * the deciding reason is numeric rather than aesthetic. `withinMs` is a
   * millisecond interval, and MikroORM infers `int` for a `number` property: a
   * 30-day reload interval is 2,592,000,000, past the 2,147,483,647 a signed INT
   * holds, so the column would either reject the row or silently store 24.8 days
   * and refuse loads earlier than the operator declared. {@link rowCount} has the
   * same problem from the other end — `maxShrink` is `0.5` and an INT stores
   * `0`, which is a bound that refuses a load for losing a single row. Both are
   * fixable with explicit column types; both are the kind of fix that is one
   * review away from being dropped, and JSON round-trips a JavaScript number
   * exactly with no column type to get wrong.
   *
   * Typed as `Record<string, unknown>` and never as `DeleteReconciliation`,
   * exactly as {@link WorkflowRow.nodes} is: MikroORM hands back whatever the
   * column holds, and declaring the union here would make every read a silent,
   * unchecked assertion about a value written by some earlier version of this
   * package. `MySqlPipelineStore` narrows it on the way out.
   */
  @Property({ type: 'json', nullable: true })
  deletes?: Record<string, unknown>;

  /**
   * The `Partial<RowCountBound>` the operator set, as JSON, or NULL.
   *
   * Partial on purpose and all the way down: an operator raising `maxShrink`
   * says nothing about `maxGrowth`, and the precedence merge resolves field by
   * field, so a stored `{ maxShrink: 0.8 }` must not imply anything about the
   * other two. A row of columns would have had to represent "not set" as NULL
   * per field and then be careful never to read a NULL as a zero — which is the
   * same distinction this column gets for free by simply not carrying the key.
   */
  @Property({ type: 'json', nullable: true })
  rowCount?: Record<string, unknown>;

  /**
   * The principal that set it.
   *
   * Never nullable, and never defaulted. An expectation whose author is unknown
   * is the state this whole layer exists to prevent — the argument for making
   * `because` mandatory is the same argument, one field along — so a row that
   * cannot say who wrote it should be impossible to write rather than rendered
   * as "unattributed".
   */
  @Property({ length: 128 })
  setBy!: string;

  /**
   * The person behind the principal, when there was one.
   *
   * Nullable because a principal is not always a person, and this column says
   * which. It is the audit's real subject: `setBy` may be a console's own
   * client id shared by everybody who logs into it, and the trail's question is
   * which human decided that `Employee` may accumulate rows deleted upstream.
   */
  @Property({ length: 128, nullable: true })
  setByActor?: string;

  /**
   * Millisecond precision, matching {@link ConnectorRunRow.startedAt} and the
   * audit trail's `occurredAt`.
   *
   * Assigned explicitly by the store on every save rather than through
   * `onCreate`/`onUpdate`. `onCreate` would freeze it at the first save, so an
   * expectation edited a year later would still claim the original date;
   * `onUpdate` would move it on any flush that touched the row for any reason,
   * including one that changed nothing about the decision. This column answers
   * "when was this decided", so only deciding may move it.
   */
  @Property({ length: 3 })
  setAt!: Date;
}
