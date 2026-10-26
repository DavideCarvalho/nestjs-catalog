import 'reflect-metadata';
import type { CatalogObjectTypeDef, CatalogPropertyDef } from '@dudousxd/nestjs-catalog';
import type { EntityManager } from '@mikro-orm/sql';
import { describe, expect, it, vi } from 'vitest';
import { SnapshotRow } from './entities/governance';
import { ObjectTypeRow } from './entities/model';
import { MySqlWarehouseStore } from './warehouse.store';

/**
 * Where a page read's `total` comes from.
 *
 * An unfiltered page of a committed snapshot used to pay a `COUNT(*)` over the
 * whole snapshot on every request — a scan that grows with the dataset, for a
 * number the snapshot record already holds. These cases pin which reads still
 * count and which take the record's answer. Whether that answer stays equal to
 * the table is held against a real engine in `snapshot-row-count.db.spec.ts`.
 */

function property(name: string, order: number): CatalogPropertyDef {
  return {
    name,
    displayName: name,
    type: 'string',
    columnName: name,
    nullable: true,
    primary: false,
    hidden: false,
    order,
    enriched: true,
  };
}

const ASSET = property('Asset_Id', 0);

const TYPE: CatalogObjectTypeDef = {
  name: 'Mvr',
  displayName: 'Vehicle',
  pluralDisplayName: 'Vehicles',
  group: 'Fleet',
  tableName: 'obj_mvr',
  enriched: true,
  primaryKey: ['Asset_Id'],
  properties: [ASSET],
  relations: [],
};

interface Snapshot {
  snapshotId: string;
  committed: boolean;
  rowCount: number;
  droppedAt?: Date;
}

/** A store whose type points at `run-9`, holding the given snapshot records. */
function warehouse(snapshots: Snapshot[]) {
  const execute = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (/COUNT\(\*\)/i.test(sql)) return [{ total: 41 }];
    return [{ Asset_Id: 'A-71' }];
  });
  const findOne = vi.fn(async (entity: unknown, where: { id?: string; name?: string }) => {
    if (entity === ObjectTypeRow) return { name: TYPE.name, currentSnapshotId: 'run-9' };
    if (entity === SnapshotRow) {
      const found = snapshots.find((each) => `${TYPE.name}:${each.snapshotId}` === where.id);
      return found ? { id: where.id, typeName: TYPE.name, ...found } : null;
    }
    throw new Error('unexpected lookup');
  });
  const forked: EntityManager = Object.create(null);
  Object.assign(forked, { findOne, getConnection: () => ({ execute }) });
  const em: EntityManager = Object.create(null);
  Object.assign(em, { fork: () => forked, getConnection: () => ({ execute }) });

  return {
    store: new MySqlWarehouseStore(em),
    counts: () => execute.mock.calls.filter((call) => /COUNT\(\*\)/i.test(String(call[0]))).length,
    statements: () => execute.mock.calls.length + findOne.mock.calls.length,
  };
}

const CURRENT: Snapshot = { snapshotId: 'run-9', committed: true, rowCount: 7_600_000 };

describe('the total of an unfiltered read', () => {
  it('is the committed snapshot record, with no COUNT issued', async () => {
    const w = warehouse([CURRENT]);

    const result = await w.store.read(TYPE, ['Asset_Id'], { page: 3, size: 25 });

    expect(result.total).toBe(7_600_000);
    expect(w.counts()).toBe(0);
    // The type, the snapshot record, the page.
    expect(w.statements()).toBe(3);
  });

  it('is the record of an earlier committed snapshot the caller named', async () => {
    const w = warehouse([CURRENT, { snapshotId: 'run-4', committed: true, rowCount: 12 }]);

    const result = await w.store.read(TYPE, ['Asset_Id'], { snapshot: 'run-4' });

    expect(result.total).toBe(12);
    expect(w.counts()).toBe(0);
  });

  it('is counted for a snapshot that has not been committed, whose record is not maintained', async () => {
    const w = warehouse([CURRENT, { snapshotId: 'run-10', committed: false, rowCount: 0 }]);

    const result = await w.store.read(TYPE, ['Asset_Id'], { snapshot: 'run-10' });

    expect(result.total).toBe(41);
    expect(w.counts()).toBe(1);
  });

  it('is counted for a snapshot with no record at all', async () => {
    const w = warehouse([CURRENT]);

    const result = await w.store.read(TYPE, ['Asset_Id'], { snapshot: 'unknown' });

    expect(result.total).toBe(41);
    expect(w.counts()).toBe(1);
  });

  it('still refuses a dropped snapshot', async () => {
    const w = warehouse([
      CURRENT,
      { snapshotId: 'run-2', committed: true, rowCount: 5, droppedAt: new Date('2026-01-02') },
    ]);

    await expect(w.store.read(TYPE, ['Asset_Id'], { snapshot: 'run-2' })).rejects.toThrow(
      /dropped/,
    );
  });
});

describe('the total of a narrowed read', () => {
  it('is counted under a search', async () => {
    const w = warehouse([CURRENT]);

    const result = await w.store.read(TYPE, ['Asset_Id'], { search: 'A-7' });

    expect(result.total).toBe(41);
    expect(w.counts()).toBe(1);
  });

  it('is counted under a filter', async () => {
    const w = warehouse([CURRENT]);

    const result = await w.store.read(TYPE, ['Asset_Id'], {
      filters: [{ property: ASSET, op: 'eq', value: 'A-71' }],
    });

    expect(result.total).toBe(41);
    expect(w.counts()).toBe(1);
    // No snapshot record is fetched for a total it would not be used for.
    expect(w.statements()).toBe(3);
  });
});
