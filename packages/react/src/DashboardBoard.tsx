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
import type { CatalogQueryResult, Dashboard, SavedQuery } from '@dudousxd/nestjs-catalog/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, GripVertical, LayoutGrid, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CssBarChart } from './charts/css';
import { getChartRenderer } from './charts/registry';
import { ChartEmpty, ChartFailed, ChartSkeleton } from './charts/skeleton';
import { cn } from './cn';
import { useCatalogClient } from './context';
import { DataTable, renderUnknown } from './ui/data-table';
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
export function DashboardBoard() {
  const client = useCatalogClient();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  const { data: dashboards = [] } = useQuery({
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
      setSelectedId(dashboard.id);
      invalidate();
    },
  });

  const update = useMutation({
    mutationFn: ({ id, cards }: { id: string; cards: Dashboard['cards'] }) =>
      client.updateDashboard(id, { cards }),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => client.deleteDashboard(id),
    onSuccess: () => {
      setSelectedId(null);
      invalidate();
    },
  });

  const selected = dashboards.find((d) => d.id === selectedId) ?? dashboards[0] ?? null;

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
                onClick={() => setSelectedId(dashboard.id)}
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
            <div className="flex h-full items-center justify-center px-6">
              <div className="max-w-sm text-center">
                <h2 className="text-lg font-medium">No dashboard open</h2>
                <p className={cn('mt-1 text-sm', MUTED)}>
                  Save a query first, then make a dashboard and add it as a card.
                </p>
              </div>
            </div>
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
                    {/* Container queries, not viewport ones. The board sits
                        beside a sidebar, so how much room a card actually has
                        is a fact about THIS box and not about the window —
                        `md:` here would give two columns on an 800px screen
                        whose board is 500px wide. `@container` is declared on
                        the scroll region above. */}
                    <div className="mt-6 grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-4">
                      {[...selected.cards]
                        .sort((a, b) => a.position - b.position)
                        .map((card) => (
                          <SortableCard
                            key={card.id}
                            id={card.id}
                            savedQueryId={card.savedQueryId}
                            width={card.width}
                            onRemove={() => removeCard(card.id)}
                            onWidth={(w) => setWidth(card.id, w)}
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
  onRemove,
  onWidth,
}: {
  id: string;
  savedQueryId: string;
  width: number;
  onRemove: () => void;
  onWidth: (width: 1 | 2 | 3 | 4) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        SPAN[width] ?? SPAN[2],
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
        onRemove={onRemove}
        onWidth={onWidth}
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
 * The width an operator chose, applied only where there are columns to spend.
 *
 * Below `@5xl` the grid has fewer than four columns, and a `col-span-4` there
 * spans past the end — which is what put a chart's axis labels outside its own
 * card. Every card is full width on a narrow board, two-up in the middle, and
 * only honours the chosen span once four columns exist to divide.
 */
const SPAN: Record<number, string> = {
  1: '@5xl:col-span-1',
  2: '@2xl:col-span-2 @5xl:col-span-2',
  3: '@2xl:col-span-2 @5xl:col-span-3',
  4: '@2xl:col-span-2 @5xl:col-span-4',
};

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
  cached,
  fetching,
  exportHref,
  onRefresh,
  onRemove,
}: {
  width: number;
  onWidth?: (width: 1 | 2 | 3 | 4) => void;
  cached: boolean;
  fetching: boolean;
  exportHref: string | undefined;
  onRefresh: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {onWidth && <CardWidthPicker width={width} onWidth={onWidth} />}
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
  onRemove,
  onWidth,
  dragHandle,
}: {
  savedQueryId: string;
  width: number;
  onRemove: () => void;
  onWidth?: (width: 1 | 2 | 3 | 4) => void;
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
          cached={data?.result.cached === true}
          fetching={isFetching}
          exportHref={data ? client.exportUrl(savedQueryId) : undefined}
          onRefresh={() => refetch()}
          onRemove={onRemove}
        />
      </div>

      <div className="mt-3">
        {/*
         * Three states, and keeping them apart is the whole point. A failed
         * query says so and offers a retry; a query that is merely refreshing
         * keeps the chart it already drew, because swapping a live chart for a
         * placeholder on every background refetch is the flicker the skeleton
         * exists to avoid; and only a card with no data yet gets the skeleton.
         *
         * `isPending`, never `isFetching`, for that reason.
         */}
        {error ? (
          <ChartFailed
            height={200}
            message={error instanceof Error ? error.message : 'The card failed to load.'}
            onRetry={() => refetch()}
          />
        ) : isPending ? (
          <ChartSkeleton kind={pendingKind} height={200} />
        ) : data ? (
          <CardBody query={data.savedQuery} result={data.result} />
        ) : null}
      </div>
    </div>
  );
}

function CardBody({
  query,
  result,
}: {
  query: SavedQuery;
  result: CatalogQueryResult;
}) {
  const viz = query.visualization ?? { kind: 'table' };
  // Held at the chart's own height rather than collapsing to one line, so a
  // card that matched nothing does not resize the grid around it — and said in
  // words, because "no rows" beside a skeleton-shaped hole is the one reading
  // that must never be ambiguous.
  if (result.rowCount === 0) {
    return <ChartEmpty height={200} message="The query ran and matched nothing." />;
  }

  if (viz.kind === 'number') {
    const column = viz.valueColumns?.[0] ?? result.columns[0];
    return (
      <div className="py-4 text-center">
        <div className="font-mono text-3xl tabular-nums">
          {String(result.rows[0]?.[column] ?? '—')}
        </div>
        <div className={cn('mt-1 font-mono text-[10px] uppercase', MUTED)}>
          {viz.labelColumn ?? column}
        </div>
      </div>
    );
  }

  if (viz.kind === 'bar' || viz.kind === 'line' || viz.kind === 'area') {
    // A registered library when the query names one and the host installed it;
    // otherwise the built-in bars. Falling back beats failing: a dashboard
    // should degrade to a plainer chart, not to an error message.
    const Renderer = getChartRenderer(viz.library);
    if (Renderer) {
      return <Renderer result={result} visualization={viz} height={200} />;
    }
    return <CssBarChart result={result} visualization={viz} height={200} />;
  }

  return <MiniTable result={result} />;
}

function MiniTable({ result }: { result: CatalogQueryResult }) {
  // Five columns and six rows, because this is a PREVIEW inside a card — the
  // whole answer lives on the query screen, and a card that tried to show it
  // would be a card you cannot read at a glance, which is the only thing a card
  // is for.
  const shown = useMemo<string[]>(() => result.columns.slice(0, 5), [result.columns]);
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
  const rows = useMemo(() => result.rows.slice(0, 6), [result.rows]);
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
