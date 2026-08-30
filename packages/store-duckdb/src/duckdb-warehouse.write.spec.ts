import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatalogObjectTypeDef } from '@dudousxd/nestjs-catalog';
import { isCatalogStoreCapabilities, isWriteStore } from '@dudousxd/nestjs-catalog';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { contractRow, contractType } from '../../../test/catalog-store-contract';
import * as duckdbModule from './duckdb';
import { DuckDbWarehouseStore } from './duckdb-warehouse.store';
import { localObjectStore } from './object-store';

/**
 * A type with one property spelled the way a real source spells it, the same incident the
 * core package's `physicalColumn` docblock records: a load matches a record to a property by
 * property NAME, so a property called `Asset Id` has to clean to `Asset_Id` on the write path
 * for `stageRow` to find it under a name DuckDB will also accept in a `SELECT` list — and
 * nothing in this file's other fixtures exercises that cleaning, since `contractType`'s
 * properties are already safe identifiers before `physicalColumn` ever touches them.
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

  it('declares only the atomicity it has measured', () => {
    // Measured, and by an experiment that can fail: the db-spec's race
    // (`duckdb-warehouse.db.spec.ts`) keeps pointer reads in flight across 200 cutovers,
    // and pointed at a `writeFile` aimed straight at the key it reads a truncated pointer
    // 229-8,296 times per run. Against the sibling-and-rename `put` does, seven runs and
    // 38,558 reads produced no torn read at all.
    expect(store.capabilities.atomicCutover).toBe(true);
    // `false`, not absent: there is no cross-statement transaction anywhere in this
    // file, so this is a measured "no" rather than an unmeasured silence.
    expect(store.capabilities.transactional).toBe(false);
    // Absent on purpose. The local and S3 bindings disagree on whether a batch
    // replace is atomic — a `COPY … TO` over an existing path is not, a `PutObject`
    // is — and one field cannot honestly describe both.
    expect(store.capabilities.atomicBatchReplace).toBeUndefined();
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

  it('serves a snapshot whose id ends in the staging suffix like any other', async () => {
    // A snapshot id is a caller's string, and it becomes a directory component of
    // `snapshotPrefix` — the same namespace the object store names a body it has not finished
    // writing in. The listing rule that keeps the two apart is pinned in `object-store.spec.ts`;
    // this is the end-to-end statement that an id shaped like one stages, counts, commits and
    // serves like any other.
    const type = contractType('StagingNamedRun');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'nightly.staging',
      principalId: 'tester',
      batch: 1,
    });
    expect(await store.countStaged(type, 'nightly.staging')).toBe(1);
    await store.commit(type, 'nightly.staging');
    const served = await store.read(type, ['id', 'label'], {});
    expect(served.total).toBe(1);
    expect(served.rows[0]?.label).toBe('A');
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
    const key = 'writeempty/run-1/part-000001.parquet';
    expect(await localObjectStore(root).list('writeempty/run-1')).toEqual([key]);
    expect(await store.countStaged(type, 'run-1')).toBe(0);

    // "Schema-carrying" is the claim under test, not just "exists": a zero-row Parquet
    // object with no columns at all would also satisfy every assertion above. `DESCRIBE`
    // over the object proves the declared columns are actually there.
    const connection = await duckdbModule.openDuckDb({ root });
    try {
      const described = await connection.rows(
        `DESCRIBE SELECT * FROM read_parquet(${duckdbModule.quoteLiteral(localObjectStore(root).locate(key))})`,
      );
      expect(described.map((column) => column.column_name)).toEqual(
        expect.arrayContaining(['id', 'label', 'score', 'active', 'seenAt']),
      );
    } finally {
      await connection.close();
    }
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

  it('refuses a batch whose record keys match no property, and still accepts a zero-row batch', async () => {
    // Every field is looked up by property name. A record set keyed under different headers —
    // the exact shape of a CSV that arrived from a resource that renamed its columns — coerces
    // to `null` for every property, and nothing about that fails on its own: `write` would
    // report `{ written: N }`, the object would land, and a later `commit` would repoint the
    // served pointer at N rows that say nothing. That is the "row count that looks plausible"
    // failure the core interface's own `write` docblock names.
    const type = contractType('WriteMismatched');
    await store.ensureType(type);
    await expect(
      store.write(type, [{ unrelatedField: 'x', anotherField: 'y' }], {
        snapshotId: 'run-1',
        principalId: 'tester',
        batch: 0,
      }),
    ).rejects.toThrow(/none of the incoming fields match/i);

    // The guard is asked only of a batch that has rows: a zero-row batch carries no field
    // names to disagree with the type, and must still succeed for Ruling 4's sake.
    const result = await store.write(type, [], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 0,
    });
    expect(result.written).toBe(0);
  });

  it('memoizes the connection, so concurrent first calls open only one', async () => {
    // `ready()` is private, so this is checked the one way available from outside: spying on
    // the module-level `openDuckDb` this store's `ready()` calls, and firing two writes at a
    // fresh store — one that has never opened a connection — at the same time. An unmemoized
    // `ready()` has an `await` between checking `this.connection` and setting it, so both
    // calls would see it unset and each call `openDuckDb`, leaking a second DuckDB instance
    // that runs under none of this store's configured memory or thread limits.
    const concurrentRoot = mkdtempSync(join(tmpdir(), 'catalog-duckdb-concurrent-'));
    const concurrentStore = new DuckDbWarehouseStore({ root: concurrentRoot });
    const openSpy = vi.spyOn(duckdbModule, 'openDuckDb');
    try {
      const type = contractType('WriteConcurrent');
      await concurrentStore.ensureType(type);
      await Promise.all([
        concurrentStore.write(type, [contractRow('a', 'A', 1)], {
          snapshotId: 'run-1',
          principalId: 'tester',
          batch: 0,
        }),
        concurrentStore.write(type, [contractRow('b', 'B', 2)], {
          snapshotId: 'run-1',
          principalId: 'tester',
          batch: 1,
        }),
      ]);
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(await concurrentStore.countStaged(type, 'run-1')).toBe(2);
    } finally {
      openSpy.mockRestore();
      await concurrentStore.close();
      rmSync(concurrentRoot, { recursive: true, force: true });
    }
  });

  it('writes a property spelled the way a source spells it under its cleaned physical name', async () => {
    // The incident `physicalColumn`'s own docblock records: thirteen types loaded with a
    // property renamed to dodge this exact problem, and six came back with most of their
    // columns empty because nothing on the write path ever exercised the cleaning. `Asset Id`
    // must clean to `Asset_Id` — a name `stageColumns` can declare and a later `SELECT` can
    // name — and the row written under the source's own spelling must actually be staged
    // there, not silently dropped for having no property that matches its exact key.
    const type = sourceSpelledType('WriteSpelled');
    await store.ensureType(type);
    const result = await store.write(type, [{ id: 'a', 'Asset Id': 'A-71' }], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 0,
    });
    expect(result.written).toBe(1);
    expect(await store.countStaged(type, 'run-1')).toBe(1);

    const key = 'writespelled/run-1/part-000000.parquet';
    const connection = await duckdbModule.openDuckDb({ root });
    try {
      const rows = await connection.rows(
        `SELECT Asset_Id FROM read_parquet(${duckdbModule.quoteLiteral(localObjectStore(root).locate(key))})`,
      );
      expect(rows).toEqual([{ Asset_Id: 'A-71' }]);
    } finally {
      await connection.close();
    }
  });

  it('persists options.labels for a plain full load, not only for an incremental one', async () => {
    // `options.labels` was declared and never read: a caller's provenance labels reached this
    // method and were silently discarded unless `carryForward` also ran for the same snapshot
    // (which DOES persist `options.labels` onto a fresh SnapshotRef). `commit` takes no
    // `labels` parameter of its own, so a plain full load's caller-supplied labels never
    // reached the committed SnapshotRef at all.
    const type = contractType('WriteLabels');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 0,
      labels: { source: 'nightly-sync' },
    });
    const committed = await store.commit(type, 'run-1');
    expect(committed.labels).toEqual({ source: 'nightly-sync' });
  });

  it('keeps the FIRST batch labels rather than overwriting them from a later batch', async () => {
    const type = contractType('WriteLabelsFirstWins');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 0,
      labels: { source: 'first-batch' },
    });
    await store.write(type, [contractRow('b', 'B', 2)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
      labels: { source: 'second-batch' },
    });
    const committed = await store.commit(type, 'run-1');
    expect(committed.labels).toEqual({ source: 'first-batch' });
  });

  it('records a label only a LATER batch supplied', async () => {
    // The core package documents the contract this pins (`EXPECT_SHRINK_LABEL` in
    // packages/pipeline/src/load-expectations.ts): "Set it in the `labels` of ANY batch of the
    // load -- PublishService.appendRows passes them through to the snapshot." `appendRows` takes
    // labels per call and the publish controller passes `body?.labels` per request, so a
    // publisher acknowledging a deliberate shrink on its second batch is an ordinary use of a
    // public surface. Creating the record on the first batch and then returning early whenever
    // one already existed discarded every later batch's labels in silence -- and with the row
    // count now recomputed, the bound that label stands down actually fires, so the load was
    // refused at commit with a message telling it to set the label it had set.
    const type = contractType('WriteLabelsLaterBatch');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 0,
    });
    await store.write(type, [contractRow('b', 'B', 2)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
      labels: { _expectShrink: 'migration to one base' },
    });
    const committed = await store.commit(type, 'run-1');
    expect(committed.labels).toEqual({ _expectShrink: 'migration to one base' });
  });

  it('adds a key a later batch brought without disturbing one an earlier batch recorded', async () => {
    const type = contractType('WriteLabelsMerged');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 0,
      labels: { source: 'first-batch' },
    });
    await store.write(type, [contractRow('b', 'B', 2)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
      labels: { source: 'second-batch', _expectShrink: 'known' },
    });
    const committed = await store.commit(type, 'run-1');
    expect(committed.labels).toEqual({ source: 'first-batch', _expectShrink: 'known' });
  });

  it('refuses a caller label that would forge one of this store own bookkeeping facts', async () => {
    // All three arrive on the same public surface: the publish controller passes a request
    // body's `labels` straight to `appendRows`, which passes them to `write`, which merges them
    // into the snapshot record verbatim.
    //
    // `_committed` is the sharpest — it makes `hasFinalRowCount` true for a record whose
    // `rowCount` is still the `0` placeholder, so `present` stops recomputing it and the
    // placeholder reaches the load bound's unconditional "collapsed to nothing" refusal.
    // `_carryForwardStale` is a permanent commit refusal a caller inflicts on itself.
    // `_carriedFrom` forges the lineage `refuseSubstitutedOrigin` compares against.
    const type = contractType('WriteReservedLabels');
    await store.ensureType(type);
    for (const key of ['_committed', '_carryForwardStale', '_carriedFrom']) {
      await expect(
        store.write(type, [contractRow('a', 'A', 1)], {
          snapshotId: 'run-1',
          principalId: 'tester',
          labels: { [key]: 'forged' },
        }),
      ).rejects.toThrow(new RegExp(key));
    }
  });

  it('refuses every label constant the store module declares, so a fourth cannot be missed', async () => {
    // The reservation is only as complete as `STORE_OWNED_LABELS`, and nothing about adding a
    // fourth `*_LABEL` constant to that module forces anyone to extend the list — the store
    // would keep working, and the new label would keep being settable from a request body. So
    // the list is checked against the declarations rather than against a copy of itself.
    //
    // Read off the source because the constants are module-private, which is where they belong:
    // exporting three internals to make them testable would be widening the package's surface
    // to hold a list still. Located from this file rather than from the working directory, so
    // the guard does not depend on where vitest was invoked.
    const source = readFileSync(
      fileURLToPath(new URL('./duckdb-warehouse.store.ts', import.meta.url)),
      'utf8',
    );
    const declared = [...source.matchAll(/^const \w+_LABEL = '([^']+)';$/gm)].map(
      (match) => match[1],
    );
    expect(declared).toEqual(
      expect.arrayContaining(['_committed', '_carriedFrom', '_carryForwardStale']),
    );

    const type = contractType('WriteAllReservedLabels');
    await store.ensureType(type);
    for (const key of declared) {
      await expect(
        store.write(type, [contractRow('a', 'A', 1)], {
          snapshotId: 'run-1',
          principalId: 'tester',
          labels: { [key]: 'forged' },
        }),
      ).rejects.toThrow(new RegExp(key));
    }
  });

  it('still accepts _expectShrink, which is the core own caller-supplied label', async () => {
    // The reason the refusal above is a list of three names and not the `_` prefix. The core
    // package tells a publisher to set `_expectShrink` "in the labels of any batch of the
    // load"; a prefix rule would refuse that acknowledgement on this adapter alone.
    const type = contractType('WriteExpectShrinkLabel');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      labels: { _expectShrink: 'migration to one base' },
    });
    const committed = await store.commit(type, 'run-1');
    expect(committed.labels).toEqual({ _expectShrink: 'migration to one base' });
  });

  it('refuses a batch above Number.MAX_SAFE_INTEGER', async () => {
    // batchKey renders a batch through String(batch); past MAX_SAFE_INTEGER that can render as
    // exponential notation ('1e+21'), which streamSnapshot's batchNumberOf cannot parse back
    // out of the key -- an unparseable batch would silently fall into the slot reserved for
    // the carry-forward object.
    const type = contractType('WriteBatchTooLarge');
    await store.ensureType(type);
    await expect(
      store.write(type, [contractRow('a', 'A', 1)], {
        snapshotId: 'run-1',
        principalId: 'tester',
        batch: 1e21,
      }),
    ).rejects.toThrow(/batch/i);
  });
});
