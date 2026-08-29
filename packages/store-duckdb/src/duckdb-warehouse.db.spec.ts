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
      // DuckDB spells a quoted identifier with double quotes; the contract defaults to
      // backticks, which this engine answers with a syntax error.
      quoteIdentifier: (value) => `"${value}"`,
      noModelReason:
        'This adapter stores rows, not the model. A deployment mounts it for the rows and a transactional store for the type model, saved queries and connector definitions — small, mutable, read-modify-write data that object storage is the wrong home for.',
    }),
  );

  it('measures whether a cutover is atomic under concurrent reads', async () => {
    // `atomicCutover` is a property of the statement the adapter chose, not of the
    // engine — the ClickHouse adapter got 18 errors from one statement and none
    // from another on the same server. So it is measured here, and the capability
    // object states only what this proves.
    const type = contractType('CutoverRace');
    await store.ensureType(type);
    for (const id of ['run-1', 'run-2']) {
      await store.write(type, [contractRow('a', id, 1)], {
        snapshotId: id,
        principalId: 'tester',
        batch: 1,
      });
    }
    await store.commit(type, 'run-1');

    const failures: unknown[] = [];
    const reads = Array.from({ length: 200 }, async () => {
      try {
        await store.read(type, ['id', 'label'], {});
      } catch (error) {
        failures.push(error);
      }
    });
    const commits = Array.from({ length: 200 }, (_value, index) =>
      store.commit(type, index % 2 === 0 ? 'run-2' : 'run-1'),
    );
    await Promise.all([...reads, ...commits]);

    // Record the number here rather than asserting zero: this assertion is what
    // licenses the capability value, so it has to be the measurement.
    expect(failures).toEqual([]);
  }, 120_000);
});
