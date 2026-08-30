import { CATALOG_FILTER_OPERATORS } from '@dudousxd/nestjs-catalog';
import type { CatalogPropertyDef, CatalogResolvedFilter } from '@dudousxd/nestjs-catalog';
import { describe, expect, it } from 'vitest';
import { predicateFor } from './filters';

function property(name: string, type: CatalogPropertyDef['type']): CatalogPropertyDef {
  return {
    name,
    displayName: name,
    type,
    columnName: name,
    nullable: true,
    primary: false,
    hidden: false,
    order: 0,
    enriched: false,
  };
}

function filter(op: CatalogResolvedFilter['op'], value?: string | number): CatalogResolvedFilter {
  return { property: property('label', 'string'), op, ...(value === undefined ? {} : { value }) };
}

function filterOn(
  prop: CatalogPropertyDef,
  op: CatalogResolvedFilter['op'],
  value?: string | number,
): CatalogResolvedFilter {
  return { property: prop, op, ...(value === undefined ? {} : { value }) };
}

describe('predicateFor', () => {
  it('answers every operator the core package declares', () => {
    // An unanswered operator that falls through to a default is a filter the
    // store ignores, and a read that ignores a filter returns more rows than
    // were asked for with nothing to distinguish it from a filter that matched
    // everything.
    for (const op of CATALOG_FILTER_OPERATORS) {
      expect(() => predicateFor(filter(op, 'x'))).not.toThrow();
    }
  });

  it('uses ILIKE for contains, so case-insensitivity matches the row store', () => {
    expect(predicateFor(filter('contains', 'ab'))).toContain('ILIKE');
  });

  it('escapes a wildcard in a contains value rather than honouring it', () => {
    // A caller typing `100%` is asking for the literal, not for a prefix match.
    expect(predicateFor(filter('contains', '100%'))).toContain('100\\%');
  });

  it('treats ne as matching NULLs, because a null is not the value', () => {
    const rendered = predicateFor(filter('ne', 'x'));
    expect(rendered).toContain('IS NULL');
  });

  it('renders the valueless operators without a value', () => {
    expect(predicateFor(filter('empty'))).toMatch(/IS NULL/);
    expect(predicateFor(filter('notEmpty'))).toMatch(/IS NOT NULL/);
  });

  it('treats an empty string as no value on a uuid column too, not only string', () => {
    // `filterOperatorsFor` in the core package offers `empty`/`notEmpty` to `uuid` and
    // `unknown` columns on the same branch as `string` — gating the empty-string half of
    // this operator on `type === 'string'` alone answered those two with the NULL-only rule
    // and nothing about `''`, which is a declared operator not fully applied on exactly the
    // columns `coerce` (in `column-types.ts`) writes `''` through verbatim for.
    const tag = property('tag', 'uuid');
    expect(predicateFor(filterOn(tag, 'empty'))).toContain(`= ''`);
    expect(predicateFor(filterOn(tag, 'notEmpty'))).toContain(`<> ''`);
  });

  it('does not compare a number, boolean or date column against an empty string', () => {
    // The three types that cannot hold `''` at all — comparing a `DOUBLE`/`BOOLEAN`/
    // `TIMESTAMP WITH TIME ZONE` column against the empty string is not "no rows", it is a
    // type error DuckDB has no obligation to accept gracefully.
    expect(predicateFor(filterOn(property('score', 'number'), 'empty'))).not.toContain(`''`);
    expect(predicateFor(filterOn(property('active', 'boolean'), 'notEmpty'))).not.toContain(`''`);
    expect(predicateFor(filterOn(property('seenAt', 'date'), 'empty'))).not.toContain(`''`);
  });

  it('refuses a non-finite filter value rather than rendering it as a column reference', () => {
    // `String(NaN)` is the text `NaN`, which DuckDB parses as an unquoted identifier rather
    // than a numeric literal — `"score" > NaN` fails with "Referenced column NaN not found",
    // pointing at the wrong thing. Guarded the same way `resolvedPaging` guards `size`/`page`
    // in `duckdb-warehouse.store.ts`.
    expect(() => predicateFor(filter('gt', Number.NaN))).toThrow(/finite number/);
  });
});
