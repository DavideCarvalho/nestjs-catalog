import type { CatalogObjectTypeDef, CatalogPropertyDef } from '@dudousxd/nestjs-catalog';
import type { StartedMySqlContainer } from '@testcontainers/mysql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CatalogDatabase, openCatalogDatabase, startMySql } from '../test/mysql-harness';
import {
  BATCH_COLUMN,
  SNAPSHOT_BATCH_INDEX,
  SNAPSHOT_COLUMN,
  ident,
  tableFor,
} from './identifiers';
import { MySqlWarehouseStore } from './mysql-warehouse.store';
import { MySqlPipelineStore } from './pipeline.store';

/**
 * What replacing one batch of a large snapshot costs, and what an index does to
 * it.
 *
 * ## The measurement this exists for
 *
 * A deployment's own query log showed `DELETE FROM obj_subwo WHERE _snapshot_id
 * = ? AND _batch = ?` accumulating **821 seconds**, against 15 seconds for the
 * `SELECT COUNT(*)` beside it. Every `obj_*` table is created with exactly one
 * secondary index — `ix_snapshot (_snapshot_id)` — and the delete's predicate
 * names two columns. With `_batch` absent from the index, the engine walks every
 * row of the snapshot and tests the batch on each one, taking row locks the
 * whole way; on a 313,833-row snapshot that is 313k rows traversed to remove ten
 * thousand, thirty times per load.
 *
 * This reproduces that shape at a realistic size and reports what each statement
 * costs with the existing index and with a composite one, so the change is an
 * answer to a number rather than to an intuition.
 *
 * ## What it does not prove
 *
 * A local container with a warm page cache and no other load on it. The real
 * table is bigger, colder and contended, so these numbers are a **lower** bound
 * on the saving rather than an estimate of it — the mechanism is what transfers,
 * not the milliseconds. Wall-clock is reported and never asserted; what is
 * asserted is the plan, read out of `EXPLAIN`, because "which index the engine
 * chose" is the same answer on every machine.
 */

/**
 * Rows in the one snapshot, and how they are split into batches.
 *
 * Under the deployment's 313,833 so the suite stays runnable, and over the size
 * at which the difference is arguable. The batch count is the deployment's: its
 * log shows the delete running 28 times per load.
 */
const SNAPSHOT_ROWS = 300_000;
const BATCHES = 30;
const ROWS_PER_BATCH = SNAPSHOT_ROWS / BATCHES;
/** Rows per INSERT while seeding. Nothing to do with the store's own batching. */
const SEED_CHUNK = 10_000;

const SNAPSHOT = 'snap-under-measurement';

const COLUMNS = [
  'workOrderNumber',
  'baseCode',
  'assetId',
  'status',
  'openedOn',
  'closedOn',
  'description',
  'technician',
  'priority',
  'systemCode',
];

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

/** A type shaped like the one in the log: a handful of columns, many rows. */
const SUBWO: CatalogObjectTypeDef = {
  name: 'MeasuredSubwo',
  displayName: 'Measured Subwo',
  pluralDisplayName: 'Measured Subwos',
  group: 'Measurement',
  tableName: 'measured_subwo',
  primaryKey: ['workOrderNumber'],
  enriched: false,
  properties: COLUMNS.map(property),
  relations: [],
};

let container: StartedMySqlContainer;
let db: CatalogDatabase;

const table = tableFor(SUBWO.name);

async function sql<T extends object>(statement: string, params: unknown[] = []): Promise<T[]> {
  return db.orm.em.getConnection().execute<T[]>(statement, params);
}

/** Milliseconds one statement took, measured around the driver call. */
async function timed(what: string, run: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await run();
  const took = Math.round((performance.now() - started) * 100) / 100;
  console.log(`[write-path] ${what}: ${took}ms`);
  return took;
}

/**
 * Which index the engine chose for a statement, and how many rows it expects to
 * look at.
 *
 * `EXPLAIN` rather than a stopwatch is what the assertions use: a millisecond
 * count depends on the machine and the page cache, and the plan does not.
 */
interface Plan {
  key: string | null;
  rows: number;
}

async function indexesOf(name: string): Promise<string[]> {
  const rows = await sql<{ INDEX_NAME: string }>(
    `SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [name],
  );
  return rows.map((row) => String(row.INDEX_NAME));
}

async function planOf(statement: string, params: unknown[]): Promise<Plan> {
  const rows = await sql<Record<string, unknown>>(`EXPLAIN ${statement}`, params);
  const first = rows[0] ?? {};
  const key = Reflect.get(first, 'key');
  const examined = Number(Reflect.get(first, 'rows') ?? 0);
  return { key: typeof key === 'string' ? key : null, rows: examined };
}

const DELETE_ONE_BATCH = `DELETE FROM ${ident(table)} WHERE ${ident(SNAPSHOT_COLUMN)} = ? AND ${ident(BATCH_COLUMN)} = ?`;
const COUNT_SNAPSHOT = `SELECT COUNT(*) AS total FROM ${ident(table)} WHERE ${ident(SNAPSHOT_COLUMN)} = ?`;

/** Rewrite the rows a batch delete removed, so the next measurement is fair. */
async function refillBatch(batch: number): Promise<void> {
  const columns = [
    SNAPSHOT_COLUMN,
    '_principal_id',
    '_loaded_at',
    BATCH_COLUMN,
    ...SUBWO.properties.map((property) => property.name),
  ];
  const now = new Date();
  for (let offset = 0; offset < ROWS_PER_BATCH; offset += SEED_CHUNK) {
    const size = Math.min(SEED_CHUNK, ROWS_PER_BATCH - offset);
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (let index = 0; index < size; index += 1) {
      const n = batch * ROWS_PER_BATCH + offset + index;
      values.push(SNAPSHOT, 'measurement', now, batch);
      values.push(
        `WO-${n}`,
        `BASE-${n % 12}`,
        `ASSET-${n % 5000}`,
        n % 3 === 0 ? 'open' : 'closed',
        '2026-01-01',
        '2026-02-01',
        `Work order ${n} for a measured load`,
        `tech-${n % 40}`,
        String(n % 5),
        `SYS-${n % 90}`,
      );
      tuples.push(`(${columns.map(() => '?').join(',')})`);
    }
    await sql(
      `INSERT INTO ${ident(table)} (${columns.map(ident).join(',')}) VALUES ${tuples.join(',')}`,
      values,
    );
  }
}

beforeAll(async () => {
  container = await startMySql();
  db = await openCatalogDatabase(container, 'write_path');
  await db.publish(SUBWO);

  // Wind the table back to the shape every existing deployment's tables are in.
  //
  // `ensureType` now creates the composite outright, so a table made here would
  // start already fixed and there would be no "before" to measure. This is what
  // a table created by an older version of this package looks like — one
  // single-column index — and it is also the input the evolution path has to
  // handle, so putting it back is both halves of the measurement.
  await sql(`ALTER TABLE ${ident(table)} DROP INDEX ${ident(SNAPSHOT_BATCH_INDEX)}`);
  await sql(`ALTER TABLE ${ident(table)} ADD INDEX \`ix_snapshot\` (${ident(SNAPSHOT_COLUMN)})`);

  for (let batch = 0; batch < BATCHES; batch += 1) await refillBatch(batch);
  // Without this the optimiser is working from the statistics of an empty
  // table, and every plan below would be a statement about the seeding rather
  // than about the index.
  await sql(`ANALYZE TABLE ${ident(table)}`);

  const [{ total }] = await sql<{ total: number }>(COUNT_SNAPSHOT, [SNAPSHOT]);
  expect(Number(total)).toBe(SNAPSHOT_ROWS);
}, 600_000);

afterAll(async () => {
  await db?.close();
  await container?.stop();
});

describe(`replacing one batch of a ${SNAPSHOT_ROWS.toLocaleString('en')}-row snapshot`, () => {
  it('walks the whole snapshot with only the single-column index', async () => {
    const plan = await planOf(DELETE_ONE_BATCH, [SNAPSHOT, 7]);
    console.log(
      `[write-path] DELETE one batch, before: key=${plan.key}, rows examined ≈ ${plan.rows}`,
    );
    await timed('DELETE one batch, before', () => sql(DELETE_ONE_BATCH, [SNAPSHOT, 7]));

    const count = await planOf(COUNT_SNAPSHOT, [SNAPSHOT]);
    console.log(`[write-path] COUNT the snapshot, before: key=${count.key}`);
    await timed('COUNT the snapshot, before', () => sql(COUNT_SNAPSHOT, [SNAPSHOT]));

    // The finding, as a plan rather than as a duration, and it is sharper than
    // "the index is not selective enough". The engine uses **no index at all**:
    // every row of the snapshot has the same `_snapshot_id`, so `ix_snapshot`
    // narrows nothing and a full table scan is the cheaper of the two bad
    // options. So the cost is not the snapshot's size — it is the whole table's,
    // every other snapshot included.
    // Refilled before the assertions, not after: an assertion that throws would
    // otherwise leave the next case deleting an empty batch and reporting a
    // wonderful number for it. That happened here once.
    await refillBatch(7);

    expect(plan.key).toBeNull();
    expect(plan.rows).toBeGreaterThan(SNAPSHOT_ROWS / 2);
  });

  /**
   * And the index arrives by the path a real deployment takes.
   *
   * `ensureType` rather than a hand-written `ALTER`, because the load-bearing
   * half of this change is not the `CREATE TABLE` — it is that the thirteen
   * tables already sitting in a deployment acquire the index without anybody
   * running anything. A fresh store instance, because `ensureType` remembers
   * per process which tables it has already brought in line.
   */
  it('touches one batch once the index carries the batch column', async () => {
    const store = new MySqlWarehouseStore(db.em);
    await timed('ensureType on an existing table (adds the index)', () => store.ensureType(SUBWO));

    expect(await indexesOf(table)).toContain(SNAPSHOT_BATCH_INDEX);
    // Left alone rather than dropped, and the log says it can go. See
    // `ensureSnapshotBatchIndex`: adding an index is recoverable and dropping
    // one is not, so the second is an operator's call.
    expect(await indexesOf(table)).toContain('ix_snapshot');

    await sql(`ANALYZE TABLE ${ident(table)}`);

    const plan = await planOf(DELETE_ONE_BATCH, [SNAPSHOT, 7]);
    console.log(
      `[write-path] DELETE one batch, after: key=${plan.key}, rows examined ≈ ${plan.rows}`,
    );
    await timed('DELETE one batch, after', () => sql(DELETE_ONE_BATCH, [SNAPSHOT, 7]));

    const count = await planOf(COUNT_SNAPSHOT, [SNAPSHOT]);
    console.log(`[write-path] COUNT the snapshot, after: key=${count.key}`);
    await timed('COUNT the snapshot, after', () => sql(COUNT_SNAPSHOT, [SNAPSHOT]));

    expect(plan.key).toBe(SNAPSHOT_BATCH_INDEX);
    // A batch, not a snapshot. The bound is generous because the optimiser's
    // estimate is an estimate; what matters is that it is an order of magnitude
    // off the whole snapshot rather than equal to it.
    expect(plan.rows).toBeLessThan(SNAPSHOT_ROWS / 4);

    expect(count.key).not.toBeNull();
  });

  /**
   * Whether the composite can *replace* the single-column index or has to sit
   * beside it.
   *
   * A composite whose leading column is `_snapshot_id` answers every
   * `_snapshot_id = ?` lookup as a prefix match, so `ix_snapshot` should be
   * redundant rather than complementary — and a redundant secondary index is not
   * free on this table, because the ingestion pattern here is delete-and-reinsert
   * and every one of those inserts maintains it.
   *
   * "Should be" is the part worth measuring: the composite is the wider key, so
   * a scan of it reads more pages, and the question is whether that shows up.
   */
  it('answers the snapshot-only lookups from the composite alone', async () => {
    await timed('ALTER TABLE DROP INDEX ix_snapshot', () =>
      sql(`ALTER TABLE ${ident(table)} DROP INDEX \`ix_snapshot\``),
    );
    await sql(`ANALYZE TABLE ${ident(table)}`);

    const count = await planOf(COUNT_SNAPSHOT, [SNAPSHOT]);
    console.log(`[write-path] COUNT the snapshot, composite only: key=${count.key}`);
    await timed('COUNT the snapshot, composite only', () => sql(COUNT_SNAPSHOT, [SNAPSHOT]));

    const read = `SELECT * FROM ${ident(table)} WHERE ${ident(SNAPSHOT_COLUMN)} = ? LIMIT 100`;
    const readPlan = await planOf(read, [SNAPSHOT]);
    console.log(`[write-path] a page of the snapshot, composite only: key=${readPlan.key}`);

    // Both still reach an index, so nothing needs `ix_snapshot` to exist.
    expect(count.key).toBe(SNAPSHOT_BATCH_INDEX);
    expect(readPlan.key).toBe(SNAPSHOT_BATCH_INDEX);
  });
});

/**
 * The other statement the deployment's N+1 list named: a read before a write,
 * of a row whose key the caller had just computed.
 *
 * Its log showed `SELECT ... FROM catalog_workflow_stage WHERE id = ?` at 29
 * executions per request — one per batch of every load — and the answer only
 * ever chose between two writes that end in the same row.
 */
describe('staging one node batch', () => {
  it('writes it in a single statement, and a retry replaces rather than appends', async () => {
    const pipeline = new MySqlPipelineStore(db.em);
    const connection = db.orm.em.getConnection();
    const seen: string[] = [];
    const original = Reflect.get(connection, 'execute');
    if (typeof original !== 'function') throw new Error('nothing to count through');
    Reflect.set(connection, 'execute', (...args: unknown[]) => {
      seen.push(String(args[0]).slice(0, 60));
      return Reflect.apply(original, connection, args);
    });

    try {
      const first = await pipeline.writeStage({
        runId: 'run-stage',
        nodeId: 'node-a',
        batch: 3,
        rows: [{ workOrderNumber: 'WO-1' }, { workOrderNumber: 'WO-2' }],
      });
      expect(first).toEqual({ written: 2 });
      expect(seen.length, seen.join(', ')).toBe(1);

      // The retry. A durable step that restarts re-sends its batches, and an
      // append here would silently double a node's output — the guarantee this
      // whole method is shaped around.
      seen.length = 0;
      await pipeline.writeStage({
        runId: 'run-stage',
        nodeId: 'node-a',
        batch: 3,
        rows: [{ workOrderNumber: 'WO-9' }],
      });
      expect(seen.length, seen.join(', ')).toBe(1);
    } finally {
      Reflect.set(connection, 'execute', original);
    }

    const staged = await pipeline.readStage({ runId: 'run-stage', nodeId: 'node-a', batch: 3 });
    expect(staged).toEqual([{ workOrderNumber: 'WO-9' }]);

    const [{ total }] = await sql<{ total: number }>(
      'SELECT COUNT(*) AS total FROM `catalog_workflow_stage` WHERE run_id = ?',
      ['run-stage'],
    );
    expect(Number(total)).toBe(1);
  });
});
