import { Download } from 'lucide-react';
import { ChartBody } from '../charts/body';
import { cn } from '../cn';
import { useCatalogClient } from '../context';
import { type EmbedAction, type EmbedActions, resolveEmbedActions } from './actions';
import type { EmbeddedChartPayload } from './payload';
import { resultFromEmbed } from './payload';

const MUTED = 'text-zinc-400 dark:text-zinc-500';

/**
 * One embedded chart, drawn from a payload that has already arrived.
 *
 * Internal on purpose: `<EmbeddedChart>` fetches one, `<EmbeddedDashboard>`
 * gets several in a single response, and both draw them through here so a chart
 * looks the same whichever way it got to the page.
 *
 * The body is `ChartBody` — the same component the console's cards use, not a
 * second copy of it. That is the point of the extraction: a bar chart in a
 * host's application and the same bar chart in the console are the same
 * drawing, and stay that way when either changes.
 */
export function EmbeddedChartCard({
  chart,
  actions,
  height = 200,
  className,
}: {
  chart: EmbeddedChartPayload;
  actions?: EmbedActions;
  height?: number;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">{chart.title}</h3>
          {/*
           * How fresh this is, in the two terms the payload actually has.
           * `generatedAt` is the machine-readable half and is left as the ISO
           * string the server sent rather than formatted: a library that picks
           * a date format picks a locale, a timezone and a convention for
           * somebody else's application, and gets at least one of them wrong.
           */}
          <time className={cn('font-mono text-[10px]', MUTED)} dateTime={chart.generatedAt}>
            {chart.rowCount} rows{chart.cached ? ' · cached' : ''}
          </time>
        </div>
        <EmbedToolbar chartId={chart.id} actions={actions} />
      </div>

      {chart.description && (
        <p className={cn('mt-0.5 truncate text-[11px]', MUTED)}>{chart.description}</p>
      )}

      <div className="mt-3">
        {/*
         * No cap on the table. A dashboard card previews because the whole
         * answer is one click away in the console; an embed has no such click,
         * so quietly showing five of twelve columns would be hiding data from
         * the only view its reader has.
         */}
        <ChartBody
          result={resultFromEmbed(chart)}
          visualization={chart.visualization}
          height={height}
        />
      </div>
    </div>
  );
}

/**
 * The controls in an embedded chart's top-right.
 *
 * Output only, and empty by default — see `actions.ts` for why an embed carries
 * no refresh, no delete, no width and no library picker. There is no branch
 * here that can produce one: the toolbar can only draw what
 * `resolveEmbedActions` returns, and that can only return members of
 * `EMBED_ACTIONS`.
 *
 * No `Tooltip`, unlike the console's card. Tooltips here need a
 * `TooltipProvider` above them, and an embed is mounted wherever the host
 * pleases — a missing provider would be a crash in somebody else's page. A
 * `title` plus an `aria-label` needs no context and is what a screen reader
 * reads anyway.
 */
function EmbedToolbar({ chartId, actions }: { chartId: string; actions?: EmbedActions }) {
  const resolved = resolveEmbedActions(actions);
  if (resolved.length === 0) return null;

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {resolved.map((action) => (
        <EmbedActionControl key={action} action={action} chartId={chartId} />
      ))}
    </div>
  );
}

const CONTROL = 'rounded-sm p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800';

/**
 * One action, drawn.
 *
 * The `never` at the bottom is the point of the shape: adding a member to
 * {@link EmbedAction} without drawing it here stops compiling. The alternative
 * — a fallthrough returning null — is exactly the "an option that does nothing"
 * failure the union was written to prevent, just moved one level down.
 *
 * PNG belongs here when the renderer being built in `src/export/` lands: one
 * more branch, one more entry in `EMBED_ACTIONS`, and nothing else changes.
 */
function EmbedActionControl({ action, chartId }: { action: EmbedAction; chartId: string }) {
  const client = useCatalogClient();

  if (action === 'csv') {
    // A link, not a button, because the server's export is a GET that streams
    // a file — the browser downloads it without this component touching the
    // response, and a link can be middle-clicked, copied, or handed to a
    // host's own download manager.
    return (
      <a
        href={client.exportUrl(chartId)}
        aria-label="Download CSV"
        title="Download CSV"
        className={cn(CONTROL, MUTED)}
      >
        <Download size={11} />
      </a>
    );
  }

  const undrawn: never = action;
  return undrawn;
}
