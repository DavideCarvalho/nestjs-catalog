import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogObjectTypeDef } from '@dudousxd/nestjs-catalog';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contractRow, contractType } from '../../../test/catalog-store-contract';
import { DuckDbWarehouseStore } from './duckdb-warehouse.store';

let root: string;
let store: DuckDbWarehouseStore;
const FIELDS = ['id', 'label', 'score', 'active', 'seenAt'];

/**
 * A type with one property spelled the way a real source spells it — the same fixture Task 7
 * added for `write`, reused here for `read`. `Asset Id` is not a SQL identifier, so it is
 * `read`'s `outputAlias`/`physicalColumn` round-trip that is under test: the SELECT list
 * aliases the physical column `Asset_Id` back to `Asset_Id` (its own `outputAlias`, since
 * `Asset Id` is unsafe), and `normaliseRow` must still hand the value back to the caller under
 * the property's own name, `Asset Id` — not under the cleaned spelling used on the wire.
 */
function sourceSpelledType(name: string): CatalogObjectTypeDef {
  return {
    name,
    displayName: name,
    pluralDisplayName: `${name}s`,
    description: 'Fixture for a property spelled the way a source spells it.',
    tableName: `obj_${name.toLowerCase()}`,
    group: 'Contract',
    primaryKey: ['id'],
    enriched: true,
    properties: [
      {
        name: 'id',
        displayName: 'id',
        type: 'string',
        columnName: 'id',
        nullable: false,
        primary: true,
        hidden: false,
        order: 0,
        enriched: false,
      },
      {
        name: 'Asset Id',
        displayName: 'Asset Id',
        type: 'string',
        columnName: 'Asset Id',
        nullable: true,
        primary: false,
        hidden: false,
        order: 1,
        enriched: false,
      },
    ],
    relations: [],
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'catalog-duckdb-read-'));
  store = new DuckDbWarehouseStore({ root });
});

afterAll(async () => {
  await store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('commit and read', () => {
  it('keeps a load invisible until it commits', async () => {
    // The single most load-bearing promise of the interface: a crash mid-load
    // must be distinguishable from a completed load that lost rows.
    const type = contractType('ReadHidden');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
    });
    expect((await store.read(type, FIELDS, {})).rows).toEqual([]);
    await store.commit(type, 'run-1');
    expect((await store.read(type, FIELDS, {})).rows).toHaveLength(1);
  });

  it('names the snapshot it is actually serving', async () => {
    const type = contractType('ReadServed');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
    });
    await store.commit(type, 'run-1');
    const result = await store.read(type, FIELDS, {});
    expect(result.snapshot).toEqual({ id: 'run-1', current: true });
    expect((await store.currentSnapshot(type))?.id).toBe('run-1');
  });

  it('returns only the fields it was given, whatever the object holds', async () => {
    // `fields` is the whitelist the caller vouched for. The reserved columns are
    // in every object and must not leak into an ordinary read.
    const type = contractType('ReadFields');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
    });
    await store.commit(type, 'run-1');
    const result = await store.read(type, ['id', 'label'], {});
    expect(Object.keys(result.rows[0] ?? {}).sort()).toEqual(['id', 'label']);
  });

  it('counts the whole snapshot, not the page', async () => {
    const type = contractType('ReadTotal');
    await store.ensureType(type);
    await store.write(
      type,
      [contractRow('a', 'A', 1), contractRow('b', 'B', 2), contractRow('c', 'C', 3)],
      { snapshotId: 'run-1', principalId: 'tester', batch: 1 },
    );
    await store.commit(type, 'run-1');
    const result = await store.read(type, FIELDS, { page: 1, size: 2 });
    expect(result.rows).toHaveLength(2);
    expect(result.total).toBe(3);
  });

  it('serves an older snapshot when asked for one', async () => {
    const type = contractType('ReadTravel');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'old', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
    });
    await store.commit(type, 'run-1');
    await store.write(type, [contractRow('a', 'new', 1)], {
      snapshotId: 'run-2',
      principalId: 'tester',
      batch: 1,
    });
    await store.commit(type, 'run-2');
    const older = await store.read(type, FIELDS, { snapshot: 'run-1' });
    expect(older.rows[0]?.label).toBe('old');
    expect(older.snapshot).toEqual({ id: 'run-1', current: false });
  });

  it('reads nothing for a type that has never committed', async () => {
    const type = contractType('ReadEmpty');
    await store.ensureType(type);
    const result = await store.read(type, FIELDS, {});
    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('moves the served snapshot backwards when an older one is committed after a newer one', async () => {
    // `commit` is last-writer-wins by design (see `SnapshotCatalog.setCurrent`'s docblock):
    // committing an older snapshot is how a rollback is expressed, and a guard that refused to
    // move the pointer backwards would make that impossible. Committing run-1 again after
    // run-2 must leave run-1 served, not silently keep run-2 because it is "newer".
    const type = contractType('ReadRollback');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'old', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
    });
    await store.commit(type, 'run-1');
    await store.write(type, [contractRow('a', 'new', 1)], {
      snapshotId: 'run-2',
      principalId: 'tester',
      batch: 1,
    });
    await store.commit(type, 'run-2');

    // Roll back: commit the older snapshot again, after the newer one already served.
    await store.commit(type, 'run-1');

    expect((await store.currentSnapshot(type))?.id).toBe('run-1');
    const result = await store.read(type, FIELDS, {});
    expect(result.rows[0]?.label).toBe('old');
    expect(result.snapshot).toEqual({ id: 'run-1', current: true });
  });

  it('returns a property spelled the way a source spells it under its own name, not the cleaned one', async () => {
    // The core package records why this matters: thirteen types were loaded through a path
    // that aliased a read to the cleaned column instead of the property's own name, and six
    // came back with most of their columns empty — 313,833 rows on the largest. `write` keys
    // staged rows by `physicalColumn(name)`; `read` selects that column aliased to
    // `outputAlias(name)`; `normaliseRow` looks the value up by `outputAlias(name)` and hands
    // it back under the property's own name. All three must agree, or `Asset Id` comes back
    // under `Asset_Id` — or not at all.
    const type = sourceSpelledType('ReadSpelled');
    await store.ensureType(type);
    await store.write(type, [{ id: 'a', 'Asset Id': 'A-71' }], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 0,
    });
    await store.commit(type, 'run-1');

    const result = await store.read(type, ['id', 'Asset Id'], {});
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.['Asset Id']).toBe('A-71');
    expect(Object.keys(result.rows[0] ?? {}).sort()).toEqual(['Asset Id', 'id']);
  });
});
