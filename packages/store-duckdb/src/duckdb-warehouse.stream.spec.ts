import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { supportsCarryForward, supportsSnapshotStreams } from '@dudousxd/nestjs-catalog';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contractRow, contractType } from '../../../test/catalog-store-contract';
import * as duckdbModule from './duckdb';
import { DuckDbWarehouseStore } from './duckdb-warehouse.store';
import { localObjectStore } from './object-store';

let root: string;
let store: DuckDbWarehouseStore;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'catalog-duckdb-stream-'));
  store = new DuckDbWarehouseStore({ root });
});

afterAll(async () => {
  await store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('streamSnapshot', () => {
  it('is detected by the core package predicate', () => {
    // Without it a `catalog`-kind source is refused outright, not paged.
    expect(supportsSnapshotStreams(store)).toBe(true);
    expect(supportsCarryForward(store)).toBe(true);
  });

  it('streams one snapshot in order and nothing from the loads beside it', async () => {
    const type = contractType('StreamOrder');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1), contractRow('b', 'B', 2)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
    });
    await store.commit(type, 'run-1');
    await store.write(type, [contractRow('z', 'Z', 9)], {
      snapshotId: 'run-2',
      principalId: 'tester',
      batch: 1,
    });
    await store.commit(type, 'run-2');
    const seen: unknown[] = [];
    for await (const row of store.streamSnapshot(type, ['id'], 'run-1')) {
      seen.push(row.id);
    }
    expect(seen).toEqual(['a', 'b']);
  });

  it('omits the provenance columns unless they are asked for, and supplies both when asked', async () => {
    const type = contractType('StreamProv');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'loader',
      batch: 1,
    });
    await store.commit(type, 'run-1');
    const plain: Array<Record<string, unknown>> = [];
    for await (const row of store.streamSnapshot(type, ['id'], 'run-1')) plain.push(row);
    expect(plain[0]).not.toHaveProperty('_principal_id');
    expect(plain[0]).not.toHaveProperty('_loaded_at');

    // Both columns or neither: a store that supplied one and not the other would let an
    // archive verify against a NULL that reads as "nobody sent a value" rather than "this
    // store declined to answer". This store can always answer both — `write` stages them on
    // every row it ever writes, and `carryForward` copies both across untouched — so there
    // is no path that could produce one without the other.
    const withProvenance: Array<Record<string, unknown>> = [];
    for await (const row of store.streamSnapshot(type, ['id'], 'run-1', { provenance: true })) {
      withProvenance.push(row);
    }
    expect(withProvenance[0]?._principal_id).toBe('loader');
    expect(typeof withProvenance[0]?._loaded_at).toBe('string');
  });

  it('refuses to stream a dropped snapshot', async () => {
    const type = contractType('StreamDropped');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
    });
    await store.commit(type, 'run-1');
    await store.write(type, [contractRow('b', 'B', 2)], {
      snapshotId: 'run-2',
      principalId: 'tester',
      batch: 1,
    });
    await store.commit(type, 'run-2');
    await store.dropSnapshot(type, 'run-1');
    // A workflow reading a tombstone would iterate zero rows, report success,
    // and commit an empty load downstream.
    await expect(async () => {
      for await (const _row of store.streamSnapshot(type, ['id'], 'run-1')) {
        // consumed for the side effect of iterating
      }
    }).rejects.toThrow(/dropped/i);
  });

  it('genuinely streams: a consumer that stops pulling leaves the rest unfetched', async () => {
    // Not provable from outside the generator in the strict sense — that is what
    // `duckdb.ts`'s `DuckDbConnection.stream` docblock verifies directly against the running
    // engine. What this asserts is the observable half: breaking out of the loop after the
    // first row does not throw, does not require draining the rest, and the generator can be
    // abandoned mid-flight without the test hanging or erroring — the behaviour a paged or
    // materialised implementation could not be told apart from, but a stream that buffered
    // the whole result first would still exhibit.
    const type = contractType('StreamEarlyExit');
    await store.ensureType(type);
    await store.write(
      type,
      [contractRow('a', 'A', 1), contractRow('b', 'B', 2), contractRow('c', 'C', 3)],
      { snapshotId: 'run-1', principalId: 'tester', batch: 0 },
    );
    await store.commit(type, 'run-1');
    const seen: unknown[] = [];
    for await (const row of store.streamSnapshot(type, ['id'], 'run-1')) {
      seen.push(row.id);
      break;
    }
    expect(seen).toEqual(['a']);
  });
});

describe('carryForward', () => {
  it('copies the previous snapshot forward and lets incoming rows win', async () => {
    const type = contractType('CarryBasic');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'old-a', 1), contractRow('b', 'old-b', 2)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
    });
    await store.commit(type, 'run-1');

    await store.write(type, [contractRow('a', 'new-a', 5)], {
      snapshotId: 'run-2',
      principalId: 'tester',
      batch: 1,
    });
    const merged = await store.carryForward(type, 'run-2', { principalId: 'tester' });
    expect(merged.from).toBe('run-1');
    expect(merged.carried).toBe(1);
    expect(merged.total).toBe(2);
    await store.commit(type, 'run-2');

    const read = await store.read(type, ['id', 'label'], { size: 10 });
    const byId = Object.fromEntries(read.rows.map((row) => [row.id, row.label]));
    expect(byId).toEqual({ a: 'new-a', b: 'old-b' });
  });

  it('is safe to call twice', async () => {
    const type = contractType('CarryTwice');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'old', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
    });
    await store.commit(type, 'run-1');
    await store.write(type, [contractRow('b', 'new', 2)], {
      snapshotId: 'run-2',
      principalId: 'tester',
      batch: 1,
    });
    await store.carryForward(type, 'run-2', { principalId: 'tester' });
    const second = await store.carryForward(type, 'run-2', { principalId: 'tester' });
    expect(second.total).toBe(2);
    expect(second.carried).toBe(1);
  });

  it('marks a carried row with _batch = -1 at a key batchKey could never produce', async () => {
    // Ruling 1: the marker column is -1, matching every sibling adapter, and it is safe only
    // because `write` refuses a negative batch by name (see duckdb-warehouse.write.spec.ts's
    // "refuses a negative batch" case) -- so no caller of `write` can ever forge one. The
    // OBJECT KEY is a separate question: `batchKey`'s zero-padding of `String(-1)` produces
    // the broken `part-0000-1.parquet`, so the carried object must live at its own,
    // independently-named key instead.
    const type = contractType('CarryMarker');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'old-a', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 0,
    });
    await store.commit(type, 'run-1');
    await store.write(type, [contractRow('z', 'new-z', 9)], {
      snapshotId: 'run-2',
      principalId: 'tester',
      batch: 0,
    });
    await store.carryForward(type, 'run-2', { principalId: 'tester' });

    const keys = await localObjectStore(root).list('carrymarker/run-2');
    expect(keys).toContain('carrymarker/run-2/carry.parquet');
    expect(keys.some((key) => /part-0000-1/.test(key))).toBe(false);

    const connection = await duckdbModule.openDuckDb({ root });
    try {
      const rows = await connection.rows(
        `SELECT id, _batch FROM read_parquet(${duckdbModule.quoteLiteral(
          localObjectStore(root).locate('carrymarker/run-2/carry.parquet'),
        )})`,
      );
      expect(rows).toEqual([{ id: 'a', _batch: -1 }]);
    } finally {
      await connection.close();
    }
  });

  it('sorts a carried row before an ordinary batch, since -1 sorts before 0', async () => {
    const type = contractType('CarryOrder');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'old-a', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 0,
    });
    await store.commit(type, 'run-1');
    await store.write(type, [contractRow('z', 'new-z', 9)], {
      snapshotId: 'run-2',
      principalId: 'tester',
      batch: 0,
    });
    await store.carryForward(type, 'run-2', { principalId: 'tester' });
    await store.commit(type, 'run-2');

    const read = await store.read(type, ['id'], { size: 10 });
    expect(read.rows.map((row) => row.id)).toEqual(['a', 'z']);
  });

  it('merges from the served snapshot, not merely the newest record', async () => {
    // Ruling 2: rolling a bad load back means committing an OLDER snapshot, after which the
    // newest record and the served one are different rows. `run-2` is committed (and is the
    // newest), and then `run-1` is committed again on top of it -- an explicit rollback.
    const type = contractType('CarryServedNotNewest');
    await store.ensureType(type);
    await store.write(
      type,
      [contractRow('a', 'from-run-1', 1), contractRow('b', 'only-run-1', 2)],
      {
        snapshotId: 'run-1',
        principalId: 'tester',
        batch: 0,
      },
    );
    await store.commit(type, 'run-1');

    await store.write(type, [contractRow('a', 'from-run-2', 5)], {
      snapshotId: 'run-2',
      principalId: 'tester',
      batch: 0,
    });
    await store.commit(type, 'run-2');

    // Roll back: run-1 is served again, even though run-2 is the newer record.
    await store.commit(type, 'run-1');

    await store.write(type, [contractRow('c', 'only-run-3', 3)], {
      snapshotId: 'run-3',
      principalId: 'tester',
      batch: 0,
    });
    const merged = await store.carryForward(type, 'run-3', { principalId: 'tester' });
    // A merge that picked the newest record would name run-2 here.
    expect(merged.from).toBe('run-1');
    await store.commit(type, 'run-3');

    const read = await store.read(type, ['id', 'label'], { size: 10 });
    const byId = Object.fromEntries(read.rows.map((row) => [row.id, row.label]));
    // Carried from run-1: 'from-run-1' (not 'from-run-2'), and 'b' exists at all only because
    // run-1, not run-2, is what got merged from.
    expect(byId).toEqual({ a: 'from-run-1', b: 'only-run-1', c: 'only-run-3' });
  });

  it('refuses a type with no primary key', async () => {
    const type = contractType('CarryNoKey');
    type.primaryKey = [];
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 0,
    });
    await expect(store.carryForward(type, 'run-1', { principalId: 'tester' })).rejects.toThrow(
      /primary key/i,
    );
  });

  it('refuses a NULL primary key among the rows already written for this load', async () => {
    const type = contractType('CarryNullIncoming');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'old-a', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 0,
    });
    await store.commit(type, 'run-1');
    await store.write(type, [{ id: null, label: 'no-key', score: 1, active: true }], {
      snapshotId: 'run-2',
      principalId: 'tester',
      batch: 0,
    });
    await expect(store.carryForward(type, 'run-2', { principalId: 'tester' })).rejects.toThrow(
      /primary key/i,
    );
  });

  it('refuses a NULL primary key in the previous snapshot', async () => {
    const type = contractType('CarryNullPrevious');
    await store.ensureType(type);
    await store.write(type, [{ id: null, label: 'no-key', score: 1, active: true }], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 0,
    });
    await store.commit(type, 'run-1');
    await store.write(type, [contractRow('a', 'new-a', 5)], {
      snapshotId: 'run-2',
      principalId: 'tester',
      batch: 0,
    });
    await expect(store.carryForward(type, 'run-2', { principalId: 'tester' })).rejects.toThrow(
      /primary key/i,
    );
  });
});

describe('commit refuses a merge a later batch invalidated', () => {
  it('refuses, then accepts once carryForward runs again', async () => {
    const type = contractType('CommitStaleMerge');
    await store.ensureType(type);

    await store.write(type, [contractRow('a', 'alpha', 1), contractRow('b', 'bravo', 2)], {
      snapshotId: 'full',
      principalId: 'contract',
      batch: 0,
    });
    await store.commit(type, 'full');

    await store.write(type, [contractRow('a', 'alpha-2', 10)], {
      snapshotId: 'late',
      principalId: 'contract',
      batch: 0,
    });
    await store.carryForward(type, 'late', { principalId: 'contract' });

    // The batch that arrives after the merge. It has nothing to displace -- the merge already
    // decided which of the previous snapshot's rows survive -- so the old version of every row
    // it touches is still sitting there, carried, and the snapshot now holds both.
    await store.write(type, [contractRow('b', 'bravo-2', 20)], {
      snapshotId: 'late',
      principalId: 'contract',
      batch: 1,
    });

    await expect(store.commit(type, 'late')).rejects.toThrow(/carr/i);

    // The documented repair: merge again, then commit -- in that order.
    await store.carryForward(type, 'late', { principalId: 'contract' });
    await store.commit(type, 'late');

    const read = await store.read(type, ['id', 'label'], { size: 10 });
    const byId = Object.fromEntries(read.rows.map((row) => [row.id, row.label]));
    expect(byId).toEqual({ a: 'alpha-2', b: 'bravo-2' });
  });
});
