import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  pgTable,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';

/** Where the catalog's tables live, and what they are called. */
export interface CatalogDrizzleTableOptions {
  /**
   * Prepended to every table name. Defaults to `catalog_`, which gives the same
   * names the MikroORM store uses (`catalog_saved_query`, ...).
   */
  readonly prefix?: string;
  /**
   * A Postgres schema to put the tables in. Absent means the connection's
   * `search_path`, which is `public` unless the host changed it.
   */
  readonly schema?: string;
}

export const DEFAULT_CATALOG_TABLE_PREFIX = 'catalog_';

const PREFIX_SHAPE = /^[a-z_][a-z0-9_]*$/;

/**
 * Checked rather than quoted around: a prefix ends up in table, index and
 * constraint names, and a name that needs quoting in one of those places is a
 * name some operator will one day type unquoted.
 */
function checkedPrefix(prefix: string): string {
  if (prefix !== '' && !PREFIX_SHAPE.test(prefix)) {
    throw new Error(
      `@dudousxd/nestjs-catalog-store-drizzle: table prefix "${prefix}" must be lower-case letters, digits and underscores, starting with a letter or underscore.`,
    );
  }
  return prefix;
}

/**
 * Millisecond precision with a time zone, everywhere. The MikroORM store had to
 * add `length: 3` after events recorded in one second came back in insertion
 * order; starting there costs nothing.
 */
const at = (name: string) => timestamp(name, { precision: 3, withTimezone: true, mode: 'date' });

/**
 * The catalog's tables, as Drizzle definitions.
 *
 * A factory rather than module-level constants so the prefix and schema are the
 * host's to choose. A host using drizzle-kit exports the result from its own
 * schema file and its migrations pick the tables up like any other; a host that
 * writes SQL by hand uses {@link catalogDrizzleSql} or the files in `sql/`.
 */
export function catalogDrizzleTables(options: CatalogDrizzleTableOptions = {}) {
  const prefix = checkedPrefix(options.prefix ?? DEFAULT_CATALOG_TABLE_PREFIX);
  // One signature for both: a schema's `table` builds the same table, only qualified.
  const table = (options.schema ? pgSchema(options.schema).table : pgTable) as typeof pgTable;
  const n = (name: string) => `${prefix}${name}`;

  const savedQuery = table(
    n('saved_query'),
    {
      id: varchar('id', { length: 64 }).primaryKey(),
      name: varchar('name', { length: 255 }).notNull(),
      description: text('description'),
      sql: text('sql').notNull(),
      /** Which revision of `sql` is live. See `SavedQueryRow.version` in the MikroORM store. */
      version: integer('version').notNull().default(1),
      folder: varchar('folder', { length: 128 }),
      createdBy: varchar('created_by', { length: 128 }).notNull(),
      cacheTtlSeconds: integer('cache_ttl_seconds').notNull().default(0),
      visualization: jsonb('visualization').$type<Record<string, unknown>>().notNull(),
      shared: boolean('shared').notNull().default(false),
      createdAt: at('created_at').notNull(),
      updatedAt: at('updated_at').notNull(),
    },
    (t) => [index(n('saved_query_folder_idx')).on(t.folder)],
  );

  const dashboard = table(n('dashboard'), {
    id: varchar('id', { length: 64 }).primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    createdBy: varchar('created_by', { length: 128 }).notNull(),
    /** Cards as one JSON value: they are only ever read and written whole. */
    cards: jsonb('cards').$type<Array<Record<string, unknown>>>().notNull(),
    shared: boolean('shared').notNull().default(false),
    createdAt: at('created_at').notNull(),
    updatedAt: at('updated_at').notNull(),
  });

  const auditEvent = table(
    n('audit_event'),
    {
      id: varchar('id', { length: 64 }).primaryKey(),
      event: varchar('event', { length: 64 }).notNull(),
      typeName: varchar('type_name', { length: 128 }),
      principalId: varchar('principal_id', { length: 128 }),
      snapshotId: varchar('snapshot_id', { length: 128 }),
      detail: jsonb('detail').$type<Record<string, unknown>>().notNull(),
      occurredAt: at('occurred_at').notNull(),
    },
    (t) => [
      index(n('audit_event_occurred_at_idx')).on(t.occurredAt),
      index(n('audit_event_type_name_idx')).on(t.typeName, t.occurredAt),
      index(n('audit_event_principal_id_idx')).on(t.principalId, t.occurredAt),
      index(n('audit_event_snapshot_id_idx')).on(t.snapshotId, t.occurredAt),
    ],
  );

  const revision = table(
    n('revision'),
    {
      /** `{subject}:{subjectId}:{version}`, see {@link catalogRevisionKey}. */
      id: varchar('id', { length: 160 }).primaryKey(),
      subjectKind: varchar('subject_kind', { length: 16 }).notNull(),
      subjectId: varchar('subject_id', { length: 64 }).notNull(),
      version: integer('version').notNull(),
      body: text('body').notNull(),
      authoredBy: varchar('authored_by', { length: 128 }).notNull(),
      authoredAt: at('authored_at').notNull(),
    },
    (t) => [index(n('revision_subject_idx')).on(t.subjectKind, t.subjectId, t.version)],
  );

  /**
   * The curation overlay, one JSON document per key. The catalog keeps one
   * overlay, under {@link DEFAULT_OVERLAY_KEY}; the key exists so two catalogs
   * can share a schema without sharing their curation.
   */
  const overlay = table(n('overlay'), {
    id: varchar('id', { length: 64 }).primaryKey(),
    document: jsonb('document').$type<Record<string, unknown>>().notNull(),
    updatedAt: at('updated_at').notNull(),
  });

  return { savedQuery, dashboard, auditEvent, revision, overlay } as const;
}

export type CatalogDrizzleTables = ReturnType<typeof catalogDrizzleTables>;

export const DEFAULT_OVERLAY_KEY = 'default';

/**
 * The things whose edited text keeps a history in the revision table. The same
 * list, and the same key shape, as the MikroORM store: a database moved from
 * one store to the other keeps the history it had.
 */
export const CATALOG_REVISION_SUBJECTS = ['transform', 'saved-query', 'reusable-node'] as const;

export type CatalogRevisionSubject = (typeof CATALOG_REVISION_SUBJECTS)[number];

export function catalogRevisionKey(
  subject: CatalogRevisionSubject,
  subjectId: string,
  version: number,
): string {
  return `${subject}:${subjectId}:${version}`;
}
