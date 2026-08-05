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
 * **Only the latest code is kept.** One row per transform, overwritten in place:
 * `saveTransform` assigns the new code onto the existing row and increments
 * `version` when the code differs. There is no history table and no second row,
 * so the code that ran last week is gone the moment somebody saves over it.
 *
 * `version` is therefore an *identifier*, not an archive. A run records the
 * version it executed, so an investigation into a surprising load can always
 * establish that the transform has been edited since — v3 in the run history
 * against v5 on the row is a definite answer to "is this still the code that
 * produced those numbers". What it cannot do is produce v3. This is the same
 * limitation {@link WorkflowRow} states for graphs, and it is stated here
 * because the console reinforces the opposite reading: a run renders as
 * `code v3`, which looks like a reference to something retrievable.
 *
 * Keeping the old rows is a schema change and not a docblock — a second table,
 * a foreign key from the run, and an answer to how long code bodies are retained
 * in a table nobody prunes. Worth doing if the investigation above turns out to
 * need the code itself rather than the fact that it changed; not worth implying
 * before then.
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
   * Enough to *identify* the code and never enough to recover it — see
   * {@link TransformRow}, which holds one row per transform and overwrites it.
   * A console that renders this as `code v3` is naming a version, not linking to
   * a copy, and an investigation that gets as far as this number has learned
   * whether the transform has changed since, which is usually the question.
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
 * Versioned like a transform, and with the same limitation stated out loud: only
 * the latest graph is kept. A run records the version and the hash it ran, so an
 * edited graph can always be *identified* as different, but not reconstructed.
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

  /** The rows themselves. The only place in this model where rows are stored. */
  @Property({ type: 'json' })
  rows: unknown[] = [];

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
