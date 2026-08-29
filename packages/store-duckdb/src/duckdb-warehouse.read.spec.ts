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
    // The core package's `outputAlias` docblock records the incident this guards against,
    // and it is a WRITE-side one: a verbatim alias forced `Asset Id` to be renamed to
    // `Asset_Id` to survive `ident()`'s refusal, and since a load matches a record to a
    // property by property NAME, the renamed property's every load read `undefined` out of a
    // record the source keyed `Asset Id` — NULL on disk, in every row, for thirteen types.
    // This test is about a narrower, read-side way to break the same round-trip: `write` keys
    // staged rows by `physicalColumn(name)`; `read` selects that column aliased to
    // `outputAlias(name)`; `normaliseRow` looks the value up by `outputAlias(name)` and hands
    // it back under the property's own name. All three must agree, or a value staged
    // correctly still comes back keyed `Asset_Id` instead of `Asset Id`.
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

  it('commits a snapshot no write ever touched without a raw engine error', async () => {
    // `commit` asks `principalOf` for a snapshot's loader when no record already names one,
    // and `principalOf` reads over the snapshot's glob — a glob that matches nothing raises
    // in DuckDB rather than answering with no rows. "Nobody has written this snapshot yet" is
    // an ordinary state to commit into (an operator committing early, or a retry racing ahead
    // of its own load), and must come back as a normal, if empty, commit rather than a raw
    // "No files found that match the pattern" out of the engine.
    const type = contractType('CommitNeverWritten');
    await store.ensureType(type);
    const ref = await store.commit(type, 'run-1');
    expect(ref.rowCount).toBe(0);
    expect(ref.principalId).toBe('unknown');
    const result = await store.read(type, FIELDS, {});
    expect(result.rows).toEqual([]);
  });

  it('keeps serving the current snapshot while a newer, uncommitted load is staged beside it', async () => {
    // The invisibility promise's load-bearing case in production: not a type that has never
    // committed, but one that already IS serving a snapshot, receiving a second load that
    // has not committed yet. A `read` that globbed the whole type prefix instead of one
    // snapshot's prefix would leak run-2's uncommitted row into this result.
    const type = contractType('ReadHiddenBesideCurrent');
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

    const result = await store.read(type, FIELDS, {});
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.label).toBe('old');
    expect(result.snapshot).toEqual({ id: 'run-1', current: true });
  });

  it('refuses an unknown field the same way whether or not the snapshot has anything staged', async () => {
    // The whitelist check used to live inside the SELECT-list builder, after the empty-glob
    // guard — so the identical bad request (a field the type does not have) either threw or
    // silently came back as `{ rows: [], total: 0 }`, depending on whether anything happened
    // to be staged yet. Resolving `fields` before that guard makes the refusal unconditional.
    const staged = contractType('ReadUnknownFieldStaged');
    await store.ensureType(staged);
    await store.write(staged, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
    });
    await store.commit(staged, 'run-1');
    await expect(store.read(staged, ['bogus'], {})).rejects.toThrow(/no property named bogus/);

    // A type with a real, committed pointer but an empty object glob (the never-written
    // commit case `commit` now accepts cleanly) is the actual "does not have objects yet"
    // case this guards: a type with no committed snapshot at all short-circuits earlier, at
    // `if (!wanted) return { rows: [], total: 0 }`, and says nothing about this ordering.
    const unstaged = contractType('ReadUnknownFieldUnstaged');
    await store.ensureType(unstaged);
    await store.commit(unstaged, 'run-1');
    await expect(store.read(unstaged, ['bogus'], {})).rejects.toThrow(/no property named bogus/);
  });

  it('refuses a non-finite page size instead of interpolating LIMIT NaN', async () => {
    // `write`'s own `batch` refuses a non-finite input with a named error rather than letting
    // it flow into a key nothing could resolve; `size` gets the same rather than silently
    // becoming `LIMIT NaN`.
    const type = contractType('ReadNonFiniteSize');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
    });
    await store.commit(type, 'run-1');
    await expect(store.read(type, FIELDS, { size: Number.NaN })).rejects.toThrow(
      /size must be a finite number/,
    );
  });
});
