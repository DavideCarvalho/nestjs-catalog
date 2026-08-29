import type { CatalogResolvedFilter } from '@dudousxd/nestjs-catalog';
import { physicalColumn } from '@dudousxd/nestjs-catalog';
import { quoteLiteral } from './duckdb';
import { ident } from './identifiers';

function literal(value: string | number | boolean | Date | undefined): string {
  if (value === undefined) return 'NULL';
  if (value instanceof Date) return quoteLiteral(value.toISOString());
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return quoteLiteral(value);
}

/**
 * A `LIKE` pattern that matches the caller's text and nothing cleverer.
 *
 * `%` and `_` are wildcards, and a caller typing `100%` means the literal. Backslash is
 * escaped first, or escaping the wildcards would introduce the very character being used to
 * escape them.
 */
function containsPattern(value: string): string {
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
  return `%${escaped}%`;
}

/**
 * One resolved filter as a SQL predicate.
 *
 * The column comes off `filter.property`, which is the *type's* definition rather than the
 * request — that is why the interface hands a `CatalogResolvedFilter` here and never the
 * caller's raw `property:operator:value` string.
 *
 * The switch is exhaustive against the core package's operator list, with a `never` default,
 * so an operator added upstream is a compile error here rather than a filter this store
 * quietly stops applying.
 */
export function predicateFor(filter: CatalogResolvedFilter): string {
  const column = ident(physicalColumn(filter.property.name));
  switch (filter.op) {
    case 'eq':
      return `${column} = ${literal(filter.value)}`;
    case 'ne':
      // A row whose value is NULL is not the value being excluded, and SQL's `<>` answers
      // NULL rather than TRUE for it — so it would be dropped from a result that asked for
      // everything except one thing.
      return `(${column} IS NULL OR ${column} <> ${literal(filter.value)})`;
    case 'contains':
      return `${column} ILIKE ${quoteLiteral(containsPattern(String(filter.value ?? '')))} ESCAPE '\\'`;
    case 'gt':
      return `${column} > ${literal(filter.value)}`;
    case 'gte':
      return `${column} >= ${literal(filter.value)}`;
    case 'lt':
      return `${column} < ${literal(filter.value)}`;
    case 'lte':
      return `${column} <= ${literal(filter.value)}`;
    case 'empty':
      return `(${column} IS NULL${filter.property.type === 'string' ? ` OR ${column} = ''` : ''})`;
    case 'notEmpty':
      return `(${column} IS NOT NULL${filter.property.type === 'string' ? ` AND ${column} <> ''` : ''})`;
    default: {
      const unreachable: never = filter.op;
      throw new Error(`unhandled filter operator: ${String(unreachable)}`);
    }
  }
}
