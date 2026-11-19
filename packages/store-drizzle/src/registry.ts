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
  isRelationKind,
} from '@dudousxd/nestjs-catalog';
import { Logger } from '@nestjs/common';
import { type SQL, and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { type CatalogDrizzleRun, catalogDrizzleRunner } from './connection';
import {
  type CatalogDrizzleTables,
  type CatalogStoredRelation,
  catalogDrizzleTables,
} from './schema';
import type { CatalogDrizzleStoreOptions } from './workspace.store';

export type CatalogDrizzleRegistryOptions = CatalogDrizzleStoreOptions & {
  /**
   * How long a served model may go unchecked, in milliseconds. A read after this
   * asks the database whether the model changed (one cheap statement) and
   * reloads in the background if it did. Defaults to 1000; 0 never checks.
   */
  readonly staleAfterMs?: number;
};

type ObjectTypeRow = CatalogDrizzleTables['objectType']['$inferSelect'];
type PropertyRow = CatalogDrizzleTables['property']['$inferSelect'];
type SnapshotRow = CatalogDrizzleTables['snapshot']['$inferSelect'];

const SCALARS: ScalarType[] = ['string', 'number', 'boolean', 'date', 'json', 'uuid', 'unknown'];
const DEFAULT_STALE_AFTER_MS = 1_000;

/**
 * The catalog's model read from its own tables (`object_type`, `property`,
 * `snapshot`), on Drizzle and Postgres: the Drizzle twin of the MikroORM
 * `StoredCatalogRegistry`, held to the same shared contract.
 *
 * Curation (`patchType`, `patchProperty`) writes the rows themselves, so every
 * replica sees it. Each replica keeps the model in memory and, at most once per
 * `staleAfterMs`, compares a watermark (row counts and newest `updated_at` of
 * both tables) with the one it loaded. A watermark is trusted only once the
 * newest write is a second old, so two writes inside one timestamp tick cannot
 * look like no change.
 *
 * Call {@link reload} once before serving: Nest does it through `onModuleInit`.
 * Nothing here creates tables.
 */
export class DrizzleCatalogRegistry extends CatalogRegistry {
  private readonly logger = new Logger(DrizzleCatalogRegistry.name);
  private readonly run: CatalogDrizzleRun;
  private readonly t: CatalogDrizzleTables;
  private readonly staleAfterMs: number;
  private snapshot: CatalogSnapshot = emptySnapshot();
  private watermark?: string;
  private lastCheckedAt = 0;
  private refreshing?: Promise<void>;

  constructor(options: CatalogDrizzleRegistryOptions) {
    super();
    this.run = catalogDrizzleRunner(options);
    this.t = catalogDrizzleTables(options);
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  }

  async onModuleInit(): Promise<void> {
    await this.reload();
    this.logger.log(
      `Catalog loaded: ${this.snapshot.stats.types} object types, ${this.snapshot.stats.properties} properties, ${this.snapshot.stats.relations} relations`,
    );
  }

  /** Read the whole model, in one unit of work, and serve it. */
  async reload(): Promise<void> {
    const { types, mark } = await this.run(async (db) => {
      const mark = await this.readWatermark(db);
      const o = this.t.objectType;
      const p = this.t.property;
      const typeRows = await db.select().from(o).orderBy(asc(o.group), asc(o.displayName));
      const propertyRows =
        typeRows.length === 0
          ? []
          : await db
              .select()
              .from(p)
              .where(
                inArray(
                  p.objectTypeName,
                  typeRows.map((row) => row.name),
                ),
              );
      const serving = await this.servingSnapshots(db);
      const byType = new Map<string, PropertyRow[]>();
      for (const row of propertyRows) {
        const list = byType.get(row.objectTypeName);
        if (list) list.push(row);
        else byType.set(row.objectTypeName, [row]);
      }
      const published = new Set(typeRows.map((row) => row.name));
      return {
        mark,
        types: typeRows.map((row) =>
          toDef(row, byType.get(row.name) ?? [], published, serving.get(row.name)),
        ),
      };
    });

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
    this.watermark = mark?.settled === true ? mark.key : undefined;
    this.lastCheckedAt = Date.now();
  }

  getSnapshot(): CatalogSnapshot {
    this.refreshIfDue();
    return this.snapshot;
  }

  getType(name: string): CatalogObjectTypeDef | undefined {
    this.refreshIfDue();
    return this.snapshot.types.find((t) => t.name.toLowerCase() === name.toLowerCase());
  }

  async patchType(
    typeName: string,
    patch: Partial<CatalogOverlay['types'][string]>,
    curatedBy: string,
  ): Promise<CatalogObjectTypeDef | undefined> {
    const o = this.t.objectType;
    const found = await this.run(async (db) => {
      const [row] = await db.select().from(o).where(eq(o.name, typeName)).limit(1).for('update');
      if (!row) return false;
      const set = defined<ObjectTypeRow>({
        displayName: patch.displayName,
        pluralDisplayName: patch.pluralDisplayName,
        description: patch.description,
        icon: patch.icon,
        group: patch.group,
        titleProperty: patch.titleProperty,
      });
      if (changes(set, row)) {
        await db
          .update(o)
          .set({ ...set, updatedAt: new Date() })
          .where(eq(o.name, typeName));
      }
      return true;
    });
    if (!found) return undefined;
    await this.reload();
    emitCatalog('type.curated', {
      typeName,
      changed: Object.keys(patch),
      principalId: curationActor(curatedBy),
    });
    return this.getType(typeName);
  }

  /**
   * Curate a property, or a relation under the same name: to whoever is reading,
   * a relation is a property, and its label is curated through the same patch.
   */
  async patchProperty(
    typeName: string,
    propertyName: string,
    patch: NonNullable<CatalogOverlay['types'][string]['properties']>[string],
    curatedBy: string,
  ): Promise<CatalogObjectTypeDef | undefined> {
    const p = this.t.property;
    const found = await this.run(async (db) => {
      const [row] = await db
        .select()
        .from(p)
        .where(eq(p.id, `${typeName}.${propertyName}`))
        .limit(1)
        .for('update');
      if (!row) return this.curateRelation(db, typeName, propertyName, patch);
      const set = defined<PropertyRow>({
        displayName: patch.displayName,
        description: patch.description,
        hidden: patch.hidden,
        position: patch.order,
        classification: patch.classification,
        unit: patch.unit,
      });
      if (changes(set, row)) {
        await db
          .update(p)
          .set({ ...set, updatedAt: new Date() })
          .where(eq(p.id, row.id));
      }
      return true;
    });
    if (!found) return undefined;
    await this.reload();
    emitCatalog('type.curated', {
      typeName,
      property: propertyName,
      changed: Object.keys(patch),
      principalId: curationActor(curatedBy),
    });
    return this.getType(typeName);
  }

  /** A relation's label, curated in the type row's `relations` JSON. */
  private async curateRelation(
    db: Parameters<Parameters<CatalogDrizzleRun>[0]>[0],
    typeName: string,
    relationName: string,
    patch: NonNullable<CatalogOverlay['types'][string]['properties']>[string],
  ): Promise<boolean> {
    const o = this.t.objectType;
    const [type] = await db.select().from(o).where(eq(o.name, typeName)).limit(1).for('update');
    if (!type) return false;
    const relations = relationsOf(type);
    const existing = relations.find((relation) => relation.name === relationName);
    if (!existing) return false;
    const patched: CatalogStoredRelation = {
      ...existing,
      ...defined<CatalogStoredRelation>({
        displayName: patch.displayName,
        description: patch.description,
        hidden: patch.hidden,
        position: patch.order,
      }),
    };
    await db
      .update(o)
      .set({
        relations: relations.map((relation) =>
          relation.name === relationName ? patched : relation,
        ),
        updatedAt: new Date(),
      })
      .where(eq(o.name, typeName));
    return true;
  }

  /** There is no overlay here: curation lives on the rows, and a type is reset by publishing it again. */
  async resetOverlay(): Promise<void> {
    throw new Error(
      'The catalog service has no overlay to reset. Re-publish the type from the application that owns it.',
    );
  }

  private refreshIfDue(): void {
    if (this.staleAfterMs <= 0) return;
    const now = Date.now();
    if (now - this.lastCheckedAt < this.staleAfterMs) return;
    this.lastCheckedAt = now;
    void this.refreshIfStale();
  }

  /** Ask for the watermark, and reload only if it moved. One check at a time. */
  private refreshIfStale(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const mark = await this.run((db) => this.readWatermark(db));
        if (mark !== undefined && mark.key === this.watermark) return;
        await this.reload();
      } catch (error) {
        this.logger.warn(
          `Could not check whether the catalog model has changed: ${
            error instanceof Error ? error.message : String(error)
          }. Still serving ${this.snapshot.stats.types} object types loaded at ${
            this.snapshot.generatedAt
          }.`,
        );
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  private async readWatermark(
    db: Parameters<Parameters<CatalogDrizzleRun>[0]>[0],
  ): Promise<{ key: string; settled: boolean } | undefined> {
    const o = this.t.objectType;
    const p = this.t.property;
    const result = await db.execute(sql`SELECT
        (SELECT COUNT(*) FROM ${o}) AS type_rows,
        (SELECT MAX(updated_at) FROM ${o}) AS type_at,
        (SELECT COUNT(*) FROM ${p}) AS property_rows,
        (SELECT MAX(updated_at) FROM ${p}) AS property_at,
        NOW() AS db_now`);
    const row = firstRow(result);
    if (!row) return undefined;
    const key = ['type_rows', 'type_at', 'property_rows', 'property_at']
      .map((column) => cell(row[column]))
      .join('|');
    const now = instant(row.db_now);
    const written = [instant(row.type_at), instant(row.property_at)].filter(
      (value): value is number => value !== undefined,
    );
    const settled =
      now === undefined || written.length === 0 || now - Math.max(...written) >= 1_000;
    return { key, settled };
  }

  /** The newest committed snapshot of each type. */
  private async servingSnapshots(
    db: Parameters<Parameters<CatalogDrizzleRun>[0]>[0],
  ): Promise<Map<string, SnapshotRow>> {
    const s = this.t.snapshot;
    const rows = await db
      .selectDistinctOn([s.typeName])
      .from(s)
      .where(and(eq(s.committed, true), sql`${s.committedAt} IS NOT NULL`) as SQL)
      .orderBy(s.typeName, desc(s.committedAt), desc(s.id));
    return new Map(rows.map((row) => [row.typeName, row]));
  }
}

/** The members that were given, so a patch sets only what it names. */
function defined<T>(values: { [K in keyof T]?: T[K] | undefined }): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function changes<T extends object>(set: Partial<T>, row: T): boolean {
  return Object.entries(set).some(([key, value]) => Reflect.get(row, key) !== value);
}

function relationsOf(row: ObjectTypeRow): CatalogStoredRelation[] {
  return Array.isArray(row.relations) ? row.relations : [];
}

function toScalar(value: string): ScalarType {
  return SCALARS.find((s) => s === value) ?? 'unknown';
}

function toRelationKind(value: string): RelationKind {
  return isRelationKind(value) ? value : 'm:1';
}

function toDef(
  row: ObjectTypeRow,
  propertyRows: PropertyRow[],
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
      targetPublished: published.has(relation.targetType),
      enriched: Boolean(relation.description),
      ...(relation.description === undefined ? {} : { description: relation.description }),
      ...(relation.localKey === undefined ? {} : { localKey: relation.localKey }),
      ...(relation.inverseName === undefined ? {} : { inverseName: relation.inverseName }),
    }));
  const properties = [...propertyRows]
    .sort((a, b) => a.position - b.position)
    .map((p) => ({
      name: p.name,
      displayName: p.displayName,
      description: p.description ?? undefined,
      type: toScalar(p.type),
      columnName: p.sourceColumn,
      nullable: p.nullable,
      primary: p.primary,
      hidden: p.hidden,
      order: p.position,
      classification: p.classification ?? undefined,
      unit: p.unit ?? undefined,
      enriched: Boolean(p.description || p.unit || p.classification),
    }));
  return {
    name: row.name,
    displayName: row.displayName,
    pluralDisplayName: row.pluralDisplayName,
    description: row.description ?? undefined,
    tableName: row.physicalTable,
    icon: row.icon ?? undefined,
    group: row.group,
    titleProperty: row.titleProperty ?? undefined,
    primaryKey: row.primaryKey ?? [],
    enriched:
      Boolean(row.description) ||
      properties.some((p) => p.enriched) ||
      relations.some((r) => r.enriched),
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

function firstRow(result: unknown): Record<string, unknown> | undefined {
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] } | null)?.rows;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  return row && typeof row === 'object' ? (row as Record<string, unknown>) : undefined;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return String(value.getTime());
  return String(value);
}

function instant(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value.replace(' ', 'T'));
  return Number.isNaN(parsed) ? undefined : parsed;
}

function emptySnapshot(): CatalogSnapshot {
  return {
    version: 0,
    generatedAt: new Date().toISOString(),
    stats: { types: 0, properties: 0, relations: 0, enrichedTypes: 0 },
    types: [],
  };
}
