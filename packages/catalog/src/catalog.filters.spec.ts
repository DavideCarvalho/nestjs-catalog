import { describe, expect, it } from 'vitest';
import {
  CATALOG_FILTER_LIMIT,
  CATALOG_FILTER_OPERATORS,
  type CatalogFilterOperator,
  type CatalogObjectFilter,
  coerceFilterValue,
  filterOperatorsFor,
  objectFilterParam,
  objectQueryParams,
  offeredFilterOperators,
  resolveObjectFilters,
} from './catalog.filters';
import type { CatalogPropertyDef, ScalarType } from './catalog.types';

/**
 * The rule that decides what may be filtered, tested as a rule.
 *
 * It is the one thing in this feature that both sides run: the server refuses a
 * filter this says no to, and the console draws a control for every operator this
 * says yes to. A case here is therefore a case about both.
 */

function property(overrides: Partial<CatalogPropertyDef> = {}): CatalogPropertyDef {
  return {
    name: 'tailNumber',
    displayName: 'Tail number',
    type: 'string',
    columnName: 'tail_number',
    nullable: true,
    primary: false,
    hidden: false,
    order: 0,
    enriched: false,
    ...overrides,
  };
}

describe('what a column may be filtered with', () => {
  it('derives the operators from the column rather than from a list of columns', () => {
    // The whole point: nothing anywhere names a filterable column, so a property
    // published a minute ago is filterable a minute ago.
    expect(filterOperatorsFor(property({ name: 'anythingAtAll', type: 'number' }))).toContain(
      'gte',
    );
    expect(filterOperatorsFor(property({ name: 'somethingElse', type: 'string' }))).toContain(
      'contains',
    );
  });

  it('gives a number the range ends and a string the text ones', () => {
    const numeric = filterOperatorsFor(property({ type: 'number' }));
    expect(numeric).toEqual(expect.arrayContaining(['gte', 'lte', 'gt', 'lt', 'eq', 'ne']));
    expect(numeric).not.toContain('contains');

    const text = filterOperatorsFor(property({ type: 'string' }));
    expect(text).toEqual(expect.arrayContaining(['contains', 'eq', 'ne']));
    expect(text).not.toContain('gte');
  });

  it('offers a date the two range ends and refuses equality on it', () => {
    // A DATETIME compared to a typed day is midnight, so `= 4 March` misses
    // every row loaded at any other second of that day — and reads as "nothing
    // happened on the 4th".
    expect(filterOperatorsFor(property({ type: 'date' }))).toEqual([
      'gte',
      'lte',
      'empty',
      'notEmpty',
    ]);
  });

  it('refuses a classified column outright', () => {
    // Not because the value would be rendered — it is not — but because a range
    // filter lets a reader binary-search a value they may not see, in as many
    // requests as it takes. The same reason search already skips these columns.
    expect(filterOperatorsFor(property({ classification: 'CUI' }))).toEqual([]);
  });

  it('refuses a hidden column and a blob', () => {
    expect(filterOperatorsFor(property({ hidden: true }))).toEqual([]);
    expect(filterOperatorsFor(property({ type: 'json' }))).toEqual([]);
  });

  it('narrows what is offered to what the store can actually apply', () => {
    // A store that can only do equality must not have a range control drawn for
    // it, or the screen offers something the read will refuse.
    const limited: CatalogFilterOperator[] = ['eq'];
    expect(offeredFilterOperators(property({ type: 'number' }), limited)).toEqual(['eq']);
    expect(offeredFilterOperators(property({ type: 'number' }), [])).toEqual([]);
  });
});

describe('the wire form', () => {
  it('sends a value containing colons and commas verbatim', () => {
    // A timestamp has colons; the bracket form needs no escaping for either.
    expect(
      objectFilterParam({ property: 'loadedAt', op: 'gte', value: '2026-03-04T11:30:00Z' }),
    ).toEqual(['filter[loadedAt][gte]', '2026-03-04T11:30:00Z']);
  });

  it('still sends a value for the operators that take none', () => {
    // A transport that drops empty params would otherwise drop the filter.
    expect(objectFilterParam({ property: 'plate', op: 'empty' })).toEqual([
      'filter[plate][empty]',
      'true',
    ]);
  });

  it('builds the whole query, sort and paging included, as flat keys', () => {
    expect(
      objectQueryParams({
        page: 2,
        size: 50,
        search: 'van',
        sort: '-miles',
        snapshot: 'run-4',
        filters: [
          { property: 'miles', op: 'gte', value: '1000' },
          { property: 'miles', op: 'lte', value: '5000' },
        ],
      }),
    ).toEqual({
      page: 2,
      size: 50,
      search: 'van',
      sort: '-miles',
      snapshot: 'run-4',
      'filter[miles][gte]': '1000',
      'filter[miles][lte]': '5000',
    });
  });

  it('refuses two filters the wire cannot tell apart', () => {
    expect(() =>
      objectQueryParams({
        filters: [
          { property: 'plate', op: 'contains', value: 'a' },
          { property: 'plate', op: 'contains', value: 'b' },
        ],
      }),
    ).toThrow(/one per property and operator/);
  });
});

describe('resolving what arrived against the type', () => {
  const columns = [
    property({ name: 'Asset_Id', columnName: 'Asset Id' }),
    property({ name: 'miles', type: 'number' }),
    property({ name: 'secret', classification: 'CUI' }),
  ];

  it('matches a filter by the property name, not by how the source spells it', () => {
    // THE case this codebase keeps paying for: the property is `Asset_Id` and the
    // source column is `Asset Id`, and only one of the two is what a predicate is
    // built from.
    const byProperty = resolveObjectFilters(columns, [
      { property: 'Asset_Id', op: 'contains', value: '71' },
    ]);
    expect(byProperty.problems).toEqual([]);
    expect(byProperty.filters[0].property.name).toBe('Asset_Id');

    const bySourceColumn = resolveObjectFilters(columns, [
      { property: 'Asset Id', op: 'contains', value: '71' },
    ]);
    expect(bySourceColumn.filters).toEqual([]);
    expect(bySourceColumn.problems[0]).toContain('Asset Id');
  });

  it('hands the store the type’s own property rather than the caller’s string', () => {
    // What keeps a caller-supplied name out of SQL: the resolved filter carries
    // the definition, so a store has nothing else to build a column from.
    const { filters } = resolveObjectFilters(columns, [
      { property: 'miles', op: 'gte', value: '1000' },
    ]);
    expect(filters[0].property).toBe(columns[1]);
  });

  it('coerces the value to the property’s type', () => {
    const { filters } = resolveObjectFilters(columns, [
      { property: 'miles', op: 'gte', value: '1000' },
    ]);
    expect(filters[0].value).toBe(1000);
  });

  it('refuses a value that is not of the property’s type', () => {
    // MySQL would coerce `abc` to 0 and answer `miles >= 0` — a full page that
    // looks filtered. Nothing about that answer says it was not.
    const { filters, problems } = resolveObjectFilters(columns, [
      { property: 'miles', op: 'gte', value: 'abc' },
    ]);
    expect(filters).toEqual([]);
    expect(problems[0]).toContain('not a number');
  });

  it('refuses an operator the column does not offer', () => {
    const { problems } = resolveObjectFilters(columns, [
      { property: 'miles', op: 'contains', value: '10' },
    ]);
    expect(problems[0]).toContain('contains');
  });

  it('refuses a classified column by name', () => {
    const { filters, problems } = resolveObjectFilters(columns, [
      { property: 'secret', op: 'eq', value: 'x' },
    ]);
    expect(filters).toEqual([]);
    expect(problems[0]).toContain('secret');
  });

  it('reports every problem at once rather than the first', () => {
    const { problems } = resolveObjectFilters(columns, [
      { property: 'miles', op: 'gte', value: 'abc' },
      { property: 'nope', op: 'eq', value: '1' },
    ]);
    expect(problems).toHaveLength(2);
  });

  it('never returns a filter it could not honour', () => {
    // The load-bearing half. A dropped filter would come back as an unfiltered
    // page presented as the matching rows; every unhonourable entry has to end up
    // in `problems`, where the service turns it into a refusal.
    const { filters, problems } = resolveObjectFilters(columns, [
      { property: 'miles', op: 'gte', value: '1000' },
      { property: 'miles', op: 'lte', value: 'oops' },
    ]);
    expect(filters).toHaveLength(1);
    expect(problems).toHaveLength(1);
  });

  it('caps how many filters one read may carry', () => {
    const many = Array.from(
      { length: CATALOG_FILTER_LIMIT + 1 },
      (): CatalogObjectFilter => ({
        property: 'miles',
        op: 'gte',
        value: '1',
      }),
    );
    const { filters, problems } = resolveObjectFilters(columns, many);
    expect(filters).toEqual([]);
    expect(problems[0]).toContain(String(CATALOG_FILTER_LIMIT));
  });
});

describe('coercion', () => {
  const cases: Array<[ScalarType, string, unknown]> = [
    ['number', '12.5', 12.5],
    ['boolean', 'true', true],
    ['boolean', 'no', false],
    ['string', 'anything', 'anything'],
  ];

  for (const [type, input, expected] of cases) {
    it(`reads ${input} as a ${type}`, () => {
      const result = coerceFilterValue(type, input);
      expect(result.ok && result.value).toEqual(expected);
    });
  }

  it('refuses an empty number rather than reading it as zero', () => {
    expect(coerceFilterValue('number', '').ok).toBe(false);
    // `Number('')` is 0, so this is the case that would silently become
    // `miles >= 0` and match the whole table.
    expect(Number('')).toBe(0);
  });

  it('keeps every declared operator spellable', () => {
    // The list is the contract: a name added to it and to nothing else would be
    // parseable and unapplied.
    for (const operator of CATALOG_FILTER_OPERATORS) {
      expect(objectFilterParam({ property: 'col', op: operator, value: '1' })[0]).toBe(
        `filter[col][${operator}]`,
      );
    }
  });
});
