import { EntityManager } from '@mikro-orm/core';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CATALOG_FILTER_OPERATORS, type CatalogResolvedFilter } from '../catalog.filters';
import { MikroOrmCatalogRegistry } from '../catalog.registry';
import type {
  CatalogFilteringReadStore,
  CatalogReadQuery,
  CatalogReadResult,
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
export class MikroOrmReadStore implements CatalogFilteringReadStore {
  readonly capabilities: CatalogStoreCapabilities = {
    snapshots: 'none',
    writable: false,
    timeTravel: false,
  };

  /**
   * All of them: every operator maps onto a MikroORM query-builder operator, and
   * the ORM writes the column name from the entity metadata rather than from
   * anything a caller sent.
   */
  readonly objectFilterOperators = CATALOG_FILTER_OPERATORS;

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
    const [rows, total] = await em.findAndCount(entityClass, buildWhere(type, query), {
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
 * The search term and the column filters, ANDed.
 *
 * Search reaches only string columns the catalog says are visible: a search that
 * reached a classified column would leak it through row membership even though
 * the value is never rendered. `filterOperatorsFor` refuses a classified column
 * for the same reason and a sharper one — a range filter lets a reader
 * binary-search a value they may not see.
 *
 * The filters are ANDed with each other and with the search, which is what makes
 * a filter narrowing: two conditions on one column express a range, and a caller
 * that wanted alternatives has `contains` or a second request.
 */
function buildWhere(type: CatalogObjectTypeDef, query: CatalogReadQuery) {
  const conditions: Array<Record<string, unknown>> = [];

  const term = query.search?.trim();
  if (term) {
    const searchable = type.properties.filter(
      (p) => !p.hidden && p.type === 'string' && !p.classification,
    );
    if (searchable.length > 0) {
      conditions.push({ $or: searchable.map((p) => ({ [p.name]: { $like: `%${term}%` } })) });
    }
  }

  for (const filter of query.filters ?? []) {
    conditions.push({ [filter.property.name]: comparison(filter) });
  }

  if (conditions.length === 0) return {};
  if (conditions.length === 1) return conditions[0];
  return { $and: conditions };
}

/**
 * One operator as MikroORM spells it.
 *
 * The property name is the ORM's own — it came off the type, which was built
 * from the entity metadata — so the column in the emitted SQL is written by the
 * ORM from that metadata and never by string concatenation here. That is the same
 * guarantee the sort above relies on.
 */
function comparison(filter: CatalogResolvedFilter): Record<string, unknown> {
  const value = filter.value;
  switch (filter.op) {
    case 'eq':
      return { $eq: value };
    case 'ne':
      // `!=` in SQL is never true of NULL, so a row whose column is empty would
      // drop out of "is not X" — which reads as those rows having the value.
      return { $or: [{ $ne: value }, { $eq: null }] };
    case 'contains':
      return { $like: `%${String(value)}%` };
    case 'gt':
      return { $gt: value };
    case 'gte':
      return { $gte: value };
    case 'lt':
      return { $lt: value };
    case 'lte':
      return { $lte: value };
    case 'empty':
      // A blank string is empty to a reader, and only a text column can hold
      // one. Both spellings, so "no value" means what it says on either.
      return { $or: [{ $eq: null }, { $eq: '' }] };
    case 'notEmpty':
      return { $and: [{ $ne: null }, { $ne: '' }] };
    default:
      // No operator falls through to a silent `{}`, which would be a filter
      // that matches everything. An operator added to the contract and not to
      // this switch fails to compile here rather than at read time.
      return unknownOperator(filter.op);
  }
}

function unknownOperator(operator: never): never {
  throw new BadRequestException(`This store cannot filter with ${String(operator)}.`);
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
