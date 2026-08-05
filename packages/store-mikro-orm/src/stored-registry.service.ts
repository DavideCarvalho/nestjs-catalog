import {
  type CatalogObjectTypeDef,
  type CatalogOverlay,
  CatalogRegistry,
  type CatalogRelationDef,
  type CatalogSnapshot,
  type RelationKind,
  type ScalarType,
  curationActor,
  emitCatalog,
} from '@dudousxd/nestjs-catalog';
import type { MikroORM } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/mysql';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { CATALOG_STORE_ENTITY_MANAGER, CATALOG_STORE_MIKRO_ORM } from './context';
import { SnapshotRow } from './entities/governance';
import { ObjectTypeRow, PropertyRow, type StoredRelation, relationsOf } from './entities/model';
import { CATALOG_STORE_OPTIONS, type CatalogStoreModuleOptions } from './options';
import { ensureCatalogSchema } from './schema';

const SCALARS: ScalarType[] = ['string', 'number', 'boolean', 'date', 'json', 'uuid', 'unknown'];

function toScalar(value: string): ScalarType {
  const found = SCALARS.find((s) => s === value);
  return found ?? 'unknown';
}

/**
 * The `id` out of a raw driver row, or undefined if it is not there.
 *
 * A guard rather than a cast because the driver's return type is genuinely
 * unknown — `execute` hands back whatever the server sent — and the alternative
 * is asserting a shape that a renamed column would make a lie at runtime while
 * still compiling. `Reflect.get` rather than indexing, so narrowing `value` to
 * an object is enough and no index signature has to be invented for it.
 */
function idOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const id = Reflect.get(value, 'id');
  return typeof id === 'string' ? id : undefined;
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

const RELATION_KINDS: RelationKind[] = ['1:1', '1:m', 'm:1', 'm:n'];

/**
 * Narrow a stored kind, the same way {@link toScalar} narrows a stored type.
 *
 * `m:1` is the fallback rather than a throw, because the alternative to a
 * best-guess kind is a catalog that refuses to load over one bad row written by
 * a publisher nobody can reach right now. The kind decides an arrowhead; the
 * link itself is still true.
 */
function toRelationKind(value: string): RelationKind {
  const found = RELATION_KINDS.find((kind) => kind === value);
  return found ?? 'm:1';
}

/**
 * The model, read from our own tables rather than reflected off entity classes.
 *
 * Held in memory and rebuilt on write. The whole model is a few hundred rows
 * and every read of every object type consults it, so paying a query per
 * request to re-read something that changes a handful of times a day would be
 * the wrong trade.
 *
 * Presentation edits land in the same rows the publisher wrote. There is no
 * separate overlay here, unlike the in-app library: the publisher's values
 * arrive over HTTP and are already just data, so a curator editing them is
 * editing the same column. What keeps a re-publish from stomping a curator's
 * work is that `upsertType` only fills in labels it has not seen before.
 *
 * Nothing about a link is derivable here and nothing ever will be: there are no
 * entity classes and no foreign keys — every published type lands as a flat
 * snapshot — so what a `@ManyToOne` says in the owning application has to arrive
 * over the wire or be asserted by a curator. The one thing this must not do is
 * guess. A `base_id` column beside a type called `Base` is a strong hint and a
 * bad edge: an ontology that invents joins is worse than one with none, because
 * the invented ones are indistinguishable from the real ones. Once the links are
 * in the snapshot, though, drawing them is the same job everywhere — which is
 * why the graph is built by the base class rather than here.
 */
@Injectable()
export class StoredCatalogRegistry extends CatalogRegistry implements OnModuleInit {
  private readonly logger = new Logger(StoredCatalogRegistry.name);
  private snapshot: CatalogSnapshot = emptySnapshot();

  constructor(
    // Both by token rather than positionally. `this.orm` is the one that really
    // must not be the host's: `ensureCatalogSchema` runs `schema.update()` on
    // it, so resolving the wrong connection would point this package's schema
    // management at somebody else's tables.
    @Inject(CATALOG_STORE_ENTITY_MANAGER)
    private readonly em: EntityManager,
    @Inject(CATALOG_STORE_MIKRO_ORM)
    private readonly orm: MikroORM,
    @Inject(CATALOG_STORE_OPTIONS)
    private readonly options: CatalogStoreModuleOptions,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    // Here rather than in a module hook: this is the first thing that reads the
    // tables, and Nest does not promise that a module's own onModuleInit runs
    // before its providers'. Making the reader responsible for the schema it
    // reads removes the ordering question entirely.
    if (this.options.autoSchema !== false) {
      await ensureCatalogSchema(this.orm);
    }
    await this.reload();
    // Relations in the boot line for the same reason the in-app registry prints
    // them: a wire that stopped carrying links shows up here as a zero, and
    // nowhere else until somebody opens the graph and finds it bare.
    this.logger.log(
      `Catalog loaded: ${this.snapshot.stats.types} object types, ${this.snapshot.stats.properties} properties, ${this.snapshot.stats.relations} relations`,
    );
  }

  async reload(): Promise<void> {
    const em = this.em.fork();
    const rows = await em.find(
      ObjectTypeRow,
      {},
      { populate: ['properties'], orderBy: { group: 'asc', displayName: 'asc' } },
    );

    const serving = await this.servingSnapshots(em);
    // Every published name, before any type is built. Whether a link's other end
    // exists is a fact about the catalog rather than about the type holding the
    // link, so it cannot be answered while the catalog is half-assembled.
    const published = new Set(rows.map((row) => row.name));
    const types = rows.map((row) => this.toDef(row, published, serving.get(row.name)));
    this.snapshot = {
      version: this.snapshot.version + 1,
      generatedAt: new Date().toISOString(),
      stats: {
        types: types.length,
        properties: types.reduce((n, t) => n + t.properties.length, 0),
        relations: types.reduce((n, t) => n + t.relations.length, 0),
        enrichedTypes: types.filter((t) => t.enriched).length,
      },
      types,
    };
  }

  getSnapshot(): CatalogSnapshot {
    return this.snapshot;
  }

  getType(name: string): CatalogObjectTypeDef | undefined {
    return this.snapshot.types.find((t) => t.name.toLowerCase() === name.toLowerCase());
  }

  // `getGraph` is deliberately absent: the base class draws the ontology from
  // the snapshot above, and it is the same drawing the library registry gets.
  // See `buildCatalogGraph` in `@dudousxd/nestjs-catalog` — this file used to
  // hold a second copy of the edge rule, under a comment asking whoever changed
  // one to change both.

  /** @param curatedBy the acting principal's id, recorded on `type.curated`. */
  async patchType(
    typeName: string,
    patch: Partial<CatalogOverlay['types'][string]>,
    curatedBy: string,
  ): Promise<CatalogObjectTypeDef | undefined> {
    const em = this.em.fork();
    const row = await em.findOne(ObjectTypeRow, { name: typeName });
    if (!row) return undefined;

    if (patch.displayName !== undefined) row.displayName = patch.displayName;
    if (patch.pluralDisplayName !== undefined) {
      row.pluralDisplayName = patch.pluralDisplayName;
    }
    if (patch.description !== undefined) row.description = patch.description;
    if (patch.icon !== undefined) row.icon = patch.icon;
    if (patch.group !== undefined) row.group = patch.group;
    if (patch.titleProperty !== undefined) {
      row.titleProperty = patch.titleProperty;
    }
    await em.flush();
    await this.reload();
    emitCatalog('type.curated', {
      typeName,
      changed: Object.keys(patch),
      // Through `curationActor` for the reason its own docblock gives, and with
      // one more edge here: this registry is reachable through
      // `RoutingCatalogRegistry`, a hand-written proxy in this same package. A
      // forwarder that drops the argument would leave the actor empty in exactly
      // the multi-environment deployments where the trail is consulted most.
      principalId: curationActor(curatedBy),
    });
    return this.getType(typeName);
  }

  /**
   * Curate one field — and a relation is a field to whoever is looking.
   *
   * The same route, the same patch shape, and the fallback below is why no new
   * endpoint was needed to name a link: the console sends `PATCH
   * .../properties/base` whether `base` turns out to be a column or a link, and
   * a caller that had to know which in advance would have to read the type first
   * just to pick a URL. The library registry already behaved this way — its
   * overlay is keyed by property name and a relation's name is in the same
   * namespace — so this is the persisted path catching up rather than a new
   * idea.
   *
   * @param curatedBy the acting principal's id, recorded on `type.curated`. The
   * same argument whichever of the two the patch lands on: a reader asking who
   * renamed `base` is not asking whether `base` turned out to be a column.
   */
  async patchProperty(
    typeName: string,
    propertyName: string,
    patch: NonNullable<CatalogOverlay['types'][string]['properties']>[string],
    curatedBy: string,
  ): Promise<CatalogObjectTypeDef | undefined> {
    const em = this.em.fork();
    const row = await em.findOne(PropertyRow, {
      id: `${typeName}.${propertyName}`,
    });

    if (row) {
      if (patch.displayName !== undefined) row.displayName = patch.displayName;
      if (patch.description !== undefined) row.description = patch.description;
      if (patch.hidden !== undefined) row.hidden = patch.hidden;
      if (patch.order !== undefined) row.position = patch.order;
      if (patch.classification !== undefined) {
        row.classification = patch.classification;
      }
      if (patch.unit !== undefined) row.unit = patch.unit;
    } else if (!(await this.patchRelation(em, typeName, propertyName, patch))) {
      return undefined;
    }

    await em.flush();
    await this.reload();
    emitCatalog('type.curated', {
      typeName,
      property: propertyName,
      changed: Object.keys(patch),
      principalId: curationActor(curatedBy),
    });
    return this.getType(typeName);
  }

  /**
   * Apply a field patch to a link instead of a column. False when there is no
   * such link, which is what makes the caller answer 404 rather than 200.
   *
   * `unit` and `classification` are ignored rather than rejected. They are
   * meaningless on a link — it has no value to carry a unit — and the console
   * sends whichever fields its editor changed, so refusing the whole patch over
   * a field nobody typed would break the editable label this exists to serve.
   */
  private async patchRelation(
    em: EntityManager,
    typeName: string,
    relationName: string,
    patch: NonNullable<CatalogOverlay['types'][string]['properties']>[string],
  ): Promise<boolean> {
    const row = await em.findOne(ObjectTypeRow, { name: typeName });
    if (!row) return false;
    const relations = relationsOf(row);
    const existing = relations.find((relation) => relation.name === relationName);
    if (!existing) return false;

    const patched: StoredRelation = {
      ...existing,
      ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.hidden === undefined ? {} : { hidden: patch.hidden }),
      ...(patch.order === undefined ? {} : { position: patch.order }),
    };
    // Replaced, never mutated in place: MikroORM diffs a JSON property against
    // the snapshot it took at load, and editing the object it already holds can
    // leave the flush with nothing to write.
    row.relations = relations.map((relation) =>
      relation.name === relationName ? patched : relation,
    );
    return true;
  }

  /**
   * Not supported here, and the reason is worth stating: in the library the
   * overlay is a separate layer over derived truth, so dropping it restores
   * what the ORM says. Here the published values *are* the stored values —
   * there is nothing underneath to fall back to, and a reset would mean
   * discarding whatever a curator wrote with no way to recover it. Re-publish
   * from the owning application instead.
   *
   * **And so this emits no `overlay.reset`.** The library registry emits one
   * because it destroys the curated values, and that event is the only record
   * of what they were; here nothing is destroyed, so an event would be a row in
   * the audit table saying a reset happened when the caller got an exception and
   * every stored label is still exactly where it was. The refusal is the honest
   * answer, and it reaches the caller rather than the trail.
   *
   * **And so it declares no actor**, where the base class and the two patches
   * above take one. An override may take fewer parameters than it was promised,
   * and accepting a `resetBy` here would advertise a record this method never
   * writes — the next reader would go looking in the audit table for the reset
   * this signature implies, and find the exception instead.
   */
  async resetOverlay(): Promise<void> {
    throw new Error(
      'The catalog service has no overlay to reset. Re-publish the type from the application that owns it.',
    );
  }

  /**
   * The newest COMMITTED snapshot per type — bounded by the number of TYPES,
   * never by the number of snapshots ever written.
   *
   * `committed: true` is the filter that makes this mean anything: an
   * uncommitted snapshot is a load in flight or a load that failed, and neither
   * is what readers are being served.
   *
   * **Why this is two statements and not one `find`.** It used to be
   * `em.find(SnapshotRow, { committed: true }, { orderBy: { committedAt: 'desc' } })`
   * — every committed snapshot ever written, dragged over the wire and hydrated
   * into managed entities, to keep one row per type and drop the rest. That is
   * the wrong shape for a table nothing ever deletes from. Measured on MySQL 8.0
   * at 200 types / 50k committed snapshots: `reload()` took 450-500 ms and the
   * hydrated rows added **161 MB** to the heap. Both of those land on the host
   * this package is mounted inside — its event loop does the hydration and its
   * pod holds the heap — and both grow forever, because a snapshot row is
   * written per load per type and nothing prunes them (see the retention note on
   * {@link SnapshotRow}). The old cost was not "a slow catalog screen"; at a
   * year of nightly loads it is a memory spike in somebody else's process.
   *
   * So: ask the database which rows are the serving ones and hydrate only
   * those. The first statement is a grouped join returning ~one id per type; the
   * second is a primary-key `IN` over that handful. Two small round trips beat
   * one enormous one, and doing the narrowing in SQL rather than in JS is the
   * whole point — the rejected rows never cross the wire.
   *
   * **What this costs elsewhere.** The grouped query still SCANS the table: the
   * only declared index is `(type_name, created_at)`, which covers neither the
   * `committed` filter nor the `committed_at` ordering, so MySQL reads every row
   * to compute the per-type maximum. That is now the database server's work
   * instead of the host's, which is the trade being made deliberately — but it
   * does not vanish. An index on `(committed, type_name, committed_at)` takes the
   * grouped query from ~85 ms to ~14 ms at 50k rows. It is not added here
   * because it is a deployment decision, not a defect: `fingerprintOf` in
   * `schema.ts` hashes only column names, types and nullability, so an added
   * `@Index` would not move the fingerprint and would never be applied to an
   * already-booted database at all.
   *
   * **Ties.** `committed_at` is a `DATETIME` with no fractional seconds, so two
   * loads of one type committing in the same second share a maximum and both ids
   * come back. The `orderBy` below makes the winner the highest id rather than
   * whichever row the engine happened to return first — the previous code broke
   * such ties arbitrarily, so this is strictly more determinism, not less.
   *
   * Table and column names are written out rather than derived from metadata,
   * matching `audit-recorder.service.ts`. Both assume MikroORM's underscored
   * naming strategy, which this package's entities are declared against.
   */
  private async servingSnapshots(em: EntityManager): Promise<Map<string, SnapshotRow>> {
    const newest = await em.getConnection().execute<unknown[]>(
      `SELECT s.id
         FROM catalog_snapshot s
         JOIN (
                SELECT type_name, MAX(committed_at) AS newest
                  FROM catalog_snapshot
                 WHERE committed = TRUE
              GROUP BY type_name
              ) latest
           ON latest.type_name = s.type_name
          AND latest.newest = s.committed_at
        WHERE s.committed = TRUE`,
    );

    const ids = newest.map(idOf).filter(isPresent);
    // Guarded rather than left to the query builder: an empty `$in` is a
    // `WHERE id IN ()`, which is a syntax error on MySQL, and a catalog with no
    // committed loads yet is the ordinary state on a fresh deployment.
    if (ids.length === 0) return new Map();

    const rows = await em.find(
      SnapshotRow,
      { id: { $in: ids } },
      { orderBy: { committedAt: 'desc', id: 'desc' } },
    );

    const serving = new Map<string, SnapshotRow>();
    for (const row of rows) {
      if (!serving.has(row.typeName)) serving.set(row.typeName, row);
    }
    return serving;
  }

  private toDef(
    row: ObjectTypeRow,
    published: Set<string>,
    serving?: SnapshotRow,
  ): CatalogObjectTypeDef {
    const relations: CatalogRelationDef[] = [...relationsOf(row)]
      .sort((a, b) => a.position - b.position)
      .map((relation) => ({
        name: relation.name,
        displayName: relation.displayName,
        kind: toRelationKind(relation.kind),
        targetType: relation.targetType,
        nullable: relation.nullable,
        hidden: relation.hidden,
        order: relation.position,
        owner: relation.owner,
        // Computed here rather than stored, because it is not a fact about this
        // link: the application that owns `Base` can publish it tomorrow or be
        // switched off tonight, and a persisted answer would keep insisting on
        // whichever was true when the row was written.
        targetPublished: published.has(relation.targetType),
        // Same limit the properties above have, for the same reason: there is no
        // derived layer underneath here, so a display name that arrived from a
        // publisher is indistinguishable from one a curator typed. A description
        // is the one field nothing writes by default.
        enriched: Boolean(relation.description),
        ...(relation.description === undefined ? {} : { description: relation.description }),
        ...(relation.localKey === undefined ? {} : { localKey: relation.localKey }),
        ...(relation.inverseName === undefined ? {} : { inverseName: relation.inverseName }),
      }));

    const properties = row.properties
      .getItems()
      .sort((a, b) => a.position - b.position)
      .map((p) => ({
        name: p.name,
        displayName: p.displayName,
        description: p.description,
        type: toScalar(p.type),
        columnName: p.sourceColumn,
        nullable: p.nullable,
        primary: p.primary,
        hidden: p.hidden,
        order: p.position,
        classification: p.classification,
        unit: p.unit,
        enriched: Boolean(p.description || p.unit || p.classification),
      }));

    return {
      name: row.name,
      displayName: row.displayName,
      pluralDisplayName: row.pluralDisplayName,
      description: row.description,
      tableName: row.physicalTable,
      icon: row.icon,
      group: row.group,
      titleProperty: row.titleProperty,
      primaryKey: row.primaryKey ?? [],
      enriched:
        Boolean(row.description) ||
        properties.some((p) => p.enriched) ||
        relations.some((r) => r.enriched),
      // Spread so a type with no committed snapshot carries no key at all
      // rather than three explicit `undefined`s. The absence is the statement —
      // "never loaded" and "loaded long ago" have to stay distinguishable, and
      // a key present-and-empty muddies that the moment anything serialises it.
      ...(serving?.committedAt
        ? {
            lastCommittedAt: serving.committedAt.toISOString(),
            rowCount: serving.rowCount,
            lastPrincipalId: serving.principalId,
          }
        : {}),
      properties,
      relations,
    };
  }
}

function emptySnapshot(): CatalogSnapshot {
  return {
    version: 0,
    generatedAt: new Date().toISOString(),
    stats: { types: 0, properties: 0, relations: 0, enrichedTypes: 0 },
    types: [],
  };
}
