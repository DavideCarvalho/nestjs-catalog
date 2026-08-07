import { Entity, Index, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/** A query someone kept. */
@Entity({ tableName: 'catalog_saved_query' })
@Index({ properties: ['folder'] })
export class SavedQueryRow {
  @PrimaryKey({ length: 64 })
  id!: string;

  @Property({ length: 255 })
  name!: string;

  @Property({ type: 'text', nullable: true })
  description?: string;

  @Property({ type: 'text' })
  sql!: string;

  /**
   * Which revision of {@link sql} is the live one.
   *
   * Bumped by `updateSavedQuery` when — and only when — the statement changed,
   * the same rule `saveTransform` applies to code. A rename or a new cache TTL
   * is not a new version of the query.
   *
   * **Not on the `SavedQuery` wire shape.** Adding a required field to a
   * published interface breaks every consumer that constructs one, and this
   * counter's only consumer today is the {@link RevisionRow} it names. It is
   * here rather than derived as `max(version) + 1` over the history because the
   * history is prunable and the subject is not: a query whose revisions had all
   * been dropped, or which predates them entirely, would restart at 1 and write
   * a second revision claiming to be version 1 with different text — over the
   * first, since the key is derived from the pair.
   *
   * Defaulted to 1, which is the backfill decision as much as a default: every
   * saved query already in a database has had exactly one statement as far as
   * anything can tell, and calling that version 1 is the only claim about it
   * that is true.
   */
  @Property({ default: 1 })
  version = 1;

  @Property({ length: 128, nullable: true })
  folder?: string;

  @Property({ length: 128 })
  createdBy!: string;

  /**
   * Seconds a result may be reused. Zero disables caching for this query.
   *
   * Per query rather than one global setting: "how many vehicles are critical"
   * tolerates a five-minute-old answer and a month-end reconciliation does not,
   * and only the person who wrote the query knows which it is.
   */
  @Property()
  cacheTtlSeconds = 0;

  @Property({ type: 'json' })
  visualization: Record<string, unknown> = { kind: 'table' };

  /** Fetchable through the embed API. Never inferred — see SavedQuery.shared. */
  @Property()
  shared = false;

  @Property({ onCreate: () => new Date() })
  createdAt!: Date;

  @Property({ onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt!: Date;
}

/** A page of saved queries laid out together. */
@Entity({ tableName: 'catalog_dashboard' })
export class DashboardRow {
  @PrimaryKey({ length: 64 })
  id!: string;

  @Property({ length: 255 })
  name!: string;

  @Property({ type: 'text', nullable: true })
  description?: string;

  @Property({ length: 128 })
  createdBy!: string;

  /**
   * Cards as JSON rather than a table.
   *
   * A dashboard's cards are only ever read and written as a whole — nobody
   * queries "all cards across all dashboards" — so a child table would buy
   * joins and orphan cleanup in exchange for nothing.
   */
  @Property({ type: 'json' })
  cards: Array<Record<string, unknown>> = [];

  @Property()
  shared = false;

  @Property({ onCreate: () => new Date() })
  createdAt!: Date;

  @Property({ onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt!: Date;
}

/**
 * One thing that happened, durably.
 *
 * The same events the library emits on `aviary:catalog:*`. The channel serves
 * observers listening right now; governance asks about six weeks ago, and a
 * diagnostics channel has no memory.
 */
@Entity({ tableName: 'catalog_audit_event' })
@Index({ properties: ['occurredAt'] })
@Index({ properties: ['typeName', 'occurredAt'] })
@Index({ properties: ['principalId', 'occurredAt'] })
// Grouping a trace means gathering every event that shares a snapshot id, and
// without this that is a full scan of the audit table — the one table that only
// ever grows.
@Index({ properties: ['snapshotId', 'occurredAt'] })
export class AuditEventRow {
  @PrimaryKey({ length: 64 })
  id!: string;

  @Property({ length: 64 })
  event!: string;

  @Property({ length: 128, nullable: true })
  typeName?: string;

  @Property({ length: 128, nullable: true })
  principalId?: string;

  @Property({ length: 128, nullable: true })
  snapshotId?: string;

  @Property({ type: 'json' })
  detail: Record<string, unknown> = {};

  /**
   * Millisecond precision, explicitly.
   *
   * MikroORM's default `datetime` is whole seconds on MySQL, and a connector
   * run start to finish takes well under one — so every event in a load landed
   * on the same timestamp and ordering by this column alone returned them in
   * insertion order. A trace view built on that renders a story where the load
   * finished before it started, with total confidence and no way to tell.
   *
   * Readers must still break ties by the event's place in the lifecycle: this
   * fixes what is recorded from here on, and says nothing about rows already
   * written at second precision.
   */
  @Property({ length: 3 })
  occurredAt!: Date;
}

/**
 * The things in this catalog whose body a person edits, and whose previous
 * bodies something else still names.
 *
 * One list, narrowed against by {@link isRevisionSubject}, for the reason every
 * other vocabulary in this codebase is: a second hand-maintained copy is what
 * drifts, and a stored value narrowed against a stale array silently becomes
 * whichever member happened to be first — which here would mean a transform's
 * history answering with a saved query's.
 *
 * `reusable-node` joined the list rather than getting a table of its own, and
 * that is the argument `RevisionRow` already makes about the other two: the
 * interesting part of an archive is not the rows, it is the *policy* — what a
 * revision costs, when one is written, how many are kept — and two copies of a
 * policy is how one of them ends up keeping fifty and the other five hundred.
 * Its body is JSON rather than code or SQL, which the column does not care
 * about: `RevisionRow.body` is text, and the store that writes it is the only
 * thing that knows how to read it back.
 *
 * A workflow graph is deliberately absent. See `CatalogWorkflow` in the catalog
 * package, which argues the exclusion where somebody looking for it will read
 * it.
 */
export const REVISION_SUBJECTS = ['transform', 'saved-query', 'reusable-node'] as const;

export type RevisionSubject = (typeof REVISION_SUBJECTS)[number];

export function isRevisionSubject(value: unknown): value is RevisionSubject {
  return REVISION_SUBJECTS.some((subject) => subject === value);
}

/**
 * The primary key of a revision: its subject and the version it is.
 *
 * Derived rather than random, which is the same trick `WorkflowStageRow` uses
 * and for the same reason. Recording a version twice — a backfill racing a save,
 * a retried write — replaces it instead of appending a second row claiming to be
 * the same version with different text. It also turns "is this version already
 * recorded" into a primary-key lookup rather than a scan, which is what the
 * backfill on the save path asks on every edit.
 *
 * The separator is `:` and the subject id may not contain one — every id in this
 * store is a UUID — so the pair cannot be ambiguous. Both halves are needed:
 * transform ids and saved-query ids are drawn from the same generator and share
 * one table here, so keying on the id alone would let two subjects that happened
 * to collide read each other's history.
 */
export function revisionKey(subject: RevisionSubject, subjectId: string, version: number): string {
  return `${subject}:${subjectId}:${version}`;
}

/**
 * One saved version of a transform's code, or of a saved query's SQL.
 *
 * ## Why this table exists
 *
 * Because the two rows it archives are overwritten in place, and one of them was
 * being cited in a console as though it were not. `TransformRow.version` is
 * bumped when the code changes and the previous code is gone the same instant;
 * `ConnectorRunRow.transformVersion` records which version ran; the runs list
 * renders `code v3`. So an operator read a version number, believed the source
 * behind it was recoverable, and it was not. A saved query had not even the
 * number.
 *
 * ## Why one table for both
 *
 * The alternative was `catalog_transform_revision` and
 * `catalog_saved_query_revision`, one beside each subject. Rejected because the
 * interesting part of this feature is not the rows, it is the *policy*: what a
 * revision costs, when one is written, how many are kept. Two tables means two
 * copies of that policy, and two copies is how one of them ends up keeping fifty
 * and the other five hundred. One table, one retention rule, one index, one
 * answer to "how big can this get".
 *
 * It is written by two stores — `MySqlPipelineStore` for transforms and
 * `MySqlWorkspaceStore` for saved queries — through helpers exported from the
 * latter, so there is still exactly one implementation of the rule.
 *
 * ## Bounded, unlike the tables it sits beside
 *
 * `catalog_audit_event` and `catalog_connector_run` are append-only and unbounded
 * and have earned it: one small row per thing that happened, at a rate an
 * operator can read off their own load schedule. This one grows with how often
 * somebody edits — which nobody meters — and each row carries a whole code body.
 * So the newest `CATALOG_REVISION_LIMIT` per subject are kept and the rest are
 * dropped as newer ones arrive. That cap can lose a version a run still names;
 * the constant's own docblock in the catalog package states what that costs and
 * why it is still the right trade.
 */
@Entity({ tableName: 'catalog_revision' })
// The one query: this subject's revisions, newest first. Without it that is a
// scan of the table that only ever grows — the same note `AuditEventRow` carries
// about grouping a trace, and the same reason.
@Index({ properties: ['subjectKind', 'subjectId', 'version'] })
export class RevisionRow {
  /** `{subject}:{subjectId}:{version}` — see {@link revisionKey}. */
  @PrimaryKey({ length: 160 })
  id!: string;

  /**
   * `transform` or `saved-query`. Narrowed on read against
   * {@link isRevisionSubject}, never cast.
   */
  @Property({ length: 16 })
  subjectKind!: string;

  /**
   * The transform or saved query this belongs to.
   *
   * Not a foreign key, for the reason `ConnectorRow.connectionId` is not: a hard
   * constraint would have to decide what happens to the history when the subject
   * is deleted, and both answers are wrong. A cascade throws away the only
   * remaining copy of code that a recorded run still names; a SET NULL leaves
   * rows belonging to nothing. Deleting a transform therefore leaves its
   * revisions behind, which is deliberate — a run that executed it is still in
   * the run history, and the code it ran should outlive somebody tidying up the
   * editor. They are bounded per subject either way.
   */
  @Property({ length: 64 })
  subjectId!: string;

  /** The version this revision IS — the number a run records. */
  @Property()
  version!: number;

  /** The text as it was. The largest column in this model outside staged rows. */
  @Property({ type: 'text' })
  body!: string;

  @Property({ length: 128 })
  authoredBy!: string;

  /**
   * Millisecond precision, matching {@link AuditEventRow.occurredAt}.
   *
   * Ordering never depends on it — revisions are ordered by {@link version},
   * which is exact — so this is for display. It is kept at the same precision as
   * the audit trail anyway, so that a revision and the `transform.changed` event
   * recorded for the same save do not appear a second apart for a reason nobody
   * can explain.
   */
  @Property({ length: 3 })
  authoredAt!: Date;
}
