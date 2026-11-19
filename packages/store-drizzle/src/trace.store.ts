import {
  CATALOG_EVENT_PHASE,
  CATALOG_EVENT_PHASE_FALLBACK,
  type CatalogAuditEvent,
  type CatalogTrace,
  type CatalogTraceList,
  type CatalogTraceSpan,
  type CatalogTraceStore,
  type CatalogTraceTotals,
  type CatalogUnlinkedList,
  type TraceQuery,
  isCatalogTraceOutcome,
  traceOutcomeFilter,
} from '@dudousxd/nestjs-catalog';
import { type SQL, sql } from 'drizzle-orm';
import {
  type CatalogDrizzleDatabase,
  type CatalogDrizzleRun,
  catalogDrizzleRunner,
} from './connection';
import { type CatalogDrizzleTables, catalogDrizzleTables } from './schema';
import type { CatalogDrizzleStoreOptions } from './workspace.store';

/** The audit table keeps milliseconds (`timestamptz(3)`), so that is the finest gap a trace can show. */
const CLOCK_RESOLUTION_MS = 1;
const DEFAULT_TRACE_LIMIT = 25;
const MAX_TRACE_LIMIT = 200;
/** Enough to show that unlinked events exist without paging a second list. */
const UNLINKED_LIMIT = 50;

/**
 * The lifecycle rank as a `CASE`, built from the core package's map so the SQL
 * and the library agree about what came first. Inlined, not bound: the values
 * are this module's constants, never caller input.
 */
const PHASE_CASE = sql.raw(
  `CASE e.event ${Object.entries(CATALOG_EVENT_PHASE)
    .map(([event, phase]) => `WHEN '${event.replaceAll("'", "''")}' THEN ${Number(phase)}`)
    .join(' ')} ELSE ${Number(CATALOG_EVENT_PHASE_FALLBACK)} END`,
);

/**
 * The audit trail read back as traces (one per snapshot id), on Postgres.
 *
 * The same grouping, grading and paging as the MikroORM `MySqlCatalogTraceStore`,
 * written for Postgres: `jsonb` operators instead of `JSON_EXTRACT`, an ordered
 * `string_agg` instead of `GROUP_CONCAT`, and no join hint. The shared contract
 * in `test/trace-store-contract.ts` runs both.
 *
 * - The page is chosen on each trace's first event, before grading, so paging
 *   neither repeats nor loses a trace. A filter selects traces by their spans and
 *   still orders them by when they started.
 * - Filtering by outcome grades every matching trace first, because an outcome
 *   is derived, not stored.
 * - A listed trace carries every span, without payloads; `getTrace` carries the
 *   payloads. Both grade a span by the same rule.
 * - Events within one millisecond are ordered by their lifecycle rank, then id.
 */
export class DrizzleCatalogTraceStore implements CatalogTraceStore {
  private readonly run: CatalogDrizzleRun;
  private readonly t: CatalogDrizzleTables;

  constructor(options: CatalogDrizzleStoreOptions) {
    this.run = catalogDrizzleRunner(options);
    this.t = catalogDrizzleTables(options);
  }

  listTraces(query: TraceQuery): Promise<CatalogTraceList> {
    const limit = clamp(query.limit ?? DEFAULT_TRACE_LIMIT, 1, MAX_TRACE_LIMIT);
    const offset = Math.max(Math.floor(Number(query.offset) || 0), 0);
    const graded = gradesBeforePaging(query);
    return this.run(async (db) => {
      const rows = await this.fetchSpanRows(db, query, limit, offset, false);
      const unlinked = await this.fetchUnlinked(db, query, UNLINKED_LIMIT);
      const total = graded
        ? rows.length > 0
          ? toNumber(rows[0]?.total)
          : await this.countGraded(db, query)
        : await this.countTraces(db, query);
      return {
        traces: assembleTraces(rows),
        total,
        limit,
        offset,
        unlinked: unlinked.map(toAuditEvent),
        unlinkedTotal: unlinked.length > 0 ? toNumber(unlinked[0]?.total) : 0,
        clockResolutionMs: CLOCK_RESOLUTION_MS,
      };
    });
  }

  getTrace(id: string): Promise<CatalogTrace | undefined> {
    return this.run(async (db) => {
      const rows = await this.fetchSpanRows(db, { traceId: id }, 1, 0, true);
      return assembleTraces(rows)[0];
    });
  }

  traceTotals(query: TraceQuery): Promise<CatalogTraceTotals> {
    return this.run(async (db) => {
      const result = await rowsOf<{ traces: unknown; rows_committed: unknown }>(
        db.execute(sql`
          ${this.gradedTraces(matchedScope(this.t, query))}
          SELECT COUNT(*) AS traces, COALESCE(SUM(g.rows_committed), 0) AS rows_committed
            FROM graded g
           WHERE ${outcomeClause(query)}`),
      );
      const row = result[0];
      return { traces: toNumber(row?.traces), rowsCommitted: toNumber(row?.rows_committed) };
    });
  }

  listUnlinked(query: TraceQuery): Promise<CatalogUnlinkedList> {
    const limit = clamp(query.limit ?? DEFAULT_TRACE_LIMIT, 1, MAX_TRACE_LIMIT);
    return this.run(async (db) => {
      const rows = await this.fetchUnlinked(db, query, limit);
      return {
        events: rows.map(toAuditEvent),
        total: rows.length > 0 ? toNumber(rows[0]?.total) : 0,
        limit,
      };
    });
  }

  private fetchSpanRows(
    db: CatalogDrizzleDatabase,
    query: TraceQuery & { traceId?: string },
    limit: number,
    offset: number,
    withDetail: boolean,
  ): Promise<SpanRow[]> {
    const a = this.t.auditEvent;
    const graded = gradesBeforePaging(query);
    const page = graded
      ? sql`${this.gradedTraces(matchedScope(this.t, query))},
          page AS (
            SELECT g.*, COUNT(*) OVER () AS total
              FROM graded g
             WHERE ${outcomeClause(query)}
             ORDER BY g.started_at DESC, g.snapshot_id DESC
             LIMIT ${limit} OFFSET ${offset}
          )`
      : sql`${this.gradedTraces(pagedScope(this.t, query, limit, offset))},
          page AS (SELECT g.* FROM graded g)`;

    const spanColumns = withDetail
      ? sql`e.detail AS span_detail`
      : sql`${jsonText('error')} AS span_error, ${jsonText('status')} AS span_status`;

    return rowsOf<SpanRow>(
      db.execute(sql`
        ${page}
        SELECT
          p.snapshot_id, p.started_at, p.last_at, p.event_count, p.type_name,
          p.principal_id, p.connector_id, p.connector_name, p.rows_committed,
          p.failures, p.outcome, ${graded ? sql`p.total,` : sql``}
          e.id AS span_id, e.event AS span_event, e.type_name AS span_type_name,
          e.principal_id AS span_principal_id, ${spanColumns},
          e.occurred_at AS span_at
        FROM page p
        JOIN ${a} e ON e.snapshot_id = p.snapshot_id
        ORDER BY p.started_at DESC, p.snapshot_id DESC, e.occurred_at ASC, ${PHASE_CASE} ASC, e.id ASC`),
    );
  }

  /** Traces the span filters match, counted without grading. */
  private async countTraces(
    db: CatalogDrizzleDatabase,
    query: TraceQuery & { traceId?: string },
  ): Promise<number> {
    const a = this.t.auditEvent;
    const rows = await rowsOf<{ total: unknown }>(
      db.execute(sql`
        SELECT COUNT(DISTINCT e.snapshot_id) AS total
          FROM ${a} e
         WHERE e.snapshot_id IS NOT NULL${andAll(spanConditions(query))}`),
    );
    return toNumber(rows[0]?.total);
  }

  /** The graded total when the requested page came back empty (an offset past the end). */
  private async countGraded(db: CatalogDrizzleDatabase, query: TraceQuery): Promise<number> {
    const rows = await rowsOf<{ total: unknown }>(
      db.execute(sql`
        ${this.gradedTraces(matchedScope(this.t, query))}
        SELECT COUNT(*) AS total FROM graded g WHERE ${outcomeClause(query)}`),
    );
    return toNumber(rows[0]?.total);
  }

  /** Events with no snapshot id: curation edits, schema and transform changes. */
  private fetchUnlinked(
    db: CatalogDrizzleDatabase,
    query: TraceQuery,
    limit: number,
  ): Promise<UnlinkedRow[]> {
    // An outcome belongs to a trace, and these are in none.
    if (query.outcome !== undefined) return Promise.resolve([]);
    const a = this.t.auditEvent;
    return rowsOf<UnlinkedRow>(
      db.execute(sql`
        SELECT e.id, e.event, e.type_name, e.principal_id, e.detail, e.occurred_at,
               COUNT(*) OVER () AS total
          FROM ${a} e
         WHERE e.snapshot_id IS NULL${andAll(spanConditions(query))}
         ORDER BY e.occurred_at DESC, e.id DESC
         LIMIT ${clamp(limit, 1, MAX_TRACE_LIMIT)}`),
    );
  }

  /**
   * The `summary` and `graded` CTEs: one row per trace with its start, end,
   * counts, committed rows and outcome. `scope`, when present, names which
   * traces to grade.
   */
  private gradedTraces(scope: SQL | undefined): SQL {
    const a = this.t.auditEvent;
    return sql`
      WITH ${scope ? sql`${scope},` : sql``}
      summary AS (
        SELECT
          e.snapshot_id,
          MIN(e.occurred_at) AS started_at,
          MAX(e.occurred_at) AS last_at,
          COUNT(*) AS event_count,
          MAX(e.type_name) AS type_name,
          MAX(e.principal_id) AS principal_id,
          MAX(e.detail ->> 'connectorId') AS connector_id,
          MAX(e.detail ->> 'connectorName') AS connector_name,
          MAX(CASE WHEN e.event = 'snapshot.committed'
                    AND jsonb_typeof(e.detail -> 'rowCount') = 'number'
                   THEN (e.detail ->> 'rowCount')::numeric END) AS rows_committed,
          COUNT(*) FILTER (WHERE e.event = 'connector.run.started') AS starts,
          COUNT(*) FILTER (WHERE e.event = 'connector.run.finished') AS finishes,
          -- A JSON null under "error" still counts, as JSON_EXTRACT does on MySQL.
          COUNT(*) FILTER (WHERE COALESCE(e.detail ->> 'status', '') = 'failed'
                              OR e.detail -> 'error' IS NOT NULL) AS failures,
          -- One character per event that can end a trace, in lifecycle order;
          -- string_agg skips the nulls and right() takes the one that did.
          right(string_agg(
            CASE e.event
              WHEN 'connector.run.finished' THEN
                CASE COALESCE(e.detail ->> 'status', '')
                  WHEN 'failed' THEN 'F'
                  WHEN 'succeeded' THEN 'S'
                  ELSE 'U'
                END
              WHEN 'snapshot.committed' THEN 'C'
              WHEN 'snapshot.dropped' THEN 'D'
            END, '' ORDER BY e.occurred_at, ${PHASE_CASE}, e.id), 1) AS last_terminal
        FROM ${a} e
        ${scope ? sql`JOIN scope k ON k.snapshot_id = e.snapshot_id` : sql`WHERE e.snapshot_id IS NOT NULL`}
        GROUP BY e.snapshot_id
      ),
      graded AS (
        SELECT u.*,
          CASE
            WHEN u.starts > u.finishes THEN 'running'
            WHEN u.last_terminal = 'F' THEN 'failed'
            WHEN u.last_terminal IN ('S', 'C') THEN 'succeeded'
            ELSE 'incomplete'
          END AS outcome
        FROM summary u
      )`;
  }
}

function gradesBeforePaging(query: TraceQuery): boolean {
  return traceOutcomeFilter(query.outcome) !== undefined;
}

/**
 * The page's trace ids, chosen without grading: ordered by each trace's first
 * event over the whole trace, and narrowed by a semijoin when the caller
 * filtered, so a filter on the last event still pages by when a load began.
 */
function pagedScope(
  t: CatalogDrizzleTables,
  query: TraceQuery & { traceId?: string },
  limit: number,
  offset: number,
): SQL {
  const a = t.auditEvent;
  const conditions = spanConditions(query, 'f');
  const narrow =
    conditions.length > 0
      ? sql` AND e.snapshot_id IN (
          SELECT DISTINCT f.snapshot_id FROM ${a} f
           WHERE f.snapshot_id IS NOT NULL${andAll(conditions)})`
      : sql``;
  return sql`scope AS (
      SELECT e.snapshot_id, MIN(e.occurred_at) AS ordered_at
        FROM ${a} e
       WHERE e.snapshot_id IS NOT NULL${narrow}
       GROUP BY e.snapshot_id
       ORDER BY ordered_at DESC, e.snapshot_id DESC
       LIMIT ${limit} OFFSET ${offset}
    )`;
}

/** Every trace with a matching span, unbounded; absent when nothing narrows. */
function matchedScope(
  t: CatalogDrizzleTables,
  query: TraceQuery & { traceId?: string },
): SQL | undefined {
  const conditions = spanConditions(query);
  if (conditions.length === 0) return undefined;
  return sql`scope AS (
      SELECT DISTINCT e.snapshot_id FROM ${t.auditEvent} e
       WHERE e.snapshot_id IS NOT NULL${andAll(conditions)}
    )`;
}

function spanConditions(query: TraceQuery & { traceId?: string }, alias = 'e'): SQL[] {
  const column = (name: string) => sql.raw(`${alias}.${name}`);
  const conditions: SQL[] = [];
  if (query.traceId) conditions.push(sql`${column('snapshot_id')} = ${query.traceId}`);
  if (query.typeName) conditions.push(sql`${column('type_name')} = ${query.typeName}`);
  if (query.principalId) conditions.push(sql`${column('principal_id')} = ${query.principalId}`);
  if (query.event) conditions.push(sql`${column('event')} = ${query.event}`);
  if (query.since) conditions.push(sql`${column('occurred_at')} >= ${new Date(query.since)}`);
  return conditions;
}

function andAll(conditions: SQL[]): SQL {
  return sql.join(
    conditions.map((condition) => sql` AND ${condition}`),
    sql``,
  );
}

function outcomeClause(query: TraceQuery): SQL {
  const outcomes = traceOutcomeFilter(query.outcome);
  if (outcomes === undefined) return sql`TRUE`;
  if (outcomes.length === 0) return sql`FALSE`;
  return sql`g.outcome IN (${sql.join(
    outcomes.map((outcome) => sql`${outcome}`),
    sql`, `,
  )})`;
}

/** A string member of the payload, or null: what grading reads without the payload. */
function jsonText(key: 'error' | 'status'): SQL {
  return sql.raw(
    `CASE WHEN jsonb_typeof(e.detail -> '${key}') = 'string' THEN e.detail ->> '${key}' END`,
  );
}

/** node-postgres answers `{ rows }`; postgres-js answers the array itself. */
async function rowsOf<T>(result: Promise<unknown>): Promise<T[]> {
  const value = await result;
  if (Array.isArray(value)) return value as T[];
  const rows = (value as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

interface SpanRow {
  snapshot_id: string;
  started_at: unknown;
  last_at: unknown;
  event_count: unknown;
  type_name: string | null;
  principal_id: string | null;
  connector_id: string | null;
  connector_name: string | null;
  rows_committed: unknown;
  failures: unknown;
  outcome: unknown;
  total?: unknown;
  span_id: string;
  span_event: string;
  span_type_name: string | null;
  span_principal_id: string | null;
  span_detail?: unknown;
  span_error?: unknown;
  span_status?: unknown;
  span_at: unknown;
}

interface UnlinkedRow {
  id: string;
  event: string;
  type_name: string | null;
  principal_id: string | null;
  detail: unknown;
  occurred_at: unknown;
  total: unknown;
}

function assembleTraces(rows: SpanRow[]): CatalogTrace[] {
  const byId = new Map<string, CatalogTrace>();
  const spansById = new Map<string, CatalogTraceSpan[]>();
  const order: string[] = [];
  for (const row of rows) {
    if (!byId.has(row.snapshot_id)) {
      byId.set(row.snapshot_id, traceFromRow(row));
      spansById.set(row.snapshot_id, []);
      order.push(row.snapshot_id);
    }
    spansById.get(row.snapshot_id)?.push(spanFromRow(row));
  }
  return order.map((id) => {
    const trace = byId.get(id);
    if (!trace) throw new Error(`Lost trace ${id} while assembling it.`);
    return withSpanTiming(trace, spansById.get(id) ?? []);
  });
}

function traceFromRow(row: SpanRow): CatalogTrace {
  const startedAt = toDate(row.started_at);
  const lastEventAt = toDate(row.last_at);
  const outcome = isCatalogTraceOutcome(row.outcome) ? row.outcome : 'incomplete';
  const ended = outcome === 'succeeded' || outcome === 'failed';
  return {
    id: row.snapshot_id,
    typeName: row.type_name ?? undefined,
    principalId: row.principal_id ?? undefined,
    connectorId: row.connector_id ?? undefined,
    connectorName: row.connector_name ?? undefined,
    outcome,
    startedAt: startedAt.toISOString(),
    lastEventAt: lastEventAt.toISOString(),
    endedAt: ended ? lastEventAt.toISOString() : undefined,
    durationMs: ended ? lastEventAt.getTime() - startedAt.getTime() : undefined,
    eventCount: toNumber(row.event_count),
    failureCount: toNumber(row.failures),
    rowsCommitted:
      row.rows_committed === null || row.rows_committed === undefined
        ? undefined
        : toNumber(row.rows_committed),
    coarse: lastEventAt.getTime() - startedAt.getTime() < CLOCK_RESOLUTION_MS,
    spans: [],
  };
}

function spanFromRow(row: SpanRow): CatalogTraceSpan {
  const detail = 'span_detail' in row ? toDetail(row.span_detail) : undefined;
  const error = detail ? errorOf(detail) : textOrUndefined(row.span_error);
  const status = detail ? detail.status : textOrUndefined(row.span_status);
  return {
    id: row.span_id,
    event: row.span_event,
    typeName: row.span_type_name ?? undefined,
    principalId: row.span_principal_id ?? undefined,
    ...(detail ? { detail } : {}),
    occurredAt: toDate(row.span_at).toISOString(),
    offsetMs: 0,
    durationMs: 0,
    failed: error !== undefined || status === 'failed',
    error,
  };
}

function withSpanTiming(trace: CatalogTrace, spans: CatalogTraceSpan[]): CatalogTrace {
  const start = new Date(trace.startedAt).getTime();
  spans.forEach((span, index) => {
    const at = new Date(span.occurredAt).getTime();
    const next = spans[index + 1];
    span.offsetMs = at - start;
    span.durationMs = next ? new Date(next.occurredAt).getTime() - at : 0;
  });
  const lastFailure = [...spans].reverse().find((span) => span.error);
  return { ...trace, error: lastFailure?.error, spans };
}

function toAuditEvent(row: UnlinkedRow): CatalogAuditEvent {
  return {
    id: row.id,
    event: row.event,
    typeName: row.type_name ?? undefined,
    principalId: row.principal_id ?? undefined,
    detail: toDetail(row.detail),
    occurredAt: toDate(row.occurred_at).toISOString(),
  };
}

function textOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toDetail(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorOf(detail: Record<string, unknown>): string | undefined {
  const error = detail.error;
  return typeof error === 'string' && error.length > 0 ? error : undefined;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(0);
}

function clamp(value: number, min: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}
