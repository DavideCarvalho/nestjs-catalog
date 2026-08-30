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

describe('COMMITTED_LABEL stays internal', () => {
  it('does not appear on a plain full load that never asked for a label', async () => {
    // PROMOTED MINOR 2: `_committed` is now set on every `commit`, unconditionally. Before
    // that, `labels` was present on a SnapshotRef only when a caller supplied some -- an
    // ordinary full load, one that never touches `carryForward` and never asked for a label
    // at all, must still report none.
    const type = await load('CommittedLabelHidden', 'run-1', 'A');

    const committed = await store.commit(type, 'run-1');
    expect(committed.labels).toBeUndefined();

    const found = await store.findSnapshot(type, 'run-1');
    expect(found?.labels).toBeUndefined();

    const current = await store.currentSnapshot(type);
    expect(current?.labels).toBeUndefined();

    const listed = await store.listSnapshots(type);
    expect(listed.find((each) => each.id === 'run-1')?.labels).toBeUndefined();
  });

  it('does not appear beside labels a caller actually supplied', async () => {
    // Written through `carryForward`, which persists caller-supplied labels onto a fresh
    // SnapshotRef. `write` does too, on a load's first batch -- see `persists options.labels
    // for a plain full load` in duckdb-warehouse.write.spec.ts, which covers that path; this
    // case is here for the incremental one, so both routes to a caller's own labels are pinned
    // against `_committed` leaking in beside them.
    const type = contractType('CommittedLabelHiddenAmongReal');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 0,
    });
    await store.carryForward(type, 'run-1', {
      principalId: 'tester',
      labels: { source: 'nightly-sync' },
    });
    const committed = await store.commit(type, 'run-1');
    expect(committed.labels?.source).toBe('nightly-sync');
    expect(committed.labels?._committed).toBeUndefined();
  });

  it('is also stripped from listSnapshotsWithRows, which is a public method, not an internal helper', async () => {
    // Corrected from an earlier round: `listSnapshotsWithRows` is declared on the core
    // `CatalogWriteStore` interface, re-exported through the fan-out, and consumed by the
    // pipeline's eviction sweep -- not a method `carryForward` merely happens to share. Leaving
    // it unstripped meant the SAME snapshot reported `labels: undefined` from `findSnapshot`
    // and `{ _committed: 'true' }` from this method, an inconsistency no caller could explain.
    // `carryForward`'s own fallback resolution now reads `this.snapshots.listLive` directly
    // (the raw catalog this method wraps) instead of calling this public method, so stripping
    // here does not touch that path -- see `excludes an uncommitted record from the fallback
    // merge source` and `names the true origin, not itself` in duckdb-warehouse.stream.spec.ts
    // for proof the fallback still works end to end.
    const type = await load('CommittedLabelPublicListAlsoStripped', 'run-1', 'A');
    const live = await store.listSnapshotsWithRows(type);
    expect(live[0]?.labels?._committed).toBeUndefined();
  });
});

describe('the row count on an uncommitted snapshot', () => {
  it('reports the rows actually staged, never the placeholder the record was created with', async () => {
    // `write` creates the snapshot record before `commit` ever runs, with `rowCount: 0` as a
    // placeholder it has no way to maintain across later batches. Every method here hands that
    // record to code outside this class, and the pipeline's own row-count bound
    // (`assertRowCountIsPlausible`, which runs BEFORE `store.commit`) reads `rowCount` off the
    // pending snapshot: a stored 0 is indistinguishable from a load that collapsed, and its
    // `pending === 0` branch refuses unconditionally -- no bound, no `minRows` floor. Every
    // full-mode connector load onto a type already serving rows would be refused at commit,
    // with a sentence saying the snapshot holds no rows while its rows sit staged on disk.
    const type = contractType('PendingRowCount');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 0,
    });
    await store.commit(type, 'run-1');

    await store.write(type, [contractRow('a', 'A', 1), contractRow('b', 'B', 2)], {
      snapshotId: 'run-2',
      principalId: 'tester',
      batch: 0,
      labels: { source: 'connector' },
    });

    expect((await store.findSnapshot(type, 'run-2'))?.rowCount).toBe(2);
    expect((await store.listSnapshots(type)).find((each) => each.id === 'run-2')?.rowCount).toBe(2);
    expect(
      (await store.listSnapshotsWithRows(type)).find((each) => each.id === 'run-2')?.rowCount,
    ).toBe(2);
  });

  it('freezes the count a tombstone actually held, not the placeholder', async () => {
    // `dropSnapshot` took `existing?.rowCount` verbatim, which is the same unmaintained
    // placeholder -- so dropping a load that was written but never committed wrote a permanent
    // record claiming it held nothing, and the rows are gone by then, so nothing can correct it.
    const type = contractType('PendingDropCount');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'served',
      principalId: 'tester',
      batch: 0,
    });
    await store.commit(type, 'served');

    await store.write(type, [contractRow('a', 'A', 1), contractRow('b', 'B', 2)], {
      snapshotId: 'abandoned',
      principalId: 'tester',
      batch: 0,
      labels: { source: 'connector' },
    });
    await store.dropSnapshot(type, 'abandoned');
    expect((await store.findSnapshot(type, 'abandoned'))?.rowCount).toBe(2);
  });
});

describe('createdAt', () => {
  it('is anchored on the first write of the load, whether or not labels were supplied', async () => {
    // `createdAt` is what `listLive`/`list` sort on, so it is what "newest" means to
    // `carryForward`'s fallback merge source. Two otherwise identical loads must not be
    // anchored differently: the record used to be created by `write` only when a caller
    // supplied labels, and by `commit` otherwise -- so supplying a label moved a load's
    // `createdAt` from commit time back to first-write time, and two loads overlapping in
    // time could swap places in that ordering purely on whether their caller passed labels.
    const type = contractType('CreatedAtAnchor');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'labelled',
      principalId: 'tester',
      batch: 0,
      labels: { source: 'connector' },
    });
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'plain',
      principalId: 'tester',
      batch: 0,
    });
    const afterBothWrites = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await store.commit(type, 'labelled');
    await store.commit(type, 'plain');

    const labelled = await store.findSnapshot(type, 'labelled');
    const plain = await store.findSnapshot(type, 'plain');
    expect(labelled?.createdAt.localeCompare(afterBothWrites)).toBeLessThan(0);
    expect(plain?.createdAt.localeCompare(afterBothWrites)).toBeLessThan(0);
  });
});
