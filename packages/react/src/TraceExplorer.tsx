// Type-only, and from the package root rather than `/client`, because the
// browser entry point does not re-export the trace types yet. `import type` is
// erased entirely, so nothing from the server package reaches the bundle — but
// this line should move to `@dudousxd/nestjs-catalog/client` the moment that
// entry carries them, so browser consumers have one place to learn the shapes.
import type {
  CatalogTrace,
  CatalogTraceList,
  CatalogTraceOutcome,
  CatalogTraceSpan,
  TraceQuery,
} from '@dudousxd/nestjs-catalog';
import type { CatalogAuditEvent } from '@dudousxd/nestjs-catalog/client';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDot,
  Columns3,
  Flag,
  GitCommitVertical,
  LoaderCircle,
  OctagonX,
  Pencil,
  Play,
  RefreshCw,
  ScrollText,
  Trash2,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from './cn';
import { useCatalogClient } from './context';
import { Tooltip, TooltipProvider } from './ui/tooltip';

const MUTED = 'text-zinc-400 dark:text-zinc-500';
const RULE = 'border-zinc-200 dark:border-zinc-800';
const PANEL = 'bg-white dark:bg-zinc-900';

/**
 * Where this screen gets its traces.
 *
 * An interface rather than a direct fetch for the same reason the rest of these
 * screens take a transport: the host already has an HTTP client with its own
 * base URL, auth and error handling, and a console that authenticates
 * differently from the app around it is a console nobody trusts.
 */
export interface CatalogTraceSource {
  listTraces(query: TraceQuery): Promise<CatalogTraceList>;
  /**
   * One trace, with the payloads the list leaves in the database.
   *
   * Optional for the same reason the whole source is discovered rather than
   * declared: a host that has not updated its client still gets a working
   * screen. Without it the steps render from what the list carried, which is
   * every step, its timing and its error — everything except the one payload
   * line per step that `summarise` writes.
   */
  getTrace?(id: string): Promise<CatalogTrace>;
}

/**
 * Resolves the trace source from whatever client the host provided.
 *
 * Discovered at run time instead of being declared on `CatalogClient`, because
 * this screen must not be the reason a host that has not updated its provider
 * stops compiling — and because the shipped React view and a hand-written one
 * should be reaching the same endpoint through the same seam. The moment
 * `CatalogProvider` exposes `listTraces`, this lights up with no change here.
 *
 * The result is validated rather than trusted: it arrived through a method
 * nobody type-checked, and a screen that renders a malformed trace as an empty
 * one would hide exactly the load somebody came here to find.
 */
export function useTraceSource(explicit?: CatalogTraceSource): CatalogTraceSource | undefined {
  const client = useCatalogClient();

  return useMemo(() => {
    if (explicit) return explicit;

    const candidate = Reflect.get(client, 'listTraces');
    if (typeof candidate !== 'function') return undefined;

    const one = Reflect.get(client, 'getTrace');

    return {
      listTraces: (query: TraceQuery) =>
        Promise.resolve(candidate.call(client, query)).then(toTraceList),
      // Discovered separately from `listTraces`, because the two arrived in
      // different versions: a host pinned to a client that has the list and not
      // this one is a supported state, and the steps still render without it.
      ...(typeof one === 'function'
        ? {
            getTrace: (id: string) => Promise.resolve(one.call(client, id)).then(toTrace),
          }
        : {}),
    };
  }, [client, explicit]);
}

function toTraceList(value: unknown): CatalogTraceList {
  if (typeof value !== 'object' || value === null) {
    throw new Error('The trace endpoint answered with something that is not a trace list.');
  }
  const rawTraces: unknown = Reflect.get(value, 'traces');
  if (!Array.isArray(rawTraces)) {
    throw new Error('The trace endpoint answered without a list of traces.');
  }
  const rawUnlinked: unknown = Reflect.get(value, 'unlinked');
  const traces = rawTraces.filter(isTrace);

  return {
    traces,
    // The server's own count when it sent one. Falling back to the page length
    // is a deliberate under-claim: "showing 25 of 25" is wrong but harmless,
    // where a fabricated larger total would put a page nobody can reach behind
    // a control that promises one.
    total: numberOr(Reflect.get(value, 'total'), traces.length),
    limit: numberOr(Reflect.get(value, 'limit'), traces.length),
    offset: numberOr(Reflect.get(value, 'offset'), 0),
    unlinked: Array.isArray(rawUnlinked) ? rawUnlinked.filter(isAuditEvent) : [],
    unlinkedTotal: numberOr(Reflect.get(value, 'unlinkedTotal'), 0),
    clockResolutionMs: numberOr(Reflect.get(value, 'clockResolutionMs'), 1),
  };
}

function isAuditEvent(value: unknown): value is CatalogAuditEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'id') === 'string' &&
    typeof Reflect.get(value, 'event') === 'string'
  );
}

function isTrace(value: unknown): value is CatalogTrace {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'id') === 'string' &&
    Array.isArray(Reflect.get(value, 'spans'))
  );
}

/**
 * One trace, validated the same way the list's are.
 *
 * Same reason as {@link toTraceList}: it came back through a method nobody
 * type-checked, and the steps pane is where somebody is reading a payload
 * closely enough that a silently malformed one would mislead rather than
 * merely look wrong.
 */
function toTrace(value: unknown): CatalogTrace {
  if (!isTrace(value)) {
    throw new Error('The trace endpoint answered with something that is not a trace.');
  }
  return value;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** What each event looks like, and what it means in one line. */
export const CATALOG_EVENT_META: Record<
  string,
  { icon: typeof Upload; tone: string; bar: string; label: string; meaning: string }
> = {
  'connector.run.started': {
    icon: Play,
    tone: 'text-sky-600',
    bar: 'bg-sky-500/70',
    label: 'Run started',
    meaning: 'A connector began pulling. Everything after this is that run.',
  },
  'transform.changed': {
    icon: ScrollText,
    tone: 'text-sky-600',
    bar: 'bg-sky-500/70',
    label: 'Transform changed',
    meaning: 'Code that shapes stored data was edited. The first question about a surprising load.',
  },
  'schema.changed': {
    icon: Columns3,
    tone: 'text-amber-600',
    bar: 'bg-amber-500/70',
    label: 'Schema changed',
    meaning: 'Columns were added. Nothing is ever dropped automatically.',
  },
  'snapshot.written': {
    icon: Upload,
    tone: 'text-sky-600',
    bar: 'bg-sky-500/70',
    label: 'Batch written',
    meaning: 'Rows landed but were not yet visible to anyone.',
  },
  'snapshot.committed': {
    icon: GitCommitVertical,
    tone: 'text-emerald-600',
    bar: 'bg-emerald-500/70',
    label: 'Snapshot committed',
    meaning: 'A load became the one readers get.',
  },
  'snapshot.dropped': {
    icon: Trash2,
    tone: 'text-red-600',
    bar: 'bg-red-500/70',
    label: 'Snapshot dropped',
    meaning: 'A load was deleted. Never the one being served.',
  },
  'connector.run.finished': {
    icon: Flag,
    tone: 'text-zinc-500',
    bar: 'bg-zinc-400/70',
    label: 'Run finished',
    meaning: 'The run reported back, one way or the other.',
  },
  'type.curated': {
    icon: Pencil,
    tone: 'text-sky-600',
    bar: 'bg-sky-500/70',
    label: 'Curated',
    meaning: 'A label, description or unit changed. No migration.',
  },
};

export function eventMeta(event: string) {
  return (
    CATALOG_EVENT_META[event] ?? {
      icon: CircleDot,
      tone: MUTED,
      bar: 'bg-zinc-400/70',
      label: event,
      meaning: '',
    }
  );
}

/**
 * How each ending is drawn.
 *
 * `running` and `incomplete` are deliberately as loud as `failed` and share
 * none of `succeeded`'s vocabulary. A load that is still going and a load that
 * stopped halfway have both moved nothing a reader can see, and the expensive
 * mistake on this screen is not mistaking one for the other — it is either of
 * them being read as a night that went fine.
 */
const OUTCOMES: Record<
  CatalogTraceOutcome,
  {
    icon: typeof CircleCheck;
    label: string;
    chip: string;
    edge: string;
    meaning: string;
    /** Whether the story is over. Drives the "still going" affordances. */
    settled: boolean;
  }
> = {
  succeeded: {
    icon: CircleCheck,
    label: 'Succeeded',
    chip: 'text-emerald-700 border-emerald-300 bg-emerald-50 dark:text-emerald-300 dark:border-emerald-900 dark:bg-emerald-950/40',
    edge: 'border-l-emerald-500',
    meaning: 'It reached an event that said it worked.',
    settled: true,
  },
  failed: {
    icon: OctagonX,
    label: 'Failed',
    chip: 'text-red-700 border-red-300 bg-red-50 dark:text-red-300 dark:border-red-900 dark:bg-red-950/40',
    edge: 'border-l-red-500',
    meaning: 'It reached an event that said it did not work.',
    settled: true,
  },
  running: {
    icon: LoaderCircle,
    label: 'Running',
    chip: 'text-sky-700 border-sky-300 bg-sky-50 dark:text-sky-300 dark:border-sky-900 dark:bg-sky-950/40',
    edge: 'border-l-sky-500',
    meaning: 'Something started and has not reported back. Nothing here is a result yet.',
    settled: false,
  },
  incomplete: {
    icon: TriangleAlert,
    label: 'Never finished',
    chip: 'text-amber-700 border-amber-300 bg-amber-50 dark:text-amber-300 dark:border-amber-900 dark:bg-amber-950/40',
    edge: 'border-l-amber-500',
    meaning:
      'It stopped without ever saying how it went. Rows may have been written, but nothing was committed, so no reader can see them.',
    settled: false,
  },
};

const OUTCOME_FILTERS: Array<{ id: CatalogTraceOutcome | ''; label: string }> = [
  { id: '', label: 'Everything' },
  { id: 'failed', label: 'Failed' },
  { id: 'running', label: 'Running' },
  { id: 'incomplete', label: 'Never finished' },
  { id: 'succeeded', label: 'Succeeded' },
];

/**
 * The trail as stories rather than as a list.
 *
 * Grouped by the correlation id that was always in the data — the snapshot id,
 * which a connector run, its batches, its commit and its finish all carry, and
 * which is the durable run id when durable scheduled the load. Nothing is
 * inferred from timing: an event with no correlation id is shown as what it is,
 * at the bottom, rather than adopted by whichever load happened to be running.
 */
export function TraceExplorer({ source }: { source?: CatalogTraceSource } = {}) {
  const traces = useTraceSource(source);
  const [outcome, setOutcome] = useState<CatalogTraceOutcome | ''>('');
  const [open, setOpen] = useState<string | null>(null);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['catalog', 'traces', outcome],
    queryFn: () =>
      traces
        ? traces.listTraces({ outcome: outcome || undefined, limit: 50 })
        : Promise.reject(new Error('No trace source')),
    enabled: traces !== undefined,
    // Short, because a running trace is the case this screen exists for and a
    // stale one reads as a load that stopped.
    refetchInterval: 10_000,
  });

  if (!traces) return <TraceSourceMissing />;

  // Its own provider even though the governance screen already has one: this
  // component is exported on its own, and a Radix tooltip outside a provider
  // throws. Nested providers are a no-op, so the shared case costs nothing.
  return (
    <TooltipProvider>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {OUTCOME_FILTERS.map((filter) => (
            <button
              key={filter.id || 'all'}
              type="button"
              onClick={() => setOutcome(filter.id)}
              className={cn(
                'rounded-md border px-2.5 py-1 text-xs transition-colors',
                filter.id === outcome
                  ? 'border-zinc-400 bg-zinc-100 text-zinc-950 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-50'
                  : cn(RULE, 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60', MUTED),
              )}
            >
              {filter.label}
            </button>
          ))}

          <Tooltip content="Re-read the trail now">
            <button
              type="button"
              onClick={() => void refetch()}
              aria-label="Refresh traces"
              className={cn(
                'ml-auto rounded-md border p-1.5 transition-colors',
                RULE,
                'hover:bg-zinc-50 dark:hover:bg-zinc-800/60',
              )}
            >
              <RefreshCw size={13} className={cn(isFetching && 'animate-spin')} />
            </button>
          </Tooltip>
        </div>

        {isLoading && (
          <p className={cn('py-10 text-center font-mono text-sm', MUTED)}>
            Reassembling the trail…
          </p>
        )}

        {error && (
          <p
            className={cn(
              'rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700',
              'dark:border-red-900 dark:bg-red-950/40 dark:text-red-300',
            )}
          >
            {error instanceof Error ? error.message : String(error)}
          </p>
        )}

        {data && data.traces.length === 0 && (
          <p
            className={cn(
              'rounded-lg border border-dashed px-4 py-12 text-center text-sm',
              RULE,
              MUTED,
            )}
          >
            No trace matches. Every trace is one snapshot id — publish something, or run a
            connector, and its whole story appears here.
          </p>
        )}

        <div className="space-y-2">
          {(data?.traces ?? []).map((trace) => (
            <TraceCard
              key={trace.id}
              trace={trace}
              source={traces}
              expanded={open === trace.id}
              onToggle={() => setOpen(open === trace.id ? null : trace.id)}
            />
          ))}
        </div>

        {data && data.total > data.traces.length && (
          <p className={cn('text-center font-mono text-[10px]', MUTED)}>
            Showing {data.traces.length} of {data.total} traces.
          </p>
        )}

        {data && data.unlinked.length > 0 && <Unlinked list={data.unlinked} />}
      </div>
    </TooltipProvider>
  );
}

/**
 * The steps of one expanded trace.
 *
 * Rendered only while the card is open, which is the whole optimisation: a
 * screen showing fifty collapsed cards makes none of these requests, and the
 * list it drew them from never carried the payloads to begin with.
 *
 * The list's spans are the steps — every one of them, in order, with its timing
 * and its error. What they do not carry is the event payload, which is the one
 * line per step {@link summarise} writes and the reason a page of traces would
 * otherwise be megabytes of JSON nobody looked at. So opening a card fetches
 * the trace that has them.
 *
 * Those spans are drawn immediately and replaced when the fetch lands, rather
 * than a spinner standing in for them. Every step, its order and its error are
 * already known; blanking a pane that can already answer "which step failed" to
 * wait for one line of payload would be slower exactly where it matters. If the
 * fetch fails, or the host's client predates `getTrace`, that is simply where it
 * stays — one line per step poorer, and still the whole story.
 */
function TraceSteps({ trace, source }: { trace: CatalogTrace; source: CatalogTraceSource }) {
  const fetchOne = source.getTrace;
  const { data, isFetching } = useQuery({
    queryKey: ['catalog', 'trace', trace.id],
    queryFn: () => {
      if (!fetchOne) throw new Error('This client cannot fetch a single trace.');
      return fetchOne(trace.id);
    },
    enabled: typeof fetchOne === 'function',
    // The payloads of a finished load do not change. A running one keeps
    // gaining steps, and the list underneath is already re-polling, so this
    // follows it rather than holding a stale pane open beside a fresh card.
    staleTime: OUTCOMES[trace.outcome].settled ? Number.POSITIVE_INFINITY : 10_000,
  });

  const spans: CatalogTraceSpan[] = data?.spans ?? trace.spans;

  return (
    <div className="mt-2 space-y-1 border-t border-zinc-100 pt-2 dark:border-zinc-800">
      {spans.map((span) => (
        <Step key={span.id} span={span} coarse={trace.coarse} />
      ))}
      {isFetching && data === undefined && (
        <p className={cn('flex items-center gap-1.5 font-mono text-[10px]', MUTED)}>
          <LoaderCircle size={11} className="animate-spin" />
          loading payloads
        </p>
      )}
    </div>
  );
}

function TraceCard({
  trace,
  source,
  expanded,
  onToggle,
}: {
  trace: CatalogTrace;
  source: CatalogTraceSource;
  expanded: boolean;
  onToggle: () => void;
}) {
  const outcome = OUTCOMES[trace.outcome];
  const OutcomeIcon = outcome.icon;

  return (
    <div className={cn('rounded-lg border border-l-2 p-3', RULE, PANEL, outcome.edge)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Tooltip content={outcome.meaning}>
          <span
            className={cn(
              'flex cursor-help items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px]',
              outcome.chip,
            )}
          >
            <OutcomeIcon size={11} className={cn(trace.outcome === 'running' && 'animate-spin')} />
            {outcome.label}
          </span>
        </Tooltip>

        <span className="font-mono text-[11px]">{trace.id}</span>
        {trace.typeName && (
          <span className={cn('font-mono text-[10px]', MUTED)}>{trace.typeName}</span>
        )}
        {trace.connectorName && (
          <span className="text-[11px] text-zinc-600 dark:text-zinc-300">
            via {trace.connectorName}
          </span>
        )}

        <span className={cn('ml-auto font-mono text-[10px]', MUTED)}>
          {new Date(trace.startedAt).toLocaleString()}
        </span>
      </div>

      <div className={cn('mt-1 flex flex-wrap gap-x-3 font-mono text-[10px]', MUTED)}>
        <Tooltip
          content={
            outcome.settled
              ? 'Start of the first event to the end of the last.'
              : 'Time since it started. It has not reported an end, so this keeps growing.'
          }
        >
          <span className="cursor-help">
            {outcome.settled
              ? formatDuration(trace.durationMs ?? 0)
              : `${formatSince(trace.startedAt)} so far`}
          </span>
        </Tooltip>
        <span>{trace.eventCount} events</span>
        {trace.rowsCommitted !== undefined && <span>{trace.rowsCommitted} rows served</span>}
        {trace.principalId && <span>{trace.principalId}</span>}
        {trace.failureCount > 0 && trace.outcome !== 'failed' && (
          <Tooltip content="An earlier attempt on this same snapshot id failed. A retry reuses the id, so both attempts are in this one story.">
            <span className="cursor-help text-amber-600">
              {trace.failureCount} earlier failure
              {trace.failureCount === 1 ? '' : 's'}
            </span>
          </Tooltip>
        )}
        {!outcome.settled && <span>last event {formatSince(trace.lastEventAt)} ago</span>}
      </div>

      <Waterfall trace={trace} />

      {/*
        Shown without expanding anything. An error one click away is an error
        that gets missed, and this screen's whole job is that a load which did
        not work cannot be mistaken for one that did.
      */}
      {trace.error && (
        <p
          className={cn(
            'mt-2 rounded-md border border-red-300 bg-red-50 px-2.5 py-1.5 font-mono text-[11px] leading-snug text-red-700',
            'dark:border-red-900 dark:bg-red-950/40 dark:text-red-300',
          )}
        >
          {trace.error}
        </p>
      )}

      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'mt-2 flex items-center gap-1 text-[11px] transition-colors',
          MUTED,
          'hover:text-zinc-950 dark:hover:text-zinc-50',
        )}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {expanded ? 'Hide steps' : `${trace.spans.length} steps`}
      </button>

      {expanded && <TraceSteps trace={trace} source={source} />}
    </div>
  );
}

/**
 * The waterfall.
 *
 * Bars are placed by offset and sized by the gap to the next event, because
 * events are instants and the interesting quantity is the work between them —
 * the stretch from `connector.run.started` to the first batch is the fetch and
 * the transform, and on a slow load it is most of the picture.
 *
 * When the recorder's clock cannot separate the events, the bars are replaced
 * by evenly spaced markers on a dashed track. Drawing them to scale anyway
 * would produce a chart of rounding error that looks exactly like a chart of
 * measurements.
 */
function Waterfall({ trace }: { trace: CatalogTrace }) {
  const settled = OUTCOMES[trace.outcome].settled;

  if (trace.coarse) {
    return (
      <Tooltip content="The whole trace landed inside one tick of the audit clock, so there is no internal timing to draw. The order is still right — it comes from the events' place in a load's life, not from their timestamps.">
        <div className="mt-2 flex cursor-help items-center gap-0.5 rounded-md border border-dashed border-zinc-300 px-1.5 py-1 dark:border-zinc-700">
          {trace.spans.map((span) => (
            <span
              key={span.id}
              className={cn(
                'h-1.5 flex-1 rounded-full',
                span.failed ? 'bg-red-500/80' : eventMeta(span.event).bar,
              )}
            />
          ))}
          {!settled && <span className="h-1.5 flex-1 animate-pulse rounded-full bg-sky-400/50" />}
        </div>
      </Tooltip>
    );
  }

  // The full width of the track. For an unsettled trace it runs to now, so the
  // open end grows on screen instead of the last event looking like an ending.
  const start = new Date(trace.startedAt).getTime();
  const end = settled
    ? start + (trace.durationMs ?? 0)
    : Math.max(Date.now(), new Date(trace.lastEventAt).getTime());
  const total = Math.max(end - start, 1);
  const lastAt = new Date(trace.lastEventAt).getTime();

  return (
    <div className="relative mt-2 h-6 rounded-md bg-zinc-100 dark:bg-zinc-800/60">
      {trace.spans.map((span) => {
        const meta = eventMeta(span.event);
        return (
          <Tooltip
            key={span.id}
            content={
              <span className="font-mono text-[11px]">
                {meta.label}
                <br />+{formatDuration(span.offsetMs)} · {formatDuration(span.durationMs)} to the
                next
                <br />
                {new Date(span.occurredAt).toLocaleTimeString()}
              </span>
            }
          >
            <span
              className={cn(
                'absolute top-1.5 h-3 cursor-help rounded-sm',
                span.failed ? 'bg-red-500/80' : meta.bar,
              )}
              style={{
                left: `${(span.offsetMs / total) * 100}%`,
                // A floor of a few pixels so an instantaneous step is still
                // visible and hoverable; without it the fast steps vanish and
                // the trace looks like it had fewer of them than it did.
                width: `max(3px, ${(span.durationMs / total) * 100}%)`,
              }}
            />
          </Tooltip>
        );
      })}

      {!settled && (
        <Tooltip content="Still open. This end of the trace has not been written yet.">
          <span
            className="absolute top-1.5 h-3 animate-pulse cursor-help rounded-sm bg-sky-400/50"
            style={{
              left: `${((lastAt - start) / total) * 100}%`,
              right: 0,
            }}
          />
        </Tooltip>
      )}
    </div>
  );
}

function Step({ span, coarse }: { span: CatalogTraceSpan; coarse: boolean }) {
  const meta = eventMeta(span.event);
  const Icon = meta.icon;

  return (
    <div className="flex items-start gap-2">
      <Tooltip content={meta.meaning} side="right">
        <span
          className={cn('mt-0.5 shrink-0 cursor-help', span.failed ? 'text-red-600' : meta.tone)}
        >
          <Icon size={12} />
        </span>
      </Tooltip>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[12px]">{meta.label}</span>
          <span className={cn('font-mono text-[10px]', MUTED)}>{summarise(span)}</span>
        </div>
        {span.error && (
          <div className="font-mono text-[10px] leading-snug text-red-600 dark:text-red-400">
            {span.error}
          </div>
        )}
      </div>

      <div className={cn('shrink-0 text-right font-mono text-[10px]', MUTED)}>
        {coarse ? (
          new Date(span.occurredAt).toLocaleTimeString()
        ) : (
          <>
            +{formatDuration(span.offsetMs)}
            {span.durationMs > 0 && (
              <span className="ml-1.5">{formatDuration(span.durationMs)}</span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** One line of the payload, chosen per event rather than dumped as JSON. */
function summarise(span: CatalogTraceSpan): string {
  const detail = span.detail ?? {};
  switch (span.event) {
    case 'snapshot.committed':
      return `${detail.rowCount ?? '?'} rows now served`;
    case 'snapshot.written':
      return `${detail.rows ?? '?'} rows in this batch`;
    case 'connector.run.started':
      return typeof detail.connectorName === 'string' ? detail.connectorName : '';
    case 'connector.run.finished':
      return `${detail.fetched ?? '?'} fetched, ${detail.written ?? '?'} written`;
    case 'schema.changed': {
      const added = Array.isArray(detail.addedColumns) ? detail.addedColumns : [];
      return detail.created
        ? `table created with ${added.length} columns`
        : `added ${added.join(', ')}`;
    }
    case 'transform.changed':
      return `${detail.name ?? ''} v${detail.version ?? '?'}`;
    default:
      return '';
  }
}

/**
 * Events with no correlation id, shown as exactly that.
 *
 * The alternative — attaching them to whichever load was running at the time —
 * is tempting and wrong. A transform edit and a connector run share a second in
 * this very catalog, and the guess would look right; it would still be a guess
 * rendered as lineage, and the next person would read it as a cause.
 */
function Unlinked({ list }: { list: CatalogAuditEvent[] }) {
  return (
    <div className={cn('rounded-lg border border-dashed p-3', RULE)}>
      <div className="flex items-center gap-2">
        <span className="text-[12px]">Not part of any trace</span>
        <span className={cn('font-mono text-[10px]', MUTED)}>{list.length} events</span>
      </div>
      <p className={cn('mt-1 max-w-2xl text-[11px] leading-snug', MUTED)}>
        These carry no correlation id, so there is nothing to group them by. Curation edits and
        transform changes are standalone acts — attaching one to the load that happened to be
        running would invent a cause.
      </p>
      <div className="mt-2 space-y-1">
        {list.map((entry) => {
          const meta = eventMeta(entry.event);
          const Icon = meta.icon;
          return (
            <div key={entry.id} className="flex items-center gap-2">
              <Tooltip content={meta.meaning} side="right">
                <span className={cn('shrink-0 cursor-help', meta.tone)}>
                  <Icon size={12} />
                </span>
              </Tooltip>
              <span className="text-[12px]">{meta.label}</span>
              {entry.typeName && (
                <span className={cn('font-mono text-[10px]', MUTED)}>{entry.typeName}</span>
              )}
              <span className={cn('ml-auto font-mono text-[10px]', MUTED)}>
                {new Date(entry.occurredAt).toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Shown when the host's client has no way to reach the trace endpoint.
 *
 * Says what is missing and what to add, rather than rendering an empty list. An
 * empty list here would read as "nothing ever ran", which on a governance
 * screen is the worst available lie.
 */
function TraceSourceMissing() {
  return (
    <div
      className={cn('rounded-lg border border-dashed px-4 py-10 text-center text-sm', RULE, MUTED)}
    >
      <p>This console&rsquo;s catalog client cannot reach the trace endpoint yet.</p>
      <p className="mt-2 font-mono text-[11px]">
        Add <span className="text-zinc-600 dark:text-zinc-300">listTraces</span> to the client,
        wired to{' '}
        <span className="text-zinc-600 dark:text-zinc-300">GET /catalog/events/traces</span>.
      </p>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1) return '0ms';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function formatSince(iso: string): string {
  return formatDuration(Math.max(Date.now() - new Date(iso).getTime(), 0));
}
