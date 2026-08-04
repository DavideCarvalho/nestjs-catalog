import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { CHART_GRID, chartSpan } from '../charts/grid';
import { cn } from '../cn';
import { catalogQueryKeys, useCatalogClient } from '../context';
import type { EmbedActions } from './actions';
import { EmbeddedChartCard } from './chart-card';
import { chartsInLayoutOrder } from './payload';
import {
  type EmbedFailureSlot,
  type EmbedLoadingSlot,
  renderFailure,
  renderLoading,
} from './slots';

/**
 * A whole shared dashboard, in a host application's own page.
 *
 * ONE request, not one per card: the server resolves every chart of a shared
 * dashboard in a single response, and a card whose query is broken or unshared
 * is left out rather than failing the page. That is also why this is not a loop
 * of `<EmbeddedChart>` — that would be N round trips from somebody else's
 * frontend against a database this deployment owns, which is precisely the load
 * pattern the embed API was shaped to avoid.
 *
 * Same rule as the single chart: output only. Nothing here can reorder, resize,
 * delete or re-run anything; the board is arranged in the console.
 */
export interface EmbeddedDashboardProps {
  /** The dashboard's id, exactly as `GET /catalog/embed` lists it. */
  dashboardId: string;
  /** Which output controls each chart draws. Defaults to `'none'`. */
  actions?: EmbedActions;
  /** What to show while fetching. A node, or a function returning one. */
  loading?: EmbedLoadingSlot;
  /** What to show when the fetch failed. Receives the error, if a function. */
  failure?: EmbedFailureSlot;
  /** Rough pixel height for each chart body. */
  height?: number;
  /** Shown when the dashboard resolved but every card was left out. */
  empty?: ReactNode;
  className?: string;
}

export function EmbeddedDashboard({
  dashboardId,
  actions,
  loading,
  failure,
  height = 200,
  empty,
  className,
}: EmbeddedDashboardProps) {
  const client = useCatalogClient();
  const { data, isPending, error } = useQuery({
    queryKey: catalogQueryKeys.embeddedDashboard(dashboardId),
    queryFn: () => client.embedDashboard(dashboardId),
  });

  if (error) {
    return <div className={cn('min-w-0', className)}>{renderFailure(failure, error, height)}</div>;
  }
  if (isPending) {
    return <div className={cn('min-w-0', className)}>{renderLoading(loading, height)}</div>;
  }

  const charts = chartsInLayoutOrder(data.charts);

  return (
    // `@container` here rather than on the host's element, because the grid
    // below is sized by container queries and the container has to be declared
    // by whoever owns the box — a host that forgot would get a one-column
    // board on a 2000px page and no way to tell why.
    <div className={cn('@container min-w-0', className)}>
      {charts.length === 0 ? (
        // Not the same as a failure, and said differently. Every card of a
        // shared dashboard can be dropped — each one's own saved query has to
        // be shared too — and a blank page with an error on it would send the
        // reader to the wrong place entirely.
        (empty ?? (
          <p className="px-4 py-8 text-center text-xs text-zinc-400 dark:text-zinc-500">
            Nothing on this dashboard has been shared.
          </p>
        ))
      ) : (
        <div className={CHART_GRID}>
          {charts.map((chart) => (
            // The author's width, honoured through the same span map the
            // console uses. `min-w-0` because a grid item defaults to
            // `min-width: auto`, and a chart wider than its column pushes the
            // column out instead of being constrained by it.
            <div key={chart.id} className={cn(chartSpan(chart.layout?.width), 'min-w-0')}>
              <EmbeddedChartCard chart={chart} actions={actions} height={height} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
