import type { CatalogAuditEvent } from '@dudousxd/nestjs-catalog/client';
import { useQuery } from '@tanstack/react-query';
import { List, Waypoints } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  CATALOG_EVENT_META,
  type CatalogTraceSource,
  TraceExplorer,
  eventMeta,
} from './TraceExplorer';
import { cn } from './cn';
import { useCatalogClient } from './context';
import { Tooltip, TooltipProvider } from './ui/tooltip';

const MUTED = 'text-zinc-400 dark:text-zinc-500';
const RULE = 'border-zinc-200 dark:border-zinc-800';
const PANEL = 'bg-white dark:bg-zinc-900';

/**
 * Two ways of reading the same rows.
 *
 * The flat trail answers "what happened", which is the right question when
 * nobody has a specific load in mind. It is the wrong one the moment somebody
 * does — "why does this type have the wrong number of rows" needs the story of
 * one load, and picking that story out of a reverse-chronological list by eye is
 * work the reader should not be doing. Traces group by the correlation id that
 * was already in every event.
 *
 * Both, rather than replacing one with the other: a trace only exists where
 * there is a correlation id, and the list is still the only view that shows
 * every row exactly as recorded.
 */
type View = 'events' | 'traces';

const VIEWS: Array<{
  id: View;
  label: string;
  icon: typeof List;
  meaning: string;
}> = [
  {
    id: 'traces',
    label: 'Traces',
    icon: Waypoints,
    meaning: 'One story per load: what started it, what happened in between, and how it ended.',
  },
  {
    id: 'events',
    label: 'Events',
    icon: List,
    meaning: 'Every recorded event, newest first, exactly as it was written.',
  },
];

/**
 * What happened, to what, by whom.
 *
 * The same events the library publishes on `aviary:catalog:*`, recorded as they
 * happen. A diagnostics channel only reaches observers listening at the time,
 * and the governance question is always asked afterwards.
 */
export function GovernanceTimeline({
  traceSource,
}: {
  /**
   * Where the trace view reads from. Optional: when the host's catalog client
   * already exposes `listTraces`, the screen finds it and nothing needs
   * passing. See `useTraceSource`.
   */
  traceSource?: CatalogTraceSource;
} = {}) {
  const client = useCatalogClient();
  const [view, setView] = useState<View>('traces');
  const [event, setEvent] = useState<string>('');
  const [principal, setPrincipal] = useState<string>('');

  const { data: events = [], isLoading } = useQuery({
    queryKey: ['catalog', 'events', event, principal],
    queryFn: () =>
      client.listEvents({
        event: event || undefined,
        principalId: principal || undefined,
        limit: 200,
      }),
    refetchInterval: 15_000,
  });

  const principals = useMemo(
    () => [...new Set(events.map((e) => e.principalId).filter(Boolean))] as string[],
    [events],
  );

  const grouped = useMemo(() => {
    const byDay = new Map<string, CatalogAuditEvent[]>();
    for (const entry of events) {
      const day = new Date(entry.occurredAt).toDateString();
      const list = byDay.get(day) ?? [];
      list.push(entry);
      byDay.set(day, list);
    }
    return [...byDay.entries()];
  }, [events]);

  return (
    <TooltipProvider>
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-4xl px-8 py-8">
          <p className={cn('font-mono text-[11px] uppercase tracking-[0.18em]', MUTED)}>
            Governance
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">What happened</h1>
          <p className={cn('mt-1 max-w-2xl text-sm', 'text-zinc-500 dark:text-zinc-400')}>
            Every load, schema change and curation edit, as it happened. Recorded from the same
            events the library publishes, because a channel only reaches whoever was listening at
            the time.
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <div className={cn('flex overflow-hidden rounded-md border', RULE)}>
              {VIEWS.map((option) => {
                const Icon = option.icon;
                return (
                  <Tooltip key={option.id} content={option.meaning}>
                    <button
                      type="button"
                      onClick={() => setView(option.id)}
                      className={cn(
                        'flex items-center gap-1.5 px-2.5 py-1 text-xs transition-colors',
                        view === option.id
                          ? 'bg-zinc-100 text-zinc-950 dark:bg-zinc-800 dark:text-zinc-50'
                          : cn(MUTED, 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60'),
                      )}
                    >
                      <Icon size={12} />
                      {option.label}
                    </button>
                  </Tooltip>
                );
              })}
            </div>

            {/*
              The event and application filters belong to the flat list only.
              Hidden rather than disabled on the trace view: the trace endpoint
              filters traces, not events, so the same two controls would mean
              something subtly different there and quietly return a different
              set than the one their labels promise.
            */}
            {view === 'events' && (
              <>
                <select
                  value={event}
                  onChange={(e) => setEvent(e.target.value)}
                  aria-label="Filter by event"
                  className={cn(
                    'rounded-md border bg-white px-2 py-1 text-xs outline-none dark:bg-zinc-900',
                    RULE,
                  )}
                >
                  <option value="">Every event</option>
                  {Object.entries(CATALOG_EVENT_META).map(([id, meta]) => (
                    <option key={id} value={id}>
                      {meta.label}
                    </option>
                  ))}
                </select>
                <select
                  value={principal}
                  onChange={(e) => setPrincipal(e.target.value)}
                  aria-label="Filter by application"
                  className={cn(
                    'rounded-md border bg-white px-2 py-1 text-xs outline-none dark:bg-zinc-900',
                    RULE,
                  )}
                >
                  <option value="">Every application</option>
                  {principals.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>

          {view === 'traces' && (
            <div className="mt-6">
              <TraceExplorer source={traceSource} />
            </div>
          )}

          {view === 'events' && (
            <>
              {isLoading && (
                <p className={cn('py-10 text-center font-mono text-sm', MUTED)}>
                  Reading the trail…
                </p>
              )}

              {!isLoading && events.length === 0 && (
                <p
                  className={cn(
                    'mt-6 rounded-lg border border-dashed px-4 py-12 text-center text-sm',
                    RULE,
                    MUTED,
                  )}
                >
                  Nothing recorded yet. Publish something and it will appear here.
                </p>
              )}

              <div className="mt-6 space-y-6">
                {grouped.map(([day, entries]) => (
                  <div key={day}>
                    <div
                      className={cn(
                        'mb-2 font-mono text-[10px] uppercase tracking-[0.14em]',
                        MUTED,
                      )}
                    >
                      {day}
                    </div>
                    <div className={cn('overflow-hidden rounded-lg border', RULE, PANEL)}>
                      {entries.map((entry) => (
                        <Row key={entry.id} entry={entry} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

function Row({ entry }: { entry: CatalogAuditEvent }) {
  // One shared map with the trace view. Two copies drifted the first time a new
  // event was added and one screen kept rendering it as a bare event name.
  const meta = eventMeta(entry.event);
  const Icon = meta.icon;

  return (
    <div className="flex items-start gap-3 border-b border-zinc-100 px-4 py-2.5 last:border-0 dark:border-zinc-900">
      <Tooltip content={meta.meaning} side="right">
        <span className={cn('mt-0.5 shrink-0 cursor-help', meta.tone)}>
          <Icon size={14} />
        </span>
      </Tooltip>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm">{meta.label}</span>
          {entry.typeName && <span className="font-mono text-[11px]">{entry.typeName}</span>}
          {entry.snapshotId && (
            <span className={cn('font-mono text-[10px]', MUTED)}>{entry.snapshotId}</span>
          )}
        </div>
        <div className={cn('font-mono text-[10px]', MUTED)}>{detailOf(entry)}</div>
      </div>

      <div className="shrink-0 text-right">
        {entry.principalId && <div className="font-mono text-[11px]">{entry.principalId}</div>}
        <div className={cn('font-mono text-[10px]', MUTED)}>
          {new Date(entry.occurredAt).toLocaleTimeString()}
        </div>
      </div>
    </div>
  );
}

/** One line of the payload, chosen per event rather than dumped as JSON. */
function detailOf(entry: CatalogAuditEvent): string {
  const detail = entry.detail ?? {};
  switch (entry.event) {
    case 'snapshot.committed':
      return `${detail.rowCount ?? '?'} rows now served`;
    case 'snapshot.written':
      return `${detail.rows ?? '?'} rows in this batch`;
    case 'schema.changed': {
      const added = Array.isArray(detail.addedColumns) ? detail.addedColumns : [];
      return detail.created
        ? `table created with ${added.length} columns`
        : `added ${added.join(', ')}`;
    }
    case 'type.curated': {
      const changed = Array.isArray(detail.changed) ? detail.changed.join(', ') : '';
      return detail.property ? `${detail.property}: ${changed}` : changed;
    }
    default:
      return '';
  }
}
