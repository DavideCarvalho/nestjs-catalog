import { describe, expect, it } from 'vitest';
import type { CatalogPrincipal } from './catalog.principal';
import type { CatalogObjectTypeDef, CatalogPropertyDef } from './catalog.types';
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  bestMatch,
  maySearch,
  searchCatalog,
  visibleToPrincipal,
} from './search';

/**
 * The half of search that has no request in it.
 *
 * Two things are being pinned, and they fail differently.
 *
 * **The ranking**, because its only virtue is that a reader can predict it. A
 * scoring function nobody can predict is worse than an obvious one, so the
 * obvious one has to be held in place: an exact name beats a prefix beats a
 * substring beats a word buried in a description, and ties break the same way
 * on every machine and every run. A change here is allowed — it is just a
 * judgement — but it should be a change somebody made on purpose.
 *
 * **The access filter**, which fails silently and expensively. A search that
 * answers with the NAME of a type the caller may not read has disclosed the
 * thing they were excluded from without returning a single row, and there is no
 * error, no status code and no log line to notice it by. Those tests are the
 * ones that must not be decorative, so they assert on what came back rather than
 * on the filter having been called.
 */

function property(overrides: Partial<CatalogPropertyDef> = {}): CatalogPropertyDef {
  return {
    name: 'id',
    displayName: 'Identifier',
    type: 'string',
    columnName: 'id',
    nullable: false,
    primary: true,
    hidden: false,
    order: 0,
    enriched: false,
    ...overrides,
  };
}

function objectType(overrides: Partial<CatalogObjectTypeDef> = {}): CatalogObjectTypeDef {
  return {
    name: 'Mvr',
    displayName: 'Vehicle',
    pluralDisplayName: 'Vehicles',
    tableName: 'mvr',
    group: 'Fleet',
    primaryKey: ['id'],
    enriched: true,
    properties: [property()],
    relations: [],
    ...overrides,
  };
}

function principal(overrides: Partial<CatalogPrincipal> = {}): CatalogPrincipal {
  return { id: 'console', scopes: ['catalog:read'], ...overrides };
}

function search(term: string, overrides: Partial<Parameters<typeof searchCatalog>[0]> = {}) {
  return searchCatalog({
    term,
    types: [],
    savedQueries: [],
    dashboards: [],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------

describe('bestMatch', () => {
  it('ranks an identifying field four ways, strongest first', () => {
    const field = (value: string) => [{ field: 'name' as const, value, identifying: true }];

    expect(bestMatch('status', field('status'))?.rank).toBe('exact');
    expect(bestMatch('status', field('statusCode'))?.rank).toBe('prefix');
    expect(bestMatch('status', field('lastStatusCode'))?.rank).toBe('name');
    expect(bestMatch('status', field('nothing like it'))).toBeUndefined();
  });

  it('gives a describing field one rank and no gradations', () => {
    // The claim on `CatalogSearchRank`: a description that happens to open with
    // your word is not a better answer than one that mentions it in the middle.
    // If this ever splits into prefix/contains, the ranking has four tiers on
    // one axis and eight on the other, and nobody can predict it any more.
    const describing = (value: string) => [
      { field: 'description' as const, value, identifying: false },
    ];

    expect(bestMatch('status', describing('status of the vehicle'))?.rank).toBe('text');
    expect(bestMatch('status', describing('the vehicle status'))?.rank).toBe('text');
  });

  it('never lets a describing field outrank an identifying one', () => {
    // The whole ranking in one assertion. `text` is the floor and `name` is
    // above it, so a type whose DESCRIPTION says "vehicle" cannot come back
    // ahead of one whose name contains it.
    const match = bestMatch('vehicle', [
      { field: 'description', value: 'the vehicle register', identifying: false },
      { field: 'name', value: 'FleetVehicleRow', identifying: true },
    ]);

    expect(match).toEqual({ rank: 'name', field: 'name' });
  });

  it('breaks an equal-strength tie in favour of the field declared first', () => {
    // Which is why every call site lists `name` before `displayName`: the code
    // name is the stable identity and the string a URL carries.
    expect(
      bestMatch('status', [
        { field: 'name', value: 'status', identifying: true },
        { field: 'displayName', value: 'Status', identifying: true },
      ]),
    ).toEqual({ rank: 'exact', field: 'name' });
  });

  it('ignores a field that is absent or blank rather than matching it', () => {
    // An empty description must not be a wildcard. `''.includes(term)` is false
    // so this is safe by accident today; asserted so it stays safe on purpose.
    expect(
      bestMatch('x', [
        { field: 'description', value: undefined, identifying: false },
        { field: 'unit', value: '   ', identifying: false },
      ]),
    ).toBeUndefined();
  });
});

describe('searchCatalog: what comes back', () => {
  it('finds a type by its code name, its display name and its plural', () => {
    const types = [objectType()];

    expect(search('mvr', { types }).hits[0]).toMatchObject({ kind: 'objectType', id: 'Mvr' });
    expect(search('vehicle', { types }).hits[0]).toMatchObject({ rank: 'exact' });
    // The plural is reported as `displayName`, not as a fifth field name nobody
    // wants to render.
    expect(search('vehicles', { types }).hits[0]).toMatchObject({
      rank: 'exact',
      field: 'displayName',
    });
  });

  it('finds a property, and says which type it belongs to', () => {
    const types = [
      objectType({ properties: [property({ name: 'tailNumber', displayName: 'Tail number' })] }),
    ];

    // `typeName` is what makes a property row navigable at all — without it a
    // hit called "Tail number" is a name with nowhere to go.
    expect(search('tail', { types }).hits).toEqual([
      {
        kind: 'property',
        id: 'tailNumber',
        label: 'Tail number',
        typeName: 'Mvr',
        detail: 'string',
        rank: 'prefix',
        field: 'name',
      },
    ]);
  });

  it('carries the unit into a property row, and matches on it', () => {
    const types = [
      objectType({
        properties: [
          property({ name: 'range', displayName: 'Range', type: 'number', unit: 'miles' }),
        ],
      }),
    ];

    expect(search('miles', { types }).hits[0]).toMatchObject({
      detail: 'number · miles',
      rank: 'text',
      field: 'unit',
    });
  });

  it('sets typeName on a type as well as on its properties', () => {
    // So a client writes `hit.typeName && explorerHref(hit.typeName)` once
    // rather than a branch per kind.
    expect(search('mvr', { types: [objectType()] }).hits[0]?.typeName).toBe('Mvr');
  });

  it('finds saved queries and dashboards, and never carries their SQL', () => {
    const result = search('sales', {
      savedQueries: [{ id: 'q-1', name: 'Sales by region', folder: 'Finance' }],
      dashboards: [{ id: 'd-1', name: 'Sales operations' }],
    });

    expect(result.hits.map((hit) => `${hit.kind}:${hit.id}`)).toEqual([
      'savedQuery:q-1',
      'dashboard:d-1',
    ]);
    // `SearchableSavedQuery` does not have a `sql` field at all, so this is a
    // structural guarantee rather than a filter — pinned anyway, because the
    // cheap "fix" for a future 'find the query that touches mvr' request is to
    // widen that interface, and this is where that should be argued.
    expect(JSON.stringify(result)).not.toContain('select');
  });

  it('matches a saved query by its folder, ranked as the grouping it is', () => {
    const result = search('finance', {
      savedQueries: [{ id: 'q-1', name: 'Sales by region', folder: 'Finance' }],
    });

    expect(result.hits[0]).toMatchObject({ rank: 'text', field: 'group', detail: 'Finance' });
  });

  it('is case-insensitive and ignores surrounding whitespace in the term', () => {
    expect(search('  VEHICLE  ', { types: [objectType()] }).hits).toHaveLength(1);
  });

  it('echoes the term back, normalised', () => {
    // So a debounced screen can tell a stale answer from a current one.
    expect(search('  VEHICLE  ', { types: [objectType()] }).term).toBe('vehicle');
  });

  it('answers an empty term with nothing, rather than with everything or an error', () => {
    // A search screen mounts empty. Returning the whole catalog would make the
    // first paint the most expensive one; throwing would put a red panel where
    // a prompt belongs.
    const result = search('   ', { types: [objectType()] });

    expect(result).toEqual({ term: '', total: 0, truncated: false, hits: [] });
  });
});

describe('searchCatalog: the order', () => {
  it('puts an exact match ahead of a prefix ahead of a substring ahead of a description', () => {
    const types = [
      objectType({ name: 'AuditLog', displayName: 'Audit log', group: 'Governance' }),
      objectType({ name: 'Audit', displayName: 'Audit', group: 'Governance' }),
      objectType({ name: 'ChangeAudit', displayName: 'Change audit', group: 'Governance' }),
      objectType({
        name: 'Snapshot',
        displayName: 'Snapshot',
        description: 'Written on every audit.',
        group: 'Governance',
      }),
    ].map((type) => ({ ...type, properties: [] }));

    expect(search('audit', { types }).hits.map((hit) => `${hit.id}:${hit.rank}`)).toEqual([
      'Audit:exact',
      'AuditLog:prefix',
      'ChangeAudit:name',
      'Snapshot:text',
    ]);
  });

  it('ranks before it groups, so an exact property beats a merely-mentioned type', () => {
    // The one place the kind order must NOT win. A type whose description
    // happens to contain the word is not a better answer than the property
    // actually called it.
    const types = [
      objectType({
        name: 'Mvr',
        displayName: 'Vehicle',
        description: 'Holds the odometer for each vehicle.',
        properties: [property({ name: 'odometer', displayName: 'Odometer' })],
      }),
    ];

    expect(search('odometer', { types }).hits.map((hit) => hit.kind)).toEqual([
      'property',
      'objectType',
    ]);
  });

  it('breaks an equal rank by kind: type, property, saved query, dashboard', () => {
    const types = [
      objectType({
        name: 'Sales',
        displayName: 'Sales',
        properties: [property({ name: 'sales', displayName: 'Sales' })],
      }),
    ];

    expect(
      search('sales', {
        types,
        savedQueries: [{ id: 'q-1', name: 'Sales' }],
        dashboards: [{ id: 'd-1', name: 'Sales' }],
      }).hits.map((hit) => hit.kind),
    ).toEqual(['objectType', 'property', 'savedQuery', 'dashboard']);
  });

  it('breaks a remaining tie by label, so the same term always gives the same order', () => {
    // Not decoration: under a debounced input, a top-of-list that reorders
    // between two identical answers is a row that moves out from under a
    // pointer. Leaving this to sort stability would tie the order to whatever
    // order the registry happens to enumerate types in.
    //
    // The ids are chosen so that sorting by id gives a DIFFERENT order from
    // sorting by label. An earlier version of this fixture numbered them in
    // label order, which meant deleting the label comparison entirely left this
    // test green — the `id` tie-break below it happened to produce the same
    // three rows. A tie-break test whose fixture makes two tie-breaks agree is
    // not testing either of them.
    const dashboards = [
      { id: 'd-1', name: 'Ops zulu' },
      { id: 'd-2', name: 'Ops alpha' },
      { id: 'd-3', name: 'Ops mike' },
    ];

    expect(search('ops', { dashboards }).hits.map((hit) => hit.label)).toEqual([
      'Ops alpha',
      'Ops mike',
      'Ops zulu',
    ]);
  });
});

describe('searchCatalog: the cap', () => {
  const many = Array.from({ length: MAX_SEARCH_LIMIT + 20 }, (_, index) => ({
    id: `d-${String(index).padStart(4, '0')}`,
    name: `Ops ${String(index).padStart(4, '0')}`,
  }));

  it('caps at the default and says how many there really were', () => {
    const result = search('ops', { dashboards: many });

    expect(result.hits).toHaveLength(DEFAULT_SEARCH_LIMIT);
    // `total` is what lets a screen say "50 of 220" rather than implying the
    // list it drew is the list.
    expect(result.total).toBe(many.length);
    expect(result.truncated).toBe(true);
  });

  it('honours a smaller limit and refuses a larger one', () => {
    expect(search('ops', { dashboards: many, limit: 5 }).hits).toHaveLength(5);
    // A caller asking for ten thousand rows gets the ceiling, not the ten
    // thousand: the whole point of a bounded route is that the bound is not the
    // caller's to choose.
    expect(search('ops', { dashboards: many, limit: 10_000 }).hits).toHaveLength(MAX_SEARCH_LIMIT);
  });

  it('does not report truncation when everything fit', () => {
    const result = search('ops', { dashboards: many.slice(0, 3) });

    expect(result).toMatchObject({ total: 3, truncated: false });
    expect(result.hits).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Access. The tests that must not be decorative.
// ---------------------------------------------------------------------------

describe('visibleToPrincipal', () => {
  const payroll = objectType({
    name: 'PayrollAdjustment',
    displayName: 'Payroll adjustment',
    properties: [property({ name: 'amount', displayName: 'Amount', classification: 'CUI' })],
  });

  it('drops a type this principal may not read, and its properties with it', () => {
    const visible = visibleToPrincipal(principal({ readTypes: ['Mvr'] }), [objectType(), payroll]);

    expect(visible.map((type) => type.name)).toEqual(['Mvr']);
  });

  it('drops a classified property from a type the principal may otherwise read', () => {
    const visible = visibleToPrincipal(principal({ classifications: [] }), [payroll]);

    expect(visible[0]?.properties).toEqual([]);
  });

  it('keeps a classified property when the principal holds the classification', () => {
    const visible = visibleToPrincipal(principal({ classifications: ['CUI'] }), [payroll]);

    expect(visible[0]?.properties.map((p) => p.name)).toEqual(['amount']);
  });

  it('keeps hidden properties, because hidden is a display flag and not a secret', () => {
    // Excluding them would make search the one place a curator cannot find the
    // property they just hid in order to un-hide it.
    const withHidden = objectType({
      properties: [property({ name: 'legacyCode', displayName: 'Legacy code', hidden: true })],
    });

    expect(visibleToPrincipal(principal(), [withHidden])[0]?.properties).toHaveLength(1);
  });

  it('filters nothing when no principal was resolved', () => {
    // Not a fail-open: in a deployment with no guard, `GET /catalog` already
    // hands over the whole snapshot. Search must never be SOFTER than the routes
    // that exist, and being exactly as soft is what this can honestly promise.
    expect(visibleToPrincipal(undefined, [objectType(), payroll])).toHaveLength(2);
  });

  it('returns the registry own object, uncopied, when nothing was dropped', () => {
    // A copy per type per keystroke, for a snapshot that is already in memory,
    // is the difference between a search box and a garbage-collection problem.
    const type = objectType();

    expect(visibleToPrincipal(principal(), [type])[0]).toBe(type);
  });

  it('does not mutate the types it was given', () => {
    const type = objectType({
      properties: [property({ name: 'amount', classification: 'CUI' }), property()],
    });

    visibleToPrincipal(principal({ classifications: [] }), [type]);

    // The registry hands out its live snapshot. Filtering in place would redact
    // the catalog itself for every subsequent caller — including the ones that
    // hold the classification.
    expect(type.properties).toHaveLength(2);
  });
});

describe('maySearch', () => {
  it('refuses a resolved principal that does not hold catalog:read', () => {
    // The guard should already have. Asked anyway, because without it a
    // principal with no read scope gets no types — `mayRead` checks the scope —
    // and every saved query and dashboard name, which have no per-object grant
    // to check.
    expect(maySearch(principal({ scopes: ['catalog:embed'] }))).toBe(false);
  });

  it('admits one that does, and an admin who implies it', () => {
    expect(maySearch(principal({ scopes: ['catalog:read'] }))).toBe(true);
    expect(maySearch(principal({ scopes: ['catalog:admin'] }))).toBe(true);
  });

  it('admits an unresolved caller, for the same reason the filter passes them', () => {
    expect(maySearch(undefined)).toBe(true);
  });
});

describe('searchCatalog: totals are counted after the filter', () => {
  it('does not report how many hits the caller was not allowed to see', () => {
    // The subtle half of the disclosure. Filtering the rows and then reporting
    // "220 matches" tells a caller exactly how many things they cannot see, and
    // does it in a field nobody reads as sensitive.
    const types = [
      objectType({ name: 'Mvr', properties: [] }),
      objectType({ name: 'MvrSecret', displayName: 'Mvr secret', properties: [] }),
    ];
    const visible = visibleToPrincipal(principal({ readTypes: ['Mvr'] }), types);

    expect(search('mvr', { types: visible })).toMatchObject({ total: 1, truncated: false });
  });
});
