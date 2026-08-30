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

/**
 * A type with one classified string column, for the search-skips-classified case.
 *
 * `filterOperatorsFor` in the core package already excludes a classified column from
 * filtering, on the grounds that a predicate over it leaks the value through row
 * membership even though the value itself is never rendered — the same reasoning applies
 * to `search`, which is why the ClickHouse sibling's `read` excludes `!p.classification`
 * from its searchable set alongside `p.type === 'string'`.
 */
function classifiedType(name: string): CatalogObjectTypeDef {
  return {
    name,
    displayName: name,
    pluralDisplayName: `${name}s`,
    description: 'Fixture with one classified string column, for the search-skips-classified case.',
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
        name: 'label',
        displayName: 'label',
        type: 'string',
        columnName: 'label',
        nullable: true,
        primary: false,
        hidden: false,
        order: 1,
        enriched: false,
      },
      {
        name: 'secret',
        displayName: 'secret',
        type: 'string',
        columnName: 'secret',
        nullable: true,
        primary: false,
        hidden: false,
        order: 2,
        enriched: false,
        classification: 'CUI',
      },
    ],
    relations: [],
  };
}

/**
 * A type with one `uuid`-typed column, for the `empty`/`notEmpty`-on-`''` case.
 *
 * `filterOperatorsFor` in the core package offers `empty`/`notEmpty` to `uuid` and `unknown`
 * columns exactly as it does to `string` ones (its `default` branch covers all three), and
 * `duckDbType` stores all three as `VARCHAR`. What makes an empty string on this column a
 * real, reachable state rather than a corner nobody hits: `coerce` in `column-types.ts`
 * writes `''` through verbatim for every non-number/boolean/date type, so a row loaded with
 * `tag: ''` lands on disk as the empty string, not as NULL.
 */
function uuidColumnType(name: string): CatalogObjectTypeDef {
  return {
    name,
    displayName: name,
    pluralDisplayName: `${name}s`,
    description: "Fixture with one uuid-typed column, for the empty/notEmpty-on-'' case.",
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
        name: 'tag',
        displayName: 'tag',
        type: 'uuid',
        columnName: 'tag',
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

  it('refuses a traversing query.snapshot before it reaches a filesystem join', async () => {
    // The reachable route the branch review found: `GET /objects/:name?snapshot=…` checks only
    // `timeTravel` on the way in, and `read` resolves the named snapshot through
    // `SnapshotCatalog.find` -> `snapshotRecordKey` -> `join(base, key)`, which has no
    // containment check of its own. Read-only, but a non-JSON file answered with its first
    // bytes inside the parse failure, which is an oracle.
    const type = contractType('ReadTraversingSnapshot');
    await store.ensureType(type);
    await expect(store.read(type, FIELDS, { snapshot: '../../../../etc/hosts' })).rejects.toThrow(
      /snapshot id/,
    );
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

  it('refuses a non-finite page number even when nothing is staged yet', async () => {
    // Sibling to the size case above, and the sweep this task adds: `size`/`page` used to be
    // checked after the empty-glob guard, so `{ page: NaN }` against a snapshot with nothing
    // staged returned a quiet `{ rows: [], total: 0 }` instead of the same named refusal a
    // caller with staged data gets. Moving both checks beside the `fields` whitelist — which
    // was moved above the guard for exactly this reason — makes the refusal unconditional.
    const type = contractType('ReadNonFinitePageUnstaged');
    await store.ensureType(type);
    await store.commit(type, 'run-1');
    await expect(store.read(type, FIELDS, { page: Number.NaN })).rejects.toThrow(
      /page must be a finite number/,
    );
  });

  it('refuses a non-finite page size even when nothing is staged yet', async () => {
    const type = contractType('ReadNonFiniteSizeUnstaged');
    await store.ensureType(type);
    await store.commit(type, 'run-1');
    await expect(store.read(type, FIELDS, { size: Number.NaN })).rejects.toThrow(
      /size must be a finite number/,
    );
  });

  it('applies a filter to both the count and the page it returns', async () => {
    const type = contractType('ReadFilterBoth');
    await store.ensureType(type);
    await store.write(
      type,
      [contractRow('a', 'alpha', 1), contractRow('b', 'bravo', 2), contractRow('c', 'charlie', 3)],
      { snapshotId: 'run-1', principalId: 'tester', batch: 0 },
    );
    await store.commit(type, 'run-1');

    const label = type.properties.find((property) => property.name === 'label');
    if (!label) throw new Error('fixture is missing its own label property');

    const result = await store.read(type, FIELDS, {
      filters: [{ property: label, op: 'eq', value: 'bravo' }],
    });

    // Proves the predicate NARROWS rather than merely compiling: a store that ignored the
    // filter would answer with all three rows and a total of 3, same as an unfiltered read.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.label).toBe('bravo');
    expect(result.total).toBe(1);
  });

  it('refuses a filter on a column the same read declined to return', async () => {
    // A predicate over a column outside `fields` narrows which rows come back without ever
    // putting the column in the SELECT list — a range operator lets a caller who cannot see
    // the column binary-search its value one request at a time. This is the control pair: the
    // refusing case below, and this one showing the identical filter still works when the
    // property IS among the requested fields, so the refusal is about the fields mismatch and
    // not about the filter itself being malformed.
    const type = contractType('ReadFilterOutsideFields');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'alpha', 1), contractRow('b', 'bravo', 2)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 0,
    });
    await store.commit(type, 'run-1');

    const label = type.properties.find((property) => property.name === 'label');
    if (!label) throw new Error('fixture is missing its own label property');

    await expect(
      store.read(type, ['id'], { filters: [{ property: label, op: 'eq', value: 'alpha' }] }),
    ).rejects.toThrow(/label/i);

    // Control: the identical filter, on a read that DOES select `label`, still narrows.
    const allowed = await store.read(type, ['id', 'label'], {
      filters: [{ property: label, op: 'eq', value: 'alpha' }],
    });
    expect(allowed.rows.map((row) => row.id)).toEqual(['a']);
  });

  it('narrows on a range operator over a number column, against the real engine', async () => {
    // `filters.spec.ts` only proves `gt`/`gte`/`lt`/`lte` compile to a string containing the
    // right operator; nothing there proves the predicate reaches the engine and actually
    // narrows. A `predicateFor` returning the literal `'TRUE'` for all four would pass every
    // unit test in that file and every case here except this one and the date case below.
    const type = contractType('ReadFilterNumberRange');
    await store.ensureType(type);
    await store.write(
      type,
      [
        contractRow('a', 'alpha', 10),
        contractRow('b', 'bravo', 20),
        contractRow('c', 'charlie', 30),
      ],
      { snapshotId: 'run-1', principalId: 'tester', batch: 0 },
    );
    await store.commit(type, 'run-1');

    const score = type.properties.find((property) => property.name === 'score');
    if (!score) throw new Error('fixture is missing its own score property');

    const gte = await store.read(type, FIELDS, {
      filters: [{ property: score, op: 'gte', value: 20 }],
    });
    expect(gte.rows.map((row) => row.id)).toEqual(['b', 'c']);
    expect(gte.total).toBe(2);

    const lt = await store.read(type, FIELDS, {
      filters: [{ property: score, op: 'lt', value: 20 }],
    });
    expect(lt.rows.map((row) => row.id)).toEqual(['a']);
    expect(lt.total).toBe(1);
  });

  it('narrows on a range operator over a date column, against the real engine', async () => {
    const type = contractType('ReadFilterDateRange');
    await store.ensureType(type);
    // Raw rows rather than `contractRow`, which pins every row to one fixed `seenAt` — a
    // range filter over a column with a single distinct value could not prove narrowing.
    await store.write(
      type,
      [
        { id: 'a', label: 'alpha', score: 1, active: true, seenAt: '2026-01-01T00:00:00.000Z' },
        { id: 'b', label: 'bravo', score: 2, active: true, seenAt: '2026-02-01T00:00:00.000Z' },
        { id: 'c', label: 'charlie', score: 3, active: true, seenAt: '2026-03-01T00:00:00.000Z' },
      ],
      { snapshotId: 'run-1', principalId: 'tester', batch: 0 },
    );
    await store.commit(type, 'run-1');

    const seenAt = type.properties.find((property) => property.name === 'seenAt');
    if (!seenAt) throw new Error('fixture is missing its own seenAt property');

    const result = await store.read(type, FIELDS, {
      filters: [{ property: seenAt, op: 'gte', value: new Date('2026-02-01T00:00:00.000Z') }],
    });
    expect(result.rows.map((row) => row.id)).toEqual(['b', 'c']);
    expect(result.total).toBe(2);
  });

  it('narrows with notEmpty, against the real engine', async () => {
    const type = contractType('ReadFilterNotEmpty');
    await store.ensureType(type);
    await store.write(
      type,
      [
        { id: 'a', label: 'alpha', score: 1, active: true, seenAt: '2026-01-01T00:00:00.000Z' },
        { id: 'b', label: '', score: 2, active: true, seenAt: '2026-01-01T00:00:00.000Z' },
      ],
      { snapshotId: 'run-1', principalId: 'tester', batch: 0 },
    );
    await store.commit(type, 'run-1');

    const label = type.properties.find((property) => property.name === 'label');
    if (!label) throw new Error('fixture is missing its own label property');

    const result = await store.read(type, FIELDS, {
      filters: [{ property: label, op: 'notEmpty' }],
    });
    expect(result.rows.map((row) => row.id)).toEqual(['a']);
    expect(result.total).toBe(1);
  });

  it('treats an empty string as no value on a uuid column, alongside NULL', async () => {
    // `filterOperatorsFor` offers `empty`/`notEmpty` to `uuid` and `unknown` columns exactly
    // as it does to `string`, and `coerce` writes `''` through verbatim on all three — so a
    // gate on `type === 'string'` alone would answer this column's `''` row wrongly in both
    // directions: `empty` would miss it (NULL-only) and `notEmpty` would wrongly include it
    // (NULL-only, inverted). Both are asserted here against a real `''` row and a real NULL
    // row, not merely against the predicate's rendered text.
    const type = uuidColumnType('ReadEmptyUuid');
    await store.ensureType(type);
    await store.write(
      type,
      [
        { id: 'blank', tag: '' },
        { id: 'missing', tag: null },
        { id: 'present', tag: 'a45f0e2e-0000-4000-8000-000000000000' },
      ],
      { snapshotId: 'run-1', principalId: 'tester', batch: 0 },
    );
    await store.commit(type, 'run-1');

    const tag = type.properties.find((property) => property.name === 'tag');
    if (!tag) throw new Error('fixture is missing its own tag property');

    const empty = await store.read(type, ['id', 'tag'], {
      filters: [{ property: tag, op: 'empty' }],
    });
    expect(empty.rows.map((row) => row.id).sort()).toEqual(['blank', 'missing']);
    expect(empty.total).toBe(2);

    const notEmpty = await store.read(type, ['id', 'tag'], {
      filters: [{ property: tag, op: 'notEmpty' }],
    });
    expect(notEmpty.rows.map((row) => row.id)).toEqual(['present']);
    expect(notEmpty.total).toBe(1);
  });

  it('matches a search term against every visible string column, case-insensitively', async () => {
    const type = contractType('ReadSearchAcrossColumns');
    await store.ensureType(type);
    await store.write(
      type,
      [
        contractRow('a', 'Alpha Team', 1),
        contractRow('b', 'Bravo Squad', 2),
        contractRow('c', 'Charlie Crew', 3),
        // `id` is a `string` property too, and is deliberately the ONLY column carrying this
        // term: a `searchPredicate` that only ever inspected the first string property
        // (`label`, in `FIELDS`' declared order) would pass the `bravo` case below by
        // matching `label` alone and never prove the `OR` across columns at all. Matching
        // `zulu-marker` on `id` — with a `label` that does not contain it — is what that case
        // for the `OR` actually is.
        contractRow('zulu-marker', 'Nothing special', 4),
      ],
      { snapshotId: 'run-1', principalId: 'tester', batch: 0 },
    );
    await store.commit(type, 'run-1');

    const byLabel = await store.read(type, FIELDS, { search: 'bravo' });
    expect(byLabel.rows.map((row) => row.id)).toEqual(['b']);
    expect(byLabel.total).toBe(1);

    const byId = await store.read(type, FIELDS, { search: 'zulu-marker' });
    expect(byId.rows.map((row) => row.id)).toEqual(['zulu-marker']);
    expect(byId.total).toBe(1);
  });

  it('leaves the result unfiltered when search is blank or only whitespace', async () => {
    const type = contractType('ReadSearchBlank');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'Alpha', 1), contractRow('b', 'Bravo', 2)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 0,
    });
    await store.commit(type, 'run-1');

    const result = await store.read(type, FIELDS, { search: '   ' });
    expect(result.total).toBe(2);
  });

  it('does not search a classified string column', async () => {
    const type = classifiedType('ReadSearchClassified');
    await store.ensureType(type);
    await store.write(
      type,
      [
        { id: 'a', label: 'nothing interesting', secret: 'zulu-target' },
        { id: 'b', label: 'zulu team', secret: 'unrelated' },
      ],
      { snapshotId: 'run-1', principalId: 'tester', batch: 0 },
    );
    await store.commit(type, 'run-1');

    const result = await store.read(type, ['id', 'label', 'secret'], { search: 'zulu' });
    // Row `a` matches only in the classified `secret` column. A search that covered it would
    // leak the classified value's presence through row membership — only `b`, matching in
    // the plain `label` column, comes back.
    expect(result.rows.map((row) => row.id)).toEqual(['b']);
  });

  it('orders by an explicit sort column and honours dir', async () => {
    const type = contractType('ReadSortExplicit');
    await store.ensureType(type);
    await store.write(
      type,
      [contractRow('a', 'charlie', 3), contractRow('b', 'alpha', 1), contractRow('c', 'bravo', 2)],
      { snapshotId: 'run-1', principalId: 'tester', batch: 0 },
    );
    await store.commit(type, 'run-1');

    const ascending = await store.read(type, FIELDS, { sort: 'label', dir: 'asc' });
    expect(ascending.rows.map((row) => row.label)).toEqual(['alpha', 'bravo', 'charlie']);

    const descending = await store.read(type, FIELDS, { sort: 'label', dir: 'desc' });
    expect(descending.rows.map((row) => row.label)).toEqual(['charlie', 'bravo', 'alpha']);
  });

  it('falls back to batch/row order when sort names a property the read does not return', async () => {
    // `CatalogService.readObjects` already narrows `query.sort` to a real, visible column
    // before a store ever sees one (`catalog.service.ts`: `columns.some((c) => c.name ===
    // query.sort) ? query.sort : undefined`) — an unrecognised name becomes `undefined`
    // there, nothing more; no primary-key substitution happens anywhere downstream. This test
    // is the store's own defence for a caller that bypasses the service and hands `read` a
    // `sort` directly, matching the ClickHouse sibling: a `sort` naming nothing among the
    // selected properties is not a refusal, it is silently ignored in favour of the same
    // (_batch, _row) order an unsorted read gets.
    const type = contractType('ReadSortUnknown');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'first', 1), contractRow('b', 'second', 2)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 0,
    });
    await store.commit(type, 'run-1');

    const result = await store.read(type, FIELDS, { sort: 'not-a-real-property' });
    expect(result.rows.map((row) => row.id)).toEqual(['a', 'b']);
  });

  it('breaks ties in an explicit sort with the batch/row order', async () => {
    const type = contractType('ReadSortTiebreak');
    await store.ensureType(type);
    await store.write(
      type,
      [contractRow('a', 'same', 1), contractRow('b', 'same', 2), contractRow('c', 'same', 3)],
      { snapshotId: 'run-1', principalId: 'tester', batch: 0 },
    );
    await store.commit(type, 'run-1');

    const result = await store.read(type, FIELDS, { sort: 'label', dir: 'asc' });
    // All three rows tie on `label`; the write order (batch 0, rows 0..2) is what breaks the
    // tie — the explicit sort composes with the fallback ordering rather than replacing it.
    expect(result.rows.map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });
});
