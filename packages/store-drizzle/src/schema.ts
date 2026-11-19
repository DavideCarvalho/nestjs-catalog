import type { SnapshotArchiveRef } from '@dudousxd/nestjs-catalog';
import {
  boolean,
  foreignKey,
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
 * The longest name the tables derive from the prefix, without it:
 * `revision_subject_kind_subject_id_version_index`. A unit test checks it
 * against every name the tables derive.
 */
const LONGEST_DERIVED_NAME = 46;

/** Postgres truncates identifiers past 63 bytes, so two long index names could collide silently. */
const POSTGRES_IDENTIFIER_LIMIT = 63;

/** How long a prefix may be. Every derived table and index name then fits in 63 bytes. */
export const MAX_CATALOG_TABLE_PREFIX_LENGTH = POSTGRES_IDENTIFIER_LIMIT - LONGEST_DERIVED_NAME;

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
  if (prefix.length > MAX_CATALOG_TABLE_PREFIX_LENGTH) {
    throw new Error(
      `@dudousxd/nestjs-catalog-store-drizzle: table prefix "${prefix}" is ${prefix.length} characters; at most ${MAX_CATALOG_TABLE_PREFIX_LENGTH} keep every index name within Postgres's 63-byte identifier limit.`,
    );
  }
  return prefix;
}

/**
 * A time zone everywhere, and the precision the MikroORM store gives the same
 * column, so a database either store created is the database the other expects:
 * milliseconds (3) on the audit and revision times, which MikroORM declares with
 * `length: 3`, and Postgres's default microseconds (6) on the row times.
 */
const at = (name: string, precision: 3 | 6 = 3) =>
  timestamp(name, { precision, withTimezone: true, mode: 'date' });

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
  // `public` is what an unqualified table is already in, and drizzle-kit refuses
  // `pgSchema('public')`, so it is the plain table. Any other schema builds the
  // same table, only qualified: one signature for both.
  const schema = options.schema && options.schema !== 'public' ? options.schema : undefined;
  const table = (schema ? pgSchema(schema).table : pgTable) as typeof pgTable;
  const n = (name: string) => `${prefix}${name}`;
  // Index names follow MikroORM's `<table>_<columns>_index`, so a database the
  // MikroORM store already created gets no second copy of any index.

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
      createdAt: at('created_at', 6).notNull(),
      updatedAt: at('updated_at', 6).notNull(),
    },
    (t) => [index(n('saved_query_folder_index')).on(t.folder)],
  );

  const dashboard = table(n('dashboard'), {
    id: varchar('id', { length: 64 }).primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    createdBy: varchar('created_by', { length: 128 }).notNull(),
    /** Cards as one JSON value: they are only ever read and written whole. */
    cards: jsonb('cards').$type<Array<Record<string, unknown>>>().notNull(),
    shared: boolean('shared').notNull().default(false),
    createdAt: at('created_at', 6).notNull(),
    updatedAt: at('updated_at', 6).notNull(),
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
      index(n('audit_event_occurred_at_index')).on(t.occurredAt),
      index(n('audit_event_type_name_occurred_at_index')).on(t.typeName, t.occurredAt),
      index(n('audit_event_principal_id_occurred_at_index')).on(t.principalId, t.occurredAt),
      index(n('audit_event_snapshot_id_occurred_at_index')).on(t.snapshotId, t.occurredAt),
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
    (t) => [
      index(n('revision_subject_kind_subject_id_version_index')).on(
        t.subjectKind,
        t.subjectId,
        t.version,
      ),
    ],
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

  /* -------------------------------------------------------------------------
   * The model: what the stored registry serves and the directory reads. Same
   * columns, types and constraint names as the MikroORM store's entities.
   * ----------------------------------------------------------------------- */

  /** One published object type. Curation edits these columns in place. */
  const objectType = table(n('object_type'), {
    name: varchar('name', { length: 128 }).primaryKey(),
    ownerPrincipalId: varchar('owner_principal_id', { length: 128 }).notNull(),
    displayName: varchar('display_name', { length: 255 }).notNull(),
    pluralDisplayName: varchar('plural_display_name', { length: 255 }).notNull(),
    description: text('description'),
    icon: varchar('icon', { length: 32 }),
    group: varchar('group', { length: 128 }).notNull().default('Ungrouped'),
    titleProperty: varchar('title_property', { length: 128 }),
    primaryKey: jsonb('primary_key').$type<string[]>().notNull(),
    physicalTable: varchar('physical_table', { length: 128 }).notNull(),
    relations: jsonb('relations').$type<CatalogStoredRelation[]>(),
    currentSnapshotId: varchar('current_snapshot_id', { length: 128 }),
    createdAt: at('created_at', 6).notNull(),
    updatedAt: at('updated_at', 6).notNull(),
  });

  /** One property of a type; its id is `<type>.<property>`. Deleted with its type. */
  const property = table(
    n('property'),
    {
      id: varchar('id', { length: 300 }).primaryKey(),
      objectTypeName: varchar('object_type_name', { length: 128 }).notNull(),
      name: varchar('name', { length: 128 }).notNull(),
      displayName: varchar('display_name', { length: 255 }).notNull(),
      description: text('description'),
      type: varchar('type', { length: 32 }).notNull(),
      sourceColumn: varchar('source_column', { length: 255 }).notNull(),
      physicalColumn: varchar('physical_column', { length: 128 }).notNull(),
      nullable: boolean('nullable').notNull().default(true),
      primary: boolean('primary').notNull().default(false),
      hidden: boolean('hidden').notNull().default(false),
      position: integer('position').notNull().default(0),
      classification: varchar('classification', { length: 64 }),
      unit: varchar('unit', { length: 64 }),
      updatedAt: at('updated_at', 6),
    },
    (t) => [
      foreignKey({
        name: n('property_object_type_name_foreign'),
        columns: [t.objectTypeName],
        foreignColumns: [objectType.name],
      }).onDelete('cascade'),
    ],
  );

  /** One load of one type: written, then committed or dropped. */
  const snapshot = table(
    n('snapshot'),
    {
      id: varchar('id', { length: 300 }).primaryKey(),
      typeName: varchar('type_name', { length: 128 }).notNull(),
      snapshotId: varchar('snapshot_id', { length: 128 }).notNull(),
      principalId: varchar('principal_id', { length: 128 }).notNull(),
      rowCount: integer('row_count').notNull().default(0),
      committed: boolean('committed').notNull().default(false),
      labels: jsonb('labels').$type<Record<string, string>>(),
      createdAt: at('created_at', 6).notNull(),
      committedAt: at('committed_at', 6),
      droppedAt: at('dropped_at', 6),
      archive: jsonb('archive').$type<SnapshotArchiveRef>(),
    },
    (t) => [index(n('snapshot_type_name_created_at_index')).on(t.typeName, t.createdAt)],
  );

  /**
   * An application that may write to or read from the catalog. `key_hash` is a
   * digest, never a key; a row without one is described here and authenticates
   * elsewhere.
   */
  const principal = table(n('principal'), {
    id: varchar('id', { length: 128 }).primaryKey(),
    displayName: varchar('display_name', { length: 255 }).notNull(),
    keyHash: varchar('key_hash', { length: 64 }),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    writeTypes: jsonb('write_types').$type<string[]>().notNull(),
    readTypes: jsonb('read_types').$type<string[]>(),
    classifications: jsonb('classifications').$type<string[]>().notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: at('created_at', 6).notNull(),
    lastSeenAt: at('last_seen_at', 6),
  });

  return {
    savedQuery,
    dashboard,
    auditEvent,
    revision,
    overlay,
    objectType,
    property,
    snapshot,
    principal,
  } as const;
}

export type CatalogDrizzleTables = ReturnType<typeof catalogDrizzleTables>;

/** A relation as the object type row stores it, in its `relations` JSON. */
export interface CatalogStoredRelation {
  name: string;
  kind: string;
  targetType: string;
  displayName: string;
  description?: string;
  localKey?: string;
  nullable: boolean;
  hidden: boolean;
  position: number;
  owner: boolean;
  inverseName?: string;
}

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
