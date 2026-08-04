import type { CatalogQueryResult, QueryVisualization } from '@dudousxd/nestjs-catalog/client';

/**
 * What `GET /catalog/embed/charts/:id` answers.
 *
 * A rendered shape rather than SQL and a connection, and that is the whole
 * point of the embed API: a consumer draws a chart without knowing this
 * catalog's query language, without a database credential, and without being a
 * second implementation of the console. It also means the server decides what
 * the caller may see — an embed cannot widen its own access, because there is
 * nothing to widen it with.
 *
 * DECLARED HERE, AND IT SHOULD NOT BE. The server owns these shapes — they are
 * `EmbeddedChart` and `EmbeddedDashboard` in `catalog.workspace.ts` — but
 * `@dudousxd/nestjs-catalog/client`, the browser entry point that exists
 * precisely so a UI can have the response types, does not export them yet. The
 * fix is one line in that package's `client.ts`; until it lands these are a
 * mirror, and a mirror can drift. Anything reading a field not listed here is
 * the signal that it has.
 *
 * The names differ from the server's by a suffix on purpose: `<EmbeddedChart>`
 * in this package is the COMPONENT, and a type and a component that share a
 * name is an import somebody eventually gets wrong.
 */
export interface EmbeddedChartPayload {
  /** The saved query's id, which is also what the CSV export is keyed by. */
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

export interface EmbeddedDashboardPayload {
  id: string;
  name: string;
  description?: string;
  charts: EmbeddedChartPayload[];
  generatedAt: string;
}

/**
 * The embed payload, as the shared chart renderers want it.
 *
 * Two fields have to be supplied because `CatalogQueryResult` requires them and
 * the embed payload does not carry them, so both are derived rather than
 * invented where that is possible:
 *
 * - `truncated` is read off the payload itself. The server caps rows before it
 *   sends them but reports the full `rowCount`, so fewer rows than the count IS
 *   the truncation, and a renderer that says "showing all of it" when it is
 *   not is the class of quiet lie this project treats as its worst bug.
 * - `elapsedMs` cannot be derived. The embed API deliberately says nothing
 *   about how long the query took — it may not have run at all, having come
 *   from cache — so this is 0, and no renderer should present it as a timing.
 *   `cached` and `generatedAt` are what actually answer "how fresh is this".
 */
export function resultFromEmbed(chart: EmbeddedChartPayload): CatalogQueryResult {
  return {
    columns: chart.columns,
    rows: chart.rows,
    rowCount: chart.rowCount,
    cached: chart.cached,
    truncated: chart.rows.length < chart.rowCount,
    elapsedMs: 0,
  };
}

/**
 * The charts of a dashboard, in the order its author laid them out.
 *
 * The server already sorts by position, so this is a second opinion — and it is
 * worth having, because between the server and this component sits a host's
 * HTTP client, possibly a proxy, possibly a cache, and a JSON array whose order
 * survived all of them is an assumption rather than a guarantee. Getting it
 * wrong is silent: the board simply reads wrong.
 *
 * A chart with no layout keeps its place at the end rather than jumping to the
 * front, which is what `?? 0` would do to a payload that mixed the two.
 */
export function chartsInLayoutOrder(charts: EmbeddedChartPayload[]): EmbeddedChartPayload[] {
  return [...charts].sort(
    (a, b) =>
      (a.layout?.position ?? Number.POSITIVE_INFINITY) -
      (b.layout?.position ?? Number.POSITIVE_INFINITY),
  );
}
