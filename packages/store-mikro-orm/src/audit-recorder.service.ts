import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import {
  CATALOG_EVENTS,
  CATALOG_EVENT_PHASE,
  CATALOG_EVENT_PHASE_FALLBACK,
  CATALOG_LIB,
  CATALOG_WORKSPACE_STORE,
  type CatalogAuditEvent,
  type CatalogTrace,
  type CatalogTraceList,
  type CatalogTraceSpan,
  type CatalogTraceStore,
  type CatalogTraceTotals,
  type CatalogUnlinkedList,
  type CatalogWorkspaceStore,
  type TraceQuery,
  channelNameFor,
  isCatalogTraceOutcome,
  traceOutcomeFilter,
} from '@dudousxd/nestjs-catalog';
import type { EntityManager } from '@mikro-orm/sql';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { CATALOG_STORE_ENTITY_MANAGER } from './context';

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

  constructor(
    // By token, never positionally — and here for a second reason on top of the
    // one its siblings give. Asking for `MySqlWorkspaceStore` by class pins this
    // recorder to one connection for the life of the process, and
    // `RoutingWorkspaceStore` *implements* the interface rather than extending
    // the class, so it could never be substituted however a host wired its
    // module. Every event in a multi-environment deployment would have landed in
    // whichever single database the recorder happened to be constructed
    // against, filed under no environment at all — a dev event sitting in the
    // production audit table, reading exactly like a production one.
    @Inject(CATALOG_WORKSPACE_STORE)
    private readonly workspace: CatalogWorkspaceStore,
  ) {}

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
 * The finest gap the audit table's timestamp can express, in milliseconds.
 *
 * Read off `AuditEventRow.occurredAt` in `entities/workspace.ts`, which is
 * `@Property({ length: 3 })` — a `datetime(3)`, and its own docblock explains
 * why it was widened. This constant went on saying `1_000` after that widening,
 * and the cost was not academic: `coarse` is
 * `duration < CLOCK_RESOLUTION_MS`, so every trace that finished inside a second
 * — which is most of them, and all of the fast ones — was flagged as having no
 * measurable internal timing. The explorer answered with a dashed track and the
 * tooltip "there is no internal timing to draw" over spans whose real spacing
 * was sitting right there in the rows, on exactly the loads a waterfall exists
 * to explain.
 *
 * Reported to the consumer rather than assumed by it, because only this side
 * knows what the writer stored. Rows written before the column was widened are
 * still whole seconds: their spans collapse onto one instant, so they come back
 * `coarse` under this value too and are drawn as markers — which is the truth
 * about them. What changes is that a *newer* trace is no longer told it has
 * nothing to show.
 *
 * If the column is ever narrowed or widened again, this is the number that has
 * to move with it. They are two halves of one fact and there is no way for the
 * code to check that they agree.
 */
const CLOCK_RESOLUTION_MS = 1;

// -----------------------------------------------------------------------------
// Retention, and why there still is none.
//
// Nothing prunes `catalog_audit_event`, and this change does not add anything
// that does. Written down here because the read path is where the consequence
// shows up, and because the shape of the answer is a decision for whoever runs
// a deployment rather than something a library should quietly take.
//
// ## Why a `LIMIT` is not the fix
//
// The obvious move — cap the window this query looks at — makes the screen lie.
// A page that silently truncates reads as "this is everything", and this is the
// governance surface: the whole reason the trail exists is to answer "who
// changed this, and when" about a month nobody is thinking about today. A
// screen that shows six weeks and says nothing about the year behind it is
// worse than a slow one, because a slow screen is obviously slow.
//
// So the paging above is bounded but the *history* is not: `total` is the real
// number of matching traces, `offset` reaches all of it, and a caller that
// wants a window asks for one with `since`.
//
// ## The shape retention should take
//
// Three tables grow without bound and they do not deserve the same policy:
//
// - `catalog_audit_event` — the trail. Prune by **age**, and only ever
//   whole traces: deleting the middle of a load leaves a story with pages torn
//   out that still renders as whole, which is the exact failure the scope CTEs
//   exist to prevent. So the unit is a `snapshot_id` whose *last* event is
//   older than the window, plus the unlinked events older than it.
// - `catalog_connector_run` — the run log. Prune by **count per connector**,
//   not by age: "the last 200 runs of this connector" stays useful on a
//   connector that runs monthly, where an age window empties it.
// - `catalog_snapshot` — **not on a timer at all, and still not.** A snapshot
//   row names data a type may still be serving; `pruneSnapshots(type, keep)` in
//   the ClickHouse store already argues this, and dropping one by age is how a
//   published type comes to point at nothing.
//
//   What has changed is what a drop costs, not who decides one. `dropSnapshot`
//   deletes a snapshot's rows and keeps its row here as a tombstone, so the run
//   log's `snapshot_id` still resolves to a record after the data is gone and
//   the serving snapshot cannot be dropped at all. That removes the objection
//   to *ever* deleting rows; it does not supply a policy for when, and pruning
//   this table itself is still the thing that would break the trail.
//
// Whatever runs it should be the host's, not this library's, and it should log
// what it removed. A deployment that discovers its audit trail is shorter than
// it thought, from a job it did not know was running, has lost the thing the
// trail was for.
// -----------------------------------------------------------------------------

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
 *
 * ## What a page costs
 *
 * Stated per request, because this screen sits inside somebody else's
 * application and a catalog that stalls the pool it borrows is a catalog that
 * gets removed.
 *
 * Without an outcome filter — which is what the explorer asks on load — a page
 * costs **one index-only pass to choose the page, then work proportional to the
 * page**: a `GROUP BY snapshot_id` over
 * `(snapshot_id, occurred_at)` alone, which MySQL answers as a covering skip
 * scan and never touches a row for, followed by aggregation and a span join
 * over the ≤ {@link MAX_TRACE_LIMIT} traces that survived. The `detail` column —
 * the widest one in the table, and the only one that has to be parsed — is read
 * for the page's spans and for nothing else.
 *
 * With an outcome filter it costs **a pass over every matching trace**, and
 * that is not a shortcoming of the statement. An outcome is `CASE ... END` over
 * `JSON_EXTRACT(detail, '$.status')` and a count of open connector frames; no
 * index can answer "which traces failed" while the answer lives inside a JSON
 * document, so the filter cannot be applied before the grading it is derived
 * from. `since` is what bounds it — the conditions reach `(occurred_at)`, and
 * the pass is over the window rather than over the table. Telescope's panels
 * all pass one (`catalog-trace-providers.ts`); the explorer's outcome chips
 * (`TraceExplorer.tsx`) do not, so clicking one is still the expensive read on
 * this screen and is the next thing worth fixing here.
 *
 * ## Why it is not simply "add an index"
 *
 * It was not an index. The four this table carries are the right four, and
 * before this the trace query could not use any of them: every filter was
 * written against a `scoped` CTE — the whole linked half of the table, `detail`
 * included, spooled into a temporary table — rather than against
 * `catalog_audit_event`, so the optimiser had nothing indexed left to reason
 * about. `EXPLAIN ANALYZE` on a 187k-row table showed it read three times and
 * sorted once to return 144 span rows. Reading the base table in every CTE is
 * what lets the existing indexes do their job, and is why this change adds no
 * DDL: an `@Index` added here would never reach an already-booted database
 * anyway, because the schema fingerprint in `schema.ts` is built from column
 * names, types and nullability and does not move when an index does.
 *
 * ## One thing a deployment should run
 *
 * No DDL, but `ANALYZE TABLE catalog_audit_event` once, if this table was
 * loaded in bulk — a restored dump, a backfill — rather than grown a row at a
 * time.
 *
 * Choosing the page is unaffected either way; it is a covering skip scan and
 * needs no statistics. The two span joins are what turn on them. With current
 * statistics MySQL looks each trace's spans up on `(snapshot_id, occurred_at)`,
 * 50 lookups for a 50-trace page. With statistics it has never gathered it
 * prices a full scan of the table at a cost of `0.102`, hash-joins instead, and
 * reads every row twice — measured on a 173k-row table, 138ms against 415ms for
 * the identical statement. A trail that grew normally gets this from
 * `innodb_stats_auto_recalc` and needs nothing; a trail that was restored has
 * never been sampled and will not be until it changes by 10%.
 *
 * ## And it still cannot be fast forever
 *
 * See the retention note near the top of this section. Nothing prunes this
 * table, so the outcome path grows without bound even though the default path
 * no longer does.
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
    const graded = gradesBeforePaging(query);

    const [rows, unlinked, counted] = await Promise.all([
      // Without the payloads. A page carries every span of every trace on it,
      // and the payload is the one column with no bound on its width — see
      // `spanColumns` for what that cost measured and why nothing on the list
      // is poorer for its absence.
      this.fetchSpanRows(query, limit, offset, { detail: false }),
      // Bounded by its own constant rather than by the caller's `limit`, which
      // belongs to the traces. This copy exists to show that changes happened
      // alongside the loads; a caller that wants to page them asks
      // `listUnlinked` and says how many it wants.
      this.fetchUnlinked(query, UNLINKED_LIMIT),
      // Only when the page was chosen before grading. The other statement
      // already carries a truthful total on every row, and a second count
      // would be a second pass over the same traces to learn what it just
      // computed.
      graded ? undefined : this.countTraces(query),
    ]);

    const traces = assembleTraces(rows);
    return {
      traces,
      // Two truthful answers, from whichever statement was in a position to
      // give one.
      //
      // When grading came first, `COUNT(*) OVER ()` is evaluated before the
      // LIMIT, so it is the real number of matching traces — but it only
      // reaches us on a row, so an empty page carries no total and zero is all
      // that can be claimed. When paging came first the count is its own
      // statement over the same filter, which is strictly better: a page past
      // the end of the list now still reports how many traces there are,
      // instead of answering an out-of-range offset with "there are none".
      total: graded ? (rows.length > 0 ? toNumber(rows[0].total) : 0) : (counted ?? 0),
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
    //
    // With the payloads, which is the one way this deliberately differs from
    // the list: there is a single trace to read them for, and this is the call
    // somebody makes precisely because they want to see them.
    const rows = await this.fetchSpanRows({ traceId: id }, 1, 0, { detail: true });
    return assembleTraces(rows)[0];
  }

  /**
   * One round trip: name the traces on this page, grade them, then join every
   * span of the ones that survived back on.
   *
   * The join deliberately re-reads all spans of a matched trace and not just
   * the ones the filter hit. A trace shown with only its `failed` events would
   * be a story with the middle torn out that still rendered as whole, which is
   * the failure mode this whole screen exists to prevent.
   *
   * `STRAIGHT_JOIN`, and that is not decoration. Left to choose, MySQL builds a
   * hash join with `catalog_audit_event` as the build side and scans the whole
   * table to find the spans of at most {@link MAX_TRACE_LIMIT} traces — it does
   * this even having just estimated the page at nothing, so the hint is not
   * making up for a missing statistic. Naming the order forces the only sane
   * plan: walk the page, and look each trace's spans up on
   * `(snapshot_id, occurred_at)`. Measured on 622k rows it is the difference
   * between 1452ms and 949ms, and the gap widens with the table because the bad
   * plan is the one that grows with it.
   *
   * The db spec asserts the plan rather than the timing, so this stays honest:
   * dropping the hint puts `Table scan on e` back and fails there.
   */
  private fetchSpanRows(
    query: TraceQuery & { traceId?: string },
    limit: number,
    offset: number,
    span: { detail: boolean },
  ): Promise<SpanRow[]> {
    const graded = gradesBeforePaging(query);

    // `limit` and `offset` are interpolated, not bound: both have already been
    // clamped to integers by the caller above, and every driver in this stack
    // treats a bound LIMIT differently enough to be worth not relying on.
    const page = graded
      ? (() => {
          // Grading has to happen first, so the LIMIT lands after it and
          // `COUNT(*) OVER ()` can say how many traces matched.
          const scope = matchedScope(query);
          const outcome = outcomeClause(query);
          return {
            sql: `${gradedTraces(scope.sql)},
              page AS (
                SELECT g.*, COUNT(*) OVER () AS total
                FROM graded g
                WHERE ${outcome.sql}
                ORDER BY g.started_at DESC, g.snapshot_id DESC
                LIMIT ${limit} OFFSET ${offset}
              )`,
            params: [...scope.params, ...outcome.params],
          };
        })()
      : (() => {
          // Nothing here needs a grade, so the LIMIT lands before the grading
          // and everything after it is bounded by the page.
          const scope = pagedScope(query, limit, offset);
          return {
            sql: `${gradedTraces(scope.sql)},
              page AS (SELECT g.* FROM graded g)`,
            params: scope.params,
          };
        })();

    const sql = `
      ${page.sql}
      SELECT
        p.snapshot_id, p.started_at, p.last_at, p.event_count, p.type_name,
        p.principal_id, p.connector_id, p.connector_name, p.rows_committed,
        p.failures, p.outcome, ${graded ? 'p.total,' : ''}
        e.id AS span_id, e.event AS span_event, e.type_name AS span_type_name,
        e.principal_id AS span_principal_id, ${spanColumns(span.detail)},
        e.occurred_at AS span_at
      FROM page p
      STRAIGHT_JOIN catalog_audit_event e ON e.snapshot_id = p.snapshot_id
      ORDER BY
        p.started_at DESC, p.snapshot_id DESC,
        e.occurred_at ASC, ${PHASE_CASE} ASC, e.id ASC
    `;

    return this.em.getConnection().execute<SpanRow[]>(sql, page.params);
  }

  /**
   * How many traces the filter matches, when the page did not have to be
   * graded to be chosen.
   *
   * `COUNT(DISTINCT snapshot_id)` over the filter directly, which is the same
   * set {@link matchedScope} would have named and is answered from
   * `(snapshot_id, occurred_at)` without reading a row. The conditions apply to
   * spans and a trace counts once if any of its spans match — the same rule
   * {@link spanConditions} describes, and the reason this is a `DISTINCT` count
   * rather than a count of rows.
   */
  private async countTraces(query: TraceQuery & { traceId?: string }): Promise<number> {
    const { conditions, params } = spanConditions(query, 'e');
    const rows = await this.em.getConnection().execute<Array<{ total: unknown }>>(
      `SELECT COUNT(DISTINCT e.snapshot_id) AS total
         FROM catalog_audit_event e
        WHERE e.snapshot_id IS NOT NULL${conditions.map((each) => ` AND ${each}`).join('')}`,
      params,
    );
    return toNumber(rows[0]?.total);
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
   *
   * Grades every matching trace and always will: both numbers it returns are
   * over the whole matched set rather than over a page, so there is no page to
   * bound the work with. It costs what the outcome-filtered branch of
   * {@link listTraces} costs, for the same reason — see that class docblock,
   * and pass `since`.
   */
  async traceTotals(query: TraceQuery): Promise<CatalogTraceTotals> {
    const scope = matchedScope(query);
    const outcome = outcomeClause(query);

    const rows = await this.em
      .getConnection()
      .execute<Array<{ traces: unknown; rows_committed: unknown }>>(
        `${gradedTraces(scope.sql)}
       SELECT COUNT(*) AS traces, COALESCE(SUM(g.rows_committed), 0) AS rows_committed
         FROM graded g
        WHERE ${outcome.sql}`,
        [...scope.params, ...outcome.params],
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
 * Whether the traces have to be graded before the page can be chosen.
 *
 * Exactly when the caller filtered by outcome, and the whole shape of the
 * statement turns on it. An outcome is not stored — it is derived from
 * `JSON_EXTRACT(detail, '$.status')` and from counting open connector frames —
 * so "the newest 50 failed traces" cannot be known until every candidate has
 * been graded. Nothing else the filter can ask has that property: a type, a
 * principal, an event name and a time are all columns, and a page selected on
 * them is a page selected from an index.
 */
function gradesBeforePaging(query: TraceQuery): boolean {
  return traceOutcomeFilter(query.outcome) !== undefined;
}

/**
 * What the page is: the ids of at most `limit` traces, chosen without grading
 * any of them.
 *
 * This is the change that made the screen usable. Ordering is by
 * `MIN(occurred_at)` per snapshot id — the identical key `graded.started_at`
 * carries, so the page this picks is the page the tail displays and page two
 * cannot repeat or skip a trace — and that key is the *leading pair* of
 * `(snapshot_id, occurred_at)`. MySQL answers it as a covering skip scan: no
 * row is read, no `detail` is parsed, and nothing is grouped a second time.
 * Everything downstream then joins against at most {@link MAX_TRACE_LIMIT} ids.
 *
 * The `IN` is present only when the caller filtered, and the reason it is a
 * semijoin rather than a `WHERE` on this aggregate is the thing that would
 * otherwise be subtly wrong. The conditions select *spans*; the ordering key is
 * `MIN` over the *whole* trace. Filtering the rows this aggregate sees would
 * order by the earliest **matching** span instead — so `?event=connector.run.finished`
 * would page by when each load finished while displaying when it started, and
 * the two orders disagree exactly often enough to lose traces between pages.
 */
function pagedScope(
  query: TraceQuery & { traceId?: string },
  limit: number,
  offset: number,
): Scope {
  // Under `f`, because these conditions go inside a subquery that reads the
  // same table a second time. Asked for rather than rewritten out of the `e`
  // form: search-and-replacing an alias across generated SQL is the kind of
  // thing that works until a condition mentions a literal containing `e.`.
  const { conditions, params } = spanConditions(query, 'f');
  const narrow =
    conditions.length > 0
      ? `AND e.snapshot_id IN (
             SELECT DISTINCT f.snapshot_id
               FROM catalog_audit_event f
              WHERE f.snapshot_id IS NOT NULL
                AND ${conditions.join(' AND ')}
           )`
      : '';

  return {
    sql: `
      scope AS (
        SELECT e.snapshot_id, MIN(e.occurred_at) AS ordered_at
        FROM catalog_audit_event e
        WHERE e.snapshot_id IS NOT NULL
        ${narrow}
        GROUP BY e.snapshot_id
        ORDER BY ordered_at DESC, e.snapshot_id DESC
        LIMIT ${limit} OFFSET ${offset}
      )`,
    params,
  };
}

/** A CTE naming which traces to grade, and what it binds. */
interface Scope {
  /** `undefined` for "every trace there is" — see {@link gradedTraces}. */
  sql: string | undefined;
  params: unknown[];
}

/**
 * What the page is drawn from when an outcome was asked for: every trace with a
 * matching span, unbounded, because none of them can be excluded before it has
 * been graded.
 *
 * Reads `catalog_audit_event` rather than a CTE over it, which is the whole
 * difference from what this used to do. The conditions land on the base table,
 * so `type_name`, `principal_id` and `occurred_at` reach their indexes and a
 * `since` window costs a range scan instead of a table scan.
 *
 * Absent entirely when there are no conditions, which is the case an outcome
 * filter on its own produces — an outcome is not a span condition. The join it
 * would produce is the identity, since every trace matches, so what it buys is
 * a `DISTINCT` pass over the whole index and a join that excludes nothing.
 * `gradedTraces` drops the join rather than writing it out as `1 = 1` in CTE
 * form, because a join MySQL still has to execute is not free for being
 * pointless.
 */
function matchedScope(query: TraceQuery & { traceId?: string }): Scope {
  const { conditions, params } = spanConditions(query, 'e');
  if (conditions.length === 0) return { sql: undefined, params: [] };
  return {
    sql: `
      scope AS (
        SELECT DISTINCT e.snapshot_id
        FROM catalog_audit_event e
        WHERE e.snapshot_id IS NOT NULL
          AND ${conditions.join(' AND ')}
      )`,
    params,
  };
}

/**
 * What a span row carries of the event payload.
 *
 * Two shapes, and the caller picks by whether it is answering `getTrace` or
 * `listTraces`:
 *
 * - **With the payload** — `e.detail` as it is stored, which is what the detail
 *   view exists to show.
 * - **Without it** — the two fields grading actually reads, extracted in the
 *   database: the error message, and the status that marks a failed step. The
 *   payload itself never leaves the disk.
 *
 * The second shape is not a smaller version of the first, it is the same
 * answer computed a cheaper way. `spanFromRow` derives `failed` and `error`
 * from whichever came back by the identical rule, so a span is graded the same
 * on both paths — the list and the detail view cannot come to disagree about
 * which step failed, which is the one way this optimisation could have gone
 * wrong quietly.
 *
 * ## Why it is worth a branch
 *
 * A trace list carries **every span of every trace on the page** — that is
 * deliberate, and `fetchSpanRows` explains why a filtered trace is still shown
 * whole. But it means the page's width is the number of traces times their
 * length, and on a real deployment that is not small: a 50-trace page measured
 * 28,022 spans carrying 4.31 MB of payload, on a screen that re-polls every ten
 * seconds. Those bytes crossed the wire from the database, were parsed into
 * 28,022 objects, and were serialised again into a 10.4 MB response — to draw a
 * waterfall that reads none of them. The payload is read when somebody expands
 * a trace, and there is exactly one trace to read it for at that point.
 *
 * `JSON_EXTRACT` on the two fields costs the same scan the grading CTEs already
 * pay for; what is saved is the transfer, the parse and the re-serialisation of
 * everything else in the payload.
 */
function spanColumns(withDetail: boolean): string {
  if (withDetail) return 'e.detail AS span_detail';
  return `${jsonString('$.error')} AS span_error,
        ${jsonString('$.status')} AS span_status`;
}

/**
 * One JSON field, but only if it really is a string.
 *
 * The `JSON_TYPE` guard is not defensive padding, it is what makes this path
 * agree with the other one. `JSON_UNQUOTE` renders a JSON `null` as the
 * four-character string `"null"` and a number as its digits, where the
 * TypeScript side asks `typeof value === 'string'` and rejects both. Without
 * the guard a payload holding `"error": null` would grade as failed on the list
 * and fine on the detail view, and the message shown for it would be the word
 * "null" — a difference that appears only on data nobody writes on purpose,
 * which is the kind that survives review and shows up in an incident.
 */
function jsonString(path: string): string {
  return `CASE WHEN JSON_TYPE(JSON_EXTRACT(e.detail, '${path}')) = 'STRING'
                 THEN JSON_UNQUOTE(JSON_EXTRACT(e.detail, '${path}')) END`;
}

/**
 * The grouping and grading half of the trace query, shared by everything that
 * needs it.
 *
 * A string builder rather than a view or a stored routine because it closes
 * over the caller's filter, and because the alternative — each entry point
 * writing its own copy of these CTEs — is how a page and the total printed
 * above it come to be computed by two statements that agree until they do not.
 *
 * `scope` names which traces to aggregate — {@link pagedScope} for a page
 * chosen up front, {@link matchedScope} for everything the filter matched — or
 * is `undefined` for "every trace there is", in which case the join is dropped
 * rather than written as an identity.
 *
 * Ends with the `graded` CTE and no trailing `SELECT`, so a caller appends
 * either another CTE or its own tail. Every parameter it takes comes from
 * {@link spanConditions}, in that order.
 */
function gradedTraces(scope: string | undefined): string {
  return `
      WITH ${scope === undefined ? '' : `${scope.trim()},`}
      summary AS (
        SELECT
          e.snapshot_id,
          MIN(e.occurred_at) AS started_at,
          MAX(e.occurred_at) AS last_at,
          COUNT(*) AS event_count,
          MAX(e.type_name) AS type_name,
          MAX(e.principal_id) AS principal_id,
          MAX(JSON_UNQUOTE(JSON_EXTRACT(e.detail, '$.connectorId'))) AS connector_id,
          MAX(JSON_UNQUOTE(JSON_EXTRACT(e.detail, '$.connectorName'))) AS connector_name,
          MAX(CASE WHEN e.event = 'snapshot.committed'
                   THEN CAST(JSON_EXTRACT(e.detail, '$.rowCount') AS UNSIGNED)
              END) AS rows_committed,
          SUM(e.event = 'connector.run.started') AS starts,
          SUM(e.event = 'connector.run.finished') AS finishes,
          -- COALESCE before the comparison, because a payload without a status
          -- makes the whole OR null, SUM of nulls is null, and a null failure
          -- count reads downstream as zero failures.
          SUM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(e.detail, '$.status')), '') = 'failed'
              OR JSON_EXTRACT(e.detail, '$.error') IS NOT NULL) AS failures,
          -- The last terminal marker, as one character per terminal event in
          -- lifecycle order. GROUP_CONCAT skips the nulls, so this string holds
          -- only the events that could end a trace, and RIGHT() takes the one
          -- that actually did. A character each because the concat is capped at
          -- group_concat_max_len: a thousand retries of a single snapshot id
          -- would be needed to truncate it, and the alternative — a correlated
          -- subquery per group — is a second scan of an unindexed column.
          RIGHT(GROUP_CONCAT(
            CASE e.event
              WHEN 'connector.run.finished' THEN
                CASE COALESCE(JSON_UNQUOTE(JSON_EXTRACT(e.detail, '$.status')), '')
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
            -- The lifecycle rank, inline rather than read off a CTE column. It
            -- is the reason a trace does not read finished, written, committed,
            -- started -- a load that lands inside one millisecond has nothing
            -- but this to order it by.
            ORDER BY e.occurred_at, ${PHASE_CASE}, e.id SEPARATOR ''
          ), 1) AS last_terminal
        FROM catalog_audit_event e
        ${scope === undefined ? 'WHERE e.snapshot_id IS NOT NULL' : 'JOIN scope k ON k.snapshot_id = e.snapshot_id'}
        GROUP BY e.snapshot_id
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
 * Applied to choose *which traces*, never to choose which spans of them come
 * back. A trace returned with only its `failed` events would be a story with
 * the middle torn out that still rendered as whole.
 *
 * `alias` is which copy of `catalog_audit_event` these read, because two of the
 * three callers put them in a subquery beside a second copy of the table. It is
 * a parameter rather than a fixed prefix so that the alias is chosen where the
 * SQL around it is written, instead of being patched into finished SQL
 * afterwards.
 */
function spanConditions(
  query: TraceQuery & { traceId?: string },
  alias: string,
): {
  conditions: string[];
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.traceId) {
    conditions.push(`${alias}.snapshot_id = ?`);
    params.push(query.traceId);
  }
  if (query.typeName) {
    conditions.push(`${alias}.type_name = ?`);
    params.push(query.typeName);
  }
  if (query.principalId) {
    conditions.push(`${alias}.principal_id = ?`);
    params.push(query.principalId);
  }
  if (query.event) {
    conditions.push(`${alias}.event = ?`);
    params.push(query.event);
  }
  if (query.since) {
    conditions.push(`${alias}.occurred_at >= ?`);
    params.push(new Date(query.since));
  }

  return { conditions, params };
}

/**
 * The outcome filter, applied after grading.
 *
 * After, rather than as another scope condition, because an outcome is a
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
  /**
   * Present only when grading came before paging, which is the only case that
   * can put a total on a row: `COUNT(*) OVER ()` counts the graded traces, and
   * a page chosen before grading never graded the ones it left behind.
   * {@link MySqlCatalogTraceStore.countTraces} answers for the other case.
   */
  total?: unknown;
  span_id: string;
  span_event: string;
  span_type_name: string | null;
  span_principal_id: string | null;
  /** The whole payload — only when the caller asked for it. See {@link spanColumns}. */
  span_detail?: unknown;
  /**
   * The two fields grading reads out of the payload, when the payload itself
   * was left in the database. Exactly one of these and `span_detail` is
   * selected, never both, and {@link spanFromRow} reads whichever came back.
   */
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
  // Which of the two shapes {@link spanColumns} selects came back. `in` rather
  // than a truthiness test on the value: a payload-carrying row whose `detail`
  // is SQL NULL is still a payload-carrying row, and reading it as the other
  // shape would silently drop a failure the database did report.
  const carriesDetail = 'span_detail' in row;
  const detail = carriesDetail ? toDetail(row.span_detail) : undefined;

  // From the payload when it is here, from the two columns the database
  // extracted when it is not. Same rule either way — `errorOf` is a non-empty
  // string, and a failure is that or a `failed` status — so a span grades
  // identically on both paths and the list cannot disagree with the detail
  // view about which step went wrong.
  const error = detail ? errorOf(detail) : textOrUndefined(row.span_error);
  const status = detail ? detail.status : textOrUndefined(row.span_status);

  return {
    id: row.span_id,
    event: row.span_event,
    typeName: row.span_type_name ?? undefined,
    principalId: row.span_principal_id ?? undefined,
    // Left off the object entirely rather than set to `{}` when it was not
    // selected. An empty payload and an unfetched one are different facts, and
    // a `{}` would let a caller read "this event carried nothing" out of a row
    // that was never asked.
    ...(detail ? { detail } : {}),
    occurredAt: toDate(row.span_at).toISOString(),
    // Filled in on the second pass, once the whole trace is known: a span's
    // width is the distance to the event after it, which the row itself
    // cannot see.
    offsetMs: 0,
    durationMs: 0,
    failed: error !== undefined || status === 'failed',
    error,
  };
}

/** A driver value that is a usable string, or nothing. */
function textOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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
