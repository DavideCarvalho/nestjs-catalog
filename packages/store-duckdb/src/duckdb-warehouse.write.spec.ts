import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCatalogStoreCapabilities, isWriteStore } from '@dudousxd/nestjs-catalog';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contractRow, contractType } from '../../../test/catalog-store-contract';
import { DuckDbWarehouseStore } from './duckdb-warehouse.store';
import { localObjectStore } from './object-store';

let root: string;
let store: DuckDbWarehouseStore;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'catalog-duckdb-write-'));
  store = new DuckDbWarehouseStore({ root });
});

afterAll(async () => {
  await store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('DuckDbWarehouseStore capabilities', () => {
  it('satisfies the core package predicate and is writable', () => {
    expect(isCatalogStoreCapabilities(store.capabilities)).toBe(true);
    expect(isWriteStore(store)).toBe(true);
  });

  it('reports emulated snapshots, because DuckDB keeps no history of its own', () => {
    expect(store.capabilities.snapshots).toBe('emulated');
    expect(store.capabilities.timeTravel).toBe(true);
  });

  it('states nothing about atomicity it has not measured', () => {
    // `undefined` is a third answer with a meaning: not stated. Task 12 measures
    // these and replaces this assertion with the measured values.
    expect(store.capabilities.atomicCutover).toBeUndefined();
  });
});

describe('write', () => {
  it('writes one object per batch at a deterministic key', async () => {
    const type = contractType('WriteOne');
    await store.ensureType(type);
    const result = await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
    });
    expect(result.written).toBe(1);
    expect(await localObjectStore(root).list('writeone/run-1')).toEqual([
      'writeone/run-1/part-000001.parquet',
    ]);
  });

  it('replaces a re-sent batch instead of appending it', async () => {
    // A durable step that retries restarts from the top and re-sends every
    // batch. An append-only write silently doubles the load, and the only
    // symptom is a row count that looks plausible.
    const type = contractType('WriteRetry');
    await store.ensureType(type);
    const options = { snapshotId: 'run-1', principalId: 'tester', batch: 1 };
    await store.write(type, [contractRow('a', 'A', 1), contractRow('b', 'B', 2)], options);
    await store.write(type, [contractRow('a', 'A', 1), contractRow('b', 'B', 2)], options);
    expect(await localObjectStore(root).list('writeretry/run-1')).toHaveLength(1);
    expect(await store.countStaged(type, 'run-1')).toBe(2);
  });

  it('reports rows accepted by this call, never rows in the snapshot', async () => {
    // A caller sums `written` across batches, and a fan-out compares the number
    // its primary reported against its follower's. Returning the running total
    // makes the sum grow quadratically and the comparison a false mismatch.
    const type = contractType('WriteCount');
    await store.ensureType(type);
    const first = await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
    });
    const second = await store.write(type, [contractRow('b', 'B', 2)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 2,
    });
    expect(first.written).toBe(1);
    expect(second.written).toBe(1);
  });

  it('refuses a negative batch rather than writing a key that cannot be replaced', async () => {
    const type = contractType('WriteBad');
    await store.ensureType(type);
    await expect(
      store.write(type, [contractRow('a', 'A', 1)], {
        snapshotId: 'run-1',
        principalId: 'tester',
        batch: -1,
      }),
    ).rejects.toThrow(/batch/i);
  });

  it('writes a zero-row batch as a readable, schema-carrying object', async () => {
    // The pipeline sends exactly one empty batch for a full load of zero rows,
    // so that a snapshot record exists carrying its labels even though there is
    // nothing to page through. `write` must not treat "no rows" as an error, and
    // the object it produces must be one `countStaged` and a later `read` can
    // open without special-casing an empty file.
    const type = contractType('WriteEmpty');
    await store.ensureType(type);
    const result = await store.write(type, [], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
    });
    expect(result.written).toBe(0);
    expect(await localObjectStore(root).list('writeempty/run-1')).toEqual([
      'writeempty/run-1/part-000001.parquet',
    ]);
    expect(await store.countStaged(type, 'run-1')).toBe(0);
  });

  it('defaults an unnumbered batch to 0, matching the sibling adapters', async () => {
    // A divergent default would land the same logical batch under a different key
    // in this store than in a MikroORM or ClickHouse primary sitting behind the
    // same fan-out, which reads back as a false mismatch between them. It also
    // matters on its own: a caller that writes once with no `batch` and then
    // again with an explicit `batch: 1` means two batches, not one overwrite.
    const type = contractType('WriteDefaultBatch');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
    });
    expect(await localObjectStore(root).list('writedefaultbatch/run-1')).toEqual([
      'writedefaultbatch/run-1/part-000000.parquet',
    ]);

    // A batch-less write and an explicit `batch: 0` write hit the same key: the
    // second replaces the first, and the snapshot still holds one row.
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 0,
    });
    expect(await localObjectStore(root).list('writedefaultbatch/run-1')).toEqual([
      'writedefaultbatch/run-1/part-000000.parquet',
    ]);
    expect(await store.countStaged(type, 'run-1')).toBe(1);

    // A batch-less write and an explicit `batch: 1` write are two different
    // batches: both objects exist, and both rows are staged.
    await store.write(type, [contractRow('b', 'B', 2)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
    });
    expect(await localObjectStore(root).list('writedefaultbatch/run-1')).toEqual([
      'writedefaultbatch/run-1/part-000000.parquet',
      'writedefaultbatch/run-1/part-000001.parquet',
    ]);
    expect(await store.countStaged(type, 'run-1')).toBe(2);
  });
});
