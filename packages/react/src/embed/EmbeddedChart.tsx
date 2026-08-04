import { useQuery } from '@tanstack/react-query';
import { cn } from '../cn';
import { catalogQueryKeys, useCatalogClient } from '../context';
import type { EmbedActions } from './actions';
import { EmbeddedChartCard } from './chart-card';
import {
  type EmbedFailureSlot,
  type EmbedLoadingSlot,
  renderFailure,
  renderLoading,
} from './slots';

/**
 * One shared chart, for a host application's own page.
 *
 * Not a console screen. This is the component somebody drops into an internal
 * tool or a customer-facing page to show a chart that was authored, saved and
 * shared somewhere else — so it renders the answer and nothing that could
 * change it. Everything that assembles a board (refresh, delete, the width and
 * library pickers, the drag handle) belongs to `<DashboardBoard />`, which is
 * where a person with the scope to author actually is.
 *
 * What it needs from the host: a `<CatalogProvider>` for the transport, a
 * `QueryClientProvider` above that, and a principal holding `catalog:embed`.
 * The server answers only for a saved query that has been explicitly marked
 * shared — an id alone is not access.
 */
export interface EmbeddedChartProps {
  /**
   * The saved query's id, exactly as `GET /catalog/embed` lists it.
   *
   * Discovering ids is the host's job — hardcode one, or read the discovery
   * endpoint through its own transport. This component takes an id rather than
   * a name because a name is not stable and a chart that silently swapped for
   * another one on rename is worse than a chart that stops loading.
   */
  chartId: string;
  /**
   * Which output controls to draw. Defaults to `'none'`: an embed is inert
   * unless the host asks for something.
   */
  actions?: EmbedActions;
  /** What to show while fetching. A node, or a function returning one. */
  loading?: EmbedLoadingSlot;
  /** What to show when the fetch failed. Receives the error, if a function. */
  failure?: EmbedFailureSlot;
  /** Rough pixel height for the chart body. The loading state matches it. */
  height?: number;
  className?: string;
}

export function EmbeddedChart({
  chartId,
  actions,
  loading,
  failure,
  height = 200,
  className,
}: EmbeddedChartProps) {
  const client = useCatalogClient();
  const { data, isPending, error } = useQuery({
    queryKey: catalogQueryKeys.embeddedChart(chartId),
    queryFn: () => client.embedChart(chartId),
  });

  // Three states kept apart, in the order that matters: an error is not a
  // pending fetch, and neither is a chart. React Query keeps `data` from the
  // last success while a background refetch runs, so `isPending` — never
  // `isFetching` — is what decides, or the host's page would flash a
  // placeholder over a chart that is already on screen.
  if (error) {
    return <div className={cn('min-w-0', className)}>{renderFailure(failure, error, height)}</div>;
  }
  if (isPending) {
    return <div className={cn('min-w-0', className)}>{renderLoading(loading, height)}</div>;
  }

  return <EmbeddedChartCard chart={data} actions={actions} height={height} className={className} />;
}
