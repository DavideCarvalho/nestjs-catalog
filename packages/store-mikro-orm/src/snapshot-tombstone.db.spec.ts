import type { CatalogObjectTypeDef, CatalogPropertyDef } from '@dudousxd/nestjs-catalog';
import { tableFor } from '@dudousxd/nestjs-catalog-store-mikro-orm';
import type { StartedMySqlContainer } from '@testcontainers/mysql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CatalogDatabase, openCatalogDatabase, startMySql } from '../test/mysql-harness';

/**
 * What survives a drop, and what every reader does when it meets what survived.
 *
 * ## The state under test
 *
 * `dropSnapshot` used to delete two things: the snapshot's rows from
 * `obj_<type>`, and its row from `catalog_snapshot`. The second deletion is what
 * kept the first one off any schedule — `catalog_connector_run.snapshotId` names
 * a snapshot, so removing the record turns the run log into a list of pointers
 * to nothing, and the store already treats an unresolvable pointer as a defect.
 *
 * They are separable. The disk is held by the rows; the history is held by the
 * record. These cases are the record surviving on its own, and every path that
 * could quietly present the survivor as data refusing to.
 *
 * ## Why every case here is about an empty result
 *
 * Because that is what this used to look like from the outside. A snapshot's
 * rows are found by `WHERE _snapshot_id = ?`, so a snapshot with no rows is not
 * an error anywhere — it is zero rows, which is also what a filter matching
 * nothing looks like, and what a load that collapsed looks like. Each assertion
 * below is that some reader says *dropped, on this date* instead of `[]`.
 *
 * ## One type per case
 *
 * Not tidiness. `catalog_snapshot` is one table for the whole catalog and the
 * carry-forward case turns on *which* row a query over it picks, so cases
 * sharing a type would have each other's snapshots as candidates — and the
 * tie-break between two rows written in the same second is their id, which would
 * make the answer depend on the names chosen here.
 */

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

function typeNamed(name: string): CatalogObjectTypeDef {
  return {
    name,
    displayName: name,
    pluralDisplayName: `${name}s`,
    group: 'Retention',
    tableName: name.toLowerCase(),
    primaryKey: ['workOrderNumber'],
    properties: ['workOrderNumber', 'baseCode', 'status'].map(property),
    relations: [],
    enriched: false,
  };
}

const FIELDS = ['workOrderNumber', 'baseCode', 'status'];

function rows(ids: string[]): Array<Record<string, unknown>> {
  return ids.map((id) => ({ workOrderNumber: id, baseCode: 'B-21', status: 'open' }));
}

describe('a dropped snapshot leaves a tombstone', () => {
  let container: StartedMySqlContainer;
  let db: CatalogDatabase;

  beforeAll(async () => {
    container = await startMySql();
    db = await openCatalogDatabase(container, 'tombstones');
  }, 300_000);

  afterAll(async () => {
    await db?.close();
    await container?.stop();
  });

  /**
   * A published type with two loads behind it: an older one of three rows, and
   * a newer one of two that is the one being served.
   */
  async function twoLoads(
    name: string,
  ): Promise<{ type: CatalogObjectTypeDef; older: string; newer: string }> {
    const type = typeNamed(name);
    await db.publish(type);
    await db.store.write(type, rows(['a', 'b', 'c']), {
      snapshotId: 'older',
      principalId: 'loader',
    });
    await db.store.commit(type, 'older');
    await db.store.write(type, rows(['a', 'b']), { snapshotId: 'newer', principalId: 'loader' });
    await db.store.commit(type, 'newer');
    return { type, older: 'older', newer: 'newer' };
  }

  it('keeps the record, with the size it held and the date its rows went', async () => {
    const { type, older } = await twoLoads('TombstoneRecord');

    const before = (await db.store.listSnapshots(type)).find((each) => each.id === older);
    expect(before?.rowCount).toBe(3);
    expect(before?.droppedAt).toBeUndefined();

    await db.store.dropSnapshot(type, older);

    // The whole point, and the assertion that fails without the change: the ref
    // is still there. Under the old behaviour the row was deleted and this find
    // returned undefined, taking with it who loaded it, when, and how large it
    // was — everything a run that names this snapshot would be asked about.
    const after = (await db.store.listSnapshots(type)).find((each) => each.id === older);
    expect(after).toBeDefined();
    expect(after?.principalId).toBe('loader');
    expect(after?.droppedAt).toBeDefined();
    // The count taken immediately before the delete, not a fresh one — a fresh
    // count of a dropped snapshot is zero, and reporting a three-row load as an
    // empty one is the thing a tombstone exists to avoid.
    expect(after?.rowCount).toBe(3);

    // And the rows really are gone. A tombstone that did not reclaim the disk
    // would be a comment.
    const [{ remaining }] = await db.orm.em
      .getConnection()
      .execute<Array<{ remaining: number }>>(
        `SELECT COUNT(*) AS remaining FROM \`${tableFor(type.name)}\` WHERE \`_snapshot_id\` = ?`,
        [older],
      );
    expect(Number(remaining)).toBe(0);
  });

  it('refuses to read one, naming the drop rather than returning no rows', async () => {
    const { type, older } = await twoLoads('TombstoneRead');
    await db.store.dropSnapshot(type, older);

    await expect(
      db.store.read(type, FIELDS, { page: 1, size: 25, snapshot: older }),
    ).rejects.toThrow(/dropped on/i);

    // The read that was not asked to time-travel is untouched: the served
    // snapshot cannot be a tombstone, so nothing on the hot path had to change.
    const current = await db.store.read(type, FIELDS, { page: 1, size: 25 });
    expect(current.total).toBe(2);
  });

  it('refuses to stream one, so a workflow cannot read it as an empty dataset', async () => {
    const { type, older } = await twoLoads('TombstoneStream');
    await db.store.dropSnapshot(type, older);

    await expect(async () => {
      for await (const _row of db.store.streamSnapshot(type, FIELDS, older)) {
        // The failure this guards is that the loop body never runs and the
        // consumer calls that success — so reaching here at all is the bug.
        throw new Error('a dropped snapshot yielded a row');
      }
    }).rejects.toThrow(/dropped on/i);
  });

  it('refuses to commit one, which is how a type would come to serve nothing', async () => {
    const { type, older, newer } = await twoLoads('TombstoneCommit');
    await db.store.dropSnapshot(type, older);

    // Rolling back to a snapshot whose rows were dropped. The refusal has to be
    // here rather than in the row-count bound above it: `commit` recounts, would
    // find zero, and its own empty-snapshot branch only *logs*.
    await expect(db.store.commit(type, older)).rejects.toThrow(/dropped on/i);

    const current = await db.store.currentSnapshot(type);
    expect(current?.id).toBe(newer);
  });

  it('will not drop what the type is serving, which is what keeps reads free of the question', async () => {
    const { type, newer } = await twoLoads('TombstoneServed');
    await expect(db.store.dropSnapshot(type, newer)).rejects.toThrow(/being served/i);
  });

  it('does not carry forward from one, which would truncate the next load', async () => {
    // The reachable route to the state: two committed loads, roll back to the
    // older one, then drop the bad newer one. The newest committed row is now a
    // tombstone, and it is not the one being served.
    const { type, older, newer } = await twoLoads('TombstoneCarry');
    await db.store.commit(type, older);
    await db.store.dropSnapshot(type, newer);

    // An incremental load that fetched one changed row.
    await db.store.write(type, rows(['a']), { snapshotId: 'next', principalId: 'loader' });
    const result = await db.store.carryForward(type, 'next', { principalId: 'loader' });

    // Carried from the snapshot that still has its data, not from the tombstone.
    // Against the tombstone this would be `carried: 0` and a total of 1 — a full
    // replacement wearing an incremental load's name, committed without a word.
    expect(result.from).toBe(older);
    expect(result.carried).toBe(2);
    expect(result.total).toBe(3);
  });

  it('is idempotent, and does not rewrite the drop date on a replay', async () => {
    const { type, older } = await twoLoads('TombstoneReplay');
    await db.store.dropSnapshot(type, older);
    const first = (await db.store.listSnapshots(type)).find((each) => each.id === older);

    await db.store.dropSnapshot(type, older);
    const second = (await db.store.listSnapshots(type)).find((each) => each.id === older);

    expect(second?.droppedAt).toBe(first?.droppedAt);
    expect(second?.rowCount).toBe(3);
  });
});
