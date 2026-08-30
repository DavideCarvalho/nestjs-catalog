import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ContractStore,
  contractRow,
  contractType,
  describeCatalogStoreContract,
} from '../../../test/catalog-store-contract';
import { DuckDbWarehouseStore } from './duckdb-warehouse.store';

/**
 * The DuckDB warehouse store, against a real DuckDB and a real filesystem.
 *
 * No container, and that is a property of the adapter rather than a shortcut: the engine is
 * in-process and the transport is a directory, so the only thing a container would add here
 * is object storage — which Task 13 covers in its own spec, against the S3 binding this store
 * also supports. Everything the contract asserts is a property of the Parquet this store
 * writes and the SQL it issues, and both are real in this configuration: no mock, no stub, a
 * real `duckdb` engine reading and writing real files under a temp directory.
 */

/**
 * How many readers keep pointer reads in flight for the whole race, and how many times the
 * pointer moves under them.
 *
 * Sixteen readers rather than a single batch of two hundred, because what this experiment
 * needs is not a large number of reads but reads still being issued when `setCurrent` fires,
 * which only a looping reader supplies. Sixteen keeps the default four-thread libuv pool —
 * the one serving both the pointer reads and the pointer writes — busy for the whole race:
 * measured, the readers get through roughly 5,000-7,000 reads across the 200 cutovers.
 */
const RACE_READERS = 16;
const RACE_CUTOVERS = 200;

/** What a caught value says, without asserting it is an `Error`. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A promise plus the handle to settle it, so a reader can tell the race it has started. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

let root: string;
let store: DuckDbWarehouseStore;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'catalog-duckdb-contract-'));
  store = new DuckDbWarehouseStore({ root });
}, 300_000);

afterAll(async () => {
  await store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('DuckDbWarehouseStore', () => {
  describeCatalogStoreContract(
    (): ContractStore => ({
      name: 'duckdb',
      store,
      // Nothing to register: this adapter derives every column from the def it is handed and
      // resolves the served snapshot from its own pointer, so shaping storage is the whole
      // of publishing here.
      publish: (type) => store.ensureType(type),
      // DuckDB spells a quoted identifier with double quotes, not the backticks the
      // contract defaults to. Nothing in this run exercises it: the only case that calls
      // it is the SQL-console one, which skips because this adapter implements no
      // `CatalogQueryStore`. Supplied anyway, so the day one is added the contract quotes
      // with the spelling this engine accepts rather than the one it rejects.
      quoteIdentifier: (value) => `"${value}"`,
      noModelReason:
        'This adapter stores rows, not the model. A deployment mounts it for the rows and a transactional store for the type model, saved queries and connector definitions — small, mutable, read-modify-write data that object storage is the wrong home for.',
    }),
  );

  /**
   * Whether a read issued while the served pointer is moving can observe a torn cutover.
   *
   * The window is one file. `read` touches the pointer exactly once, at its first await
   * (`snapshots.current`), and everything after that reads Parquet under the id it already
   * resolved, which no commit rewrites. `commit` moves that same pointer through
   * `ObjectStore.put`. So this experiment is sensitive only while a pointer read is in flight
   * during a pointer write, and its whole design is about arranging that overlap: the readers
   * loop for the lifetime of the commits, and the commits do not start until every reader has
   * completed a read and is going round again. A fixed batch of reads fired once up front
   * measures nothing — all of them resolve before the first `setCurrent` lands, since every
   * commit clears `snapshots.find`, a `countStaged` scan and a `snapshots.put` first, so
   * `failures` would be empty by construction, which is a green test that measured nothing.
   *
   * What this guards is `put`'s rename (`object-store.ts`). Aimed at a `writeFile` that goes
   * straight at the key, this same experiment reads a zero-byte `_current.json` 229-8,296
   * times per run — that is the positive control that says the detector fires, and it is what
   * licenses the `atomicCutover: true` the store now states. Should the pointer write stop
   * being atomic, a `Current-snapshot pointer … is not valid JSON` lands in `failures` and the
   * assertion below turns it into a red test rather than a silent capability lie.
   */
  it('measures whether a cutover is atomic under concurrent reads', async () => {
    // `atomicCutover` is a property of the statement the adapter chose, not of the engine —
    // the ClickHouse adapter got 18 errors from one statement and none from another on the
    // same server. So it is measured here, and the capability object states only what this
    // proves.
    const type = contractType('CutoverRace');
    await store.ensureType(type);
    for (const id of ['run-1', 'run-2']) {
      await store.write(type, [contractRow('a', id, 1)], {
        snapshotId: id,
        principalId: 'tester',
        batch: 1,
      });
    }
    // Both committed before the race starts, so the pointer only ever flips between two
    // snapshots that already have a record and rows: a read that resolves either id has
    // something to serve, and any failure is the cutover rather than the fixture.
    await store.commit(type, 'run-1');
    await store.commit(type, 'run-2');

    const failures: unknown[] = [];
    let reads = 0;
    let racing = true;

    const started = Array.from({ length: RACE_READERS }, deferred);
    const readers = started.map(async (start) => {
      while (racing) {
        try {
          await store.read(type, ['id', 'label'], {});
          reads += 1;
        } catch (error) {
          failures.push(error);
        }
        start.resolve();
      }
    });

    // Gate the commits on the readers being in flight rather than on queue position: each
    // reader settles its own promise the moment it finishes a read, so when this barrier
    // lifts all RACE_READERS are between iterations and about to issue their next pointer
    // read, and they keep issuing them until `racing` goes false.
    await Promise.all(started.map((start) => start.promise));

    const readsBefore = reads;
    try {
      for (let index = 0; index < RACE_CUTOVERS; index += 1) {
        await store.commit(type, index % 2 === 0 ? 'run-2' : 'run-1');
      }
    } finally {
      // In the `finally` because the readers are unbounded loops: a commit that rejects would
      // otherwise leave sixteen of them spinning against a store this file closes in
      // `afterAll`, for the rest of the worker's life, and the failure they then report would
      // be about a closed connection rather than about the commit that actually broke.
      racing = false;
      await Promise.all(readers);
    }
    const readsDuring = reads - readsBefore;

    console.log(
      `[cutover] ${RACE_CUTOVERS} cutovers, ${readsDuring} reads during the race, ${failures.length} torn`,
    );
    for (const message of new Set(failures.map(messageOf))) console.log(`[cutover] ${message}`);

    // First, that the experiment was switched on. An experiment that issued no reads while
    // the pointer was moving reports zero failures for the same reason an unplugged detector
    // does, and the previous shape of this test did exactly that: 200 reads fired once, all
    // resolved before the first `setCurrent` landed, zero failures by construction.
    expect(readsDuring).toBeGreaterThan(0);
    // Then what the capability object is allowed to say, bound to what this run observed.
    // Conditional on purpose, and the two directions are not symmetric: one torn read
    // disproves `atomicCutover` outright, while a clean run proves nothing beyond itself and
    // so constrains nothing. Since the store now states `true`, this is the regression gate —
    // the day the pointer write stops being atomic, one torn read fails this case.
    if (failures.length > 0) expect(store.capabilities.atomicCutover).toBeUndefined();
  }, 300_000);
});
