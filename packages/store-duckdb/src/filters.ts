import type { CatalogResolvedFilter, ScalarType } from '@dudousxd/nestjs-catalog';
import { physicalColumn } from '@dudousxd/nestjs-catalog';
import { BadRequestException } from '@nestjs/common';
import { quoteLiteral } from './duckdb';
import { ident } from './identifiers';

/**
 * A resolved filter value, rendered as a SQL literal.
 *
 * `number` is guarded the same way `resolvedPaging` guards `size`/`page` in
 * `duckdb-warehouse.store.ts`, and for the same reason: `String(NaN)` is the text `NaN`,
 * which is not a numeric literal — it is an unquoted identifier, so `"score" > NaN` asks
 * DuckDB for a column named `NaN` and fails with "Referenced column NaN not found" instead
 * of naming the actual problem, which is the value this filter was built from. The core
 * service's own `coerceFilterValue` already rejects a non-numeric string before a
 * `CatalogResolvedFilter` exists, so this is unreachable through the documented path — it is
 * here for the same reason `resolvedPaging`'s checks are: a caller who builds
 * `CatalogResolvedFilter` by hand, bypassing the service, gets a named refusal rather than a
 * raw engine error that points at the wrong thing. `BadRequestException`, like every other
 * refusal this adapter raises over a caller's value and like both shipped siblings: the same
 * bad filter must not be a 400 with a sentence on one store and a 500 with the message
 * swallowed on this one, behind a fan-out, from the same console screen.
 */
function literal(value: string | number | boolean | Date | undefined): string {
  if (value === undefined) return 'NULL';
  if (value instanceof Date) return quoteLiteral(value.toISOString());
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new BadRequestException(`filter value must be a finite number, got ${value}.`);
    }
    return String(value);
  }
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
 * Whether `empty`/`notEmpty` should also treat an empty string as "no value" on this column's
 * type, alongside NULL.
 *
 * The negative form — every type except the three that cannot hold `''` — rather than a
 * positive list of the text-shaped ones, because `filterOperatorsFor` in the core package
 * (`catalog.filters.ts`) offers `empty`/`notEmpty` to four scalar types, not one:
 * `string`, `uuid`, `unknown` (its `default` branch) and `date`/`number`/`boolean` each on
 * their own branch. A predicate gated on `type === 'string'` alone answered `uuid` and
 * `unknown` — both stored as `VARCHAR` here, per `duckDbType` — with the NULL-only half of
 * the rule, silently narrower than the operator `filterOperatorsFor` had already promised the
 * caller.
 *
 * This is not a theoretical gap in this adapter specifically: `coerce` in `column-types.ts`
 * writes an empty string through **verbatim** for every non-number/boolean/date type
 * (`typeof value === 'string' ? value : String(value)`, with no `''`-to-`null` step) —
 * unlike the ClickHouse sibling, which nulls it on the way in. So a `uuid`/`unknown` column
 * holding `''` is a real, reachable row on this store: gating on `'string'` alone meant
 * `empty` missed it (rendering `IS NULL` only, so a row with no value at all did not count as
 * empty) and `notEmpty` wrongly included it (rendering `IS NOT NULL` only, so a row with no
 * value at all counted as having one) — a declared operator answering both directions
 * incorrectly on exactly the columns most likely to hold blanks arriving as `''` rather than
 * as a missing field.
 */
function emptyable(type: ScalarType): boolean {
  return type !== 'number' && type !== 'boolean' && type !== 'date';
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
      return `(${column} IS NULL${emptyable(filter.property.type) ? ` OR ${column} = ''` : ''})`;
    case 'notEmpty':
      return `(${column} IS NOT NULL${emptyable(filter.property.type) ? ` AND ${column} <> ''` : ''})`;
    default: {
      const unreachable: never = filter.op;
      throw new Error(`unhandled filter operator: ${String(unreachable)}`);
    }
  }
}
