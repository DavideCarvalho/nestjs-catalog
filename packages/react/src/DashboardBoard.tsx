import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type {
  CatalogQueryResult,
  Dashboard,
  QueryVisualization,
  SavedQuery,
} from '@dudousxd/nestjs-catalog/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Download,
  GripVertical,
  LayoutGrid,
  Link2Off,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { paramFromLocation } from './ObjectExplorer';
import { ChartBody } from './charts/body';
import { CHART_GRID, chartSpan } from './charts/grid';
import { registeredChartLibraries, visualizationFor } from './charts/registry';
import { ChartFailed, ChartSkeleton } from './charts/skeleton';
import { cn } from './cn';
import { useCatalogClient } from './context';
import { ShareControl } from './sharing';
import { Select } from './ui/select';
import { Tooltip, TooltipProvider } from './ui/tooltip';

const MUTED = 'text-zinc-400 dark:text-zinc-500';
const RULE = 'border-zinc-200 dark:border-zinc-800';
const PANEL = 'bg-white dark:bg-zinc-900';

const dashboardKeys = {
  all: ['catalog', 'dashboards'] as const,
  card: (id: string) => ['catalog', 'dashboard-card', id] as const,
};

/**
 * Saved queries, laid out on a page.
 *
 * Each card runs its own saved query and honours the TTL that query was saved
 * with — so a dashboard of cached cards costs one round trip and no database
 * work, and a dashboard of uncached ones is honest about being expensive. The
 * alternative, a dashboard-wide refresh policy, would override a decision the
 * query's author already made with more information than the dashboard has.
 */
export interface DashboardBoardProps {
  /**
   * Which board to open. Omit to fall back to `?dashboard=` then to the first.
   *
   * The same shape, and the same reasoning, as `ObjectExplorer`'s `type`: the
   * host is the one that knows where its own router keeps parameters, so it
   * passes what it parsed, and {@link paramFromLocation} is the convenience for
   * a host that does not. This screen took no props at all until now, which is
   * why `#dashboards?dashboard=…` from the search box landed here and then
   * showed whichever board the component picked for itself.
   *
   * `| undefined` is spelled out rather than left to `?`, because a host
   * compiling under `exactOptionalPropertyTypes` — which the console in this
   * repo does — cannot pass `params.get('dashboard') ?? undefined` to a bare
   * `?: string` without a spread that exists only to satisfy the compiler. "No
   * board named" is a value this prop genuinely takes.
   */
  dashboardId?: string | undefined;
  /**
   * Called with whatever board is now open, so the host can put it in the
   * address. `undefined` when nothing is — the board was just deleted, say.
   *
   * **Why the write is a callback and the read is not.** Reading a URL is an
   * observation. Writing one is an act with effects outside this component's
   * box: whether a selection becomes a history entry you can press Back through
   * is the host's decision, and eleven boards clicked through in a session is
   * eleven presses of Back if it is made carelessly. A console mounted inside
   * somebody else's page should not find a library it embedded rewriting the
   * address. So this screen reports and the host writes; omit it and nothing
   * writes, which is what every existing host gets.
   *
   * Fired on SELECTION only, never on the implicit first board. The default
   * board is not something anybody chose, and naming it in the address would
   * hand out links that promise a specific board and deliver "whatever is
   * first" — the failure this whole prop pair exists to remove.
   */
  onDashboardChange?: (id: string | undefined) => void;
}

export function DashboardBoard({ dashboardId, onDashboardChange }: DashboardBoardProps = {}) {
  const client = useCatalogClient();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  // The prop wins whenever it changes, not only on the first render — a host
  // navigating from one board to another sets it, and guarding on "nothing open
  // yet" would show the previous board under an address naming the new one.
  // Deliberately NOT guarded on the id existing: ignoring an id we cannot find
  // is how a dead link ends up looking like a live one.
  //
  // The one and only place either source is read. Seeding the state with
  // `dashboardId ?? null` as well would read the prop twice, which is not just
  // redundant: it makes the first render right even when this effect is wrong,
  // so a build that stopped following the prop would still open the right board
  // on arrival and only misbehave on the second navigation — the harder half of
  // the bug, hidden behind the easier one.
  useEffect(() => {
    const requested = dashboardId ?? paramFromLocation('dashboard');
    if (requested) setSelectedId(requested);
  }, [dashboardId]);

  function select(id: string) {
    setSelectedId(id);
    onDashboardChange?.(id);
  }

  const { data: dashboards = [], isSuccess: dashboardsLoaded } = useQuery({
    queryKey: dashboardKeys.all,
    queryFn: () => client.listDashboards(),
  });
  const { data: saved = [] } = useQuery({
    queryKey: ['catalog', 'saved-queries'],
    queryFn: () => client.listSavedQueries(),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: dashboardKeys.all });

  const create = useMutation({
    mutationFn: () => client.saveDashboard({ name }),
    onSuccess: (dashboard) => {
      setCreating(false);
      setName('');
      // A board you just made is as chosen as one you clicked, so the address
      // names it and the link is sendable the moment it exists.
      select(dashboard.id);
      invalidate();
    },
  });

  const update = useMutation({
    mutationFn: ({ id, cards }: { id: string; cards: Dashboard['cards'] }) =>
      client.updateDashboard(id, { cards }),
    onSuccess: invalidate,
  });

  /**
   * Sharing, as its own mutation rather than a third caller of `update`.
   *
   * Two reasons, and both are about what the screen says while it happens. A
   * drag that is still saving must not disable the share button, and a refused
   * share must be reported next to the share control rather than swallowed into
   * whatever the last layout write did. They are also different acts: one
   * arranges a board, the other hands it to an application this deployment does
   * not run, which the server records as an event.
   */
  const share = useMutation({
    mutationFn: ({ id, shared }: { id: string; shared: boolean }) =>
      client.updateDashboard(id, { shared }),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => client.deleteDashboard(id),
    onSuccess: () => {
      setSelectedId(null);
      // The parameter goes with it. Left in place it would name a board that
      // this very session deleted, and the next reload would greet its author
      // with a "that board is gone" notice about their own deliberate act.
      onDashboardChange?.(undefined);
      invalidate();
    },
  });

  /**
   * Which board is open, and — separately — whether a link asked for one that
   * is not here.
   *
   * The old line was `find(...) ?? dashboards[0] ?? null`, which answered two
   * different questions with one fallback. "Nobody named a board" and "the
   * board somebody named is gone" both landed on the first board in the list:
   * correct for the first, and for the second the behaviour that makes a stale
   * link look like a working link showing the wrong thing. A person who clicked
   * a search result for a specific board would read somebody else's numbers
   * under the title of somebody else's board, with nothing on screen to suggest
   * they were not the ones asked for.
   *
   * So the fallback now applies only when nothing was asked for. `missingId` is
   * the other case, and it waits for `dashboardsLoaded`: until the list has
   * arrived the id is merely unresolved, and reporting that as gone would flash
   * the notice on every correct link.
   */
  const found = dashboards.find((d) => d.id === selectedId) ?? null;
  const missingId = selectedId !== null && dashboardsLoaded && !found ? selectedId : null;
  const selected = selectedId === null ? (dashboards[0] ?? null) : found;

  // Pointer with a small activation distance so a click on a card's buttons is
  // not swallowed as the start of a drag; keyboard so the layout is reachable
  // without a mouse, which native HTML5 drag never is.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function onDragEnd(event: DragEndEvent) {
    if (!selected) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const ordered = [...selected.cards].sort((a, b) => a.position - b.position);
    const from = ordered.findIndex((c) => c.id === active.id);
    const to = ordered.findIndex((c) => c.id === over.id);
    if (from === -1 || to === -1) return;

    update.mutate({
      id: selected.id,
      cards: arrayMove(ordered, from, to).map((card, index) => ({
        ...card,
        position: index,
      })),
    });
  }

  function setWidth(cardId: string, width: 1 | 2 | 3 | 4) {
    if (!selected) return;
    update.mutate({
      id: selected.id,
      cards: selected.cards.map((card) => (card.id === cardId ? { ...card, width } : card)),
    });
  }

  function setLibrary(cardId: string, library: string | undefined) {
    if (!selected) return;
    update.mutate({
      id: selected.id,
      cards: selected.cards.map((card) =>
        // The key is REMOVED rather than set to undefined when the card goes
        // back to following the query: `library: undefined` survives into the
        // stored JSON on some drivers and then reads as "this card chose the
        // built-in", which is a different statement.
        card.id === cardId
          ? library
            ? { ...card, library }
            : (({ library: _following, ...rest }) => rest)(card)
          : card,
      ),
    });
  }

  function addCard(savedQueryId: string) {
    if (!selected) return;
    update.mutate({
      id: selected.id,
      cards: [
        ...selected.cards,
        {
          id: `card-${Date.now()}`,
          savedQueryId,
          width: 2,
          position: selected.cards.length,
        },
      ],
    });
  }

  function removeCard(cardId: string) {
    if (!selected) return;
    update.mutate({
      id: selected.id,
      cards: selected.cards.filter((c) => c.id !== cardId),
    });
  }

  return (
    <TooltipProvider>
      <div className="flex h-full min-h-0">
        <aside className={cn('flex w-60 shrink-0 flex-col border-r', RULE, PANEL)}>
          <div className={cn('flex items-center justify-between border-b px-3 py-2', RULE)}>
            <span className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>
              Dashboards
            </span>
            <button
              type="button"
              onClick={() => setCreating((o) => !o)}
              className={cn('rounded-sm p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800', MUTED)}
              aria-label="New dashboard"
            >
              <Plus size={12} />
            </button>
          </div>

          {creating && (
            <form
              className="flex gap-1 p-2"
              onSubmit={(e) => {
                e.preventDefault();
                create.mutate();
              }}
            >
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name"
                aria-label="Dashboard name"
                className={cn(
                  'min-w-0 flex-1 rounded-md border bg-white px-2 py-1 text-xs outline-none dark:bg-zinc-900',
                  RULE,
                )}
              />
              <button
                type="submit"
                disabled={name.trim().length === 0}
                className="rounded-md bg-zinc-950 px-2 text-xs text-zinc-50 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-950"
              >
                Add
              </button>
            </form>
          )}

          <nav className="min-h-0 flex-1 overflow-y-auto p-2">
            {dashboards.length === 0 && (
              <p className={cn('px-2 py-4 text-center text-[11px]', MUTED)}>No dashboards yet.</p>
            )}
            {dashboards.map((dashboard) => (
              <button
                key={dashboard.id}
                type="button"
                onClick={() => select(dashboard.id)}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm',
                  selected?.id === dashboard.id
                    ? 'bg-sky-100 dark:bg-sky-950'
                    : 'hover:bg-zinc-50 dark:hover:bg-zinc-800',
                )}
              >
                <LayoutGrid size={12} className={MUTED} />
                <span className="min-w-0 flex-1 truncate">{dashboard.name}</span>
                <span className={cn('font-mono text-[10px]', MUTED)}>{dashboard.cards.length}</span>
              </button>
            ))}
          </nav>

          {selected && saved.length > 0 && (
            <div className={cn('border-t p-2', RULE)}>
              <div
                className={cn('px-1 pb-1 font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}
              >
                Add a card
              </div>
              {saved.map((query) => (
                <button
                  key={query.id}
                  type="button"
                  onClick={() => addCard(query.id)}
                  className={cn(
                    'w-full truncate rounded-md px-2 py-1 text-left text-[11px]',
                    'transition-all hover:translate-x-0.5 hover:bg-sky-50',
                    'dark:hover:bg-sky-950/40',
                  )}
                >
                  + {query.name}
                </button>
              ))}
            </div>
          )}
        </aside>

        <main className="@container min-w-0 flex-1 overflow-y-auto">
          {!selected ? (
            <NothingOpen missingId={missingId} />
          ) : (
            <div className="mx-auto max-w-6xl px-8 py-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h1 className="text-2xl font-semibold tracking-tight">{selected.name}</h1>
                  <p className={cn('mt-0.5 font-mono text-[11px]', MUTED)}>
                    {selected.cards.length} cards · by {selected.createdBy}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => remove.mutate(selected.id)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs',
                    RULE,
                    MUTED,
                    'hover:bg-zinc-50 dark:hover:bg-zinc-800',
                  )}
                >
                  <Trash2 size={12} />
                  Delete
                </button>
              </div>

              {/*
               * On its own line under the title rather than tucked in beside
               * Delete: this is the one control on the screen whose effect is
               * felt outside this deployment, and the sentence explaining what
               * the current state means is the reason it is a row and not an
               * icon. See `sharing.tsx` for why it is not a switch.
               */}
              <ShareControl
                className="mt-4"
                kind="dashboard"
                shared={selected.shared}
                pending={share.isPending}
                error={share.error}
                name={selected.name}
                onChange={(shared) => share.mutate({ id: selected.id, shared })}
              />

              {selected.cards.length === 0 ? (
                <p
                  className={cn(
                    'mt-8 rounded-lg border border-dashed px-4 py-12 text-center text-sm',
                    RULE,
                    MUTED,
                  )}
                >
                  Empty. Add a saved query from the left.
                </p>
              ) : (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={onDragEnd}
                >
                  <SortableContext
                    items={[...selected.cards]
                      .sort((a, b) => a.position - b.position)
                      .map((c) => c.id)}
                    strategy={rectSortingStrategy}
                  >
                    {/* The grid and the per-card spans travel together — see
                        charts/grid.ts, which the embedded board uses too so a
                        dashboard is arranged the same way wherever it is shown.
                        `@container` is declared on the scroll region above. */}
                    <div className={cn('mt-6', CHART_GRID)}>
                      {[...selected.cards]
                        .sort((a, b) => a.position - b.position)
                        .map((card) => (
                          <SortableCard
                            key={card.id}
                            id={card.id}
                            savedQueryId={card.savedQueryId}
                            width={card.width}
                            {...(card.library ? { library: card.library } : {})}
                            onRemove={() => removeCard(card.id)}
                            onWidth={(w) => setWidth(card.id, w)}
                            onLibrary={(next) => setLibrary(card.id, next)}
                          />
                        ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
            </div>
          )}
        </main>
      </div>
    </TooltipProvider>
  );
}

/**
 * The two reasons this pane can be empty, which must not be told as one.
 *
 * "There is no board open" is a state a new deployment starts in, and the right
 * thing to say is how to make one. "The board you asked for is not here" is a
 * failure that happened to somebody following a link, and the right thing to
 * say is which board and that nothing was substituted for it — because the
 * alternative reading, the one this notice exists to prevent, is that the click
 * never registered.
 *
 * The id is quoted verbatim: it is the only actionable part of a dead link.
 * Whoever sent it can be told exactly which one, and somebody looking at two
 * environments can see at a glance that the id belongs to the other one. The
 * address is deliberately left naming it — rewriting the URL to something valid
 * would erase the evidence while the reader is still looking at it.
 */
function NothingOpen({ missingId }: { missingId: string | null }) {
  if (missingId) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-md text-center">
          <Link2Off size={20} className={cn('mx-auto', MUTED)} />
          <h2 className="mt-2 text-lg font-medium">That dashboard is not here</h2>
          <p className={cn('mt-1 text-sm', MUTED)}>
            This link named <span className="font-mono text-[12px]">{missingId}</span>, which is not
            in this catalog — it may have been deleted, or it may belong to a different environment.
            No other board was opened in its place. Pick one from the left.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-sm text-center">
        <h2 className="text-lg font-medium">No dashboard open</h2>
        <p className={cn('mt-1 text-sm', MUTED)}>
          Save a query first, then make a dashboard and add it as a card.
        </p>
      </div>
    </div>
  );
}

/**
 * A card you can pick up.
 *
 * The drag handle is its own control rather than the whole card: a card is full
 * of buttons and a link, and making the entire surface draggable means every
 * click starts a drag the user did not ask for.
 */
function SortableCard({
  id,
  savedQueryId,
  width,
  library,
  onRemove,
  onWidth,
  onLibrary,
}: {
  id: string;
  savedQueryId: string;
  width: number;
  library?: string;
  onRemove: () => void;
  onWidth: (width: 1 | 2 | 3 | 4) => void;
  onLibrary: (library: string | undefined) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        chartSpan(width),
        // A grid item defaults to `min-width: auto`, so a chart wider than its
        // column pushes the column out instead of being constrained by it —
        // the same rule that made the nav overflow the page.
        'min-w-0',
        'motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95',
        isDragging && 'z-10 opacity-60 shadow-lg',
      )}
    >
      <Card
        savedQueryId={savedQueryId}
        width={width}
        {...(library ? { library } : {})}
        onRemove={onRemove}
        onWidth={onWidth}
        onLibrary={onLibrary}
        dragHandle={
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label="Reorder card"
            className={cn(
              'cursor-grab rounded-sm p-1 active:cursor-grabbing',
              'hover:bg-zinc-100 dark:hover:bg-zinc-800',
              MUTED,
            )}
          >
            <GripVertical size={11} />
          </button>
        }
      />
    </div>
  );
}

/**
 * How many of the four columns this card spans.
 *
 * A pressed-state button group rather than a select: there are exactly four
 * choices, the current one has to be visible at a glance while arranging a
 * board, and a closed dropdown shows nothing.
 */
function CardWidthPicker({
  width,
  onWidth,
}: {
  width: number;
  onWidth: (width: 1 | 2 | 3 | 4) => void;
}) {
  return (
    <span
      // A group of toggle buttons, not form fields, so `role="group"` is the
      // accurate semantic — it is what the ARIA authoring practices give a
      // toolbar toggle group and what Base UI's own ToggleGroup renders. A
      // `<fieldset>` here would claim these are form controls and drag its
      // user-agent sizing into a component the host styles.
      // biome-ignore lint/a11y/useSemanticElements: fieldset is for grouping form controls; these are toggle buttons
      className={cn('mr-1 flex overflow-hidden rounded-md border', RULE)}
      role="group"
      aria-label="Card width"
    >
      {([1, 2, 3, 4] as const).map((size) => (
        <Tooltip key={size} content={`${size} of 4 columns wide`}>
          <button
            type="button"
            onClick={() => onWidth(size)}
            aria-pressed={width === size}
            className={cn(
              'px-1.5 py-0.5 font-mono text-[10px] transition-colors',
              width === size
                ? 'bg-zinc-950 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-950'
                : 'hover:bg-zinc-100 dark:hover:bg-zinc-800',
            )}
          >
            {size}
          </button>
        </Tooltip>
      ))}
    </span>
  );
}

/**
 * The controls in a card's top-right: width, refresh, export, remove.
 *
 * Export appears only once there is a result, because the URL exports what the
 * query returns and offering it before the first run promises a file that does
 * not exist yet.
 */
function CardToolbar({
  width,
  onWidth,
  library,
  queryLibrary,
  onLibrary,
  cached,
  fetching,
  exportHref,
  onRefresh,
  onRemove,
}: {
  width: number;
  onWidth?: (width: 1 | 2 | 3 | 4) => void;
  library?: string;
  queryLibrary?: string;
  onLibrary?: (library: string | undefined) => void;
  cached: boolean;
  fetching: boolean;
  exportHref: string | undefined;
  onRefresh: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {onWidth && <CardWidthPicker width={width} onWidth={onWidth} />}
      {onLibrary && (
        <CardLibraryPicker library={library} queryLibrary={queryLibrary} onLibrary={onLibrary} />
      )}
      <Tooltip content={cached ? 'Cached — refetch anyway' : 'Run again'}>
        <button
          type="button"
          onClick={onRefresh}
          className={cn('rounded-sm p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800', MUTED)}
          aria-label="Refresh card"
        >
          <RefreshCw size={11} className={fetching ? 'animate-spin' : undefined} />
        </button>
      </Tooltip>
      {exportHref && (
        <Tooltip content="Download as CSV">
          <a
            href={exportHref}
            className={cn('rounded-sm p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800', MUTED)}
            aria-label="Export card"
          >
            <Download size={11} />
          </a>
        </Tooltip>
      )}
      <button
        type="button"
        onClick={onRemove}
        className={cn('rounded-sm p-1 hover:text-red-600', MUTED)}
        aria-label="Remove card"
      >
        <Trash2 size={11} />
      </button>
    </div>
  );
}

function Card({
  savedQueryId,
  width,
  library,
  onRemove,
  onWidth,
  onLibrary,
  dragHandle,
}: {
  savedQueryId: string;
  width: number;
  library?: string;
  onRemove: () => void;
  onWidth?: (width: 1 | 2 | 3 | 4) => void;
  onLibrary?: (library: string | undefined) => void;
  dragHandle?: React.ReactNode;
}) {
  const client = useCatalogClient();
  const { data, isPending, isFetching, refetch, error } = useQuery({
    queryKey: dashboardKeys.card(savedQueryId),
    queryFn: () => client.runSavedQuery(savedQueryId),
  });

  /**
   * The saved query itself, so the skeleton knows which chart is coming.
   *
   * Read from the list the board already loaded — same key, so this is a cache
   * hit rather than a second request. Without it the card cannot know whether
   * bars or a number are about to appear, and a generic grey box that turns
   * into a chart is exactly the placeholder this is meant to replace.
   */
  const { data: saved = [] } = useQuery({
    queryKey: ['catalog', 'saved-queries'],
    queryFn: () => client.listSavedQueries(),
    staleTime: 60_000,
  });
  const pendingKind =
    saved.find((query) => query.id === savedQueryId)?.visualization?.kind ?? 'table';

  return (
    <div className={cn('h-full rounded-lg border p-3 transition-shadow', RULE, PANEL)}>
      <div className="flex items-start justify-between gap-2">
        {dragHandle}
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">{data?.savedQuery.name ?? '…'}</h3>
          {data && (
            <p className={cn('font-mono text-[10px]', MUTED)}>
              {data.result.rowCount} rows
              {data.result.cached ? ' · cached' : ` · ${data.result.elapsedMs}ms`}
            </p>
          )}
        </div>
        <CardToolbar
          width={width}
          onWidth={onWidth}
          {...(library ? { library } : {})}
          {...(data?.savedQuery.visualization?.library
            ? { queryLibrary: data.savedQuery.visualization.library }
            : {})}
          onLibrary={onLibrary}
          cached={data?.result.cached === true}
          fetching={isFetching}
          exportHref={data ? client.exportUrl(savedQueryId) : undefined}
          onRefresh={() => refetch()}
          onRemove={onRemove}
        />
      </div>

      <div className="mt-3">
        <CardContent
          error={error}
          isPending={isPending}
          data={data}
          pendingKind={pendingKind}
          {...(library ? { library } : {})}
          onRetry={() => refetch()}
        />
      </div>
    </div>
  );
}

/**
 * Which of the three things a card can be showing.
 *
 * Its own component rather than a ternary inside `Card`, which had grown past
 * the point where the branches were readable — and this is the part of the card
 * that must stay readable, because the states are easy to collapse into each
 * other and the collapse is invisible until somebody's dashboard flickers.
 *
 * A failed query says so and offers a retry; a query that is merely refreshing
 * keeps the chart it already drew, because swapping a live chart for a
 * placeholder on every background refetch is the flicker the skeleton exists to
 * avoid; and only a card with no data yet gets the skeleton.
 *
 * `isPending`, never `isFetching`, for that reason.
 */
function CardContent({
  error,
  isPending,
  data,
  pendingKind,
  library,
  onRetry,
}: {
  error: unknown;
  isPending: boolean;
  data: { savedQuery: SavedQuery; result: CatalogQueryResult } | undefined;
  pendingKind: QueryVisualization['kind'];
  library?: string;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <ChartFailed
        height={200}
        message={error instanceof Error ? error.message : 'The card failed to load.'}
        onRetry={onRetry}
      />
    );
  }
  if (isPending) return <ChartSkeleton kind={pendingKind} height={200} />;
  if (!data) return null;
  return (
    <CardBody query={data.savedQuery} result={data.result} {...(library ? { library } : {})} />
  );
}

function CardBody({
  query,
  result,
  library,
}: {
  query: SavedQuery;
  result: CatalogQueryResult;
  /** This card's override. Undefined means "whatever the query chose". */
  library?: string;
}) {
  return (
    <ChartBody
      result={result}
      // Merged into the visualization rather than passed beside it, so a
      // renderer reading `visualization.library` sees the one it is actually
      // being drawn as. The merge stays HERE rather than inside `ChartBody`,
      // because the per-card override is a console feature: an embed has no
      // card to override from, and giving it one would be an authoring control.
      visualization={visualizationFor(query.visualization, library)}
      height={200}
      // Five columns and six rows, because this is a PREVIEW inside a card —
      // the whole answer lives on the query screen, and a card that tried to
      // show it would be a card you cannot read at a glance, which is the only
      // thing a card is for.
      maxColumns={5}
      maxRows={6}
    />
  );
}

/**
 * Which chart library draws this card.
 *
 * On the card rather than only on the saved query, because the two answer
 * different questions: the query says how this ANSWER is best drawn wherever it
 * appears, and the card says how it should look HERE, beside the other cards on
 * this board. A board mixing two libraries' idea of a bar reads as two boards,
 * and fixing that by editing the saved query would change it everywhere else
 * the query is used.
 *
 * A select rather than a button group — unlike width, the options are whatever
 * the host registered, so there is no fixed small set to lay out, and the
 * current value still has to be readable while arranging.
 */
/**
 * What the default option says underneath its label.
 *
 * Three cases, and the third is the one worth the function: a query naming a
 * library nobody registered. The card falls back to the built-in, correctly and
 * silently, so this line has to be the thing that says so.
 */
export function followsHint(queryLibrary: string | undefined, available: string[]): string {
  if (!queryLibrary) return 'the built-in renderer';
  if (!available.includes(queryLibrary)) {
    return `${queryLibrary} — not installed, drawing built-in`;
  }
  return queryLibrary;
}

function CardLibraryPicker({
  library,
  queryLibrary,
  onLibrary,
}: {
  /** This card's override, if it has one. */
  library: string | undefined;
  /** What the saved query chose, shown as the default option's subtitle. */
  queryLibrary: string | undefined;
  onLibrary: (library: string | undefined) => void;
}) {
  // Only what the host actually registered. Offering a library nobody
  // installed would be offering a choice that silently degrades to the
  // built-in — the picker would say one thing and the card draw another.
  const available = registeredChartLibraries();
  if (available.length === 0) return null;

  return (
    <Select
      value={library ?? ''}
      onValueChange={(next) => onLibrary(next || undefined)}
      ariaLabel="Chart library for this card"
      className="mr-1"
      options={[
        {
          value: '',
          label: 'follows query',
          // The hint is the reason this is not a native `<option>`: a native
          // one is a single line of unstyleable text, and what matters here is
          // the second line — that the query named a library nobody installed,
          // so the card is drawing something other than what it says.
          hint: followsHint(queryLibrary, available),
        },
        ...available.map((name) => ({ value: name, label: name })),
      ]}
    />
  );
}
