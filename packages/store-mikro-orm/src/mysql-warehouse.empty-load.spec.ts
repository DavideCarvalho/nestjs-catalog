import type { CatalogObjectTypeDef, CatalogPropertyDef } from '@dudousxd/nestjs-catalog';
import type { EntityManager } from '@mikro-orm/sql';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { SnapshotRow } from './entities/governance';
import { ObjectTypeRow } from './entities/model';
import { MySqlWarehouseStore } from './warehouse.store';

/**
 * A load that produced no rows, and what the store does about it.
 *
 * **The failure this pins.** `write` used to return on an empty array before
 * touching anything, so a load whose source returned nothing left no snapshot
 * row — and the next step, `commit`, refused with "no snapshot has been written
 * for this type". That message is true and it names the wrong event. Nothing
 * failed to be written; a source returned nothing, which is a fact about the
 * source, and the operator holding the wrong sentence goes looking for a lost
 * batch or a dropped connection.
 *
 * **And a second consequence, which is why it was worth fixing rather than
 * rewording.** The acknowledgement an operator attaches to a load that is
 * *meant* to collapse rides on the snapshot's labels — `refuseRowCountDrift`
 * reads it from there, and it is the only thing that lets a deliberate
 * truncation through the row-count bound. With no snapshot there are no labels,
 * so the acknowledgement was inert for precisely the load most likely to need
 * it: the one where the dataset really did go to zero.
 *
 * **Why unit tests and not the `*.db.spec.ts` next door.** That suite runs
 * against a real MySQL and it is right to, because what it pins are properties
 * of the statements this adapter emits. What is pinned here is which statements
 * it emits *at all* — that an empty batch still issues its DELETE, still counts,
 * still creates the snapshot row — and the cheapest way to observe a statement
 * that is not sent is to stand where the driver would be. That also keeps this
 * check on the path CI actually runs, which for a refusal that decides whether a
 * catalog can represent an empty type is where it belongs.
 */

// ---------------------------------------------------------------------------
// A stand-in for the driver: enough of an EntityManager to see what was issued.
// ---------------------------------------------------------------------------

interface StoredRow {
  snapshotId: string;
  batch: number;
}

/**
 * Answers only the queries these paths actually run.
 *
 * Deliberately not a SQL engine. It recognises the four shapes `write` and
 * `commit` issue and throws on anything else, so a statement this file has not
 * thought about surfaces as a failure here rather than as a plausible-looking
 * zero — which is the same reasoning the pipeline store's spec gives for
 * answering only the calls its methods make.
 */
function warehouse(
  options: { rows?: StoredRow[]; snapshots?: SnapshotRow[]; served?: string } = {},
) {
  const table: StoredRow[] = [...(options.rows ?? [])];
  const snapshots = new Map<string, SnapshotRow>(
    (options.snapshots ?? []).map((row) => [row.id, row]),
  );
  const statements: string[] = [];
  let pending: SnapshotRow[] = [];

  const typeRow = new ObjectTypeRow();
  typeRow.name = 'Widget';
  if (options.served !== undefined) typeRow.currentSnapshotId = options.served;

  // Every column the type needs, so `ensureType` finds nothing to do. A table
  // already in line is the uninteresting case here, and the interesting one — a
  // reserved column added later — has a test of its own against a real engine.
  const columns = (): Array<{ COLUMN_NAME: string }> =>
    ['_row', '_snapshot_id', '_principal_id', '_loaded_at', '_batch', 'id', 'label'].map(
      (COLUMN_NAME) => ({ COLUMN_NAME }),
    );

  const deleteBatch = (params: unknown[]): void => {
    const [snapshotId, batch] = params;
    const kept = table.filter((row) => !(row.snapshotId === snapshotId && row.batch === batch));
    table.length = 0;
    table.push(...kept);
  };

  const insertRows = (sql: string, params: unknown[]): number => {
    const [snapshotId, , , batch] = params;
    // One row per `(?` in the VALUES list, which is how this statement is
    // assembled. Counting the parameters instead would need this fake to know
    // the type's column count, which is the thing under test's business.
    const tuples = sql.split('(?').length - 1;
    for (let index = 0; index < tuples; index += 1) {
      table.push({ snapshotId: String(snapshotId), batch: Number(batch) });
    }
    return tuples;
  };

  /**
   * The grouped count `commit` and `listSnapshots` take.
   *
   * Faithful to GROUP BY on the one point these cases turn on: a snapshot
   * holding no rows produces **no row at all** rather than a zero. That is
   * exactly the shape an emptied load arrives in, and it is why the store
   * defaults a miss to 0 rather than to whatever the snapshot row last said.
   */
  const countBySnapshot = (params: unknown[]): Array<{ snapshot: string; total: number }> => {
    const grouped = new Map<string, number>();
    for (const row of table) {
      if (!params.includes(row.snapshotId)) continue;
      grouped.set(row.snapshotId, (grouped.get(row.snapshotId) ?? 0) + 1);
    }
    return [...grouped].map(([snapshot, total]) => ({ snapshot, total }));
  };

  const execute = (sql: string, params: unknown[] = []): Promise<unknown> => {
    statements.push(sql.replace(/\s+/g, ' ').trim());

    if (sql.includes('information_schema.COLUMNS')) return Promise.resolve(columns());
    // The index the write path needs. Answered as already present, because what
    // these cases are about is an empty batch and not schema evolution — see
    // `ensureSnapshotBatchIndex`, whose own behaviour is held by
    // `write-path.db.spec.ts` against a real engine.
    if (sql.includes('information_schema.STATISTICS')) {
      return Promise.resolve([{ INDEX_NAME: 'ix_snapshot_batch' }]);
    }
    if (sql.startsWith('DELETE FROM')) {
      deleteBatch(params);
      return Promise.resolve({ affectedRows: 0 });
    }
    if (sql.startsWith('INSERT INTO')) {
      return Promise.resolve({ affectedRows: insertRows(sql, params) });
    }
    if (sql.includes('AS snapshot, COUNT(*) AS total')) {
      return Promise.resolve(countBySnapshot(params));
    }
    if (sql.startsWith('SELECT COUNT(*) AS total')) {
      return Promise.resolve([
        { total: table.filter((row) => row.snapshotId === params[0]).length },
      ]);
    }
    if (sql.startsWith('CREATE OR REPLACE VIEW')) return Promise.resolve(undefined);
    throw new Error(`This spec answers no such statement: ${sql}`);
  };

  const fake = {
    fork: () => fake,
    getConnection: () => ({ execute }),
    getPlatform: () => ({ quoteValue: (value: string) => `'${value}'` }),
    findOne: (entity: unknown, where: Record<string, string>) => {
      if (entity === SnapshotRow) return Promise.resolve(snapshots.get(where.id ?? '') ?? null);
      if (entity === ObjectTypeRow) return Promise.resolve(typeRow);
      throw new Error('This spec exercises no other entity.');
    },
    create: (_entity: unknown, data: Record<string, unknown>) =>
      Object.assign(new SnapshotRow(), data),
    persist: (row: SnapshotRow) => {
      pending.push(row);
    },
    flush: () => {
      for (const row of pending) snapshots.set(row.id, row);
      pending = [];
      return Promise.resolve();
    },
  };

  // Not a type assertion: `Object.create(null)` is `any`, so the merged value is
  // too, and the declared return type is what narrows it back down.
  const em: EntityManager = Object.assign(Object.create(null), fake);
  return {
    store: new MySqlWarehouseStore(em),
    statements,
    typeRow,
    rowsInTable: () => table.length,
    snapshotOf: (snapshotId: string) => snapshots.get(`Widget:${snapshotId}`),
  };
}

function property(name: string, primary: boolean): CatalogPropertyDef {
  return {
    name,
    displayName: name,
    type: 'string',
    columnName: name,
    nullable: false,
    primary,
    hidden: false,
    order: primary ? 0 : 1,
    enriched: false,
  };
}

const WIDGET: CatalogObjectTypeDef = {
  name: 'Widget',
  displayName: 'Widget',
  pluralDisplayName: 'Widgets',
  tableName: 'obj_widget',
  group: 'Test',
  primaryKey: ['id'],
  enriched: false,
  properties: [property('id', true), property('label', false)],
  relations: [],
};

function storedSnapshot(input: {
  snapshotId: string;
  rowCount: number;
  committed?: boolean;
  labels?: Record<string, string>;
}): SnapshotRow {
  const row = new SnapshotRow();
  row.id = `Widget:${input.snapshotId}`;
  row.typeName = 'Widget';
  row.snapshotId = input.snapshotId;
  row.principalId = 'loader';
  row.rowCount = input.rowCount;
  row.committed = input.committed ?? false;
  row.labels = input.labels;
  row.createdAt = new Date('2020-01-01T00:00:00.000Z');
  return row;
}

// ---------------------------------------------------------------------------

describe('a load that produced no rows', () => {
  it('creates the snapshot, carrying the labels the load was given', async () => {
    // The fix, and the whole of it. The snapshot has to exist for anything
    // downstream to have an opinion about it: the row-count bound needs a count
    // to measure and an acknowledgement to read, and both of those live on this
    // row. Before, there was no row, and `commit` failed on its absence.
    const db = warehouse();

    const result = await db.store.write(WIDGET, [], {
      snapshotId: 'empty',
      principalId: 'loader',
      labels: { _expectShrink: 'the 442nd was decommissioned last week' },
    });

    expect(result).toEqual({ written: 0 });
    const snapshot = db.snapshotOf('empty');
    expect(snapshot?.rowCount).toBe(0);
    expect(snapshot?.committed).toBe(false);
    // The acknowledgement reached the snapshot, which is the only place the
    // bound looks for it. This is the half of the bug that made a deliberate,
    // announced collapse unannounceable.
    expect(snapshot?.labels?._expectShrink).toBe('the 442nd was decommissioned last week');
  });

  it('is not refused as a load whose fields match nothing', async () => {
    // The refusal that guards against a CSV with the wrong headers works by
    // finding no property that any incoming record mentions — which is also true
    // of no records at all. Letting the empty load fall into it would refuse the
    // right thing for a reason that is nonsense on its face, and the operator
    // would be told to look at a transform's field mapping over a batch that has
    // no fields.
    const db = warehouse();

    await expect(
      db.store.write(WIDGET, [], { snapshotId: 'empty', principalId: 'loader' }),
    ).resolves.toEqual({ written: 0 });
  });

  it('still replaces what that batch held, because a batch is what it last said it was', async () => {
    // An empty batch is a batch. A caller re-sending batch 1 after its source
    // stopped returning those rows means the batch is empty now, and leaving the
    // previous attempt's rows in place would hold rows in a snapshot that the
    // caller has retracted them from — with the row count, and every check built
    // on it, agreeing that all is well.
    const db = warehouse({
      rows: [
        { snapshotId: 'load', batch: 1 },
        { snapshotId: 'load', batch: 1 },
        { snapshotId: 'load', batch: 2 },
      ],
      snapshots: [storedSnapshot({ snapshotId: 'load', rowCount: 3 })],
    });

    await db.store.write(WIDGET, [], { snapshotId: 'load', principalId: 'loader', batch: 1 });

    expect(db.rowsInTable()).toBe(1);
    // Asked of the store rather than read off the snapshot row, because the row
    // is no longer where an in-flight count lives: `write` stopped counting the
    // whole snapshot once per batch — see `countBySnapshot` — and `commit` is
    // what establishes the number. The property this case is about is unchanged
    // and is the one being checked: after an empty batch replaced a full one,
    // the snapshot is reported at what actually survived.
    await expect(db.store.commit(WIDGET, 'load')).resolves.toMatchObject({ rowCount: 1 });
    expect(db.statements.some((sql) => sql.startsWith('DELETE FROM'))).toBe(true);
    // And no INSERT, which is only because MySQL has no syntax for inserting no
    // tuples — not a second meaning for the empty case.
    expect(db.statements.some((sql) => sql.startsWith('INSERT INTO'))).toBe(false);
  });

  it('invalidates a merge it lands after, exactly as a batch with rows does', async () => {
    // The consequence of the rule above, and the reason it is one rule rather
    // than two. The carry-forward decides which of the previous snapshot's rows
    // to copy by looking at the batches present when it runs; an empty batch
    // arriving afterwards *removes* rows, so a row it displaced is now neither
    // in this load nor carried, and the merged snapshot is short. Marked rather
    // than repaired, and `commit` refuses on the mark.
    const db = warehouse({
      rows: [{ snapshotId: 'load', batch: 1 }],
      snapshots: [
        storedSnapshot({ snapshotId: 'load', rowCount: 1, labels: { _carriedFrom: 'previous' } }),
      ],
    });

    await db.store.write(WIDGET, [], { snapshotId: 'load', principalId: 'loader', batch: 1 });

    expect(db.snapshotOf('load')?.labels?._carryForwardStale).toBe('true');
    await expect(db.store.commit(WIDGET, 'load')).rejects.toThrow(BadRequestException);
  });

  it('refuses a negative batch number, which used to slip past on an empty array', async () => {
    // Not a new rule, a rule that now applies to the whole of the method. The
    // early return sat above this check, so a caller numbering a batch -1 — the
    // number the store keeps for the rows it carries forward — was told nothing
    // as long as the batch happened to be empty, and told the moment it was not.
    // A refusal that depends on how many rows a caller sent is a refusal nobody
    // can act on.
    const db = warehouse();

    await expect(
      db.store.write(WIDGET, [], { snapshotId: 'empty', principalId: 'loader', batch: -1 }),
    ).rejects.toThrow(/Batch numbers count up from 0/);
  });

  it('commits, and says out loud that it is emptying a type that had rows', async () => {
    // Committing is the right outcome and it is not this store's decision to
    // second-guess: the rule "zero rows never replaces a non-empty dataset"
    // lives with the acknowledgement that suspends it, one layer up, and a
    // refusal here would enforce that rule with no way to answer it. What is
    // left to do is say so — for a host running this adapter with no bound
    // configured, this line is the only thing between an empty load and a blank
    // screen.
    const db = warehouse({
      rows: [{ snapshotId: 'before', batch: 1 }],
      snapshots: [
        storedSnapshot({ snapshotId: 'before', rowCount: 400, committed: true }),
        storedSnapshot({ snapshotId: 'empty', rowCount: 0 }),
      ],
      served: 'before',
    });
    const warnings: string[] = [];
    Reflect.set(Reflect.get(db.store, 'logger'), 'warn', (line: string) => warnings.push(line));

    const ref = await db.store.commit(WIDGET, 'empty');

    expect(ref.rowCount).toBe(0);
    expect(db.typeRow.currentSnapshotId).toBe('empty');
    expect(warnings.join(' ')).toContain('holds no rows');
    expect(warnings.join(' ')).toContain('400');
  });
});

describe('a load that wrote no batch at all', () => {
  it('is refused at commit, naming the source that returned nothing', async () => {
    // The other half, and the one this store genuinely cannot fix. A run that
    // never wrote is indistinguishable here from a run whose source was
    // unreachable and from a snapshot id nobody ever wrote to — there are no
    // rows in any of those cases, and no record either. Inventing an empty
    // snapshot to commit would pick the most destructive reading, so it refuses.
    //
    // What the message has to do is offer the possibility the caller's own logs
    // will not: a source that returned nothing. The other two announce
    // themselves as errors somewhere upstream; "the source is empty" is not an
    // error anywhere and so has no other voice.
    const db = warehouse();

    await expect(db.store.commit(WIDGET, 'never-written')).rejects.toThrow(
      /produced no rows writes no batch/,
    );
    await expect(db.store.commit(WIDGET, 'never-written')).rejects.toThrow(
      /write an empty batch under never-written/,
    );
  });
});
