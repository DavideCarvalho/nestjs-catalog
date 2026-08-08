import type { CatalogObjectTypeDef } from '@dudousxd/nestjs-catalog';
import type { StartedMySqlContainer } from '@testcontainers/mysql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contractRow, contractType } from '../../../test/catalog-store-contract';
import {
  type CatalogDatabase,
  openCatalogDatabase,
  startMySql,
} from '../../store-mikro-orm/test/mysql-harness';
import { type CatalogTypeReader, fetchCatalog, toRecordStream } from './sources';

/**
 * Reading a catalogued type back out of the warehouse, with history in the way.
 *
 * ## The measurement this file exists to keep
 *
 * The store **retains every committed snapshot** in `obj_<type>` and tells them
 * apart by a column. That is the whole of time travel and it is the right
 * design — but it means the physical table is not the dataset, it is every load
 * that has ever run stacked on top of each other. A workflow that reaches its
 * own warehouse through a `sql` connector naming that table therefore reads all
 * of them.
 *
 * Measured against a real deployment, with two snapshots present: a source read
 * 89,440 rows where the type holds 44,720, the run finished `succeeded`, and
 * the row count written was **identical** because the downstream `GROUP BY`
 * collapsed the duplicates. What moved was every `SUM` — `actualLaborCost` went
 * from 212,192,113 to 424,384,226 — and every `GROUP_CONCAT`. Nothing anywhere
 * reported a problem, and the one number anybody checks did not move.
 *
 * So the case below writes **two committed snapshots of the same type** and
 * asserts on the count. The control assertion — that the physical table really
 * does hold both — is not decoration: without it a fetcher that read the right
 * number by accident, because only one snapshot existed, would look identical
 * to one that filtered.
 *
 * This is a `*.db.spec.ts` because the subject is what a `WHERE` clause does
 * against a table that has rows in it. A fake store filtering an array would
 * assert that the fake filters.
 */

let container: StartedMySqlContainer;
let db: CatalogDatabase;

beforeAll(async () => {
  container = await startMySql();
  db = await openCatalogDatabase(container, 'catalog');
}, 300_000);

afterAll(async () => {
  await db?.close();
  await container?.stop();
});

/** The seam a `catalog` source reads through, wired to the real store. */
function reader(): CatalogTypeReader {
  return {
    getType: (name: string): CatalogObjectTypeDef | undefined => db.registry.getType(name),
    store: db.store,
  };
}

/** Everything the fetcher yields, as records. */
async function drain(type: string): Promise<Array<Record<string, unknown>>> {
  const stream = toRecordStream(
    await fetchCatalog({
      connector: {
        id: 'node-source',
        name: 'Read the type',
        kind: 'catalog',
        targetType: '',
        config: { objectType: type },
        enabled: true,
        createdBy: 'spec',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      state: {},
      mode: 'full',
      catalog: reader(),
    }),
  );
  const records: Array<Record<string, unknown>> = [];
  for await (const record of stream.records) {
    if (typeof record === 'object' && record !== null && !Array.isArray(record)) {
      records.push({ ...record });
    }
  }
  return records;
}

/** How many rows the table physically holds, whatever any snapshot says. */
async function physicalRows(type: CatalogObjectTypeDef): Promise<number> {
  const rows = await db.em
    .fork()
    .getConnection()
    .execute<Array<{ total: number }>>(`SELECT COUNT(*) AS total FROM \`${type.tableName}\``);
  return Number(rows[0]?.total ?? 0);
}

describe('a catalog source, over a type with history behind it', () => {
  it('reads the current snapshot and not every snapshot ever committed', async () => {
    const type = contractType('SnapshotBleed');
    await db.publish(type);

    await db.store.write(
      type,
      [contractRow('a', 'first load', 1), contractRow('b', 'first load', 2)],
      { snapshotId: 'load-1', principalId: 'spec', batch: 0 },
    );
    await db.store.commit(type, 'load-1');

    await db.store.write(
      type,
      [contractRow('a', 'second load', 10), contractRow('b', 'second load', 20)],
      { snapshotId: 'load-2', principalId: 'spec', batch: 0 },
    );
    await db.store.commit(type, 'load-2');

    // The control. Both loads are still there — this is the retention the store
    // promises, and it is what a `SELECT ... FROM obj_snapshotbleed` returns.
    expect(await physicalRows(type)).toBe(4);

    const records = await drain('SnapshotBleed');

    // Two rows, not four. The count is the assertion that matters: it is the
    // number the real defect left unchanged, because the duplicates only showed
    // up in the sums.
    expect(records).toHaveLength(2);
    // …and they are the *current* load's rows, not the first load's. A fetcher
    // that pinned the oldest snapshot would also report two.
    expect(records.map((row) => row.label).sort()).toEqual(['second load', 'second load']);
    expect(records.map((row) => row.score).sort((a, b) => Number(a) - Number(b))).toEqual([10, 20]);
  });

  it('refuses a type that has never committed, rather than reading nothing', async () => {
    // Zero rows and a green run is the same failure as the one above wearing a
    // different number. A type that has been published but never loaded has no
    // current snapshot at all, and the only honest thing a source can do about
    // that is stop.
    const type = contractType('NeverLoaded');
    await db.publish(type);

    await expect(drain('NeverLoaded')).rejects.toThrow(/no committed snapshot/i);
  });

  it('refuses a type the catalog has never heard of', async () => {
    await expect(drain('NotAType')).rejects.toThrow(/NotAType/);
  });
});
