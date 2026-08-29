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

  it('orders batches by parsed number, not by key string, past six digits', async () => {
    // PROMOTED MINOR 1: batchKey zero-pads to six digits, which keeps a listing's STRING order
    // agreeing with batch NUMBER order only below 1,000,000. `write` accepts any non-negative
    // integer batch (no upper bound), and 999_999 pads to 'part-999999.parquet' while
    // 1_000_000's own seven digits leave 'part-1000000.parquet' unpadded -- comparing the two
    // as strings puts '1000000' before '999999' (the leading '1' sorts below '9'), which is
    // backwards. Confirmed directly: ['part-1000000.parquet', 'part-999999.parquet'].sort()
    // returns them in that (wrong) order.
    const type = contractType('StreamBatchOrderPastSixDigits');
    await store.ensureType(type);
    await store.write(type, [contractRow('low', 'low-batch', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 999_999,
    });
    await store.write(type, [contractRow('high', 'high-batch', 2)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1_000_000,
    });
    await store.commit(type, 'run-1');

    const seen: unknown[] = [];
    for await (const row of store.streamSnapshot(type, ['id'], 'run-1')) {
      seen.push(row.id);
    }
    expect(seen).toEqual(['low', 'high']);
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

  it('is not truncated by another store operation running while it is still open', async () => {
    // CRITICAL 1: `DuckDbWarehouseStore` is `@Injectable()`, so it is a singleton with one
    // memoized connection (`this.ready()`). Before `streamSnapshot` opened its own dedicated
    // connection, a stream left open across `await`s on that shared connection was silently
    // truncated by any other query the store issued while it was open -- not an error, a
    // `fetchChunk` reporting an empty result that a `for await` reads as the stream simply
    // ending.
    //
    // 6,000 rows forces three 2,048-row chunks, and the pause point (2,100 rows pulled) sits
    // inside chunk 2 -- so chunk 1 and chunk 2 are already fetched by the time the unrelated
    // operation below runs, and only chunk 3 remains, requiring a NEW native `fetchChunk` call
    // AFTER that operation. A smaller fixture (a total that fits in two chunks) would pause
    // with nothing left to fetch, and this test would pass whether or not the connection was
    // actually shared -- proving nothing about the bug it exists to catch.
    const type = contractType('StreamConcurrent');
    await store.ensureType(type);
    const rows = Array.from({ length: 6000 }, (_, index) =>
      contractRow(String(index).padStart(4, '0'), `label-${index}`, index),
    );
    await store.write(type, rows, { snapshotId: 'run-1', principalId: 'tester', batch: 0 });
    await store.commit(type, 'run-1');

    const seen: string[] = [];
    const iterator = store.streamSnapshot(type, ['id'], 'run-1')[Symbol.asyncIterator]();
    for (let index = 0; index < 2100; index += 1) {
      const step = await iterator.next();
      if (step.done) break;
      seen.push(String(step.value.id));
    }
    expect(seen).toHaveLength(2100);

    // An unrelated store operation, on the store's own shared connection, while the stream
    // above is still open and mid-iteration on its own connection.
    const otherType = contractType('StreamConcurrentOther');
    await store.ensureType(otherType);
    await store.write(otherType, [contractRow('x', 'X', 1)], {
      snapshotId: 'other-run',
      principalId: 'tester',
      batch: 0,
    });
    expect(await store.countStaged(type, 'run-1')).toBe(6000);

    let step = await iterator.next();
    while (!step.done) {
      seen.push(String(step.value.id));
      step = await iterator.next();
    }
    expect(seen).toHaveLength(6000);
    expect(seen[0]).toBe('0000');
    expect(seen[5999]).toBe('5999');
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

  it('names the true origin, not itself, when carryForward runs again on the served snapshot', async () => {
    // A durable retry that replays a step whose commit already succeeded runs `write` (a
    // no-op re-send of the same batch), then `carryForward`, again -- and by then
    // `currentSnapshot` names THIS OWN snapshot, because the earlier attempt's commit
    // already landed. The MikroORM sibling's `findPreviousCommitted` docblock names the
    // hazard this guards against directly: carrying forward from itself would delete the
    // carried rows and then find nothing to replace them with, silently reducing the
    // dataset to whatever the run happened to fetch. That hazard is real for a store where
    // "previous" and "incoming" share one physical table (both siblings do). Checked here
    // against the real engine rather than assumed to transfer: for THIS adapter, row
    // content survives a self-merge even without the guard, because the anti-join's
    // "incoming" side is deliberately built from `part-*.parquet` only (see `carryForward`'s
    // own docblock, "why the incoming glob excludes carry.parquet") -- a carried row can
    // never match itself there, self-merge or not, so it is always re-carried rather than
    // dropped. What the guard demonstrably fixes for this adapter is `merged.from`: without
    // it, a self-merge reports `from: snapshotId` -- the snapshot claiming to have carried
    // rows forward from ITSELF, which is not a fact about the data, it is a wrong answer to
    // "where did this come from" that would corrupt a lineage or audit trail built on it.
    // Both properties are asserted below: the row content (defence in depth, and the literal
    // ask), and the attribution (what actually regresses without the guard on this adapter).
    const type = contractType('CarrySelfMerge');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'old-a', 1), contractRow('b', 'old-b', 2)], {
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
    await store.carryForward(type, 'run-2', { principalId: 'tester' });
    await store.commit(type, 'run-2');

    // The retry: `write` re-sends the same batch (idempotent, same key), then `carryForward`
    // runs again for 'run-2' while 'run-2' is itself the served snapshot.
    await store.write(type, [contractRow('a', 'new-a', 5)], {
      snapshotId: 'run-2',
      principalId: 'tester',
      batch: 0,
    });
    const merged = await store.carryForward(type, 'run-2', { principalId: 'tester' });
    await store.commit(type, 'run-2');

    const read = await store.read(type, ['id', 'label'], { size: 10 });
    const byId = Object.fromEntries(read.rows.map((row) => [row.id, row.label]));
    expect(byId).toEqual({ a: 'new-a', b: 'old-b' });
    // Without the guard this names 'run-2' -- itself -- rather than the snapshot 'b' was
    // actually carried out of.
    expect(merged.from).toBe('run-1');
  });

  it('refuses to erase served rows when a replay finds its predecessor has been dropped', async () => {
    // The self-merge-retry guard above assumes the replay's fallback resolves to the SAME
    // predecessor the original successful carryForward used, reproducing the same content.
    // That assumption breaks when the predecessor was dropped in between -- legal, since
    // dropSnapshot only refuses the CURRENTLY SERVED snapshot, and dropping a superseded
    // predecessor during retention is ordinary. Four steps, each individually permitted by
    // this file's own refusals:
    //   1. run-1 written and committed.
    //   2. run-2 written; carryForward carries run-1's survivors into run-2's carry.parquet;
    //      commit -- run-2 is now served.
    //   3. dropSnapshot(run-1) -- legal, run-1 is not served.
    //   4. carryForward(run-2) replays (the durable-retry state) -- served.id === snapshotId
    //      sends it to the fallback; listLive no longer offers the dropped run-1; nothing else
    //      carries COMMITTED_LABEL; previous is undefined.
    // `read` globs every object under the prefix with no commit gate to pass first, so writing
    // zero rows to run-2's carry.parquet here would delete 'b' from the currently served
    // dataset with no error and nothing to make the change visible or reversible.
    const type = contractType('CarryDroppedPredecessor');
    await store.ensureType(type);

    await store.write(type, [contractRow('a', 'old-a', 1), contractRow('b', 'old-b', 2)], {
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
    await store.carryForward(type, 'run-2', { principalId: 'tester' });
    await store.commit(type, 'run-2');

    await store.dropSnapshot(type, 'run-1');

    await expect(store.carryForward(type, 'run-2', { principalId: 'tester' })).rejects.toThrow(
      /serv/i,
    );

    // The refusal must not have touched anything: 'b', carried forward before run-1 was
    // dropped, is still there.
    const read = await store.read(type, ['id', 'label'], { size: 10 });
    const byId = Object.fromEntries(read.rows.map((row) => [row.id, row.label]));
    expect(byId).toEqual({ a: 'new-a', b: 'old-b' });
  });

  it('does not refuse a replay of the first-ever incremental load, which never carried anything', async () => {
    // NEW IMPORTANT A: refusing on `served.id === snapshotId` alone over-fires. This is the
    // first legitimate replay path: run-1 is the FIRST snapshot this type has ever had,
    // carryForward finds no previous, writes a zero-row carry.parquet, and commit serves it.
    // A durable retry then replays write + carryForward for the same run-1 -- served.id ===
    // snapshotId, and the fallback (excluding run-1 itself) still finds nothing, because
    // nothing else has ever committed. Nothing was ever carried; carryKey holds zero rows both
    // before and after; there is nothing for a refusal to protect.
    const type = contractType('CarryFirstEverReplay');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 0,
    });
    await store.carryForward(type, 'run-1', { principalId: 'tester' });
    await store.commit(type, 'run-1');

    // The replay: write re-sends the same batch, then carryForward runs again for run-1 while
    // run-1 is itself the served snapshot.
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 0,
    });
    const merged = await store.carryForward(type, 'run-1', { principalId: 'tester' });
    expect(merged.carried).toBe(0);
    expect(merged.total).toBe(1);
    await store.commit(type, 'run-1');

    const read = await store.read(type, ['id'], { size: 10 });
    expect(read.rows.map((row) => row.id)).toEqual(['a']);
  });

  it('does not refuse a replay whose merge source is a legitimately empty predecessor', async () => {
    // NEW IMPORTANT A, second legitimate path: run-1 is committed with nothing ever written to
    // it (a genuinely empty snapshot, same as `carries nothing forward, without crashing`
    // below). run-2 carries forward from it -- nothing to carry, carryKey stays at zero rows --
    // and is committed, becoming served. A replay of carryForward(run-2) then has served.id
    // === snapshotId, sending resolution to the fallback, which finds run-1 again (still live
    // and committed) -- but run-1 is STILL empty, so `previousObjects.length === 0` and this
    // hits the same "nothing worth protecting" branch as the first-ever case, not the merge
    // branch. There is nothing carried before or after; refusing here would be exactly as
    // wrong as refusing the first path.
    const type = contractType('CarryEmptyPredecessorReplay');
    await store.ensureType(type);
    await store.commit(type, 'run-1');

    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-2',
      principalId: 'tester',
      batch: 0,
    });
    await store.carryForward(type, 'run-2', { principalId: 'tester' });
    await store.commit(type, 'run-2');

    const merged = await store.carryForward(type, 'run-2', { principalId: 'tester' });
    expect(merged.from).toBe('run-1');
    expect(merged.carried).toBe(0);
    expect(merged.total).toBe(1);
    await store.commit(type, 'run-2');

    const read = await store.read(type, ['id'], { size: 10 });
    expect(read.rows.map((row) => row.id)).toEqual(['a']);
  });

  it('refuses to substitute a different predecessor into an already-served snapshot', async () => {
    // NEW IMPORTANT B: the self-merge-retry guard's docblocks used to claim a replay's
    // fallback resolves to the SAME predecessor the original successful carryForward used.
    // False -- the fallback returns the newest LIVE, COMMITTED record other than snapshotId,
    // not the original predecessor by identity. History run-0 -> run-1 -> run-2, run-2 served
    // and carrying from run-1: dropping run-1 while run-0 survives sends a replay's fallback to
    // run-0 instead, which is a real, non-empty previous -- the MERGE branch runs, not the
    // "nothing to carry" refusal, and would otherwise silently substitute run-0's survivors
    // into run-2's already-served dataset.
    const type = contractType('CarrySubstitutedOrigin');
    await store.ensureType(type);

    await store.write(type, [contractRow('z', 'old-z', 1)], {
      snapshotId: 'run-0',
      principalId: 'tester',
      batch: 0,
    });
    await store.commit(type, 'run-0');

    await store.write(type, [contractRow('a', 'old-a', 1), contractRow('b', 'old-b', 2)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 0,
    });
    await store.carryForward(type, 'run-1', { principalId: 'tester' }); // carries 'z' from run-0
    await store.commit(type, 'run-1');

    await store.write(type, [contractRow('a', 'new-a', 5)], {
      snapshotId: 'run-2',
      principalId: 'tester',
      batch: 0,
    });
    await store.carryForward(type, 'run-2', { principalId: 'tester' }); // carries 'b','z' from run-1
    await store.commit(type, 'run-2');

    await store.dropSnapshot(type, 'run-1');

    // Replay: served.id === 'run-2' === snapshotId; the fallback (run-1 gone) now resolves
    // run-0 -- real, non-empty, but NOT what run-2's own record says it was carried from.
    await expect(store.carryForward(type, 'run-2', { principalId: 'tester' })).rejects.toThrow(
      /resolved a different source|substitut/i,
    );

    // Unaffected by the refused attempt.
    const read = await store.read(type, ['id', 'label'], { size: 10 });
    const byId = Object.fromEntries(read.rows.map((row) => [row.id, row.label]));
    expect(byId).toEqual({ a: 'new-a', b: 'old-b', z: 'old-z' });
  });

  it('carries nothing forward, without crashing, when the previous snapshot has no objects at all', async () => {
    // IMPORTANT 3: `commit` does not require `write` to have run first -- see `principalOf`'s
    // own docblock, "commit calls this for a snapshot write never touched" -- so a genuinely
    // empty, committed snapshot (a first run that fetched nothing from its source) is a real,
    // reachable `previous`. Every other glob in this file checks `objects.list(...)` before
    // handing a glob to DuckDB, because a glob matching nothing is an IO error in this engine,
    // not an empty result (see `countStaged`'s own docblock); `carryForward`'s previous-side
    // glob used not to, and would die on that error instead of carrying nothing forward.
    const type = contractType('CarryEmptyPrevious');
    await store.ensureType(type);

    // A first, genuinely empty run: nothing written, straight to commit.
    await store.commit(type, 'run-1');

    await store.write(type, [contractRow('a', 'from-run-2', 1)], {
      snapshotId: 'run-2',
      principalId: 'tester',
      batch: 0,
    });
    const merged = await store.carryForward(type, 'run-2', { principalId: 'tester' });
    expect(merged.from).toBe('run-1');
    expect(merged.carried).toBe(0);
    expect(merged.total).toBe(1);
    await store.commit(type, 'run-2');

    const read = await store.read(type, ['id'], { size: 10 });
    expect(read.rows.map((row) => row.id)).toEqual(['a']);
  });

  it('clears a stale carried row when a later call finds the previous snapshot empty', async () => {
    // The other half of the same fix, and a real idempotence gap it closes (a MINOR item
    // alongside the Critical/Important review): a second `carryForward` call for the SAME
    // snapshotId, whose own `previous` resolves to something with no rows, must not leave an
    // earlier call's carried row sitting in `carry.parquet` -- `total` would otherwise still
    // count a row this call's own answer says should not be there.
    const type = contractType('CarryStaleClears');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'old-a', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 0,
    });
    await store.commit(type, 'run-1');

    await store.write(type, [contractRow('b', 'new-b', 2)], {
      snapshotId: 'run-2',
      principalId: 'tester',
      batch: 0,
    });
    const first = await store.carryForward(type, 'run-2', { principalId: 'tester' });
    expect(first.carried).toBe(1); // 'a' carried forward from run-1
    expect(first.total).toBe(2);

    // Roll the served pointer to a genuinely empty snapshot. 'run-2' is not yet committed, so
    // this is legal, and it makes run-2's OWN previous resolve to something with no rows.
    await store.commit(type, 'run-0');

    const second = await store.carryForward(type, 'run-2', { principalId: 'tester' });
    expect(second.from).toBe('run-0');
    expect(second.carried).toBe(0);
    // Only 'b' -- 'a' must not still be sitting in carry.parquet from the first call.
    expect(second.total).toBe(1);
    await store.commit(type, 'run-2');

    const read = await store.read(type, ['id'], { size: 10 });
    expect(read.rows.map((row) => row.id)).toEqual(['b']);
  });

  it('excludes an uncommitted record from the fallback merge source', async () => {
    // IMPORTANT 4: `carryForward` creates a live `SnapshotRef` before `commit` ever runs (see
    // CARRIED_FROM_LABEL), so an aborted load -- write, then carryForward, but never commit --
    // leaves a live record `listSnapshotsWithRows` cannot tell apart from a served one by
    // tombstone status alone. Without COMMITTED_LABEL's filter, that record would be eligible
    // as the fallback's merge source the next time nothing is served for this type -- a merge
    // source nobody ever served, the same mistake Ruling 2 exists to prevent, reached through
    // carryForward's own bookkeeping rather than through "newest record" reasoning.
    const type = contractType('CarryUncommittedFallback');
    await store.ensureType(type);

    // The aborted run: write, then carryForward, never commit.
    await store.write(type, [contractRow('a', 'from-aborted-run', 1)], {
      snapshotId: 'aborted',
      principalId: 'tester',
      batch: 0,
    });
    await store.carryForward(type, 'aborted', { principalId: 'tester' });

    // A second load. Nothing has EVER been committed for this type, so `served` is still
    // undefined and the fallback runs.
    await store.write(type, [contractRow('b', 'from-run-2', 2)], {
      snapshotId: 'run-2',
      principalId: 'tester',
      batch: 0,
    });
    const merged = await store.carryForward(type, 'run-2', { principalId: 'tester' });
    expect(merged.from).toBeUndefined();
    expect(merged.carried).toBe(0);
    await store.commit(type, 'run-2');

    const read = await store.read(type, ['id'], { size: 10 });
    // Without the fix this would include 'a', carried forward from the aborted run.
    expect(read.rows.map((row) => row.id)).toEqual(['b']);
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

describe('carryForward on a snapshot that is already served', () => {
  it('does not crash asking how many rows a carry object that was never written holds', async () => {
    // `countCarried` reads an EXACT path with no `objects.list` guard, and the branch that
    // decides whether to refuse a served clear calls it before any branch has written
    // `carry.parquet`. A plain full load that was committed and is now served has no
    // `carry.parquet` at all, so a `carryForward` for that same snapshot -- a connector
    // switching a type from full to incremental, or a durable step replaying past its own
    // commit -- met a glob matching nothing, which is a raw DuckDB IO error in this engine
    // rather than an empty result. Nothing is at stake in that state: there is nothing carried
    // to destroy, so it must skip rather than raise.
    const type = contractType('CarryNeverWritten');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 0,
    });
    await store.commit(type, 'run-1');

    const merged = await store.carryForward(type, 'run-1', { principalId: 'tester' });
    expect(merged.from).toBeUndefined();
    expect(merged.carried).toBe(0);
    expect(merged.total).toBe(1);

    const read = await store.read(type, ['id'], { size: 10 });
    expect(read.rows.map((row) => row.id)).toEqual(['a']);
  });

  it('refuses to merge a predecessor into a served snapshot whose record names no origin', async () => {
    // The origin comparison short-circuited on `recordedOrigin !== undefined`, which left one
    // served-snapshot mutation uncovered: a snapshot that never carried anything carries no
    // `_carriedFrom` label at all, so the comparison abstained and the merge branch ran. A
    // plain full load, committed and served, with an older committed snapshot still live is
    // exactly that state -- and the merge would inject that older snapshot's rows straight
    // into the dataset the type is serving, with no commit to make it visible or reversible.
    const type = contractType('CarryServedNoOrigin');
    await store.ensureType(type);

    await store.write(type, [contractRow('z', 'old-z', 9)], {
      snapshotId: 'run-0',
      principalId: 'tester',
      batch: 0,
    });
    await store.commit(type, 'run-0');

    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 0,
    });
    await store.commit(type, 'run-1');

    await expect(store.carryForward(type, 'run-1', { principalId: 'tester' })).rejects.toThrow(
      /serv/i,
    );

    const read = await store.read(type, ['id'], { size: 10 });
    expect(read.rows.map((row) => row.id)).toEqual(['a']);
  });
});

describe('the labels a snapshot record ends up with', () => {
  it('keeps what write recorded first and picks up what only carryForward supplied', async () => {
    // One rule across all three writers of the record: a key is recorded by the first call
    // that supplies it and never overwritten by a later one. `write` now creates the record on
    // a load's first batch, so a merge that overwrote labels wholesale would flip a caller's
    // provenance halfway through a load -- and one that ignored `options.labels` whenever a
    // record already existed would leave `carryForward`'s own parameter declared and never
    // read, which is the same defect `write`'s own `options.labels` is pinned against in
    // duckdb-warehouse.write.spec.ts.
    const type = contractType('CarryLabelMerge');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 0,
      labels: { source: 'connector' },
    });
    await store.carryForward(type, 'run-1', {
      principalId: 'tester',
      labels: { source: 'merge-time', run: 'nightly' },
    });
    const committed = await store.commit(type, 'run-1');
    expect(committed.labels?.source).toBe('connector');
    expect(committed.labels?.run).toBe('nightly');
  });
});
