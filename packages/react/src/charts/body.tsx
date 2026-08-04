import type { CatalogQueryResult, QueryVisualization } from '@dudousxd/nestjs-catalog/client';
import { useMemo } from 'react';
import { DataTable, renderUnknown } from '../ui/data-table';
import { CssBarChart } from './css';
import { getChartRenderer } from './registry';
import { ChartEmpty } from './skeleton';

/**
 * A result plus a visualization, drawn.
 *
 * Lifted out of `DashboardBoard`'s `CardBody` when the embed components needed
 * the same thing, and lifted rather than copied on purpose: "how a bar chart is
 * drawn" has to have exactly one answer. Two implementations do not disagree on
 * the day they are written — they disagree six months later, when somebody
 * tightens the empty state or changes which column a number reads, and the
 * console and the embedded copy of the same dashboard start showing different
 * things to different people with no way to tell which is right.
 *
 * What is NOT here is the decision about which library draws: that is
 * `visualizationFor`, and it stays with the caller, because the console has a
 * per-card override and an embed deliberately does not.
 */
export interface ChartBodyProps {
  result: CatalogQueryResult;
  /**
   * Already resolved — pass what `visualizationFor` returned, not the saved
   * query's raw value, or a card's library override is silently dropped.
   */
  visualization: QueryVisualization;
  /** Rough pixel height the surrounding box has to spare. */
  height?: number;
  /**
   * Cap the table preview.
   *
   * Absent means "show what you were given", which is what an embed wants: a
   * host that asked for a table and got five of its twelve columns, with no
   * control to see the rest, has been handed a broken component. The console
   * passes a cap because a dashboard card is a PREVIEW — the whole answer lives
   * one click away on the query screen, and a card you cannot read at a glance
   * is not a card.
   */
  maxColumns?: number;
  maxRows?: number;
}

export function ChartBody({
  result,
  visualization,
  height = 200,
  maxColumns,
  maxRows,
}: ChartBodyProps) {
  // Held at the chart's own height rather than collapsing to one line, so a
  // card that matched nothing does not resize the grid around it — and said in
  // words, because "no rows" beside a skeleton-shaped hole is the one reading
  // that must never be ambiguous.
  if (result.rowCount === 0) {
    return <ChartEmpty height={height} message="The query ran and matched nothing." />;
  }

  if (visualization.kind === 'number') {
    const column = visualization.valueColumns?.[0] ?? result.columns[0];
    return (
      <div className="py-4 text-center">
        <div className="font-mono text-3xl tabular-nums">
          {String(result.rows[0]?.[column] ?? '—')}
        </div>
        <div className="mt-1 font-mono text-[10px] uppercase text-zinc-400 dark:text-zinc-500">
          {visualization.labelColumn ?? column}
        </div>
      </div>
    );
  }

  if (
    visualization.kind === 'bar' ||
    visualization.kind === 'line' ||
    visualization.kind === 'area'
  ) {
    // A registered library when the query names one and the host installed it;
    // otherwise the built-in bars. Falling back beats failing: a dashboard
    // should degrade to a plainer chart, not to an error message.
    const Renderer = getChartRenderer(visualization.library);
    if (Renderer) {
      return <Renderer result={result} visualization={visualization} height={height} />;
    }
    return <CssBarChart result={result} visualization={visualization} height={height} />;
  }

  return <ChartTable result={result} maxColumns={maxColumns} maxRows={maxRows} />;
}

/**
 * The table rendering, in its own component so `ChartBody` above can early-return.
 *
 * Hooks cannot follow a conditional return, and every branch of a chart body is
 * a conditional return.
 */
function ChartTable({
  result,
  maxColumns,
  maxRows,
}: {
  result: CatalogQueryResult;
  maxColumns?: number;
  maxRows?: number;
}) {
  const shown = useMemo<string[]>(
    () => (maxColumns === undefined ? result.columns : result.columns.slice(0, maxColumns)),
    [result.columns, maxColumns],
  );
  const columns = useMemo(
    () =>
      shown.map((column) => ({
        id: column,
        accessorFn: (row: Record<string, unknown>) => row[column],
        header: column,
        cell: (context: { getValue: () => unknown }) => renderUnknown(context.getValue()),
      })),
    [shown],
  );
  const rows = useMemo(
    () => (maxRows === undefined ? result.rows : result.rows.slice(0, maxRows)),
    [result.rows, maxRows],
  );
  const numericColumns = useMemo(() => {
    const first = rows[0];
    return new Set(first ? shown.filter((column) => typeof first[column] === 'number') : []);
  }, [rows, shown]);

  return (
    <DataTable
      data={rows}
      columns={columns}
      numeric={(id) => numericColumns.has(id)}
      density="text-[11px]"
    />
  );
}
