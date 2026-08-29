import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contractRow, contractType } from '../../../test/catalog-store-contract';
import { DuckDbWarehouseStore } from './duckdb-warehouse.store';

let root: string;
let store: DuckDbWarehouseStore;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'catalog-duckdb-snapshots-'));
  store = new DuckDbWarehouseStore({ root });
});

afterAll(async () => {
  await store.close();
  rmSync(root, { recursive: true, force: true });
});

async function load(typeName: string, snapshotId: string, label: string) {
  const type = contractType(typeName);
  await store.ensureType(type);
  await store.write(type, [contractRow('a', label, 1)], {
    snapshotId,
    principalId: 'tester',
    batch: 1,
  });
  await store.commit(type, snapshotId);
  return type;
}

describe('dropSnapshot', () => {
  it('refuses to drop the snapshot it is serving', async () => {
    // The invariant that keeps ordinary reads free of the tombstone question:
    // the snapshot a type serves can never be one.
    const type = await load('DropServed', 'run-1', 'A');
    await expect(store.dropSnapshot(type, 'run-1')).rejects.toThrow(/serving|current/i);
  });

  it('keeps the record with the size it held and the date it went', async () => {
    const type = await load('DropKeeps', 'run-1', 'A');
    await load('DropKeeps', 'run-2', 'B');
    await store.dropSnapshot(type, 'run-1');
    const found = await store.findSnapshot(type, 'run-1');
    expect(found?.rowCount).toBe(1);
    expect(found?.droppedAt).toBeDefined();
  });

  it('is idempotent and does not rewrite the date', async () => {
    const type = await load('DropTwice', 'run-1', 'A');
    await load('DropTwice', 'run-2', 'B');
    await store.dropSnapshot(type, 'run-1');
    const first = await store.findSnapshot(type, 'run-1');
    await store.dropSnapshot(type, 'run-1');
    expect((await store.findSnapshot(type, 'run-1'))?.droppedAt).toBe(first?.droppedAt);
  });

  it('refuses to read a dropped snapshot rather than answering with no rows', async () => {
    const type = await load('DropRead', 'run-1', 'A');
    await load('DropRead', 'run-2', 'B');
    await store.dropSnapshot(type, 'run-1');
    await expect(store.read(type, ['id'], { snapshot: 'run-1' })).rejects.toThrow(/dropped/i);
  });
});

describe('listSnapshotsWithRows', () => {
  it('bounds by the live snapshots, not by the records', async () => {
    // A bound applied before a predicate answers a different question from one
    // applied after it: filtering a bounded list gives the live snapshots OF
    // THAT WINDOW, and past N tombstones it gives none at all.
    const type = contractType('ListLive');
    await store.ensureType(type);
    for (const id of ['load-1', 'load-2', 'load-3', 'load-4', 'load-5']) {
      await store.write(type, [contractRow('a', id, 1)], {
        snapshotId: id,
        principalId: 'tester',
        batch: 1,
      });
      await store.commit(type, id);
    }
    await store.dropSnapshot(type, 'load-3');
    await store.dropSnapshot(type, 'load-4');
    const live = await store.listSnapshotsWithRows(type, 3);
    expect(live.map((each) => each.id)).toEqual(['load-5', 'load-2', 'load-1']);
  });
});
