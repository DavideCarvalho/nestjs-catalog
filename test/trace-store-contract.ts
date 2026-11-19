import type { CatalogTraceStore } from '@dudousxd/nestjs-catalog';
import { beforeAll, describe, expect, it } from 'vitest';
import { type SeedEvent, auditTrailRows } from './audit-trail-rows';

/**
 * One contract for every `CatalogTraceStore`: the audit trail grouped into
 * traces, graded and paged.
 *
 * These cases were the MikroORM store's own spec. They moved here so a store on
 * another engine is held to the same answers: the lifecycle order inside one
 * millisecond, the outcome taken from the last terminal event, pages that
 * neither repeat nor lose a trace, totals that agree between `listTraces` and
 * `traceTotals`. What is specific to one engine (the MySQL query plan) stays in
 * that store's spec.
 *
 * The suite owns its table: it seeds 30,000 loads and asserts exact totals, so
 * the store it is given must read an audit table nothing else writes to.
 */
export interface TraceContractStore {
  readonly name: string;
  readonly store: CatalogTraceStore;
  /** Write these rows straight at the store's audit table, ids and times as given. */
  insertEvents(rows: SeedEvent[]): Promise<void>;
  /** Refresh planner statistics after seeding, if the engine has them. */
  analyze?(): Promise<void>;
}

/** 30,000 seeded loads, two same-millisecond loads and two overlapping ones. */
const TRACES = 30_004;

function sameMillisecondLoad(
  snapshotId: string,
  at: string,
  status: 'succeeded' | 'failed',
): SeedEvent[] {
  const causal = [
    'connector.run.started',
    'schema.changed',
    'snapshot.written',
    'snapshot.committed',
    'connector.run.finished',
  ];
  // Ids in REVERSE causal order, so an id tie-break alone would list the trace
  // backwards: only the lifecycle rank can put it right.
  return causal.map((event, index) => ({
    id: `${snapshotId}-${causal.length - 1 - index}`,
    event,
    typeName: 'Mvr',
    principalId: 'ana@example.com',
    snapshotId,
    detail:
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
    occurredAt: at,
  }));
}

/** A slow load that starts first and finishes last, around a quick one. */
function overlappingPair(): SeedEvent[] {
  const rows: Array<[string, string, string, string]> = [
    ['snap-slow-0', 'connector.run.started', 'snap-slow', '2026-06-10T09:00:00.000Z'],
    ['snap-slow-1', 'connector.run.finished', 'snap-slow', '2026-06-10T09:00:10.000Z'],
    ['snap-quick-0', 'connector.run.started', 'snap-quick', '2026-06-10T09:00:01.000Z'],
    ['snap-quick-1', 'connector.run.finished', 'snap-quick', '2026-06-10T09:00:02.000Z'],
  ];
  return rows.map(([id, event, snapshotId, at]) => ({
    id,
    event,
    typeName: 'Overlap',
    principalId: 'ana@example.com',
    snapshotId,
    detail: event === 'connector.run.finished' ? { status: 'succeeded' } : {},
    occurredAt: at,
  }));
}

export function describeTraceStoreContract(setup: () => Promise<TraceContractStore>): void {
  let store: CatalogTraceStore;

  beforeAll(async () => {
    const subject = await setup();
    store = subject.store;
    await subject.insertEvents([
      ...auditTrailRows({ traces: 30_000, unlinked: 2_000 }),
      ...sameMillisecondLoad('snap-same-ms', '2026-06-02T09:00:00.000Z', 'succeeded'),
      ...sameMillisecondLoad('snap-same-ms-failed', '2026-06-02T09:00:01.000Z', 'failed'),
      ...overlappingPair(),
    ]);
    await subject.analyze?.();
  }, 300_000);

  describe('grouping the audit trail into traces', () => {
    it('orders a same-millisecond trace by the lifecycle rank, not by insertion', async () => {
      const trace = await store.getTrace('snap-same-ms');
      expect(trace?.spans.map((span) => span.event)).toEqual([
        'connector.run.started',
        'schema.changed',
        'snapshot.written',
        'snapshot.committed',
        'connector.run.finished',
      ]);
      expect(new Set(trace?.spans.map((span) => span.occurredAt))).toHaveProperty('size', 1);
    });

    it('grades a same-millisecond trace from the last terminal event', async () => {
      const trace = await store.getTrace('snap-same-ms');
      expect(trace?.outcome).toBe('succeeded');
      expect(trace?.rowsCommitted).toBe(1234);
      expect(trace?.connectorName).toBe('C One');
    });

    it('grades on the lifecycle rank, so a commit before a failure is not the ending', async () => {
      const trace = await store.getTrace('snap-same-ms-failed');
      expect(trace?.outcome).toBe('failed');
      expect(trace?.error).toBe('The source went away mid-read.');
      expect(trace?.failureCount).toBe(1);
    });

    it('answers undefined for a trace that does not exist', async () => {
      expect(await store.getTrace('no-such-snapshot')).toBeUndefined();
    });

    it('pages without repeating or losing a trace', async () => {
      const pages = await Promise.all(
        [0, 40, 80].map((offset) => store.listTraces({ limit: 40, offset })),
      );
      const traces = pages.flatMap((page) => page.traces);
      expect(traces).toHaveLength(120);
      expect(new Set(traces.map((trace) => trace.id)).size).toBe(120);
      const starts = traces.map((trace) => Date.parse(trace.startedAt));
      expect([...starts].sort((a, b) => b - a)).toEqual(starts);
    });

    it('cuts a filtered page on the trace start, not on the span that matched', async () => {
      const query = { event: 'connector.run.finished', typeName: 'Overlap' } as const;
      const first = await store.listTraces({ ...query, limit: 1, offset: 0 });
      const second = await store.listTraces({ ...query, limit: 1, offset: 1 });
      expect(first.traces.map((trace) => trace.id)).toEqual(['snap-quick']);
      expect(second.traces.map((trace) => trace.id)).toEqual(['snap-slow']);
    });

    it('pages a filtered list on the trace start, not on the matching span', async () => {
      const query = { event: 'connector.run.finished' } as const;
      const first = await store.listTraces({ ...query, limit: 30, offset: 0 });
      const second = await store.listTraces({ ...query, limit: 30, offset: 30 });
      const traces = [...first.traces, ...second.traces];
      expect(new Set(traces.map((trace) => trace.id)).size).toBe(60);
      const starts = traces.map((trace) => Date.parse(trace.startedAt));
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
      expect((await store.listTraces({ limit: 10, offset: 0 })).total).toBe(TRACES);
      const beyond = await store.listTraces({ limit: 10, offset: 1_000_000 });
      expect(beyond.traces).toHaveLength(0);
      expect(beyond.total).toBe(TRACES);
    });

    it('reports the real total past the last page of an outcome filter too', async () => {
      const failed = await store.listTraces({ outcome: 'failed', limit: 10 });
      expect(failed.total).toBeGreaterThan(0);
      const beyond = await store.listTraces({ outcome: 'failed', limit: 10, offset: 1_000_000 });
      expect(beyond.traces).toHaveLength(0);
      expect(beyond.total).toBe(failed.total);
    });

    it('keeps the traces with an event at or after `since`, whole', async () => {
      // The overlapping pair is the newest data in the trail (2026-06-10), and
      // snap-slow began before this instant: it matches on its later finish and
      // still comes back with its start.
      const since = '2026-06-10T09:00:05.000Z';
      const page = await store.listTraces({ since, limit: 50 });
      expect(page.traces.map((trace) => trace.id)).toEqual(['snap-slow']);
      expect(page.total).toBe(1);
      expect(page.traces[0]?.spans.map((span) => span.event)).toEqual([
        'connector.run.started',
        'connector.run.finished',
      ]);

      const wider = await store.listTraces({ since: '2026-06-10T09:00:00.000Z', limit: 50 });
      expect(wider.traces.map((trace) => trace.id)).toEqual(['snap-quick', 'snap-slow']);
      const totals = await store.traceTotals?.({ since: '2026-06-10T09:00:00.000Z' });
      if (totals) expect(totals.traces).toBe(2);
      // Every unlinked event is older than June 10.
      expect(wider.unlinked).toHaveLength(0);
      expect(wider.unlinkedTotal).toBe(0);
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
      expect(failed.traces).toHaveLength(20);
      expect(failed.traces.every((trace) => trace.outcome === 'failed')).toBe(true);
      expect(failed.total).toBeGreaterThan(20);
      expect(failed.traces.every((trace) => typeof trace.error === 'string')).toBe(true);
    });

    it('answers an empty outcome selection with nothing, not with everything', async () => {
      const none = await store.listTraces({ outcome: [], limit: 20 });
      expect(none.traces).toHaveLength(0);
      expect(none.total).toBe(0);
    });

    it('agrees with traceTotals about how many traces failed', async () => {
      const page = await store.listTraces({ outcome: 'failed', limit: 1 });
      const totals = await store.traceTotals?.({ outcome: 'failed' });
      if (!totals) return;
      expect(totals.traces).toBe(page.total);
    });

    it('sums committed rows over every matching trace, not over a page', async () => {
      const totals = await store.traceTotals?.({ typeName: 'Mvr' });
      if (!totals) return;
      // Both same-millisecond loads committed 1234 rows.
      expect(totals).toEqual({ traces: 2, rowsCommitted: 2468 });
    });

    it('lists a trace without its payloads and still grades it identically', async () => {
      const page = await store.listTraces({ outcome: 'failed', limit: 1 });
      const listed = page.traces[0];
      if (!listed) throw new Error('no failed trace to compare');
      const detailed = await store.getTrace(listed.id);
      if (!detailed) throw new Error(`getTrace lost ${listed.id}`);
      expect(listed.spans.map((span) => span.id)).toEqual(detailed.spans.map((span) => span.id));
      expect(listed.spans.every((span) => span.detail === undefined)).toBe(true);
      expect(detailed.spans.every((span) => span.detail !== undefined)).toBe(true);
      expect(listed.spans.map((span) => span.failed)).toEqual(
        detailed.spans.map((span) => span.failed),
      );
      expect(listed.spans.map((span) => span.error)).toEqual(
        detailed.spans.map((span) => span.error),
      );
      expect(listed.error).toBe(detailed.error);
      expect(typeof listed.error).toBe('string');
    });

    it('carries the unlinked events beside a page, and none under an outcome filter', async () => {
      const page = await store.listTraces({ limit: 1 });
      expect(page.unlinked.length).toBe(50);
      expect(page.unlinkedTotal).toBe(2_000);
      expect(page.unlinked.every((event) => event.snapshotId === undefined)).toBe(true);
      const times = page.unlinked.map((event) => Date.parse(event.occurredAt));
      expect([...times].sort((a, b) => b - a)).toEqual(times);

      const graded = await store.listTraces({ outcome: 'failed', limit: 1 });
      expect(graded.unlinked).toHaveLength(0);
    });

    it('lists the unlinked events on their own, with the total and the limit', async () => {
      if (!store.listUnlinked) return;
      const list = await store.listUnlinked({ event: 'type.curated', limit: 7 });
      expect(list.events).toHaveLength(7);
      expect(list.limit).toBe(7);
      expect(list.total).toBeGreaterThan(7);
      expect(list.events.every((event) => event.event === 'type.curated')).toBe(true);
      expect(await store.listUnlinked({ outcome: 'failed' })).toMatchObject({ events: [] });
    });
  });
}
