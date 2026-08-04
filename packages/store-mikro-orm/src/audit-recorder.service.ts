import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import {
  CATALOG_EVENTS,
  CATALOG_EVENT_PHASE,
  CATALOG_EVENT_PHASE_FALLBACK,
  CATALOG_LIB,
  type CatalogAuditEvent,
  type CatalogTrace,
  type CatalogTraceList,
  type CatalogTraceSpan,
  type CatalogTraceStore,
  type CatalogTraceTotals,
  type CatalogUnlinkedList,
  type TraceQuery,
  channelNameFor,
  isCatalogTraceOutcome,
  traceOutcomeFilter,
} from '@dudousxd/nestjs-catalog';
import type { EntityManager } from '@mikro-orm/mysql';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { CATALOG_STORE_ENTITY_MANAGER } from './context';
import { MySqlWorkspaceStore } from './workspace.store';

type Handler = (message: unknown) => void;

/**
 * Writes the diagnostics stream into the audit table.
 *
 * The library emits on `aviary:catalog:*` and depends on nothing to do it,
 * which is right — but a channel only reaches observers that were listening at
 * the time. Governance asks "who changed this, and when" months later, so
 * something has to keep the answer. This is that something, and it is a
 * separate class so a deployment that wants the events in its own tracing and
 * nowhere else can simply not provide it.
 */
@Injectable()
export class CatalogAuditRecorder implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CatalogAuditRecorder.name);
  private readonly handlers = new Map<string, Handler>();

  constructor(private readonly workspace: MySqlWorkspaceStore) {}

  onModuleInit(): void {
    for (const event of CATALOG_EVENTS) {
      const channel = channelNameFor(event);
      const handler: Handler = (message) => {
        void this.record(event, message);
      };
      subscribe(channel, handler);
      this.handlers.set(channel, handler);
    }
    this.logger.log(`Recording ${CATALOG_EVENTS.length} catalog event types to the audit trail`);
  }

  onModuleDestroy(): void {
    for (const [channel, handler] of this.handlers) {
      unsubscribe(channel, handler);
    }
    this.handlers.clear();
  }

  private async record(event: string, message: unknown): Promise<void> {
    const envelope = (message ?? {}) as Record<string, unknown>;
    const payload = (envelope.payload ?? envelope) as Record<string, unknown>;

    await this.workspace.recordEvent({
      event,
      typeName: asString(payload.typeName),
      principalId: asString(payload.principalId),
      snapshotId: asString(payload.snapshotId),
      detail: payload,
      // The envelope's own timestamp when there is one: the write happens on a
      // background tick, and "when it was persisted" is a different fact from
      // "when it happened".
      occurredAt: new Date(
        typeof envelope.ts === 'number' ? envelope.ts : Date.now(),
      ).toISOString(),
    });
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export { CATALOG_LIB };

// -----------------------------------------------------------------------------
// Reading the same table back as stories.
//
// Beside the recorder rather than in the workspace store because these two
// classes are the write half and the read half of one table, and the trace
// shape depends on precisely which events the recorder chose to persist and how
// it flattened their payloads. Split across files, the reader would eventually
// be grouping on a column the writer had stopped filling and nobody would
// notice until a trace quietly came back short.
// -----------------------------------------------------------------------------

/**
 * The audit table's timestamp is a MySQL `datetime`, which keeps whole seconds.
 *
 * Reported rather than assumed by the consumer, and it is the reason a trace
 * carries a `coarse` flag: most loads finish inside one second, so their spans
 * all land on the same instant and there is no internal timing to draw. Raising
 * this means widening the column, which changes what the writer stores — a
 * decision that belongs to whoever owns the entity, not to this query.
 */
const CLOCK_RESOLUTION_MS = 1_000;

const DEFAULT_TRACE_LIMIT = 25;
const MAX_TRACE_LIMIT = 200;
/** Enough to show that unlinked events exist without paging a second list. */
const UNLINKED_LIMIT = 50;

/**
 * `CASE ... END` over the shared lifecycle rank, built from the exported map so
 * the SQL and the library cannot disagree about what came first.
 *
 * Inlined into the statement rather than bound: these are integers this module
 * produced from a constant it imported, never anything a caller supplied.
 */
const PHASE_CASE = `CASE e.event ${Object.entries(CATALOG_EVENT_PHASE)
  .map(([event, phase]) => `WHEN ${quote(event)} THEN ${phase}`)
  .join(' ')} ELSE ${CATALOG_EVENT_PHASE_FALLBACK} END`;

/**
 * Groups the audit trail into traces, in the database.
 *
 * All of the grouping, ranking, outcome and paging happen in one statement on
 * purpose. The alternative — select the trail and group it in Node — reads the
 * whole table to render one page, and gets slower in exact proportion to how
 * long the deployment has been keeping records, which is to say it works
 * perfectly until the first time anyone needs it.
 */
@Injectable()
export class MySqlCatalogTraceStore implements CatalogTraceStore {
  constructor(
    // By token, never positionally. The default connection is whichever one the
    // host registered first, and in a host with a database of its own that is
    // not this catalog's.
    @Inject(CATALOG_STORE_ENTITY_MANAGER)
    private readonly em: EntityManager,
  ) {}

  async listTraces(query: TraceQuery): Promise<CatalogTraceList> {
    const limit = clamp(query.limit ?? DEFAULT_TRACE_LIMIT, 1, MAX_TRACE_LIMIT);
    const offset = Math.max(Math.floor(Number(query.offset) || 0), 0);

    const [rows, unlinked] = await Promise.all([
      this.fetchSpanRows(query, limit, offset),
      // Bounded by its own constant rather than by the caller's `limit`, which
      // belongs to the traces. This copy exists to show that changes happened
      // alongside the loads; a caller that wants to page them asks
      // `listUnlinked` and says how many it wants.
      this.fetchUnlinked(query, UNLINKED_LIMIT),
    ]);

    const traces = assembleTraces(rows);
    return {
      traces,
      // `COUNT(*) OVER ()` is evaluated before the LIMIT, so it is the real
      // number of matching traces. It only reaches us on a row, though: an
      // empty page carries no total, and zero is the only truthful answer then.
      total: rows.length > 0 ? toNumber(rows[0].total) : 0,
      limit,
      offset,
      unlinked: unlinked.map(toAuditEvent),
      unlinkedTotal: unlinked.length > 0 ? toNumber(unlinked[0].total) : 0,
      clockResolutionMs: CLOCK_RESOLUTION_MS,
    };
  }

  async getTrace(id: string): Promise<CatalogTrace | undefined> {
    // The same statement with the id pinned, rather than a second one shaped
    // slightly differently. One trace rendered by two queries is one trace that
    // can be shown two ways, and the detail view is exactly where somebody is
    // looking closely enough for the difference to matter.
    const rows = await this.fetchSpanRows({ traceId: id }, 1, 0);
    return assembleTraces(rows)[0];
  }

  /**
   * One round trip: group into traces, page them, then join every span of the
   * traces that survived paging back on.
   *
   * The join deliberately re-reads all spans of a matched trace and not just
   * the ones the filter hit. A trace shown with only its `failed` events would
   * be a story with the middle torn out that still rendered as whole, which is
   * the failure mode this whole screen exists to prevent.
   */
  private fetchSpanRows(
    query: TraceQuery & { traceId?: string },
    limit: number,
    offset: number,
  ): Promise<SpanRow[]> {
    const { conditions, params } = spanConditions(query);
    const outcome = outcomeClause(query);

    // `limit` and `offset` are interpolated, not bound: both have already been
    // clamped to integers by the caller above, and every driver in this stack
    // treats a bound LIMIT differently enough to be worth not relying on.
    const sql = `
      ${gradedTraces(conditions)},
      page AS (
        SELECT g.*, COUNT(*) OVER () AS total
        FROM graded g
        WHERE ${outcome.sql}
        ORDER BY g.started_at DESC, g.snapshot_id DESC
        LIMIT ${limit} OFFSET ${offset}
      )
      SELECT
        p.snapshot_id, p.started_at, p.last_at, p.event_count, p.type_name,
        p.principal_id, p.connector_id, p.connector_name, p.rows_committed,
        p.failures, p.outcome, p.total,
        s.id AS span_id, s.event AS span_event, s.type_name AS span_type_name,
        s.principal_id AS span_principal_id, s.detail AS span_detail,
        s.occurred_at AS span_at
      FROM page p
      JOIN scoped s ON s.snapshot_id = p.snapshot_id
      ORDER BY
        p.started_at DESC, p.snapshot_id DESC,
        s.occurred_at ASC, s.phase ASC, s.id ASC
    `;

    return this.em.getConnection().execute<SpanRow[]>(sql, [...params, ...outcome.params]);
  }

  /**
   * Count the matching traces and sum their committed rows, in the database.
   *
   * The same grouping and grading `listTraces` runs — literally the same CTEs,
   * built by the same function — with an aggregate instead of a page on the end.
   * Two views of one number that were assembled by two similar statements would
   * eventually disagree, and the disagreement would surface as a dashboard whose
   * total does not match its own table.
   *
   * `SUM` over `rows_committed` is exact rather than bounded. The column is NULL
   * for a trace that never committed and `SUM` skips NULLs, so a load that moved
   * no data contributes no term — the same distinction
   * {@link CatalogTrace.rowsCommitted} makes by being absent rather than zero.
   */
  async traceTotals(query: TraceQuery): Promise<CatalogTraceTotals> {
    const { conditions, params } = spanConditions(query);
    const outcome = outcomeClause(query);

    const rows = await this.em
      .getConnection()
      .execute<Array<{ traces: unknown; rows_committed: unknown }>>(
        `${gradedTraces(conditions)}
       SELECT COUNT(*) AS traces, COALESCE(SUM(g.rows_committed), 0) AS rows_committed
         FROM graded g
        WHERE ${outcome.sql}`,
        [...params, ...outcome.params],
      );

    const row = rows[0];
    return {
      traces: toNumber(row?.traces),
      rowsCommitted: toNumber(row?.rows_committed),
    };
  }

  /**
   * The unlinked events on their own, without assembling a page of traces
   * nobody asked for.
   *
   * The list `listTraces` carries alongside its traces is the same set produced
   * by the same statement, so the two cannot drift. What differs is the bound: a
   * caller that came for these gets to say how many it wants, where the copy
   * riding along with a trace page is capped at {@link UNLINKED_LIMIT} because
   * it is there to show that changes exist, not to be paged through.
   */
  async listUnlinked(query: TraceQuery): Promise<CatalogUnlinkedList> {
    const limit = clamp(query.limit ?? DEFAULT_TRACE_LIMIT, 1, MAX_TRACE_LIMIT);
    const rows = await this.fetchUnlinked(query, limit);
    return {
      events: rows.map(toAuditEvent),
      total: rows.length > 0 ? toNumber(rows[0].total) : 0,
      limit,
    };
  }

  /**
   * Events that belong to no trace, because they carry no correlation id.
   *
   * A curation edit and a transform change are standalone acts. The temptation
   * is to adopt them into whichever load ran nearest in time — and in this very
   * database a `transform.changed` and a `connector.run.started` share a
   * timestamp to the second, so the guess would even look right. It would still
   * be a guess rendered as lineage, and the next reader would treat it as a
   * fact about what caused what.
   */
  private fetchUnlinked(query: TraceQuery, limit: number): Promise<UnlinkedRow[]> {
    // Skipped entirely when the caller asked for an outcome: an outcome is a
    // property of a trace, and an event that is in no trace has none. Returning
    // these anyway under a "failed" filter would put unrelated rows on a screen
    // whose whole point was to show failures. An empty outcome list is a filter
    // that matches nothing, which these do not match either.
    if (query.outcome !== undefined) return Promise.resolve([]);

    const conditions = ['e.snapshot_id IS NULL'];
    const params: unknown[] = [];

    if (query.typeName) {
      conditions.push('e.type_name = ?');
      params.push(query.typeName);
    }
    if (query.principalId) {
      conditions.push('e.principal_id = ?');
      params.push(query.principalId);
    }
    if (query.event) {
      conditions.push('e.event = ?');
      params.push(query.event);
    }
    if (query.since) {
      conditions.push('e.occurred_at >= ?');
      params.push(new Date(query.since));
    }

    // Interpolated for the same reason the trace page's LIMIT is: it is an
    // integer this module clamped, never anything a caller supplied verbatim.
    return this.em.getConnection().execute<UnlinkedRow[]>(
      `SELECT e.id, e.event, e.type_name, e.principal_id, e.detail, e.occurred_at,
              COUNT(*) OVER () AS total
         FROM catalog_audit_event e
        WHERE ${conditions.join(' AND ')}
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT ${clamp(limit, 1, MAX_TRACE_LIMIT)}`,
      params,
    );
  }
}

/**
 * The grouping and grading half of the trace query, shared by everything that
 * needs it.
 *
 * A string builder rather than a view or a stored routine because it closes
 * over the caller's filter, and because the alternative — each entry point
 * writing its own copy of these four CTEs — is how a page and the total printed
 * above it come to be computed by two statements that agree until they do not.
 *
 * Ends with the `graded` CTE and no trailing `SELECT`, so a caller appends
 * either another CTE or its own tail. Every parameter it takes comes from
 * {@link spanConditions}, in that order.
 */
function gradedTraces(conditions: string[]): string {
  return `
      WITH scoped AS (
        SELECT
          e.id, e.snapshot_id, e.event, e.type_name, e.principal_id,
          e.detail, e.occurred_at,
          ${PHASE_CASE} AS phase
        FROM catalog_audit_event e
        WHERE e.snapshot_id IS NOT NULL
      ),
      matched AS (
        SELECT DISTINCT s.snapshot_id
        FROM scoped s
        ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
      ),
      summary AS (
        SELECT
          s.snapshot_id,
          MIN(s.occurred_at) AS started_at,
          MAX(s.occurred_at) AS last_at,
          COUNT(*) AS event_count,
          MAX(s.type_name) AS type_name,
          MAX(s.principal_id) AS principal_id,
          MAX(JSON_UNQUOTE(JSON_EXTRACT(s.detail, '$.connectorId'))) AS connector_id,
          MAX(JSON_UNQUOTE(JSON_EXTRACT(s.detail, '$.connectorName'))) AS connector_name,
          MAX(CASE WHEN s.event = 'snapshot.committed'
                   THEN CAST(JSON_EXTRACT(s.detail, '$.rowCount') AS UNSIGNED)
              END) AS rows_committed,
          SUM(s.event = 'connector.run.started') AS starts,
          SUM(s.event = 'connector.run.finished') AS finishes,
          -- COALESCE before the comparison, because a payload without a status
          -- makes the whole OR null, SUM of nulls is null, and a null failure
          -- count reads downstream as zero failures.
          SUM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(s.detail, '$.status')), '') = 'failed'
              OR JSON_EXTRACT(s.detail, '$.error') IS NOT NULL) AS failures,
          -- The last terminal marker, as one character per terminal event in
          -- lifecycle order. GROUP_CONCAT skips the nulls, so this string holds
          -- only the events that could end a trace, and RIGHT() takes the one
          -- that actually did. A character each because the concat is capped at
          -- group_concat_max_len: a thousand retries of a single snapshot id
          -- would be needed to truncate it, and the alternative — a correlated
          -- subquery per group — is a second scan of an unindexed column.
          RIGHT(GROUP_CONCAT(
            CASE s.event
              WHEN 'connector.run.finished' THEN
                CASE COALESCE(JSON_UNQUOTE(JSON_EXTRACT(s.detail, '$.status')), '')
                  WHEN 'failed' THEN 'F'
                  WHEN 'succeeded' THEN 'S'
                  -- A finish with no status at all is not a success. Guessing
                  -- either way here is how a failed load comes to be painted
                  -- green; 'U' falls through to "incomplete", which says what
                  -- is actually known.
                  ELSE 'U'
                END
              WHEN 'snapshot.committed' THEN 'C'
              WHEN 'snapshot.dropped' THEN 'D'
            END
            ORDER BY s.occurred_at, s.phase, s.id SEPARATOR ''
          ), 1) AS last_terminal
        FROM scoped s
        JOIN matched m ON m.snapshot_id = s.snapshot_id
        GROUP BY s.snapshot_id
      ),
      graded AS (
        SELECT
          u.*,
          CASE
            -- An open connector frame outranks every other piece of evidence,
            -- including a commit. A run that committed and then never reported
            -- back has not finished, and the commit is precisely what would
            -- make it look as though it had.
            WHEN u.starts > u.finishes THEN 'running'
            WHEN u.last_terminal = 'F' THEN 'failed'
            WHEN u.last_terminal IN ('S', 'C') THEN 'succeeded'
            ELSE 'incomplete'
          END AS outcome
        FROM summary u
      )`;
}

/**
 * The filter, as conditions over one span row and the parameters they bind.
 *
 * Applied inside `matched`, which keeps every span of a trace that has one
 * matching event — never as a filter on the spans themselves. A trace returned
 * with only its `failed` events would be a story with the middle torn out that
 * still rendered as whole.
 */
function spanConditions(query: TraceQuery & { traceId?: string }): {
  conditions: string[];
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.traceId) {
    conditions.push('s.snapshot_id = ?');
    params.push(query.traceId);
  }
  if (query.typeName) {
    conditions.push('s.type_name = ?');
    params.push(query.typeName);
  }
  if (query.principalId) {
    conditions.push('s.principal_id = ?');
    params.push(query.principalId);
  }
  if (query.event) {
    conditions.push('s.event = ?');
    params.push(query.event);
  }
  if (query.since) {
    conditions.push('s.occurred_at >= ?');
    params.push(new Date(query.since));
  }

  return { conditions, params };
}

/**
 * The outcome filter, applied after grading.
 *
 * After, rather than as another `matched` condition, because an outcome is a
 * property of the whole trace and no single row carries it.
 *
 * Three cases, and the third is the one worth writing down. No filter is
 * `1 = 1`. One or more outcomes is an `IN` list, which is what lets the "needs
 * attention" question — failed *and* incomplete — be one query whose page is
 * genuinely the newest N of the union, rather than two pages merged afterwards
 * with whichever outcome was busier pushing the other off the bottom. An
 * *empty* list is `1 = 0`, not "no filter": the caller asked for none of the
 * outcomes, and answering that with every trace in the window would turn an
 * empty selection into a screen claiming everything needs attention.
 */
function outcomeClause(query: TraceQuery): { sql: string; params: unknown[] } {
  const outcomes = traceOutcomeFilter(query.outcome);
  if (outcomes === undefined) return { sql: '1 = 1', params: [] };
  if (outcomes.length === 0) return { sql: '1 = 0', params: [] };
  const placeholders = outcomes.map(() => '?').join(', ');
  return { sql: `g.outcome IN (${placeholders})`, params: [...outcomes] };
}

/** One span, with its trace's aggregates repeated on every row of the join. */
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
  total: unknown;
  span_id: string;
  span_event: string;
  span_type_name: string | null;
  span_principal_id: string | null;
  span_detail: unknown;
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

/**
 * Folds the joined rows into traces.
 *
 * Bounded by the page, not by the table: the LIMIT has already been applied, so
 * this walks at most `limit` traces' worth of spans. The database did the part
 * that scales.
 */
function assembleTraces(rows: SpanRow[]): CatalogTrace[] {
  const byId = new Map<string, CatalogTrace>();
  // The rows arrive in the order the trace should be told and the order the
  // traces should be listed, so a single pass preserves both.
  const order: string[] = [];
  const spansById = new Map<string, CatalogTraceSpan[]>();

  for (const row of rows) {
    const traceId = row.snapshot_id;

    if (!byId.has(traceId)) {
      byId.set(traceId, traceFromRow(row));
      spansById.set(traceId, []);
      order.push(traceId);
    }

    spansById.get(traceId)?.push(spanFromRow(row));
  }

  return order.map((traceId) => {
    const trace = byId.get(traceId);
    const spans = spansById.get(traceId) ?? [];
    // Neither can be missing — both maps are written together above — but a
    // non-null assertion here would be a promise the compiler cannot check.
    if (!trace) throw new Error(`Lost trace ${traceId} while assembling it.`);
    return withSpanTiming(trace, spans);
  });
}

/**
 * The trace header, taken from the first row that carries its id.
 *
 * Every row of one trace repeats these columns — they are the aggregate side of
 * the join — so the first row is as good as any, and reading them again per row
 * would be the same answer computed N times.
 */
function traceFromRow(row: SpanRow): CatalogTrace {
  const startedAt = toDate(row.started_at);
  const lastEventAt = toDate(row.last_at);
  const outcome = isCatalogTraceOutcome(row.outcome)
    ? row.outcome
    : // Unreachable while the CASE above and the outcome list agree. If they
      // ever stop agreeing, "incomplete" is the reading that claims least.
      'incomplete';
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

/** One row's span, with the timings left for {@link withSpanTiming}. */
function spanFromRow(row: SpanRow): CatalogTraceSpan {
  const detail = toDetail(row.span_detail);
  const error = errorOf(detail);

  return {
    id: row.span_id,
    event: row.span_event,
    typeName: row.span_type_name ?? undefined,
    principalId: row.span_principal_id ?? undefined,
    detail,
    occurredAt: toDate(row.span_at).toISOString(),
    // Filled in on the second pass, once the whole trace is known: a span's
    // width is the distance to the event after it, which the row itself
    // cannot see.
    offsetMs: 0,
    durationMs: 0,
    failed: error !== undefined || detail.status === 'failed',
    error,
  };
}

/**
 * Second pass: the two numbers a span cannot know about itself.
 *
 * A span's offset is measured from the trace's start and its width is the
 * distance to the event after it, so both need the assembled, ordered trace —
 * which is the whole reason this is a second pass rather than part of
 * {@link spanFromRow}. The last span has no successor and is given zero width
 * rather than being stretched to the trace's end: it has not necessarily
 * finished, and drawing it as though it had is the difference between a running
 * load and a finished one.
 */
function withSpanTiming(trace: CatalogTrace, spans: CatalogTraceSpan[]): CatalogTrace {
  const start = new Date(trace.startedAt).getTime();
  for (let index = 0; index < spans.length; index += 1) {
    const at = new Date(spans[index].occurredAt).getTime();
    const next = spans[index + 1];
    spans[index].offsetMs = at - start;
    spans[index].durationMs = next ? new Date(next.occurredAt).getTime() - at : 0;
  }

  // The most recent failure, not the first: on a retried snapshot id the last
  // one is the reason it is still broken, and the earlier ones stay reachable
  // on their own spans.
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

/**
 * JSON columns come back parsed by the driver, but not always — a column read
 * through a CTE, or a driver configured to hand back strings, gives text. Both
 * are handled rather than assumed, because the failure of the assumption is a
 * detail pane rendering `[object Object]` at the moment someone is trying to
 * read an error message out of it.
 */
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

/** `SUM()` comes back as a decimal string, `COUNT()` as a number. */
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
  // Epoch rather than "now": a trace whose timestamps could not be read should
  // sort to the bottom and look obviously wrong, not blend into today.
  return new Date(0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.floor(Number(value) || min), min), max);
}

/** Single-quoted SQL literal, for the event names this module inlines itself. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
