import 'reflect-metadata';
import type {
  CatalogObjectTypeDef,
  CatalogPropertyDef,
  CatalogResolvedFilter,
} from '@dudousxd/nestjs-catalog';
import type { EntityManager } from '@mikro-orm/mysql';
import { describe, expect, it, vi } from 'vitest';
import { MySqlWarehouseStore } from './mysql-warehouse.store';

/**
 * What a filtered read and a historical read actually issue.
 *
 * A fake connection is enough here because every claim is about which statements
 * are ISSUED and what is bound into them — the same reason `query.read-only.spec`
 * uses one. Two of those claims are worth stating plainly:
 *
 * - A filter's column comes from the type and goes through `ident`, which refuses
 *   anything outside a narrow character set rather than escaping it. Nothing a
 *   caller sent is concatenated.
 * - Reading an old snapshot is a predicate on the physical table. It must not
 *   touch the SQL view: the view is what the query console selects from, so
 *   repointing it to read history would quietly answer every ad-hoc query in the
 *   deployment about last Tuesday too.
 */

function property(overrides: Partial<CatalogPropertyDef> = {}): CatalogPropertyDef {
  return {
    name: 'Asset_Id',
    displayName: 'Asset',
    type: 'string',
    columnName: 'Asset Id',
    nullable: true,
    primary: false,
    hidden: false,
    order: 0,
    enriched: true,
    ...overrides,
  };
}

const MILES = property({ name: 'miles', type: 'number', columnName: 'miles' });
const ASSET = property();

const TYPE: CatalogObjectTypeDef = {
  name: 'Mvr',
  displayName: 'Vehicle',
  pluralDisplayName: 'Vehicles',
  group: 'Fleet',
  tableName: 'obj_mvr',
  enriched: true,
  primaryKey: ['Asset_Id'],
  properties: [ASSET, MILES],
  relations: [],
};

/**
 * An EntityManager that records every statement and the values bound to it.
 *
 * `null` rather than `undefined` for "nothing committed": a default parameter
 * would swallow an explicitly passed `undefined` and the case would silently test
 * the happy path instead.
 */
function warehouse(currentSnapshotId: string | null = 'run-9') {
  const execute = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (/COUNT\(\*\)/i.test(sql)) return [{ total: 1 }];
    return [{ Asset_Id: 'A-71', miles: 1200 }];
  });
  const forked: EntityManager = Object.create(null);
  Object.assign(forked, {
    findOne: async () => ({ name: TYPE.name, currentSnapshotId: currentSnapshotId ?? undefined }),
    getConnection: () => ({ execute }),
  });
  const em: EntityManager = Object.create(null);
  Object.assign(em, { fork: () => forked, getConnection: () => ({ execute }) });

  return {
    store: new MySqlWarehouseStore(em),
    statements: () => execute.mock.calls.map((call) => String(call[0])),
    /** The page SELECT — the one carrying the ORDER BY and the LIMIT — and its values. */
    page: () => {
      const call = execute.mock.calls.find((each) => /LIMIT/i.test(String(each[0])));
      return { sql: String(call?.[0] ?? ''), params: call?.[1] ?? [] };
    },
  };
}

const filter = (
  property_: CatalogPropertyDef,
  op: CatalogResolvedFilter['op'],
  value?: CatalogResolvedFilter['value'],
): CatalogResolvedFilter =>
  value === undefined ? { property: property_, op } : { property: property_, op, value };

describe('filtering a read', () => {
  it('builds the predicate from the physical column and binds the value', async () => {
    const w = warehouse();

    await w.store.read(TYPE, ['Asset_Id', 'miles'], {
      filters: [filter(ASSET, 'contains', 'A-7')],
    });

    const { sql, params } = w.page();
    // The property's name — `Asset_Id` — is the column. The source spelling,
    // `Asset Id`, is not a column and would not survive `ident` if it were used.
    expect(sql).toContain('`Asset_Id` LIKE ?');
    expect(sql).not.toContain('Asset Id');
    // The value is bound, including the wildcards. Nothing a caller typed is in
    // the statement text.
    expect(params).toContain('%A-7%');
    expect(sql).not.toContain('A-7');
  });

  it('refuses a property whose name is not a usable identifier', async () => {
    // The guard is the catalog's own `ident`, not a second one written here: a
    // name outside `[A-Za-z_][A-Za-z0-9_]*` is refused rather than quoted, so a
    // property that somehow arrives carrying one cannot become SQL. The property
    // is on the type and in the field list, so nothing earlier catches it.
    const hostile = property({ name: '1; DROP TABLE obj_mvr' });
    const type: CatalogObjectTypeDef = { ...TYPE, properties: [hostile] };
    const w = warehouse();

    await expect(
      w.store.read(type, [hostile.name], { filters: [filter(hostile, 'eq', 'x')] }),
    ).rejects.toThrow(/Refusing to use/);
  });

  it('refuses to filter on a column the read is not returning', async () => {
    // Defence in depth against a caller that builds the query itself: a
    // predicate over a column the same request declined to return is how a
    // hidden or classified value leaks out through row membership.
    const w = warehouse();

    await expect(
      w.store.read(TYPE, ['Asset_Id'], { filters: [filter(MILES, 'gte', 1000)] }),
    ).rejects.toThrow(/not among the columns this read returns/);
  });

  it('ANDs a range into one statement rather than reading twice', async () => {
    const w = warehouse();

    await w.store.read(TYPE, ['Asset_Id', 'miles'], {
      filters: [filter(MILES, 'gte', 1000), filter(MILES, 'lte', 5000)],
    });

    const { sql, params } = w.page();
    expect(sql).toContain('`miles` >= ?');
    expect(sql).toContain('`miles` <= ?');
    expect(params).toEqual(expect.arrayContaining([1000, 5000]));
    // Two statements for the whole read — a COUNT and a page — however many
    // filters there are. A filter must not cost a query.
    expect(w.statements()).toHaveLength(2);
  });

  it('counts and pages through the same predicate', async () => {
    // A total that ignored the filter would say "1 of 40,000" under eleven rows,
    // and the pager would offer pages that come back empty.
    const w = warehouse();

    await w.store.read(TYPE, ['Asset_Id', 'miles'], {
      filters: [filter(MILES, 'gte', 1000)],
    });

    for (const sql of w.statements()) {
      expect(sql).toContain('`miles` >= ?');
    }
  });

  it('keeps rows with no value out of an "is not" and out of "has a value"', async () => {
    const w = warehouse();

    await w.store.read(TYPE, ['Asset_Id'], { filters: [filter(ASSET, 'ne', 'A-71')] });
    // `<>` is never true of NULL, so without the second half every row with no
    // asset id would drop out of "is not A-71" — which reads as those rows
    // being A-71.
    expect(w.page().sql).toContain('(`Asset_Id` <> ? OR `Asset_Id` IS NULL)');

    const empty = warehouse();
    await empty.store.read(TYPE, ['Asset_Id'], { filters: [filter(ASSET, 'empty')] });
    expect(empty.page().sql).toContain("(`Asset_Id` IS NULL OR `Asset_Id` = '')");
  });
});

describe('reading as of an earlier load', () => {
  it('filters the physical table and never touches the served view', async () => {
    const w = warehouse('run-9');

    const result = await w.store.read(TYPE, ['Asset_Id'], { snapshot: 'run-4' });

    const { sql, params } = w.page();
    expect(sql).toContain('`_snapshot_id` = ?');
    expect(params[0]).toBe('run-4');
    // THE case. `CREATE OR REPLACE VIEW` is how the view moves on commit; doing
    // it to read history would repoint every ad-hoc query in the deployment.
    for (const statement of w.statements()) {
      expect(statement).not.toMatch(/CREATE\s+OR\s+REPLACE\s+VIEW/i);
      expect(statement).not.toMatch(/DROP\s+VIEW/i);
    }
    // And the rows say which load they are, so a screen can warn without
    // trusting its own state.
    expect(result.snapshot).toEqual({ id: 'run-4', current: false });
  });

  it('costs exactly what a current read costs', async () => {
    // History is a value of the same column, so an old load is the same two
    // statements — no union, no replay, no second table.
    const historical = warehouse('run-9');
    await historical.store.read(TYPE, ['Asset_Id'], { snapshot: 'run-4' });

    const current = warehouse('run-9');
    await current.store.read(TYPE, ['Asset_Id'], {});

    expect(historical.statements()).toHaveLength(current.statements().length);
  });

  it('reports the served snapshot as current when nothing was asked for', async () => {
    const w = warehouse('run-9');

    const result = await w.store.read(TYPE, ['Asset_Id'], {});

    expect(result.snapshot).toEqual({ id: 'run-9', current: true });
  });

  it('reports current when the load asked for happens to be the served one', async () => {
    // Somebody who picks today's load off the list is not reading history, and a
    // banner shown here would be one people learn to ignore.
    const w = warehouse('run-9');

    const result = await w.store.read(TYPE, ['Asset_Id'], { snapshot: 'run-9' });

    expect(result.snapshot).toEqual({ id: 'run-9', current: true });
  });

  it('says nothing at all when the type has never committed', async () => {
    const w = warehouse(null);

    const result = await w.store.read(TYPE, ['Asset_Id'], {});

    expect(result).toEqual({ rows: [], total: 0 });
    expect(w.statements()).toHaveLength(0);
  });
});
