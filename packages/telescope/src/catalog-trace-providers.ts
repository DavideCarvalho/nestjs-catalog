import {
  CATALOG_TRACE_OUTCOMES,
  CATALOG_TRACE_STORE,
  type CatalogAuditEvent,
  type CatalogTrace,
  type CatalogTraceOutcome,
  type CatalogTraceStore,
  isTraceStore,
} from '@dudousxd/nestjs-catalog';
import type { DataProvider, ExtensionContext } from '@dudousxd/nestjs-telescope';
import {
  NO_VALUE,
  capError,
  isRecord,
  resolveLimit,
  resolveSince,
  stringField,
} from './catalog.shared.js';

/**
 * The in-app Telescope route that renders one trace as a waterfall.
 *
 * A load's `snapshotId` is stamped as the `traceId` of every entry the watcher
 * records for it (see `buildCatalogEntry`), and a `CatalogTrace.id` IS that
 * snapshot id, so a row in these tables deep-links straight to the load's own
 * waterfall with nothing else wired. `#/…` is an in-app hash route, so it must
 * NOT be marked `external` — that would open a new tab onto the same SPA.
 */
const TRACE_HREF = '#/traces/{id}';

/**
 * How many succeeded loads the committed-rows stat sums over.
 *
 * The trace store reports an exact `total` per outcome but not an aggregate of
 * `rowsCommitted`, so the sum is computed over a bounded page rather than by
 * asking for every trace in the window. A window containing more than this many
 * successful loads will therefore UNDERCOUNT.
 *
 * That direction is chosen deliberately. An undercount makes a healthy night
 * look quieter than it was, which prompts a look; an overcount would make a bad
 * night look productive, which is the failure mode this whole package is built
 * to avoid. And an operator whose window holds five hundred successful loads is
 * not reading this stat to audit a row total.
 */
const ROWS_SUM_LIMIT = 500;

/**
 * Resolve the host's trace store, or `undefined` when it is not bound.
 *
 * Three things are going on, and each is load-bearing.
 *
 * The store is resolved at REQUEST time out of `ctx.moduleRef`, not captured at
 * module init, so this extension imposes no ordering on the host's module graph
 * — the same pattern `@dudousxd/nestjs-agent-telescope` uses for its governance
 * queries.
 *
 * `ModuleRef.get` THROWS when a token is unbound, it does not return
 * `undefined`. A host that runs the catalog without a trace-capable store is a
 * supported configuration, so the throw is caught and turned into an empty
 * panel rather than a five-hundred inside a dashboard.
 *
 * `isTraceStore` is checked even after a successful resolve. `CATALOG_TRACE_STORE`
 * is a plain `Symbol()`, not `Symbol.for()`, which means it is only equal to
 * itself within one loaded copy of `@dudousxd/nestjs-catalog`. If a package
 * manager ever hoists two copies — this package bundling its own instead of
 * taking the host's — the lookup silently misses and every durable panel goes
 * permanently, quietly blank. That is exactly why `@dudousxd/nestjs-catalog` is
 * a peerDependency here and never a dependency.
 */
export function resolveTraceStore(ctx: ExtensionContext): CatalogTraceStore | undefined {
  try {
    const resolved: unknown = ctx.moduleRef.get(CATALOG_TRACE_STORE, {
      strict: false,
    });
    return isTraceStore(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/** Count traces with `outcome` in the window, exactly, without fetching them. */
async function countByOutcome(
  store: CatalogTraceStore,
  outcome: CatalogTraceOutcome,
  since: string,
): Promise<number> {
  // `limit: 1` because only `total` is read. `total` is documented as the
  // matching count BEFORE paging, so this is an exact answer for the cost of
  // one row.
  const page = await store.listTraces({ outcome, since, limit: 1 });
  return page.total;
}

/**
 * A `stat` panel bound to one outcome's count.
 *
 * Each outcome gets its own panel rather than one "loads" number with a
 * breakdown beside it, because the four outcomes are not four slices of one
 * quantity — they are four different questions, and three of them are the
 * questions somebody is awake at 3am to answer.
 */
function outcomeStatProvider(name: string, outcome: CatalogTraceOutcome): DataProvider {
  return {
    name,
    async resolve(query, ctx) {
      const store = resolveTraceStore(ctx);
      if (!store) return { value: 0 };
      return { value: await countByOutcome(store, outcome, resolveSince(query)) };
    },
  };
}

/**
 * stat → loads that reported failure.
 *
 * Its own number, first on the page, with `up-bad` thresholds on the panel: a
 * non-zero here is the thing you came to find.
 */
export function catalogFailedLoadsProvider(): DataProvider {
  return outcomeStatProvider('catalog.loads.failed', 'failed');
}

/**
 * stat → loads that stopped without ever saying how they went.
 *
 * The most important number on this dashboard and the least obvious one.
 * `incomplete` is the catalog's name for batches written and never committed, a
 * snapshot dropped, a process that died between the two — rows landed, and no
 * reader can see any of them. Folded into "failed" it would be understated;
 * folded into "succeeded" it would be a silent data loss rendered in green,
 * which is precisely the failure-that-looks-like-a-success this codebase treats
 * as its worst class of bug. So it is neither, and it is shown on its own.
 */
export function catalogIncompleteLoadsProvider(): DataProvider {
  return outcomeStatProvider('catalog.loads.incomplete', 'incomplete');
}

/**
 * stat → loads currently in flight.
 *
 * Separated from every finished outcome so that an in-progress run is never
 * counted as, or rendered beside, a result. A load that is still running has
 * committed nothing a reader can see; a screen that let it sit in the same
 * column as a success would be reporting rows that do not exist yet.
 */
export function catalogRunningLoadsProvider(): DataProvider {
  return outcomeStatProvider('catalog.loads.running', 'running');
}

/**
 * stat → rows the window's successful loads made visible to readers.
 *
 * Committed rows specifically, not written rows. Written-and-uncommitted rows
 * are invisible to every reader of the catalog, so counting them here would
 * report work that moved no data as if it had.
 *
 * See {@link ROWS_SUM_LIMIT} for the bound on this sum and why it undercounts
 * rather than overcounts.
 */
export function catalogRowsCommittedProvider(): DataProvider {
  return {
    name: 'catalog.loads.rows',
    async resolve(query, ctx) {
      const store = resolveTraceStore(ctx);
      if (!store) return { value: 0 };
      const page = await store.listTraces({
        outcome: 'succeeded',
        since: resolveSince(query),
        limit: ROWS_SUM_LIMIT,
      });
      let total = 0;
      for (const trace of page.traces) {
        // Absent means nothing was ever committed, which contributes nothing —
        // not zero-as-a-measurement, just no term in the sum.
        if (typeof trace.rowsCommitted === 'number') total += trace.rowsCommitted;
      }
      return { value: total };
    },
  };
}

/**
 * breakdown → how the window's loads ended.
 *
 * Iterates {@link CATALOG_TRACE_OUTCOMES} rather than a literal list, so the
 * day the catalog adds a fifth outcome this donut shows it instead of quietly
 * dropping those loads out of the picture entirely.
 */
export function catalogOutcomeMixProvider(): DataProvider {
  return {
    name: 'catalog.loads.outcomes',
    async resolve(query, ctx) {
      const store = resolveTraceStore(ctx);
      if (!store) return { segments: [] };
      const since = resolveSince(query);
      const segments = await Promise.all(
        CATALOG_TRACE_OUTCOMES.map(async (outcome) => ({
          label: outcome,
          value: await countByOutcome(store, outcome, since),
        })),
      );
      // Zero-valued segments are dropped: a donut with four labels and one
      // non-zero slice reads as four categories of activity.
      return { segments: segments.filter((segment) => segment.value > 0) };
    },
  };
}

/** One row of a loads table. `id` is carried for the deep link even where no column shows it. */
export interface CatalogLoadTableRow {
  id: string;
  startedAt: string;
  typeName: string;
  connectorName: string;
  outcome: CatalogTraceOutcome;
  rows: number | string;
  durationMs: number | string;
  failures: number;
  error: string;
}

/**
 * Map a trace to a table row.
 *
 * Every optional field falls back to {@link NO_VALUE} rather than to `0` or to
 * a derived value. Two of those fallbacks are the whole reason this function
 * exists rather than the traces being returned raw:
 *
 *  - `durationMs` is absent for a `running` or `incomplete` trace, by design in
 *    the catalog: "we stopped hearing from it" and "it finished" are different
 *    facts, and only the second has a duration. A `0` in that cell would read
 *    as an instant load.
 *  - `rowsCommitted` is absent when nothing was ever committed. A `0` there
 *    would read as a measured result — "we checked, it was zero" — rather than
 *    as an absence of any commit at all.
 */
export function toLoadRow(trace: CatalogTrace): CatalogLoadTableRow {
  return {
    id: trace.id,
    startedAt: trace.startedAt,
    typeName: trace.typeName ?? NO_VALUE,
    connectorName: trace.connectorName ?? NO_VALUE,
    outcome: trace.outcome,
    rows: trace.rowsCommitted ?? NO_VALUE,
    durationMs: trace.durationMs ?? NO_VALUE,
    // Surfaced beside the outcome because a retry reuses the snapshot id, so a
    // trace can honestly be "succeeded, on the third attempt". A success with a
    // failure count is a healthy pipeline hiding an unhealthy dependency.
    failures: trace.failureCount,
    error: capError(trace.error) ?? NO_VALUE,
  };
}

/** table → the window's loads, newest first. */
export function catalogRecentLoadsProvider(): DataProvider {
  return {
    name: 'catalog.loads.recent',
    async resolve(query, ctx) {
      const store = resolveTraceStore(ctx);
      if (!store) return { rows: [] };
      const page = await store.listTraces({
        since: resolveSince(query),
        limit: resolveLimit(query),
      });
      return { rows: page.traces.map(toLoadRow) };
    },
  };
}

/**
 * table → only the loads that failed or never finished.
 *
 * A second table over the same data, and worth its own panel: the recent-loads
 * table on a healthy night is fifty green rows, and a single failure in
 * position thirty-one is not something a tired person finds by scrolling. This
 * one is empty when there is nothing wrong, which makes "not empty" the signal.
 *
 * Two queries rather than one filtered client-side, because the store's
 * `outcome` filter is applied before paging: fetching one page of everything
 * and keeping the bad rows would return however many failures happened to fall
 * inside the newest N loads, which on a busy night is zero of them.
 */
export function catalogProblemLoadsProvider(): DataProvider {
  return {
    name: 'catalog.loads.problems',
    async resolve(query, ctx) {
      const store = resolveTraceStore(ctx);
      if (!store) return { rows: [] };
      const since = resolveSince(query);
      const limit = resolveLimit(query);
      const [failed, incomplete] = await Promise.all([
        store.listTraces({ outcome: 'failed', since, limit }),
        store.listTraces({ outcome: 'incomplete', since, limit }),
      ]);
      const rows = [...failed.traces, ...incomplete.traces]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, limit)
        .map(toLoadRow);
      return { rows };
    },
  };
}

/** One row of the governance-changes table. */
export interface CatalogChangeTableRow {
  occurredAt: string;
  event: string;
  typeName: string;
  principalId: string;
  detail: string;
}

/**
 * Render the one-line "what changed" summary for a governance event.
 *
 * Hand-written per event rather than dumping the payload, because a table cell
 * holding `{"addedColumns":["a","b"],"created":false}` is not readable at 3am.
 * Every branch narrows with guards and every branch emits only NAMES — column
 * names, property names, a transform's name and version. That is the same line
 * the rest of the catalog holds: telemetry may give away the shape of an
 * integration, never its data.
 *
 * The default branch returns an empty string rather than stringifying an
 * unrecognised payload. An event this function has not been taught about could
 * carry anything, and guessing that it is safe to render is not a guess worth
 * making.
 */
export function summarizeChange(event: CatalogAuditEvent): string {
  const detail = isRecord(event.detail) ? event.detail : {};
  switch (event.event) {
    case 'schema.changed': {
      const raw = Reflect.get(detail, 'addedColumns');
      const columns = Array.isArray(raw)
        ? raw.filter((column): column is string => typeof column === 'string')
        : [];
      const created = Reflect.get(detail, 'created') === true;
      const table = stringField(detail, 'table') ?? NO_VALUE;
      if (created) return `created table ${table}`;
      return columns.length > 0 ? `${table}: +${columns.join(', ')}` : `${table}: no columns added`;
    }
    case 'type.curated': {
      const raw = Reflect.get(detail, 'changed');
      const changed = Array.isArray(raw)
        ? raw.filter((field): field is string => typeof field === 'string')
        : [];
      const property = stringField(detail, 'property');
      const target = property !== undefined ? `${property} ` : '';
      return `${target}${changed.join(', ')}`.trim();
    }
    case 'transform.changed': {
      const name = stringField(detail, 'name') ?? NO_VALUE;
      const language = stringField(detail, 'language') ?? NO_VALUE;
      const version = Reflect.get(detail, 'version');
      const versionLabel = typeof version === 'number' ? ` v${version}` : '';
      return `${name}${versionLabel} (${language})`;
    }
    default:
      return '';
  }
}

/**
 * table → schema changes, curation edits and transform changes.
 *
 * Read out of the trace list's `unlinked` bucket, which is exactly this set:
 * events carrying no snapshot id and therefore belonging to no load. The
 * catalog deliberately refuses to adopt them into the nearest trace, because a
 * transform edit that happened in the same second as a load is a coincidence,
 * and a UI that drew it as part of the load would be manufacturing evidence.
 * This panel honours that — they are shown beside the loads, never inside one.
 *
 * It is the second question of any incident. The first is "what broke"; the
 * second is "what changed", and for a load that produced a number nobody
 * believes, the answer is almost always on this table.
 */
export function catalogRecentChangesProvider(): DataProvider {
  return {
    name: 'catalog.changes.recent',
    async resolve(query, ctx) {
      const store = resolveTraceStore(ctx);
      if (!store) return { rows: [] };
      const limit = resolveLimit(query);
      // `limit` bounds the traces too, which this panel discards. Paying for a
      // page of traces to read the unlinked bucket is the cost of the store
      // exposing one call; it is bounded and it keeps the two views consistent
      // with each other, which matters more than the saved rows.
      const page = await store.listTraces({ since: resolveSince(query), limit });
      const rows: CatalogChangeTableRow[] = page.unlinked.map((event) => ({
        occurredAt: event.occurredAt,
        event: event.event,
        typeName: event.typeName ?? NO_VALUE,
        principalId: event.principalId ?? NO_VALUE,
        detail: summarizeChange(event),
      }));
      return { rows };
    },
  };
}

/** Every durable, trace-store-backed provider this package contributes. */
export function catalogTraceProviders(): DataProvider[] {
  return [
    catalogFailedLoadsProvider(),
    catalogIncompleteLoadsProvider(),
    catalogRunningLoadsProvider(),
    catalogRowsCommittedProvider(),
    catalogOutcomeMixProvider(),
    catalogRecentLoadsProvider(),
    catalogProblemLoadsProvider(),
    catalogRecentChangesProvider(),
  ];
}

export { TRACE_HREF };
