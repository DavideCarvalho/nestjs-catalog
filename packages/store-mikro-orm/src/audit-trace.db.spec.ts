// First, and a side-effect import on purpose — see the note in `mysql-harness.ts`.
import 'reflect-metadata';
import { MySqlCatalogTraceStore } from '@dudousxd/nestjs-catalog-store-mikro-orm';
import type { StartedMySqlContainer } from '@testcontainers/mysql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { seedAuditTrail } from '../test/audit-seed';
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

/**
 * One load, entirely inside a single millisecond, written backwards.
 *
 * The ids descend in causal order (`…-9` is the start, `…-0` the finish) and
 * every row carries the same `occurred_at`. So `ORDER BY occurred_at` decides
 * nothing, `ORDER BY id` decides it wrongly, and the only thing that can
 * produce the real story is the lifecycle rank.
 */
async function seedSameMillisecondLoad(
  snapshotId: string,
  at: string,
  status: 'succeeded' | 'failed',
): Promise<void> {
  const causal = [
    'connector.run.started',
    'schema.changed',
    'snapshot.written',
    'snapshot.committed',
    'connector.run.finished',
  ];
  const rows = causal.map((event, index) => ({
    // Descending, so lexical id order is the reverse of the truth.
    id: `${snapshotId}-${causal.length - 1 - index}`,
    event,
    detail: JSON.stringify(
      event === 'connector.run.finished'
        ? {
            status,
            connectorId: 'c1',
            connectorName: 'C One',
            ...(status === 'failed' ? { error: 'The source went away mid-read.' } : {}),
          }
        : event === 'snapshot.committed'
          ? { rowCount: 1234, connectorId: 'c1' }
          : { connectorId: 'c1' },
    ),
  }));

  await db.em.getConnection().execute(
    `INSERT INTO catalog_audit_event
       (id, event, type_name, principal_id, snapshot_id, detail, occurred_at)
     VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
    rows.flatMap((row) => [
      row.id,
      row.event,
      'Mvr',
      'ana@example.com',
      snapshotId,
      row.detail,
      at,
    ]),
  );
}

/**
 * Two loads whose start order and finish order disagree, newer than everything
 * else in the table so they are always the first page.
 *
 * `slow` begins first and takes ten seconds; `quick` begins a second later and
 * is done in one. So by start the newest is `quick`, and by finish the newest
 * is `slow` — the pair exists to make that difference decidable rather than
 * statistical, because in a randomly seeded trail the two orders agree almost
 * everywhere and a case that relies on them disagreeing passes by luck.
 */
async function seedOverlappingPair(): Promise<void> {
  const rows = [
    ['snap-slow-0', 'connector.run.started', 'snap-slow', '2026-06-10 09:00:00.000'],
    ['snap-slow-1', 'connector.run.finished', 'snap-slow', '2026-06-10 09:00:10.000'],
    ['snap-quick-0', 'connector.run.started', 'snap-quick', '2026-06-10 09:00:01.000'],
    ['snap-quick-1', 'connector.run.finished', 'snap-quick', '2026-06-10 09:00:02.000'],
  ];
  await db.em.getConnection().execute(
    `INSERT INTO catalog_audit_event
       (id, event, type_name, principal_id, snapshot_id, detail, occurred_at)
     VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
    rows.flatMap(([id, event, snapshotId, at]) => [
      id,
      event,
      'Overlap',
      'ana@example.com',
      snapshotId,
      JSON.stringify(event === 'connector.run.finished' ? { status: 'succeeded' } : {}),
      at,
    ]),
  );
}

describe('grouping the audit trail into traces', () => {
  beforeAll(async () => {
    await seedAuditTrail(db.em, { traces: 30_000, unlinked: 2_000 });
    await seedSameMillisecondLoad('snap-same-ms', '2026-06-02 09:00:00.000', 'succeeded');
    await seedSameMillisecondLoad('snap-same-ms-failed', '2026-06-02 09:00:01.000', 'failed');
    await seedOverlappingPair();
    // Statistics, because the fixture above arrived as bulk inserts and InnoDB
    // has therefore never sampled this table. Without it the optimiser costs a
    // scan of 173k rows at 0.102 and hash-joins the spans back instead of
    // looking them up, which is not a fact about the statement — it is a fact
    // about a table nothing has measured. A deployment gets this from
    // `innodb_stats_auto_recalc` as the trail grows; a deployment that just
    // restored a dump does not, which is why the docblock on the store says to
    // run this by hand after one.
    await db.em.getConnection().execute('ANALYZE TABLE catalog_audit_event');
  }, 300_000);

  it('orders a same-millisecond trace by the lifecycle rank, not by insertion', async () => {
    const trace = await store.getTrace('snap-same-ms');

    expect(trace).toBeDefined();
    expect(trace?.spans.map((span) => span.event)).toEqual([
      'connector.run.started',
      'schema.changed',
      'snapshot.written',
      'snapshot.committed',
      'connector.run.finished',
    ]);
    // And the rank had to do the work: every span really is on one instant, so
    // a passing assertion above cannot be the timestamps quietly saving it.
    expect(new Set(trace?.spans.map((span) => span.occurredAt))).toHaveProperty('size', 1);
  });

  it('grades a same-millisecond trace from the last terminal event', async () => {
    const trace = await store.getTrace('snap-same-ms');
    expect(trace?.outcome).toBe('succeeded');
    expect(trace?.rowsCommitted).toBe(1234);
  });

  /**
   * The grade depends on the rank too, not just the rendered order.
   *
   * This load committed and *then* failed, inside one millisecond, with ids
   * that sort the other way. `RIGHT(GROUP_CONCAT(... ORDER BY ...), 1)` takes
   * the last terminal marker — so without the rank in that inner `ORDER BY` the
   * concat comes out as the reverse story and the commit is read as the ending.
   * A load that failed would be painted green, and the row count it managed to
   * commit before dying is exactly what makes that look plausible.
   */
  it('grades on the lifecycle rank, so a commit before a failure is not the ending', async () => {
    const trace = await store.getTrace('snap-same-ms-failed');
    expect(trace?.outcome).toBe('failed');
    expect(trace?.error).toBe('The source went away mid-read.');
  });

  it('pages without repeating or losing a trace', async () => {
    const first = await store.listTraces({ limit: 40, offset: 0 });
    const second = await store.listTraces({ limit: 40, offset: 40 });
    const third = await store.listTraces({ limit: 40, offset: 80 });

    const ids = [...first.traces, ...second.traces, ...third.traces].map((trace) => trace.id);
    expect(ids).toHaveLength(120);
    expect(new Set(ids).size).toBe(120);

    // And the concatenation is still in the order the pages claim: every trace
    // starts no later than the one before it.
    const starts = [...first.traces, ...second.traces, ...third.traces].map((trace) =>
      Date.parse(trace.startedAt),
    );
    expect([...starts].sort((a, b) => b - a)).toEqual(starts);
  });

  /**
   * The reason the filter is a semijoin rather than a `WHERE` on the aggregate
   * that chooses the page.
   *
   * `?event=connector.run.finished` matches only the last span of each load.
   * Filter the rows the paging aggregate sees and its key becomes
   * `MIN(occurred_at)` over the *finishes*, so the page is cut by finish order
   * while the list is displayed in start order.
   *
   * Asserted one trace at a time, because a whole page hides it: the tail of
   * the statement re-sorts whatever it was given by `started_at`, so a page
   * that scooped up the wrong traces still comes back internally tidy. The
   * damage is only ever at the boundary — which trace is the last of this page
   * and which is the first of the next — and that is what these two reads are.
   * `snap-slow` starts first but ends last, so the two orders name different
   * traces for position one.
   */
  it('cuts a filtered page on the trace start, not on the span that matched', async () => {
    const first = await store.listTraces({ event: 'connector.run.finished', limit: 1, offset: 0 });
    const second = await store.listTraces({ event: 'connector.run.finished', limit: 1, offset: 1 });

    expect(first.traces.map((trace) => trace.id)).toEqual(['snap-quick']);
    expect(second.traces.map((trace) => trace.id)).toEqual(['snap-slow']);
  });

  it('pages a filtered list on the trace start, not on the matching span', async () => {
    // `connector.run.finished` is the LAST event of a load. Paging on the
    // matching span would order these by when each load ended while displaying
    // when it began — the two orders disagree, and traces fall between pages.
    const query = { event: 'connector.run.finished' } as const;
    const first = await store.listTraces({ ...query, limit: 30, offset: 0 });
    const second = await store.listTraces({ ...query, limit: 30, offset: 30 });

    const ids = [...first.traces, ...second.traces].map((trace) => trace.id);
    expect(new Set(ids).size).toBe(60);

    const starts = [...first.traces, ...second.traces].map((trace) => Date.parse(trace.startedAt));
    expect([...starts].sort((a, b) => b - a)).toEqual(starts);
  });

  it('returns every span of a matched trace, not only the spans that matched', async () => {
    const page = await store.listTraces({ event: 'connector.run.finished', limit: 5 });

    expect(page.traces.length).toBeGreaterThan(0);
    for (const trace of page.traces) {
      expect(trace.spans.length).toBeGreaterThan(1);
      expect(trace.spans.map((span) => span.event)).toContain('connector.run.started');
    }
  });

  it('reports the real total, including for a page past the end of the list', async () => {
    const page = await store.listTraces({ limit: 10, offset: 0 });
    expect(page.total).toBe(30_004); // 30k seeded loads, two same-ms, two overlapping.

    const beyond = await store.listTraces({ limit: 10, offset: 1_000_000 });
    expect(beyond.traces).toHaveLength(0);
    // The old statement carried its total on a row, so an empty page could only
    // say zero — an out-of-range offset claimed the trail was empty.
    expect(beyond.total).toBe(30_004);
  });

  it('counts only the traces a filter matched', async () => {
    const all = await store.listTraces({ limit: 1 });
    const filtered = await store.listTraces({ typeName: 'type_7', limit: 1 });

    expect(filtered.total).toBeGreaterThan(0);
    expect(filtered.total).toBeLessThan(all.total);
    expect(filtered.traces[0]?.typeName).toBe('type_7');
  });

  it('filters by outcome, which needs every candidate graded', async () => {
    const failed = await store.listTraces({ outcome: 'failed', limit: 20 });

    expect(failed.traces.length).toBe(20);
    expect(failed.traces.every((trace) => trace.outcome === 'failed')).toBe(true);
    expect(failed.total).toBeGreaterThan(20);
    // Every one of them carries the reason, which is the only thing this filter
    // is for.
    expect(failed.traces.every((trace) => typeof trace.error === 'string')).toBe(true);
  });

  it('answers an empty outcome selection with nothing, not with everything', async () => {
    const none = await store.listTraces({ outcome: [], limit: 20 });
    expect(none.traces).toHaveLength(0);
    expect(none.total).toBe(0);
  });

  it('agrees with traceTotals about how many traces failed', async () => {
    const page = await store.listTraces({ outcome: 'failed', limit: 1 });
    const totals = await store.traceTotals({ outcome: 'failed' });
    expect(totals.traces).toBe(page.total);
  });

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
