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
});
