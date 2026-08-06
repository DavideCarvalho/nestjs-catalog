import type { EntityManager } from '@mikro-orm/mysql';

/**
 * A deployment's worth of audit trail, written straight at the table.
 *
 * Not through `recordEvent`: this seeds tens of thousands of rows, and a fork
 * and a flush per row would make the fixture itself the slow part of a
 * measurement about the read path. What it does keep faithful is the *shape* —
 * the same column set, the same `detail` keys the recorder flattens payloads
 * into, the same handful of events per trace, and the same same-millisecond
 * bunching a fast load produces — because every one of those is something the
 * trace query reads.
 *
 * Deterministic: a fixed seed, so two runs of a benchmark measure the same
 * table and a difference between them is the code.
 */

export interface SeedShape {
  /** How many correlated loads to write. Each contributes ~7 events. */
  traces: number;
  /** Standalone events carrying no snapshot id — curation, sharing, edits. */
  unlinked: number;
  /** How far back the trail reaches. Six weeks matches the retention question. */
  daysOfHistory?: number;
  /**
   * Extra `snapshot.written` batches per load, on top of the ~7 lifecycle
   * events. A real load writes one per batch, so a wide table loaded in small
   * batches produces a trace with hundreds of spans — which is the shape that
   * separates "many traces" from "many spans per trace" in a measurement.
   */
  spansPerTrace?: number;
}

/** xorshift32, so the trail is the same one on every machine. */
function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

interface Row {
  id: string;
  event: string;
  typeName: string | null;
  principalId: string | null;
  snapshotId: string | null;
  detail: string;
  occurredAt: string;
}

const TYPES = Array.from({ length: 12 }, (_, index) => `type_${index}`);
const PRINCIPALS = Array.from({ length: 20 }, (_, index) => `user_${index}`);
const UNLINKED_EVENTS = [
  'type.curated',
  'overlay.reset',
  'transform.changed',
  'workflow.changed',
  'query.shared',
  'dashboard.shared',
];

function stamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 23).replace('T', ' ');
}

/** Where the trail begins and ends, and how far apart its events can fall. */
interface Window {
  oldest: number;
  span: number;
}

/**
 * One load's worth of rows: a start, a schema change, its write batches, and
 * whichever ending it got.
 *
 * A `running` trace stops after its writes — started, never finished — which is
 * exactly what an interrupted load leaves behind, and is the case the `starts >
 * finishes` arm of the grading exists for.
 */
function traceRows(
  index: number,
  random: () => number,
  window: Window,
  batches: number,
): Array<Omit<Row, 'id'>> {
  const snapshotId = `snap-${index.toString().padStart(7, '0')}`;
  const typeName = TYPES[Math.floor(random() * TYPES.length)];
  const principalId = PRINCIPALS[Math.floor(random() * PRINCIPALS.length)];
  const connectorId = `conn-${index % 40}`;
  const connectorName = `Connector ${index % 40}`;
  const start = window.oldest + Math.floor(random() * window.span);

  // Most loads finish inside a millisecond — that is the case the phase rank
  // exists for — and a minority take real time. Both are seeded, so a change
  // that reorders same-tick spans is visible here.
  const step = random() < 0.6 ? 0 : 1 + Math.floor(random() * 400);

  const roll = random();
  const outcome = roll < 0.72 ? 'succeeded' : roll < 0.88 ? 'failed' : 'running';
  const rowCount = 50 + Math.floor(random() * 100_000);

  const base = { connectorId, connectorName, typeName, principalId, snapshotId };
  const rows: Array<Omit<Row, 'id'>> = [];
  const push = (event: string, at: number, detail: Record<string, unknown>) => {
    rows.push({
      event,
      typeName,
      principalId,
      snapshotId,
      detail: JSON.stringify({ ...base, ...detail }),
      occurredAt: stamp(at),
    });
  };

  push('connector.run.started', start, { runId: `run-${index}` });
  push('schema.changed', start + step, { columns: 14 });
  for (let batch = 0; batch < batches; batch += 1) {
    push('snapshot.written', start + step * (2 + batch), {
      rowCount: Math.floor((rowCount * (batch + 1)) / batches),
      batch,
    });
  }
  if (outcome !== 'failed') {
    push('snapshot.committed', start + step * (2 + batches), { rowCount });
  }
  if (outcome === 'succeeded') {
    push('connector.run.finished', start + step * (3 + batches), { status: 'succeeded', rowCount });
  }
  if (outcome === 'failed') {
    push('connector.run.finished', start + step * (3 + batches), {
      status: 'failed',
      error: `Connector ${index % 40} could not read column ${index % 14}.`,
    });
  }
  return rows;
}

/** One standalone act — a curation edit, a share — belonging to no load. */
function unlinkedRow(random: () => number, window: Window): Omit<Row, 'id'> {
  const typeName = TYPES[Math.floor(random() * TYPES.length)];
  const principalId = PRINCIPALS[Math.floor(random() * PRINCIPALS.length)];
  return {
    event: UNLINKED_EVENTS[Math.floor(random() * UNLINKED_EVENTS.length)],
    typeName,
    principalId,
    snapshotId: null,
    detail: JSON.stringify({ typeName, principalId, note: 'curation' }),
    occurredAt: stamp(window.oldest + Math.floor(random() * window.span)),
  };
}

export async function seedAuditTrail(em: EntityManager, shape: SeedShape): Promise<number> {
  const random = rng(0x5eed);
  const span = (shape.daysOfHistory ?? 42) * 24 * 60 * 60 * 1000;
  const window: Window = { oldest: Date.UTC(2026, 5, 1) - span, span };
  const batches = shape.spansPerTrace ?? 2;

  const unnumbered: Array<Omit<Row, 'id'>> = [];
  for (let index = 0; index < shape.traces; index += 1) {
    unnumbered.push(...traceRows(index, random, window, batches));
  }
  for (let index = 0; index < shape.unlinked; index += 1) {
    unnumbered.push(unlinkedRow(random, window));
  }

  // Numbered last, in one pass, so that the ids are a plain function of the
  // position rather than a counter threaded through everything above.
  const rows: Row[] = unnumbered.map((row, index) => ({
    ...row,
    id: `evt-${(index + 1).toString().padStart(9, '0')}`,
  }));

  const connection = em.getConnection();
  const CHUNK = 500;
  for (let at = 0; at < rows.length; at += CHUNK) {
    const chunk = rows.slice(at, at + CHUNK);
    const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
    const params = chunk.flatMap((row) => [
      row.id,
      row.event,
      row.typeName,
      row.principalId,
      row.snapshotId,
      row.detail,
      row.occurredAt,
    ]);
    await connection.execute(
      `INSERT INTO catalog_audit_event
         (id, event, type_name, principal_id, snapshot_id, detail, occurred_at)
       VALUES ${values}`,
      params,
    );
  }

  return rows.length;
}
