// First, and a side-effect import on purpose — see the note in `mysql-harness.ts`.
import 'reflect-metadata';
import { MySqlCatalogTraceStore } from '@dudousxd/nestjs-catalog-store-mikro-orm';
import type { StartedMySqlContainer } from '@testcontainers/mysql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { describeTraceStoreContract } from '../../../test/trace-store-contract';
import { insertAuditRows } from '../test/audit-seed';
import { type CatalogDatabase, openCatalogDatabase, startMySql } from '../test/mysql-harness';

/**
 * The trace query, against the engine that has to plan it.
 *
 * `audit-recorder.spec.ts` covers the write half over stubs. What a stub cannot
 * cover is this, because here the statement *is* the design: four CTEs, a
 * lifecycle rank inlined into a `GROUP_CONCAT`, and — since the rewrite this
 * file was added for — two different statement shapes depending on whether the
 * caller filtered by outcome. A fake answers from its own contents whatever it
 * is asked, so a page that silently ordered by the wrong key, or a filter that
 * quietly dropped the middle of a trace, passes everywhere except here.
 *
 * Two things this file exists to hold still, both of which a plausible
 * "optimisation" breaks:
 *
 * 1. **Same-millisecond spans stay in causal order.** The fixture below writes
 *    a whole load onto one timestamp with ids that sort *backwards*, so only
 *    the lifecycle rank can put it right. Delete the rank from the `ORDER BY`
 *    and the trace reads finished-first, which is the bug the rank was
 *    introduced for and is invisible in any seed whose ids happen to agree.
 * 2. **Paging is stable.** The page is now chosen on `MIN(occurred_at)` before
 *    anything is graded, and displayed on `started_at`, which is the same
 *    number computed a second time. If those two ever stop being the same
 *    number, pages overlap and traces fall between them — so the cases here
 *    walk the whole list a page at a time and check that what comes back is
 *    every trace, once.
 *
 * The plan assertion at the end is a performance claim written as a fact rather
 * than as a stopwatch: on a table with 30k traces the default page must be
 * answered from `(snapshot_id, occurred_at)` and must not scan the table. A
 * timing threshold here would measure the CI runner; the plan measures the
 * query.
 */
let container: StartedMySqlContainer;
let db: CatalogDatabase;
let store: MySqlCatalogTraceStore;

beforeAll(async () => {
  container = await startMySql();
  db = await openCatalogDatabase(container, 'traces');
  store = new MySqlCatalogTraceStore(db.em);
}, 300_000);

afterAll(async () => {
  await db?.close();
  await container?.stop();
});

// The engine-neutral cases: the same ones the Drizzle store runs on Postgres.
describe('the MikroORM trace store on MySQL', () => {
  describeTraceStoreContract(async () => ({
    name: 'mikro-orm (mysql)',
    store,
    insertEvents: (rows) => insertAuditRows(db.em, rows),
    analyze: async () => {
      await db.em.getConnection().execute('ANALYZE TABLE catalog_audit_event');
    },
  }));

  // MySQL only: the plan the statement's join hint exists to force.
  /**
   * The performance claim, as a fact about the plan.
   *
   * Before the rewrite every filter was written against a CTE that spooled the
   * whole linked half of the table into a temporary table, so none of the four
   * indexes on `catalog_audit_event` could be reached and the default page cost
   * three passes over everything. This asserts the two halves of the fix: the
   * page is chosen from the index without reading rows, and nothing in the
   * statement scans the table.
   */
  it('answers the default page from an index, without scanning the table', async () => {
    const plan = await explainDefaultPage();

    // The page itself: chosen off the index, no rows read.
    expect(plan).toContain(
      'Covering index skip scan for grouping on e using catalog_audit_event_snapshot_id_occurred_at_index',
    );
    // And the spans, twice — once to aggregate the page and once to return it —
    // looked up per trace rather than found by scanning.
    expect(
      plan.match(/Index lookup on e using catalog_audit_event_snapshot_id_occurred_at_index/g),
    ).toHaveLength(2);
    // `Table scan on e` over the base table is what the old statement did three
    // times per request. The scans left in this plan are over CTE results, which
    // the plan names `<temporary>`.
    expect(plan).not.toMatch(/Table scan on e\b/);
  });
});

/**
 * The plan for exactly what the explorer asks on load.
 *
 * The statement is taken off the connection as the store issues it rather than
 * pasted in here, so what this asserts about cannot drift from what ships. The
 * default page binds no parameters — there is no filter — so it can be handed
 * straight back to `EXPLAIN ANALYZE`; anything with a `?` in it would need the
 * bindings too, and this case is deliberately the one that does not.
 */
async function explainDefaultPage(): Promise<string> {
  const connection = db.em.getConnection();
  const issued: string[] = [];
  const original = connection.execute.bind(connection);

  const spy = vi
    .spyOn(connection, 'execute')
    .mockImplementation((...args: Parameters<typeof original>) => {
      if (typeof args[0] === 'string') issued.push(args[0]);
      return original(...args);
    });
  try {
    await store.listTraces({ limit: 50 });
  } finally {
    spy.mockRestore();
  }

  const sql = issued.find((statement) => statement.includes('STRAIGHT_JOIN'));
  if (sql === undefined) {
    throw new Error(
      `The trace page no longer issues the span join this case explains. Saw: ${issued.join(' | ')}`,
    );
  }

  const plan = await connection.execute<Array<Record<string, string>>>(`EXPLAIN ANALYZE ${sql}`);
  return Object.values(plan[0] ?? {}).join('\n');
}
