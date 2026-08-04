/**
 * The things people make *with* a catalog, as opposed to the model itself:
 * saved queries, dashboards, and the record of what happened to all of it.
 *
 * Kept apart from the store interfaces because these are optional in a
 * different way. A store that cannot run SQL simply has no saved queries; a
 * store with no event log still serves every read. A host should be able to
 * mount the catalog without any of this and notice nothing missing.
 */

export interface SavedQuery {
  id: string;
  name: string;
  description?: string;
  sql: string;
  /** Free-form grouping, the way a folder would work without being one. */
  folder?: string;
  /** Which application or person saved it. */
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /**
   * How long a result may be reused, in seconds. Zero means never cache.
   *
   * Per query rather than global: "how many vehicles are critical" tolerates a
   * five-minute-old answer, and the query behind a month-end report does not.
   */
  cacheTtlSeconds: number;
  /** How the dashboard should draw it. */
  visualization: QueryVisualization;
  /**
   * Whether another application may fetch this through the embed API.
   *
   * Explicit, and never inferred from the SQL. A saved query can join five
   * relations, so working out "which types does this touch" means parsing the
   * statement — and a permission derived from a parser is a permission that
   * silently widens the day the parser meets a query it did not expect. Marking
   * it shared is a decision a person made, and it shows up in the audit trail
   * as one.
   */
  shared: boolean;
}

export interface QueryVisualization {
  kind: 'table' | 'bar' | 'line' | 'area' | 'number';
  /**
   * Which chart library draws it, by registered name.
   *
   * Undefined means the built-in renderer, which needs no dependency. Naming a
   * library nobody registered falls back to that rather than failing — a
   * dashboard should degrade to a plainer chart, not to an error.
   */
  library?: string;
  /** Column for the category axis, or the label of a single number. */
  labelColumn?: string;
  /** Columns to plot. Empty means every numeric column. */
  valueColumns?: string[];
}

export interface SaveQueryInput {
  name: string;
  sql: string;
  description?: string;
  folder?: string;
  cacheTtlSeconds?: number;
  visualization?: QueryVisualization;
  shared?: boolean;
}

export interface Dashboard {
  id: string;
  name: string;
  description?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  cards: DashboardCard[];
  /** Fetchable through the embed API by an application with `catalog:embed`. */
  shared: boolean;
}

export interface DashboardCard {
  id: string;
  savedQueryId: string;
  /** Overrides the saved query's own title on this dashboard. */
  title?: string;
  /**
   * Overrides the saved query's chart library on this dashboard.
   *
   * Separate from the query's own choice because the two answer different
   * questions. The query says how this ANSWER is best drawn, once, wherever it
   * appears; the card says how it should look HERE, next to the other cards on
   * this board. A dashboard that mixes two chart libraries' idea of a bar looks
   * like two dashboards, and fixing that by editing the saved query would
   * change it on every other board that uses it.
   *
   * Undefined falls back to the query's `visualization.library`, which in turn
   * falls back to the built-in renderer. A name nobody registered degrades to
   * the built-in rather than failing — a dashboard should come back plainer,
   * not broken.
   */
  library?: string;
  /** 1–4, in a twelve-column grid. Kept coarse on purpose. */
  width: 1 | 2 | 3 | 4;
  position: number;
}

/**
 * One thing that happened.
 *
 * The same events the library emits on `aviary:catalog:*`, durably recorded.
 * The channel is for observers that are listening *now*; governance asks about
 * six weeks ago, and a diagnostics channel has no memory.
 */
export interface CatalogAuditEvent {
  id: string;
  /** `snapshot.committed`, `type.curated`, … */
  event: string;
  typeName?: string;
  principalId?: string;
  snapshotId?: string;
  /** The event payload, verbatim. */
  detail: Record<string, unknown>;
  occurredAt: string;
}

export interface AuditQuery {
  event?: string;
  typeName?: string;
  principalId?: string;
  since?: string;
  limit?: number;
}

/**
 * The same events, told as stories instead of as a list.
 *
 * A flat trail answers "what happened" and is useless for "what happened to
 * *this load*" — the question anybody actually has when a number looks wrong.
 * The spine of the answer is already in the data and needed no new plumbing:
 * a connector run, the snapshot it writes, every batch, the commit and the
 * finish all carry the same `snapshotId`, and when the durable engine schedules
 * the run that id *is* the durable run id. So a trace is not something this
 * library invents; it is the correlation that was always there, grouped.
 *
 * What is deliberately *not* here is a parent for events that carry no such id.
 * A curation edit and a transform change are standalone acts, and the fact that
 * one happened in the same second as a load is a coincidence, not causality —
 * attaching them to the nearest run would fabricate a lineage that reads as
 * evidence. They come back separately, as {@link CatalogTraceList.unlinked}.
 */
export const CATALOG_TRACE_OUTCOMES = [
  /**
   * Something claimed to start and has not reported back. Never rendered as a
   * result: a load still in flight has no rows anybody should be relying on.
   */
  'running',
  /** It reached a terminal event that said so. */
  'succeeded',
  /** It reached a terminal event that said it did not. */
  'failed',
  /**
   * It stopped without ever saying how it went — batches written and never
   * committed, a snapshot dropped, a process that died between the two.
   *
   * Its own outcome rather than being folded into "failed" or, far worse, left
   * to look successful because rows did land. Uncommitted rows are invisible to
   * readers, so a trace that ends here moved no data at all, and a screen that
   * showed it in green would be reporting a silent data loss as a good night.
   */
  'incomplete',
] as const;

export type CatalogTraceOutcome = (typeof CATALOG_TRACE_OUTCOMES)[number];

/**
 * Narrows an outcome that arrived as a string — a query parameter, a database
 * column. Same reason as every other guard in this package: a second
 * hand-maintained copy of these names is what drifts.
 */
export function isCatalogTraceOutcome(value: unknown): value is CatalogTraceOutcome {
  return CATALOG_TRACE_OUTCOMES.some((outcome) => outcome === value);
}

/** One event, placed on the trace's clock. */
export interface CatalogTraceSpan {
  /** The audit event id, so a span links back to the row in the flat trail. */
  id: string;
  event: string;
  typeName?: string;
  /**
   * Whoever the recorder attributed the event to, passed through untouched.
   *
   * Deliberately not decomposed here. This string is already the place
   * attribution lives everywhere else in the catalog, and a delegated caller
   * encodes the person inside it, so a trace that re-models "who" would be a
   * second answer to a question that already has one.
   */
  principalId?: string;
  /** The event payload, verbatim — the same bytes the flat trail shows. */
  detail: Record<string, unknown>;
  occurredAt: string;
  /** Milliseconds from the first event of the trace. Where the bar starts. */
  offsetMs: number;
  /**
   * Milliseconds until the next event in the trace; zero on the last one.
   *
   * This is the width of the bar, and it is the *work that followed the event*,
   * not the event itself — events are instants, and an instant has no width to
   * draw. The gap between `connector.run.started` and the first
   * `snapshot.written` is the fetch and the transform, which is exactly the
   * step that usually owns the wall clock.
   */
  durationMs: number;
  /** This event carries a failure. Set from the payload, never inferred. */
  failed: boolean;
  /** The message, when there is one. Kept per span so a retry shows both. */
  error?: string;
}

/** One causal story: what started it, what happened in between, how it ended. */
export interface CatalogTrace {
  /** The correlation id — the snapshot id, which is also the durable run id. */
  id: string;
  typeName?: string;
  principalId?: string;
  connectorId?: string;
  connectorName?: string;
  outcome: CatalogTraceOutcome;
  startedAt: string;
  /** The most recent event. Always set, including while still running. */
  lastEventAt: string;
  /**
   * When it ended, and **only** when a terminal event says it did.
   *
   * Absent for `running` and `incomplete`, and absent rather than filled in
   * with the last event's time, because "we stopped hearing from it" and "it
   * finished" are different facts and this field is the one a caller will read
   * as the second. A consumer that wants "how long has this been going" uses
   * {@link lastEventAt} and knows what it is looking at.
   */
  endedAt?: string;
  /** Wall clock of the whole story. Absent whenever {@link endedAt} is. */
  durationMs?: number;
  eventCount: number;
  /**
   * How many spans carried a failure.
   *
   * Separate from {@link outcome} because a retry reuses the snapshot id, so a
   * trace can genuinely be "succeeded, on the third attempt". Reporting that as
   * a plain success hides the two failures; reporting it as a failure hides the
   * data that did land.
   */
  failureCount: number;
  /** Rows the commit made visible. Absent when nothing was ever committed. */
  rowsCommitted?: number;
  /** The most recent failure message, hoisted so a UI need not dig for it. */
  error?: string;
  /**
   * True when the whole story fits inside one tick of the recorder's clock.
   *
   * Worth saying out loud rather than quietly drawing zero-width bars: with a
   * second-resolution timestamp column a fast load has no measurable internal
   * timing at all, and a waterfall drawn from it would be a picture of rounding
   * error. Ordering is still correct — see the lifecycle rank the store sorts
   * by — but proportions are not, and a consumer should say so.
   */
  coarse: boolean;
  /** Ordered: what started it first, how it ended last. */
  spans: CatalogTraceSpan[];
}

export interface TraceQuery {
  typeName?: string;
  principalId?: string;
  /**
   * Keeps traces that contain this event, and still returns all of their spans.
   *
   * Filtering the spans instead would produce a trace with holes in it that
   * still looked whole, which is the one thing a causal view must never do.
   */
  event?: string;
  /**
   * One outcome, or any of several.
   *
   * A list rather than only a single value because the question an operations
   * screen actually asks is "what needs attention", and that is `failed` **and**
   * `incomplete` — two outcomes that are deliberately not one (see
   * {@link CATALOG_TRACE_OUTCOMES}) and are still always wanted together.
   * Answering it with two queries and merging their pages client-side does not
   * work: each page is the newest N of its own outcome, so the merged list is
   * not the newest N of the union, and on a night with many failures the
   * incomplete loads — the ones that lost data silently — fall off the bottom.
   *
   * An empty array is not "no filter", it is a filter that matches nothing, and
   * a store must answer it with an empty page. Treating it as unfiltered would
   * turn a caller's empty selection into every trace in the window, which on
   * this screen reads as "all of these need attention".
   */
  outcome?: CatalogTraceOutcome | CatalogTraceOutcome[];
  since?: string;
  limit?: number;
  offset?: number;
}

/**
 * Normalises {@link TraceQuery.outcome} to a list, or `undefined` for no filter.
 *
 * Exported so a store and a controller narrow it the same way. The distinction
 * that has to survive is `undefined` (no filter) versus `[]` (a filter nothing
 * satisfies), and a store hand-rolling this is one `?? []` away from collapsing
 * the two.
 */
export function traceOutcomeFilter(
  outcome: TraceQuery['outcome'],
): CatalogTraceOutcome[] | undefined {
  if (outcome === undefined) return undefined;
  return Array.isArray(outcome) ? outcome : [outcome];
}

export interface CatalogTraceList {
  traces: CatalogTrace[];
  /** Matching traces before paging, so a UI can page honestly. */
  total: number;
  limit: number;
  offset: number;
  /**
   * Events that carry no correlation id, and so belong to no trace.
   *
   * Returned beside the traces rather than hidden, because "these three things
   * happened and are not part of any story" is itself the honest answer. See
   * the note on {@link CATALOG_TRACE_OUTCOMES} for why they are not adopted.
   */
  unlinked: CatalogAuditEvent[];
  unlinkedTotal: number;
  /**
   * The finest interval the store's timestamps can distinguish, in
   * milliseconds. Reported by the store rather than assumed by the caller: one
   * store keeps microseconds and another keeps whole seconds, and a renderer
   * that guesses wrong either throws away detail or draws noise.
   */
  clockResolutionMs: number;
}

/** Totals over every trace a query matches, without fetching any of them. */
export interface CatalogTraceTotals {
  /**
   * Matching traces. The same number {@link CatalogTraceList.total} would carry
   * for the same query — repeated here so the sum below has a denominator and a
   * caller drawing both needs one round trip rather than two.
   */
  traces: number;
  /**
   * Rows the matching traces' commits made visible to readers.
   *
   * Committed rows specifically. Rows written and never committed are invisible
   * to every reader of the catalog, so counting them here would report a load
   * that moved no data as though it had.
   *
   * Traces that committed nothing contribute no term, exactly as
   * {@link CatalogTrace.rowsCommitted} is absent rather than zero for them. So
   * this is a sum over the loads that committed, not an average anybody can
   * divide by `traces`.
   */
  rowsCommitted: number;
}

/** The events that belong to no trace, on their own. */
export interface CatalogUnlinkedList {
  events: CatalogAuditEvent[];
  /** Matching events before paging, so a UI can page honestly. */
  total: number;
  limit: number;
}

/**
 * Reading the trail as stories.
 *
 * A separate interface and a separate token from {@link CatalogWorkspaceStore}
 * on purpose. Grouping, ranking and paging tens of thousands of audit rows is a
 * query the storage engine should run; a store that cannot express it should be
 * able to say so by not providing this, and everything else still works.
 */
export interface CatalogTraceStore {
  listTraces(query: TraceQuery): Promise<CatalogTraceList>;
  getTrace(id: string): Promise<CatalogTrace | undefined>;

  /**
   * Aggregate the matching traces instead of listing them.
   *
   * Exists because the alternative is arithmetic over a page, and a page is a
   * bound the caller had to choose. A dashboard summing `rowsCommitted` over the
   * newest 500 successful loads is exact until the 501st, and then it is wrong
   * in a direction it has to pick deliberately: undercounting makes a good night
   * look quiet, overcounting makes a bad night look productive. That is a real
   * choice to have to make and it should not have to be made — the engine can
   * sum the column.
   *
   * Optional, and the fallback is the bounded page sum the callers already
   * write, so a store that cannot express the aggregate costs a caller accuracy
   * rather than the panel. A caller falling back should say which it is showing;
   * a number that is sometimes exact and sometimes not, with nothing to tell
   * them apart, is worse than either.
   */
  traceTotals?(query: TraceQuery): Promise<CatalogTraceTotals>;

  /**
   * The unlinked events on their own — schema changes, curation edits,
   * transform edits: everything carrying no snapshot id and so belonging to no
   * load.
   *
   * The same set {@link CatalogTraceList.unlinked} carries. Separate because
   * they are the answer to the second question of any incident ("what changed?")
   * and a caller asking only that had to fetch, assemble and discard a page of
   * traces to reach them — grouping and ranking every audit row of the window to
   * throw the result away.
   *
   * The two must agree, so this honours {@link TraceQuery} the same way
   * `listTraces` does, including the part that looks like a bug and is not: a
   * query naming an `outcome` returns nothing here. An outcome is a property of
   * a trace, and an event that is in no trace has none — returning these anyway
   * under a `failed` filter would put unrelated rows on a screen whose whole
   * point was to show failures.
   *
   * Optional; the fallback is to read `unlinked` off a `listTraces` page, which
   * is correct and merely wasteful.
   */
  listUnlinked?(query: TraceQuery): Promise<CatalogUnlinkedList>;
}

export const CATALOG_TRACE_STORE = Symbol('CATALOG_TRACE_STORE');

export function isTraceStore(store: unknown): store is CatalogTraceStore {
  return (
    typeof store === 'object' &&
    store !== null &&
    typeof Reflect.get(store, 'listTraces') === 'function'
  );
}

/**
 * What an external frontend gets.
 *
 * Deliberately a rendered shape rather than raw SQL and columns: the point of
 * the embed API is that a consumer builds its own UI without needing to know
 * this catalog's query language, and handing back SQL would make every consumer
 * a second implementation of the console.
 */
export interface EmbeddedChart {
  id: string;
  title: string;
  description?: string;
  visualization: QueryVisualization;
  /** Position and width from the dashboard, as a hint the consumer may ignore. */
  layout?: { width: number; position: number };
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  /** True when this came from cache; tells a consumer how fresh it is. */
  cached: boolean;
  generatedAt: string;
}

export interface EmbeddedDashboard {
  id: string;
  name: string;
  description?: string;
  charts: EmbeddedChart[];
  generatedAt: string;
}

/**
 * What the *card* says about a chart, as opposed to what the saved query says.
 *
 * A card carries two kinds of statement and they are easy to conflate. Width
 * and position are a hint about the grid, which a consumer may ignore. `title`
 * and `library` are overrides — the board's answer to a question the query has
 * already answered — and dropping them is not a hint being ignored, it is the
 * embed disagreeing with the console about the same dashboard.
 */
export interface EmbeddedChartPlacement {
  width: number;
  position: number;
  /** The card's title override. Blank or absent falls back to the query's name. */
  title?: string;
  /** The card's library override. Absent falls back to the query's own. */
  library?: string;
}

/**
 * Which library draws an embedded chart, given the two places that can say.
 *
 * The server twin of `visualizationFor` in the React package, and it must stay
 * the same rule: the card wins, then the query, then the built-in renderer. Two
 * different precedences for one field would mean the console and an embedding
 * application draw the same board differently, which is exactly the bug the
 * override exists to prevent.
 *
 * Restated here rather than imported, because a server package must not depend
 * on a React one. Kept as a named function rather than two lines inside
 * `embedChart` for the same reason the React side did: a precedence a test can
 * hold by name cannot drift silently.
 *
 * When neither chose, the key is ABSENT rather than explicitly undefined — this
 * shape is serialised to a consumer, and "the key is there and empty" is a
 * different statement from "nobody chose".
 */
export function embeddedVisualization(
  saved: QueryVisualization | undefined,
  cardLibrary: string | undefined,
): QueryVisualization {
  const base = saved ?? { kind: 'table' };
  return cardLibrary ? { ...base, library: cardLibrary } : base;
}

export interface CatalogWorkspaceStore {
  listSavedQueries(): Promise<SavedQuery[]>;
  getSavedQuery(id: string): Promise<SavedQuery | undefined>;
  saveQuery(input: SaveQueryInput, createdBy: string): Promise<SavedQuery>;
  updateSavedQuery(id: string, input: Partial<SaveQueryInput>): Promise<SavedQuery | undefined>;
  deleteSavedQuery(id: string): Promise<boolean>;

  listDashboards(): Promise<Dashboard[]>;
  getDashboard(id: string): Promise<Dashboard | undefined>;
  saveDashboard(
    input: {
      name: string;
      description?: string;
      cards?: DashboardCard[];
      shared?: boolean;
    },
    createdBy: string,
  ): Promise<Dashboard>;
  updateDashboard(
    id: string,
    input: Partial<{
      name: string;
      description: string;
      cards: DashboardCard[];
      shared: boolean;
    }>,
  ): Promise<Dashboard | undefined>;
  deleteDashboard(id: string): Promise<boolean>;

  recordEvent(event: Omit<CatalogAuditEvent, 'id'>): Promise<void>;
  listEvents(query: AuditQuery): Promise<CatalogAuditEvent[]>;
}

export function isWorkspaceStore(store: unknown): store is CatalogWorkspaceStore {
  return (
    typeof store === 'object' &&
    store !== null &&
    typeof Reflect.get(store, 'listSavedQueries') === 'function'
  );
}

export const CATALOG_WORKSPACE_STORE = Symbol('CATALOG_WORKSPACE_STORE');
