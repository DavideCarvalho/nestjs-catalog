import {
  type CatalogGraph,
  type CatalogObjectTypeDef,
  type CatalogOverlay,
  CatalogRegistry,
  type CatalogSnapshot,
  type ScalarType,
  emitCatalog,
} from '@dudousxd/nestjs-catalog';
import type { MikroORM } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/mysql';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { CATALOG_STORE_ENTITY_MANAGER, CATALOG_STORE_MIKRO_ORM } from './context';
import { ObjectTypeRow, PropertyRow } from './entities/model';
import { CATALOG_STORE_OPTIONS, type CatalogStoreModuleOptions } from './options';
import { ensureCatalogSchema } from './schema';

const SCALARS: ScalarType[] = ['string', 'number', 'boolean', 'date', 'json', 'uuid', 'unknown'];

function toScalar(value: string): ScalarType {
  const found = SCALARS.find((s) => s === value);
  return found ?? 'unknown';
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
    this.logger.log(
      `Catalog loaded: ${this.snapshot.stats.types} object types, ${this.snapshot.stats.properties} properties`,
    );
  }

  async reload(): Promise<void> {
    const em = this.em.fork();
    const rows = await em.find(
      ObjectTypeRow,
      {},
      { populate: ['properties'], orderBy: { group: 'asc', displayName: 'asc' } },
    );

    const types = rows.map((row) => this.toDef(row));
    this.snapshot = {
      version: this.snapshot.version + 1,
      generatedAt: new Date().toISOString(),
      stats: {
        types: types.length,
        properties: types.reduce((n, t) => n + t.properties.length, 0),
        relations: 0,
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

  /**
   * Empty for now.
   *
   * Links are the one thing that cannot be derived here: a foreign key lives in
   * the publisher's schema, and what arrives is a flat set of rows. They have
   * to be published explicitly, which is the next piece of the wire format.
   */
  getGraph(): CatalogGraph {
    return {
      nodes: this.snapshot.types.map((t) => ({
        id: t.name,
        label: t.displayName,
        group: t.group,
        icon: t.icon,
        propertyCount: t.properties.length,
        relationCount: 0,
      })),
      edges: [],
    };
  }

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

  async patchProperty(
    typeName: string,
    propertyName: string,
    patch: NonNullable<CatalogOverlay['types'][string]['properties']>[string],
  ): Promise<CatalogObjectTypeDef | undefined> {
    const em = this.em.fork();
    const row = await em.findOne(PropertyRow, {
      id: `${typeName}.${propertyName}`,
    });
    if (!row) return undefined;

    if (patch.displayName !== undefined) row.displayName = patch.displayName;
    if (patch.description !== undefined) row.description = patch.description;
    if (patch.hidden !== undefined) row.hidden = patch.hidden;
    if (patch.order !== undefined) row.position = patch.order;
    if (patch.classification !== undefined) {
      row.classification = patch.classification;
    }
    if (patch.unit !== undefined) row.unit = patch.unit;
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

  private toDef(row: ObjectTypeRow): CatalogObjectTypeDef {
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
      enriched: Boolean(row.description) || properties.some((p) => p.enriched),
      properties,
      relations: [],
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
