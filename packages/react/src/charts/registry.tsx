import type { CatalogQueryResult, QueryVisualization } from '@dudousxd/nestjs-catalog/client';
import type { ComponentType } from 'react';

/**
 * What every chart renderer receives.
 *
 * The result and the visualization config, nothing else — a renderer that
 * needed the catalog client could reach data the card's own query never
 * returned, and a chart should never be able to widen its own access.
 */
export interface ChartRendererProps {
  result: CatalogQueryResult;
  visualization: QueryVisualization;
  /** Rough pixel height the card has to spare. */
  height?: number;
}

export type ChartRenderer = ComponentType<ChartRendererProps>;

/**
 * Chart libraries, registered rather than imported.
 *
 * This package ships one renderer that needs no dependency at all, and takes
 * none. Recharts (what shadcn/ui's charts are built on) and bklit-ui (which
 * builds on visx, d3 and motion) are both perfectly good and both far larger
 * than everything here put together — bundling either would make every consumer
 * pay for a choice only some of them want.
 *
 * So a host installs the library it prefers and registers a renderer:
 *
 * ```tsx
 * import { registerChartRenderer } from "@dudousxd/nestjs-catalog-react";
 * import { ShadcnChartRenderer } from "@dudousxd/nestjs-catalog-react/recharts";
 * import { BklitRenderer } from "@dudousxd/nestjs-catalog-react/bklit";
 *
 * registerChartRenderer("recharts", ShadcnChartRenderer);
 * registerChartRenderer("bklit", BklitRenderer);
 * ```
 *
 * Saved queries then name a library in their visualization, and one that names
 * a library nobody registered falls back to the built-in rather than failing —
 * a dashboard should degrade to a plainer chart, not to an error. That matters
 * more than it sounds: `library` is stored data, so a query saved when a
 * renderer was registered outlives it, and a card naming a renderer that is no
 * longer there must still draw something.
 */
const renderers = new Map<string, ChartRenderer>();

export function registerChartRenderer(name: string, renderer: ChartRenderer): void {
  renderers.set(name, renderer);
}

export function getChartRenderer(name?: string): ChartRenderer | undefined {
  if (!name) return undefined;
  return renderers.get(name);
}

/** Which libraries are available right now, for the picker in the console. */
export function registeredChartLibraries(): string[] {
  return ['css', ...renderers.keys()];
}

/**
 * Pull the label column and one numeric series out of a result.
 *
 * Shared by every renderer so they all read a saved query the same way — a
 * chart that picks a different column than the one beside it is the kind of
 * inconsistency nobody reports and everybody distrusts.
 */
export function seriesFrom(
  result: CatalogQueryResult,
  visualization: QueryVisualization,
): {
  labelColumn: string;
  valueColumns: string[];
  data: Array<Record<string, unknown>>;
} {
  const labelColumn = visualization.labelColumn ?? result.columns[0];
  const declared = visualization.valueColumns?.filter((c) => result.columns.includes(c));
  const numeric = result.columns.filter(
    (column) =>
      column !== labelColumn && result.rows.some((row) => typeof row[column] === 'number'),
  );
  const valueColumns =
    declared && declared.length > 0
      ? declared
      : numeric.length > 0
        ? numeric.slice(0, 3)
        : result.columns.slice(1, 2);

  return { labelColumn, valueColumns, data: result.rows };
}

/** A palette that works in both themes, so a renderer need not invent one. */
export const CHART_COLORS = ['#8b5cf6', '#10b981', '#f59e0b', '#0ea5e9', '#f43f5e'];

/**
 * Which library draws a card, given the two places that can say.
 *
 * Here rather than inside the board, so the precedence is one named thing a
 * test can hold — the alternative was two lines inside a component that needs a
 * query client and a transport to render, and a test that mirrors them can
 * drift from them silently.
 *
 * The card wins because it is the more specific statement: it says how this
 * answer should look on THIS board, while the query says how it looks wherever
 * it appears. Reading them the other way round means editing one board changes
 * every other board that uses the same query.
 *
 * When neither chose, the key is ABSENT rather than explicitly undefined. The
 * two behave identically at the lookup, but a card is stored as JSON and "the
 * key is there and empty" is a different statement from "nobody chose" the
 * moment anything else reads it.
 */
export function visualizationFor(
  saved: QueryVisualization | undefined,
  cardLibrary: string | undefined,
): QueryVisualization {
  const base = saved ?? { kind: 'table' };
  return cardLibrary ? { ...base, library: cardLibrary } : base;
}
