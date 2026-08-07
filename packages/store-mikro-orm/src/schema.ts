import { createHash } from 'node:crypto';
import { MetadataStorage, MikroORM } from '@mikro-orm/core';
import { Logger } from '@nestjs/common';
import { type CatalogSqlDialect, dialectForPlatform } from './dialect';
import { PrincipalRow, SnapshotRow } from './entities/governance';
import { ObjectTypeRow, PropertyRow } from './entities/model';
import {
  ConnectionRow,
  ConnectorRow,
  ConnectorRunRow,
  LoadExpectationRow,
  ReusableNodeRow,
  TransformRow,
  WorkflowReleaseRow,
  WorkflowRow,
  WorkflowStageRow,
} from './entities/pipeline';
import { AuditEventRow, DashboardRow, RevisionRow, SavedQueryRow } from './entities/workspace';

/** Where the applied-schema fingerprint is kept. */
export const MARKER_TABLE = 'catalog_schema_meta';

const OWNED = [
  ObjectTypeRow,
  PropertyRow,
  SnapshotRow,
  PrincipalRow,
  SavedQueryRow,
  DashboardRow,
  AuditEventRow,
  ConnectorRow,
  TransformRow,
  ConnectorRunRow,
  // See the note beside `catalogStoreEntities`: nothing points at this entity,
  // so it is only ever managed because it is named here.
  ConnectionRow,
  // Same again, and with the same consequence if forgotten. A connector holds a
  // workflow *id* rather than a relation, and a staged batch holds a run id, so
  // MikroORM's discovery can reach neither of these from anything else.
  WorkflowRow,
  WorkflowStageRow,
  // And again: a revision holds a subject *id* rather than a relation to a
  // transform or a saved query — deliberately, so deleting a subject cannot
  // cascade away code a recorded run still names — so discovery can reach this
  // one from nothing either.
  RevisionRow,
  // Once more: an expectation is keyed by an object type *name*, and the type it
  // names may not have been published yet — that is the point of it, a policy
  // settable before the first load — so there is no relation for discovery to
  // walk and this list is the only thing that creates the table.
  LoadExpectationRow,
  // And once more, for the reason the four above give: a workflow node holds a
  // reusable node's *id* rather than a relation — deliberately, so that deleting
  // one cannot cascade a node out of somebody else's graph — so discovery can
  // reach this from nothing either.
  ReusableNodeRow,
  // And again: a workflow's live pointer is a NUMBER on `catalog_workflow`, not
  // a relation to this table — deliberately, since the column must be able to
  // hold nothing at all, which is what "follow the latest save" is stored as —
  // so discovery can reach this from nothing either, and this list is what
  // creates it.
  WorkflowReleaseRow,
];

/**
 * Tables this package creates and manages at boot (autoSchema). Feed to your
 * ORM's migration differ skip list so it never tries to drop them.
 *
 * ```ts
 * await MikroORM.init({
 *   schemaGenerator: { skipTables: catalogManagedTables() },
 * });
 * ```
 *
 * Derived from the entities' own `tableName` rather than written out again, so
 * a rename cannot drift from what this package actually owns. Excludes
 * {@link MARKER_TABLE}, matching `durableManagedTables()` and
 * `agentManagedTables()`.
 *
 * Note that the *object* tables — `obj_<type>`, one per published type — are
 * deliberately absent. Their names are not knowable ahead of time, they are
 * created by the store as types arrive, and no migration differ should be
 * allowed to reason about them at all.
 */
export function catalogManagedTables(): string[] {
  return OWNED.map((entity) => tableNameOf(entity));
}

/**
 * The table name the `@Entity({ tableName })` decorator recorded.
 *
 * Read from MikroORM's decorator metadata rather than off the class: the
 * decorator does not assign a `tableName` property to the constructor, so a
 * `Reflect.get(entity, "tableName")` is always undefined and any fallback
 * derived from the class name silently produces `object_type` where the real
 * table is `catalog_object_type`.
 *
 * That failure is worse than it looks. The one job of this list is to tell a
 * migration differ which tables to leave alone — hand it four names that do not
 * exist and it will leave nothing alone and drop all four. So an unreadable
 * name throws rather than guessing.
 *
 * Connection-agnostic, and that is worth stating because it is the question
 * anyone mounting this package beside a host's own ORM will ask.
 * `MetadataStorage.getMetadata()` with no arguments returns the *global*
 * decorator-time registry (it lives on `globalThis`), which the `@Entity()`
 * decorator fills at module-import time. Discovery copies it into a per-ORM
 * storage and leaves the global one untouched, so this answers the same whether
 * these entities were registered on the default connection, on a named one, or
 * on no ORM at all.
 */
function tableNameOf(entity: (typeof OWNED)[number]): string {
  // The decorator-time registry, populated when the entity module is imported
  // and available long before `MikroORM.init` — which matters, since this list
  // is meant to be fed *into* the ORM config.
  const declared = Object.values(MetadataStorage.getMetadata());
  // The constructor first, and the class *name* only as a fallback across the
  // whole registry rather than as an alternative inside one pass.
  //
  // The registry is global and process-wide, so in a host that mounts this
  // catalog beside its own entities it holds both sets. A single `find` with
  // `meta.class === entity || meta.className === entity.name` returns whichever
  // entry comes first, so a host entity that merely shares a class name — the
  // names here are ordinary enough for that to happen — would win over the real
  // one and contribute the *host's* table name to this list. The differ would
  // then skip a table the host owns and drop the one this package owns.
  const match =
    declared.find((meta) => meta.class === entity) ??
    declared.find((meta) => meta.className === entity.name);
  const name = match?.tableName ?? match?.collection;
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(
      `Could not read the table name for ${entity.name}. Refusing to guess: this list is used to tell migration tooling what NOT to drop.`,
    );
  }
  return name;
}

/**
 * Non-destructive, fingerprint-gated schema management — the "autoSchema" the
 * host gets for free at boot, matching how `@dudousxd/nestjs-durable` and
 * `-agent` manage their own tables.
 *
 * A steady-state boot is one cheap read: the fingerprint of this package's
 * entity metadata is compared to the one stored in the marker table, and when
 * they match this returns immediately. No introspection, so it never slows or
 * deadlocks a shared multi-owner boot. Only when the fingerprint changes —
 * first boot, or this package evolved its schema — is the schema introspected
 * and updated.
 *
 * Always `safe: true`. This package shares a database with tables it does not
 * own, most importantly the `obj_*` tables that have no entity classes at all
 * — an unsafe update would read those as orphans and drop every published
 * type's data.
 */
export async function ensureCatalogSchema(
  orm: MikroORM,
  /**
   * Which engine's DDL the three statements below are written in.
   *
   * Derived from the ORM's own platform rather than passed in by every caller,
   * because the ORM already knows and a second opinion is a second thing that
   * can be wrong — a host that named the wrong one here would create the marker
   * table with MySQL quoting against a Postgres connection and fail at boot with
   * a syntax error rather than with a sentence. Overridable for a test that
   * wants to pin one.
   */
  dialect: CatalogSqlDialect = dialectForPlatform(orm),
): Promise<void> {
  const logger = new Logger('CatalogSchema');
  const fingerprint = fingerprintOf(orm);
  const connection = orm.em.getConnection();

  await connection.execute(dialect.markerTableCreate(MARKER_TABLE));

  const rows = await connection.execute<Array<{ fingerprint: string }>>(
    `SELECT fingerprint FROM ${dialect.ident(MARKER_TABLE)} WHERE id = 'catalog'`,
  );
  if (rows[0]?.fingerprint === fingerprint) return;

  await orm.schema.update({ safe: true });
  await connection.execute(dialect.markerUpsert(MARKER_TABLE), [fingerprint]);
  logger.log(
    `Schema applied for ${catalogManagedTables().join(', ')} (${fingerprint.slice(0, 12)})`,
  );
}

/**
 * A hash of what this package's tables should look like.
 *
 * Built from the property names, types and nullability of the owned entities —
 * the things whose change actually requires DDL. Deliberately not the whole
 * metadata object, which carries hydration details that shift between MikroORM
 * patch releases and would invalidate the marker for no reason.
 */
function fingerprintOf(orm: MikroORM): string {
  const owned = new Set(OWNED.map((e) => e.name));
  const shape: string[] = [];

  for (const meta of orm.getMetadata().getAll().values()) {
    if (!owned.has(meta.className)) continue;
    const columns = meta.props
      .filter((p) => p.persist !== false && p.kind === 'scalar')
      .map(
        (p) =>
          `${p.fieldNames?.[0] ?? p.name}:${p.columnTypes?.[0] ?? p.type}:${p.nullable ? 1 : 0}`,
      )
      .sort();
    shape.push(`${meta.tableName}(${columns.join(',')})`);
  }

  return createHash('sha256').update(shape.sort().join('|')).digest('hex');
}
