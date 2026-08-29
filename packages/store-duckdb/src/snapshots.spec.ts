import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SnapshotRef } from '@dudousxd/nestjs-catalog';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { snapshotRecordKey } from './identifiers';
import { type ObjectStore, localObjectStore } from './object-store';
import { type SnapshotCatalog, objectSnapshotCatalog } from './snapshots';

let root: string;
let objects: ObjectStore;
let catalog: SnapshotCatalog;

function ref(id: string, createdAt: string, overrides: Partial<SnapshotRef> = {}): SnapshotRef {
  return { id, createdAt, rowCount: 3, principalId: 'tester', ...overrides };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'catalog-duckdb-snap-'));
  objects = localObjectStore(root);
  catalog = objectSnapshotCatalog(objects);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('objectSnapshotCatalog', () => {
  it('round-trips a whole record rather than merging fields', async () => {
    await catalog.put('mvr', ref('run-1', '2026-01-01T00:00:00.000Z', { labels: { a: 'b' } }));
    const found = await catalog.find('mvr', 'run-1');
    expect(found).toEqual(ref('run-1', '2026-01-01T00:00:00.000Z', { labels: { a: 'b' } }));
  });

  it('finds a snapshot by id whatever its age, tombstone included', async () => {
    // A scan of the newest N turns "older than N loads" into "no such snapshot",
    // and those two sentences send a reader to different places.
    await catalog.put(
      'age',
      ref('old', '2020-01-01T00:00:00.000Z', { droppedAt: '2026-01-01T00:00:00.000Z' }),
    );
    for (let index = 0; index < 20; index += 1) {
      await catalog.put(
        'age',
        ref(`new-${index}`, `2026-02-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`),
      );
    }
    const found = await catalog.find('age', 'old');
    expect(found?.droppedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('lists newest first', async () => {
    await catalog.put('ord', ref('a', '2026-01-01T00:00:00.000Z'));
    await catalog.put('ord', ref('b', '2026-03-01T00:00:00.000Z'));
    await catalog.put('ord', ref('c', '2026-02-01T00:00:00.000Z'));
    expect((await catalog.list('ord')).map((each) => each.id)).toEqual(['b', 'c', 'a']);
  });

  it('breaks a tie on createdAt using id, descending, rather than list order', async () => {
    await catalog.put('tie', ref('b', '2026-04-01T00:00:00.000Z'));
    await catalog.put('tie', ref('a', '2026-04-01T00:00:00.000Z'));
    expect((await catalog.list('tie')).map((each) => each.id)).toEqual(['b', 'a']);
  });

  it('has limit bound what list returns', async () => {
    await catalog.put('cap', ref('x', '2026-01-01T00:00:00.000Z'));
    await catalog.put('cap', ref('y', '2026-01-02T00:00:00.000Z'));
    await catalog.put('cap', ref('z', '2026-01-03T00:00:00.000Z'));
    expect((await catalog.list('cap', 2)).map((each) => each.id)).toEqual(['z', 'y']);
  });

  it('applies the live predicate before the raw-read bound, not after', async () => {
    // objectSnapshotCatalog reads every record and sorts before ever slicing,
    // so a raw cap smaller than the type's whole history must not be able to
    // hide a live record that sits below it once tombstones are filtered out.
    // A filter-after-bound `listLive` would take the newest `cap` records off
    // the *unfiltered* sort, discard the tombstones among them, and never see
    // the live one sitting just past the cap at all.
    await catalog.put('deephist', ref('live-old', '2026-01-01T00:00:00.000Z'));
    await catalog.put(
      'deephist',
      ref('tomb-1', '2026-01-02T00:00:00.000Z', { droppedAt: '2026-01-03T00:00:00.000Z' }),
    );
    await catalog.put(
      'deephist',
      ref('tomb-2', '2026-01-03T00:00:00.000Z', { droppedAt: '2026-01-04T00:00:00.000Z' }),
    );
    await catalog.put('deephist', ref('live-new', '2026-01-04T00:00:00.000Z'));
    // Newest-first: live-new, tomb-2, tomb-1, live-old. A raw cap of 2 taken
    // before filtering keeps only [live-new, tomb-2] and loses live-old.
    const live = await catalog.listLive('deephist', 2);
    expect(live.map((each) => each.id)).toEqual(['live-new', 'live-old']);
  });

  it('has no current snapshot until one is set', async () => {
    expect(await catalog.current('fresh')).toBeUndefined();
    await catalog.setCurrent('fresh', 'run-9');
    expect(await catalog.current('fresh')).toBe('run-9');
  });

  it('names the key when a record under _snapshots/ is corrupt', async () => {
    const key = snapshotRecordKey('broken', 'bad-1');
    await objects.put(key, '{not valid json');
    await expect(catalog.list('broken')).rejects.toThrow(key);
  });

  it('refuses a blob missing principalId as a SnapshotRef', async () => {
    await objects.put(
      snapshotRecordKey('partial', 'no-principal'),
      JSON.stringify({ id: 'no-principal', createdAt: '2026-01-01T00:00:00.000Z', rowCount: 1 }),
    );
    expect(await catalog.find('partial', 'no-principal')).toBeUndefined();
  });
});
