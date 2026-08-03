import { EntityManager } from '@mikro-orm/core';
import { Injectable, NotFoundException } from '@nestjs/common';
import { MikroOrmCatalogRegistry } from '../catalog.registry';
import type {
  CatalogReadQuery,
  CatalogReadResult,
  CatalogReadStore,
  CatalogStoreCapabilities,
} from '../catalog.store';
import type { CatalogObjectTypeDef } from '../catalog.types';

/**
 * Reads objects straight out of the application's own tables, through the ORM
 * that already maps them.
 *
 * The default store, and the one that needs no infrastructure: there is no copy
 * to keep in sync and no load to schedule, so the catalog is never stale. The
 * trade is that there is also no history — the tables hold current state, and
 * nothing here can show you last Tuesday.
 */
@Injectable()
export class MikroOrmReadStore implements CatalogReadStore {
  readonly capabilities: CatalogStoreCapabilities = {
    snapshots: 'none',
    writable: false,
    timeTravel: false,
  };

  constructor(
    private readonly registry: MikroOrmCatalogRegistry,
    private readonly em: EntityManager,
  ) {}

  async read(
    type: CatalogObjectTypeDef,
    fields: string[],
    query: CatalogReadQuery,
  ): Promise<CatalogReadResult> {
    const em = this.em.fork();
    // The constructor, not the name: `EntityName` dropped `string` in MikroORM
    // 7. The registry only holds classes for types that survived the include /
    // exclude filter, so an excluded entity cannot be reached by guessing.
    const entityClass = this.registry.getEntityClass(type.name);
    if (!entityClass) {
      throw new NotFoundException(`Unknown object type: ${type.name}`);
    }

    const size = query.size ?? 25;
    const page = query.page ?? 1;

    // No explicit type arguments: `findAndCount` declares `Fields extends string
    // = never`, so naming even one generic makes the rest fall back to their
    // defaults and types `fields` as `never[]`. Inference gets it right.
    const [rows, total] = await em.findAndCount(entityClass, buildWhere(type, query.search), {
      limit: size,
      offset: (page - 1) * size,
      orderBy: buildOrderBy(type, query.sort, query.dir),
      fields,
    });

    return {
      total,
      rows: rows.map((row) => serialize(row, fields)),
    };
  }
}

/**
 * Only string columns the catalog says are visible.
 *
 * A search that reached a classified column would leak it through row
 * membership even though the value is never rendered.
 */
function buildWhere(type: CatalogObjectTypeDef, search?: string) {
  const term = search?.trim();
  if (!term) return {};

  const searchable = type.properties.filter(
    (p) => !p.hidden && p.type === 'string' && !p.classification,
  );
  if (searchable.length === 0) return {};

  return { $or: searchable.map((p) => ({ [p.name]: { $like: `%${term}%` } })) };
}

/** Only ever a column the catalog vouched for; falls back to the key. */
function buildOrderBy(
  type: CatalogObjectTypeDef,
  sort?: string,
  dir?: 'asc' | 'desc',
): Record<string, 'asc' | 'desc'> {
  const direction: 'asc' | 'desc' = dir === 'desc' ? 'desc' : 'asc';
  const known = sort ? type.properties.find((p) => p.name === sort && !p.hidden) : undefined;
  if (known) return { [known.name]: direction };
  const [pk] = type.primaryKey;
  return pk ? { [pk]: direction } : {};
}

/**
 * Make one column value safe for `JSON.stringify`.
 *
 * BigInt is the case that matters: `JSON.stringify` throws outright on it, so a
 * single `bigint` column anywhere in a table turns the whole generic read into
 * a 500. It becomes a string rather than a number on purpose — a value is only
 * stored as BigInt when it might exceed `Number.MAX_SAFE_INTEGER`, and silently
 * rounding it would be worse than the type change.
 */
function toJsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  return value;
}

/** Whitelist by field, so a column the catalog hides can never be returned. */
function serialize(row: unknown, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!row || typeof row !== 'object') return out;
  for (const field of fields) {
    out[field] = toJsonValue(Reflect.get(row, field));
  }
  return out;
}
