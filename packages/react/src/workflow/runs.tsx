/**
 * What a published graph runs as, and what it has done lately.
 *
 * WHY A CONNECTOR IS STILL ON SCREEN AT ALL
 * -----------------------------------------
 * Because it is the id everything else is keyed on. A connector is no longer
 * something anybody creates — publishing a graph mints one, deleting the graph
 * removes it, and there is no route that makes one directly — but the run
 * history and the incremental watermark hang off that id, and the connector is
 * what a scheduled fire is attributed to. An internal record no screen exposes
 * is one an operator debugs by opening the database.
 *
 * So this panel is a READ and says so. There is no run button here (the run
 * button is on the graph), no delete (deleting the graph is what removes it) and
 * no edit (every field it used to hold is a node on the canvas now). Where one
 * of those used to be, the panel says where the action went instead of quietly
 * not being there.
 *
 * **Nothing here prints a config.** The server redacts a URL password on the way
 * out and `allowInlineCredentials` decides whether one may be stored at all, so
 * the honest thing for a screen is not to render the field: showing `REDACTED`
 * beside a real host teaches people the console shows credentials, and the day
 * one is not redacted is the day somebody screenshots it.
 */

import type {
  CatalogConnector,
  CatalogTransform,
  ConnectorRun,
} from '@dudousxd/nestjs-catalog/client';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleX, Loader2, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '../cn';
import { catalogQueryKeys, useCatalogClient } from '../context';
import { RevisionHistorySheet } from '../diff/RevisionDiff';
import { Tooltip } from '../ui/tooltip';
import { WORKFLOW_NAME } from './name';

const MUTED = 'text-zinc-400 dark:text-zinc-500';
const RULE = 'border-zinc-200 dark:border-zinc-800';
const PANEL = 'bg-white dark:bg-zinc-900';

/**
 * The connector this graph runs as, and its recent loads.
 *
 * Rendered for a stored graph only. A draft has nothing behind it — that is
 * what a draft is — and an empty "Runs as" panel over a canvas somebody is
 * still drawing would be a permanent heading nobody reads.
 */
export function RunsAsPanel({
  workflowId,
  status,
  transforms,
}: {
  workflowId: string;
  status: 'draft' | 'ready';
  /** The transforms this graph names, so a run's `code v3` can be compared. */
  transforms: CatalogTransform[];
}) {
  const client = useCatalogClient();

  const { data: connectors = [], isPending } = useQuery({
    queryKey: catalogQueryKeys.connectors,
    queryFn: () => client.listConnectors(),
  });

  const connector = useMemo(
    () => connectors.find((candidate) => candidate.workflowId === workflowId),
    [connectors, workflowId],
  );

  return (
    <section className={cn('rounded-lg border p-3', RULE, PANEL)}>
      <h2 className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>Runs as</h2>

      {isPending && <p className={cn('mt-2 text-[11px]', MUTED)}>Reading…</p>}

      {!isPending && !connector && (
        <p className={cn('mt-2 text-[11px] leading-relaxed', MUTED)}>
          {status === 'ready'
            ? `This ${WORKFLOW_NAME.singular} is ready but nothing is running it yet. That is unusual — publishing is what mints the connector a run history is keyed on — and it is worth a look before trusting a schedule on it.`
            : `Nothing yet. Publishing is what mints the connector this ${WORKFLOW_NAME.singular} runs as; until then a run is something you press, and there is no history to key.`}
        </p>
      )}

      {connector && <ConnectorIdentity connector={connector} />}
      {connector && <RecentRuns connectorId={connector.id} transforms={transforms} />}
    </section>
  );
}

/**
 * The connector's id and state, and nothing else.
 *
 * The id is the load-bearing part: it is what `GET pipeline/runs?connector=` is
 * keyed on and what an operator greps a log for. Its name and target type are
 * the graph's, restated, so they are not repeated here.
 */
function ConnectorIdentity({ connector }: { connector: CatalogConnector }) {
  return (
    <div className="mt-2 space-y-1">
      <Tooltip content="The id the run history, the incremental watermark and the singleton lock are all keyed on. It survives an unpublish and a re-publish, which is what makes those three carry over.">
        <div className={cn('flex cursor-help items-center gap-1.5 font-mono text-[10px]', MUTED)}>
          <span className="truncate">{connector.id}</span>
        </div>
      </Tooltip>
      <div className="flex flex-wrap items-center gap-1.5">
        {connector.mode === 'incremental' && (
          <Tooltip content="Reads only what changed since the last run, and carries the rest forward. The position is kept per source node.">
            <span
              className={cn('flex cursor-help items-center gap-1 font-mono text-[10px]', MUTED)}
            >
              <RefreshCw size={10} />
              incremental
            </span>
          </Tooltip>
        )}
        {!connector.enabled && (
          <Tooltip content="Disabled. Unpublishing does this, and it is why the id and the history survive one.">
            <span className="cursor-help rounded-sm bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] uppercase dark:bg-zinc-800">
              disabled
            </span>
          </Tooltip>
        )}
      </div>
      {/*
       * Said, rather than left as an absence.
       *
       * This panel used to be a card with Run and Delete on it, and somebody who
       * remembers that will look for them here. "They are not here" and "they
       * moved onto the graph" are different answers, and only the second one
       * ends the search.
       */}
      <p className={cn('text-[10px] leading-relaxed', MUTED)}>
        Read-only. Running, scheduling and deleting are all done on the {WORKFLOW_NAME.singular}{' '}
        above — this row is minted by publishing it and removed with it.
      </p>
    </div>
  );
}

/**
 * What this workflow has done lately, and the way from a load to the code that
 * produced it.
 *
 * The `code v3` on a row is a control rather than a fact: it is where the
 * question "why did this load come out different" actually occurs to somebody,
 * and making the number the way in means nobody has to carry it to another
 * screen and pick it out of a dropdown — which is the step where you pick the
 * wrong one and conclude the code was fine.
 *
 * It is only a control when the answer is unambiguous. A run records ONE
 * `transformVersion`, which meant something exact when a connector had at most
 * one transform; a graph may run three in a row, and offering a comparison
 * against whichever one this screen happened to pick first would be worse than
 * offering none. So the compare is available for a graph with exactly one
 * transform, and the version is plain text otherwise.
 */
function RecentRuns({
  connectorId,
  transforms,
}: {
  connectorId: string;
  transforms: CatalogTransform[];
}) {
  const client = useCatalogClient();
  const [comparing, setComparing] = useState<number | null>(null);

  const { data: runs = [] } = useQuery({
    queryKey: catalogQueryKeys.runs(connectorId),
    queryFn: () => client.listRuns(connectorId),
  });

  const only = transforms.length === 1 ? transforms[0] : undefined;

  if (runs.length === 0) {
    return <p className={cn('mt-2 text-[11px]', MUTED)}>No runs recorded against it yet.</p>;
  }

  return (
    <>
      <div className={cn('mt-3 border-t pt-2', RULE)}>
        <div className={cn('mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>
          Recent runs
        </div>
        <div className="space-y-1">
          {runs.slice(0, 4).map((entry) => (
            <Tooltip
              key={entry.id}
              content={
                entry.error ? (
                  <span className="font-mono text-[11px]">{entry.error}</span>
                ) : (
                  <span className="font-mono text-[11px]">
                    {entry.logs.slice(-3).join('\n') || 'No logs.'}
                  </span>
                )
              }
            >
              <div className="flex cursor-help flex-wrap items-center gap-1.5 text-[11px]">
                {/* The icon carries the outcome, so the outcome needs a name
                    too — otherwise a failed run and a run that found nothing
                    read identically as "0 fetched · 0 written". */}
                <span className="sr-only">{entry.status}: </span>
                <RunStatusIcon status={entry.status} />
                <span className="truncate font-mono text-[10px]">{entry.snapshotId}</span>
                <span className={cn('font-mono text-[10px]', MUTED)}>
                  {entry.fetched} fetched · {entry.written} written
                </span>
                <RanCodeVersion
                  version={entry.transformVersion}
                  comparable={only !== undefined}
                  onCompare={setComparing}
                />
              </div>
            </Tooltip>
          ))}
        </div>
      </div>

      {only && (
        <RevisionHistorySheet
          open={comparing !== null}
          onOpenChange={(open) => {
            if (!open) setComparing(null);
          }}
          subject={{ kind: 'transform', id: only.id, name: only.name }}
          current={{ version: only.version, body: only.code }}
          ranVersion={comparing ?? undefined}
        />
      )}
    </>
  );
}

function RunStatusIcon({ status }: { status: ConnectorRun['status'] }) {
  if (status === 'succeeded')
    return <CircleCheck size={11} aria-hidden className="text-emerald-600" />;
  if (status === 'failed') return <CircleX size={11} aria-hidden className="text-red-600" />;
  return <Loader2 size={11} aria-hidden className="animate-spin text-sky-600" />;
}

/**
 * `code v3` on a run, as a way into the comparison rather than as a fact.
 *
 * Still only text when there is nothing on the other side: a pipeline with no
 * transform never records a version, a version whose transform has since been
 * deleted has no current code to compare against, and a graph with several
 * transforms has no single answer to which one this number names. A control that
 * opens an empty panel — or the wrong one — is a control that teaches people to
 * stop pressing it.
 */
function RanCodeVersion({
  version,
  comparable,
  onCompare,
}: {
  version: number | undefined;
  comparable: boolean;
  onCompare: (version: number) => void;
}) {
  if (version === undefined) return null;
  if (!comparable)
    return <span className={cn('font-mono text-[10px]', MUTED)}>code v{version}</span>;

  return (
    // Inside the tooltip's trigger rather than beside it, because this row IS
    // the trigger: pulling the button out would put a gap in the hover target
    // exactly where the pointer is heading. A click inside it bubbles normally.
    <button
      type="button"
      onClick={() => onCompare(version)}
      aria-label={`Compare the code that ran (v${version}) with the current code`}
      className={cn(
        'rounded-sm px-1 font-mono text-[10px] underline decoration-dotted underline-offset-2',
        MUTED,
        'hover:text-sky-600',
      )}
    >
      code v{version}
    </button>
  );
}
