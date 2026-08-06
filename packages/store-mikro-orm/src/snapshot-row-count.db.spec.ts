import type { CatalogObjectTypeDef, CatalogPropertyDef } from '@dudousxd/nestjs-catalog';
import type { StartedMySqlContainer } from '@testcontainers/mysql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CatalogDatabase, openCatalogDatabase, startMySql } from '../test/mysql-harness';
import { SnapshotRow } from './entities/governance';

/**
 * Where a snapshot's `rowCount` comes from, and how often it is paid for.
 *
 * ## The cost this is about
 *
 * `write()` used to end every batch with `SELECT COUNT(*) ... WHERE
 * _snapshot_id = ?`. The predicate names the snapshot, not the batch, so the
 * scan grows with the snapshot while the number of scans grows with the load:
 * O(rows² / batch). Measured on a local container against a 42-column shape,
 * one count costs 1.7ms over 10,000 rows and 14.4ms over 100,000 — linear, as
 * an index range scan should be — which makes the counting alone 0.03s and
 * 2.87s for loads of those sizes. At the 783,000 rows a deployment's Subwo load
 * carries, in batches of 500, that term dominates everything else the load does.
 *
 * ## What must not break to fix it
 *
 * Three properties, and the first is why the count was where it was:
 *
 * 1. **A replaced batch must not double-count.** A retried durable step
 *    re-sends its batches and `write` answers with delete-then-reinsert, so
 *    anything that added rows as they arrived would count a re-sent batch twice.
 * 2. **A replay must not drift.** The count has to converge on what the table
 *    holds however many times a step runs, which is what rules out
 *    `rowCount += inserted - deleted`: `write`'s three statements are not one
 *    transaction, so a crash between the INSERT and the snapshot flush leaves
 *    arithmetic permanently short by a batch.
 * 3. **The row-count bound still gets a real number.** It reads the *pending*
 *    snapshot's size through `listSnapshots`, before `commit` — so a count
 *    taken only at commit would arrive after the check that needs it.
 */

const TYPE_NAME = 'CountedSubwo';

function property(name: string, index: number): CatalogPropertyDef {
  return {
    name,
    displayName: name,
    type: 'string',
    columnName: name,
    nullable: index > 0,
    primary: index === 0,
    hidden: false,
    order: index,
    enriched: false,
  };
}

const TYPE: CatalogObjectTypeDef = {
  name: TYPE_NAME,
  displayName: 'Counted Subwo',
  pluralDisplayName: 'Counted Subwos',
  group: 'Measurement',
  tableName: 'counted_subwo',
  primaryKey: ['workOrderNumber'],
  properties: ['workOrderNumber', 'baseCode', 'status'].map(property),
  relations: [],
  enriched: false,
};

function rows(count: number, from = 0): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    workOrderNumber: `WO-${from + i}`,
    baseCode: 'B-21',
    status: 'open',
  }));
}

/** Statements that count a whole snapshot, which is the cost under measurement. */
function snapshotCounts(log: readonly string[]): string[] {
  return log.filter(
    (sql) => /count\(\*\)/i.test(sql) && /_snapshot_id/i.test(sql) && !/_batch/i.test(sql),
  );
}

describe('snapshot row count', () => {
  let container: StartedMySqlContainer;
  let db: CatalogDatabase;
  const log: string[] = [];

  beforeAll(async () => {
    container = await startMySql();
    db = await openCatalogDatabase(container, 'counted', (sql) => log.push(sql));
    await db.publish(TYPE);
  }, 300_000);

  afterAll(async () => {
    await db?.close();
    await container?.stop();
  });

  /**
   * The measurement, as an assertion.
   *
   * Counted from MikroORM's own query log rather than inferred, because the
   * whole point is what reached the server. Before this change a load of ten
   * batches issued ten of these; now the only one is the count `commit` takes.
   */
  it('counts the snapshot once per load, not once per batch', async () => {
    const BATCHES = 10;
    log.length = 0;

    for (let batch = 0; batch < BATCHES; batch += 1) {
      await db.store.write(TYPE, rows(20, batch * 20), {
        snapshotId: 'census',
        principalId: 'loader',
        batch,
      });
    }

    expect(snapshotCounts(log)).toHaveLength(0);

    // And the write that used to carry the count away with it. `rowCount` was
    // the only field a batch after the first one changed, so maintaining it
    // meant an UPDATE of `catalog_snapshot` per batch as well as the scan;
    // with nothing to change, MikroORM's change tracking issues neither. Worth
    // asserting separately because it is a round trip rather than a scan, and
    // round trips are what a remote database charges for: measured over these
    // ten batches, 70 statements before and 33 after.
    const snapshotUpdates = log.filter((sql) => /update .*catalog_snapshot/i.test(sql));
    expect(snapshotUpdates).toHaveLength(0);

    log.length = 0;
    const ref = await db.store.commit(TYPE, 'census');

    expect(snapshotCounts(log)).toHaveLength(1);
    expect(ref.rowCount).toBe(200);
  });

  /**
   * The property that rules out arithmetic, stated directly.
   *
   * The stored number is corrupted by hand — which is what a crash between the
   * INSERT and the snapshot flush would leave behind, and what any scheme that
   * accumulates deltas would leave behind permanently — and then the snapshot is
   * committed with no further writes. A commit that trusted the row would
   * publish the wrong size; one that asks the table cannot.
   */
  it('commits the size the table holds, not the size the row claims', async () => {
    await db.store.write(TYPE, rows(120), {
      snapshotId: 'drifted',
      principalId: 'loader',
      batch: 0,
    });

    const em = db.em.fork();
    const stored = await em.findOne(SnapshotRow, { id: `${TYPE_NAME}:drifted` });
    if (!stored) throw new Error('the write did not create a snapshot row');
    stored.rowCount = 999_999;
    await em.flush();

    const ref = await db.store.commit(TYPE, 'drifted');
    expect(ref.rowCount).toBe(120);
  });

  /**
   * The reason the count was taken from the table in the first place. A batch
   * re-sent smaller replaces its predecessor rather than adding to it.
   */
  it('does not double-count a replaced batch', async () => {
    await db.store.write(TYPE, rows(50), { snapshotId: 'replaced', principalId: 'l', batch: 0 });
    await db.store.write(TYPE, rows(50, 50), {
      snapshotId: 'replaced',
      principalId: 'l',
      batch: 1,
    });
    // Batch 1 again, and shorter: 50 rows leave, 10 arrive.
    await db.store.write(TYPE, rows(10, 50), {
      snapshotId: 'replaced',
      principalId: 'l',
      batch: 1,
    });

    const ref = await db.store.commit(TYPE, 'replaced');
    expect(ref.rowCount).toBe(60);
  });

  /**
   * A whole load re-sent, which is what a retried durable step does. The count
   * must land on the same number however many times the run replays.
   */
  it('does not drift when the whole load replays', async () => {
    const send = async (): Promise<void> => {
      for (let batch = 0; batch < 4; batch += 1) {
        await db.store.write(TYPE, rows(25, batch * 25), {
          snapshotId: 'replayed',
          principalId: 'l',
          batch,
        });
      }
    };

    await send();
    await send();
    await send();

    const ref = await db.store.commit(TYPE, 'replayed');
    expect(ref.rowCount).toBe(100);
  });

  /**
   * What the row-count bound reads, and the reason `listSnapshots` counts the
   * uncommitted rows it reports instead of handing back what they store.
   * `PublishService.assertRowCountIsPlausible` runs *before* `commit`, so a
   * store that only counted at commit would hand the bound a zero for every
   * load and refuse them all.
   */
  it('reports an uncommitted snapshot at the size it actually holds', async () => {
    await db.store.write(TYPE, rows(37), { snapshotId: 'pending', principalId: 'l', batch: 0 });

    const listed = await db.store.listSnapshots(TYPE);
    const pending = listed.find((snapshot) => snapshot.id === 'pending');

    expect(pending).toBeDefined();
    expect(pending?.rowCount).toBe(37);
  });

  /**
   * An empty snapshot is a real state — a source that legitimately emptied — and
   * it produces no group row for the count to find. Reported as zero rather
   * than as whatever the row last said, which is the difference between seeing
   * a collapse and seeing yesterday's size.
   */
  it('reports an empty snapshot as zero rather than as its last size', async () => {
    await db.store.write(TYPE, rows(80), { snapshotId: 'emptied', principalId: 'l', batch: 0 });

    // The same batch, now carrying nothing: the load retracted its rows.
    await db.store.write(TYPE, [], { snapshotId: 'emptied', principalId: 'l', batch: 0 });

    const listed = await db.store.listSnapshots(TYPE);
    expect(listed.find((snapshot) => snapshot.id === 'emptied')?.rowCount).toBe(0);

    const ref = await db.store.commit(TYPE, 'emptied');
    expect(ref.rowCount).toBe(0);
  });
});
