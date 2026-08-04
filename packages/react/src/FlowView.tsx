import type { CatalogAuditEvent, CatalogObjectTypeDef } from '@dudousxd/nestjs-catalog/client';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CircleAlert, CircleCheck, CircleDot } from 'lucide-react';
import { useMemo } from 'react';
import { cn } from './cn';
import { catalogQueryKeys, useCatalogClient } from './context';
import { Tooltip, TooltipProvider } from './ui/tooltip';

const MUTED = 'text-zinc-400 dark:text-zinc-500';
const RULE = 'border-zinc-200 dark:border-zinc-800';
const PANEL = 'bg-white dark:bg-zinc-900';

/**
 * The flow: which application feeds which type, and how that has been going.
 *
 * Reconstructed from the audit trail rather than declared anywhere. A catalog
 * has no DAG to draw because nobody writes one — the graph is whatever the
 * publishers actually did, and inferring it from what happened is both less
 * work and more truthful than a diagram someone has to remember to update.
 *
 * Deliberately not an orchestrator. Scheduling, retries and backfill already
 * live in the publisher's own durable engine; duplicating them here would mean
 * two systems believing they own when a load runs.
 */
export function FlowView() {
  const client = useCatalogClient();

  const { data: snapshot } = useQuery({
    queryKey: catalogQueryKeys.snapshot,
    queryFn: () => client.snapshot(),
  });
  const { data: events = [], isLoading } = useQuery({
    queryKey: ['catalog', 'flow-events'],
    queryFn: () => client.listEvents({ limit: 500 }),
    refetchInterval: 20_000,
  });

  const lanes = useMemo(() => buildLanes(snapshot?.types ?? [], events), [snapshot, events]);

  return (
    <TooltipProvider>
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-5xl px-8 py-8">
          <p className={cn('font-mono text-[11px] uppercase tracking-[0.18em]', MUTED)}>Flow</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Who feeds what</h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-500 dark:text-zinc-400">
            Built from what the publishers actually did, not from a diagram somebody maintains.
            Scheduling and retries stay in each publisher's own engine — two systems believing they
            own when a load runs is worse than no picture at all.
          </p>

          {isLoading && (
            <p className={cn('py-10 text-center font-mono text-sm', MUTED)}>Reading the trail…</p>
          )}

          {!isLoading && lanes.length === 0 && (
            <p
              className={cn(
                'mt-6 rounded-lg border border-dashed px-4 py-12 text-center text-sm',
                RULE,
                MUTED,
              )}
            >
              Nothing has published yet.
            </p>
          )}

          <div className="mt-6 space-y-3">
            {lanes.map((lane) => (
              <Lane key={`${lane.principalId}:${lane.typeName}`} lane={lane} />
            ))}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

interface Lane {
  principalId: string;
  typeName: string;
  displayName: string;
  icon?: string;
  /** Most recent first. */
  loads: Array<{
    snapshotId: string;
    rows: number;
    committed: boolean;
    at: string;
  }>;
  schemaChanges: number;
  lastAt?: string;
}

/**
 * One lane per (publisher, type) pair.
 *
 * The pair, not the type: two applications feeding one type would be the single
 * most important thing on this screen, and collapsing by type would hide
 * exactly that.
 */
/** An empty lane for one (publisher, type) pair, named from the type when it is known. */
function newLane(
  principalId: string,
  typeName: string,
  def: CatalogObjectTypeDef | undefined,
): Lane {
  return {
    principalId,
    typeName,
    displayName: def?.displayName ?? typeName,
    icon: def?.icon,
    loads: [],
    schemaChanges: 0,
  };
}

/**
 * Fold one snapshot event into a lane's loads.
 *
 * A snapshot is written and then committed — two events for one load — so a
 * second event updates the load already recorded rather than adding another bar
 * beside it. Capped at 12 because a lane is a sparkline, not a log.
 */
function recordSnapshot(lane: Lane, event: CatalogAuditEvent): void {
  if (!event.snapshotId || !event.event.startsWith('snapshot.')) return;

  const committed = event.event === 'snapshot.committed';
  const rows = Number(event.detail?.rowCount ?? event.detail?.rows ?? 0);
  const existing = lane.loads.find((load) => load.snapshotId === event.snapshotId);

  if (existing) {
    existing.committed = existing.committed || committed;
    existing.rows = Math.max(existing.rows, rows);
    return;
  }
  if (lane.loads.length < 12) {
    lane.loads.push({ snapshotId: event.snapshotId, rows, committed, at: event.occurredAt });
  }
}

function buildLanes(types: CatalogObjectTypeDef[], events: CatalogAuditEvent[]): Lane[] {
  const byType = new Map(types.map((t) => [t.name, t]));
  const lanes = new Map<string, Lane>();

  // Events arrive newest first; walking them in that order keeps each lane's
  // loads sorted without a second pass.
  for (const event of events) {
    if (!event.typeName) continue;
    const principalId = event.principalId ?? 'curated by hand';
    const key = `${principalId}:${event.typeName}`;
    const lane = lanes.get(key) ?? newLane(principalId, event.typeName, byType.get(event.typeName));

    if (event.event === 'schema.changed') lane.schemaChanges += 1;
    recordSnapshot(lane, event);

    lane.lastAt = lane.lastAt ?? event.occurredAt;
    lanes.set(key, lane);
  }

  return [...lanes.values()].sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
}

function Lane({ lane }: { lane: Lane }) {
  const committed = lane.loads.filter((l) => l.committed).length;
  const uncommitted = lane.loads.length - committed;

  return (
    <div className={cn('rounded-lg border p-4', RULE, PANEL)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-zinc-100 px-2 py-1 font-mono text-[11px] dark:bg-zinc-800">
          {lane.principalId}
        </span>
        <ArrowRight size={14} className={MUTED} />
        <span className="text-sm">
          {lane.icon ? `${lane.icon} ` : ''}
          {lane.displayName}
        </span>
        <span className={cn('font-mono text-[10px]', MUTED)}>{lane.typeName}</span>

        <span className={cn('ml-auto font-mono text-[10px]', MUTED)}>
          {lane.lastAt ? new Date(lane.lastAt).toLocaleString() : ''}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {lane.loads.length === 0 && (
          <span className={cn('text-[11px]', MUTED)}>No loads recorded.</span>
        )}
        {[...lane.loads].reverse().map((load) => (
          <Tooltip
            key={load.snapshotId}
            content={
              <span className="font-mono text-[11px]">
                {load.snapshotId}
                <br />
                {load.rows} rows · {load.committed ? 'committed' : 'written, never committed'}
                <br />
                {new Date(load.at).toLocaleString()}
              </span>
            }
          >
            <span
              className={cn(
                'flex cursor-help items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px]',
                load.committed
                  ? 'border-emerald-200 text-emerald-700 dark:border-emerald-900 dark:text-emerald-300'
                  : 'border-amber-200 text-amber-700 dark:border-amber-900 dark:text-amber-300',
              )}
            >
              {load.committed ? <CircleCheck size={10} /> : <CircleDot size={10} />}
              {load.rows}
            </span>
          </Tooltip>
        ))}
      </div>

      <div className={cn('mt-2 flex flex-wrap gap-3 font-mono text-[10px]', MUTED)}>
        <span>{committed} committed</span>
        {uncommitted > 0 && (
          <Tooltip content="Written but never committed. Nobody is reading these — a publisher that stopped halfway leaves exactly this.">
            <span className="cursor-help text-amber-600">{uncommitted} left uncommitted</span>
          </Tooltip>
        )}
        {lane.schemaChanges > 0 && (
          <Tooltip content="Columns were added. This catalog never drops or retypes one automatically.">
            <span className="flex cursor-help items-center gap-1">
              <CircleAlert size={10} />
              {lane.schemaChanges} schema change
              {lane.schemaChanges === 1 ? '' : 's'}
            </span>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
