import {
  type CatalogObjectTypeDef,
  type CatalogOverlay,
  CatalogRegistry,
  type CatalogRelationDef,
  type CatalogSnapshot,
  type RelationKind,
  type ScalarType,
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

  async patchType(
    typeName: string,
    patch: Partial<CatalogOverlay['types'][string]>,
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
   */
  async patchProperty(
    typeName: string,
    propertyName: string,
    patch: NonNullable<CatalogOverlay['types'][string]['properties']>[string],
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
   */
  async resetOverlay(): Promise<void> {
    throw new Error(
      'The catalog service has no overlay to reset. Re-publish the type from the application that owns it.',
    );
  }

  /**
   * The newest COMMITTED snapshot per type, in one query.
   *
   * One query rather than one per type, because this runs on every reload and a
   * catalog with two hundred types would otherwise pay two hundred round trips
   * to answer a question nobody asked yet. Ordered newest-first and kept on
   * first sight, so the map holds the serving snapshot for each type.
   *
   * `committed: true` is the filter that makes this mean anything: an
   * uncommitted snapshot is a load in flight or a load that failed, and neither
   * is what readers are being served.
   */
  private async servingSnapshots(em: EntityManager): Promise<Map<string, SnapshotRow>> {
    const rows = await em.find(
      SnapshotRow,
      { committed: true },
      { orderBy: { committedAt: 'desc' } },
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
