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
