import type { CatalogObjectTypeDef, ScalarType } from '@dudousxd/nestjs-catalog/client';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { cn } from './cn';
import { catalogQueryKeys, useCatalogClient } from './context';

/**
 * One table for every object type in the catalog.
 *
 * Nothing here knows what any of your types are. The columns, their labels,
 * their alignment and their units all arrive with the data — which is the
 * point: the screen that replaces N hand-written tables cannot afford to know
 * about any of them.
 */

const MUTED = 'text-zinc-400 dark:text-zinc-500';
const PANEL = 'bg-white dark:bg-zinc-900';
const RULE = 'border-zinc-200 dark:border-zinc-800';
const HAIRLINE = 'border-zinc-100 dark:border-zinc-900';

function formatCell(value: unknown, type: ScalarType): string {
  if (value === null || value === undefined || value === '') return '—';
  if (type === 'boolean') return value ? 'Yes' : 'No';
  if (type === 'date') {
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime())
      ? String(value)
      : parsed.toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'short',
          day: '2-digit',
        });
  }
  if (type === 'json') return JSON.stringify(value);
  return String(value);
}

const isNumeric = (type: ScalarType) => type === 'number';

export interface ObjectExplorerProps {
  /** Which type to open. Omit to fall back to `?type=` then the first type. */
  type?: string;
  pageSize?: number;
  /** Where to send the "back" link. Omit to hide it. */
  backHref?: string;
  backLabel?: string;
}

/**
 * The type asked for in the URL, wherever the host keeps it.
 *
 * Both the real query string and the hash's own query, because a console like
 * this is very often hash-routed and `#objects?type=Mvr` leaves
 * `location.search` empty. Reading only one of the two made a link that
 * changed the address and nothing else — the worst kind of broken, because it
 * looks like the click did not register.
 *
 * A convenience, not the contract: hosts that route properly should pass the
 * `type` prop and never depend on this.
 */
function typeFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  const fromSearch = new URLSearchParams(window.location.search).get('type');
  if (fromSearch) return fromSearch;
  const hash = window.location.hash;
  const mark = hash.indexOf('?');
  if (mark === -1) return null;
  return new URLSearchParams(hash.slice(mark + 1)).get('type');
}

export function ObjectExplorer({
  type: typeProp,
  pageSize = 25,
  backHref,
  backLabel = 'Catalog',
}: ObjectExplorerProps) {
  const client = useCatalogClient();
  const { data: snapshot, isLoading: loadingCatalog } = useQuery({
    queryKey: catalogQueryKeys.snapshot,
    queryFn: () => client.snapshot(),
    staleTime: 30_000,
  });

  const [typeName, setTypeName] = useState<string>(typeProp ?? '');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sort, setSort] = useState<string | undefined>();
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // The prop wins whenever it changes, not only on the first render.
  //
  // Guarding this on "no type chosen yet" meant a host that linked from one
  // type to another — the ordinary way to arrive here — set the prop, watched
  // it be ignored, and showed the previous type under a URL naming the new one.
  useEffect(() => {
    if (!typeProp || !snapshot?.types.length) return;
    const match = snapshot.types.find((type) => type.name === typeProp);
    if (match) setTypeName(match.name);
  }, [snapshot, typeProp]);

  useEffect(() => {
    if (typeName || !snapshot?.types.length) return;
    const requested = typeProp ?? typeFromLocation();
    const match = snapshot.types.find((t) => t.name === requested);
    setTypeName(match?.name ?? snapshot.types[0].name);
  }, [snapshot, typeName, typeProp]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  const params = useMemo(
    () => ({
      page,
      size: pageSize,
      search: debouncedSearch || undefined,
      sort,
      dir,
    }),
    [page, pageSize, debouncedSearch, sort, dir],
  );

  const { data, isFetching } = useQuery({
    queryKey: catalogQueryKeys.objects(typeName, params),
    queryFn: () => client.objects(typeName, params),
    enabled: Boolean(typeName),
    placeholderData: (previous) => previous,
  });

  const selectedType = snapshot?.types.find((t) => t.name === typeName);

  function toggleSort(column: string) {
    if (sort === column) {
      setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(column);
      setDir('asc');
    }
    setPage(1);
  }

  if (loadingCatalog) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className={cn('font-mono text-sm', MUTED)}>Reading the catalog…</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-zinc-50 dark:bg-zinc-950">
      <header className={cn('shrink-0 border-b px-8 py-5', RULE, PANEL)}>
        {backHref && (
          <a
            href={backHref}
            className={cn(
              'mb-3 inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em]',
              MUTED,
              'hover:text-zinc-950 dark:hover:text-zinc-50',
            )}
          >
            <ArrowLeft size={12} />
            {backLabel}
          </a>
        )}

        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="relative">
            <button
              type="button"
              onClick={() => setSwitcherOpen((o) => !o)}
              aria-expanded={switcherOpen}
              className="flex items-baseline gap-2 text-left"
            >
              <span className="text-2xl leading-none">{selectedType?.icon ?? '◈'}</span>
              <span className="text-2xl font-semibold tracking-tight">
                {selectedType?.pluralDisplayName ?? 'Objects'}
              </span>
              <ChevronDown size={16} className={MUTED} />
            </button>
            <p className={cn('mt-1 pl-1 font-mono text-[11px]', MUTED)}>
              {selectedType?.tableName} · {data ? `${data.total.toLocaleString()} rows` : '…'} ·{' '}
              {data?.columns.length ?? 0} columns from the catalog
            </p>

            {switcherOpen && (
              <div
                className={cn(
                  'absolute left-0 top-full z-20 mt-2 max-h-96 w-80 overflow-y-auto',
                  'rounded-lg border p-1 shadow-lg',
                  RULE,
                  PANEL,
                )}
              >
                {snapshot?.types.map((t) => (
                  <button
                    key={t.name}
                    type="button"
                    onClick={() => {
                      setTypeName(t.name);
                      setSwitcherOpen(false);
                      setPage(1);
                      setSort(undefined);
                      setSearch('');
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                      t.name === typeName
                        ? 'bg-violet-100 dark:bg-violet-950'
                        : 'hover:bg-zinc-50 dark:hover:bg-zinc-800',
                    )}
                  >
                    <span>{t.icon ?? '◈'}</span>
                    <span className="flex-1 truncate">{t.pluralDisplayName}</span>
                    <span className={cn('font-mono text-[10px]', MUTED)}>{t.tableName}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="relative">
            <Search
              size={14}
              className={cn(
                'pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2',
                MUTED,
              )}
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${selectedType?.pluralDisplayName?.toLowerCase() ?? 'objects'}`}
              aria-label="Search objects"
              className={cn(
                'w-72 rounded-md border bg-zinc-50 py-2 pl-8 pr-3 text-sm outline-none dark:bg-zinc-950',
                RULE,
                'placeholder:text-zinc-400 focus:border-violet-500 focus:ring-2 focus:ring-violet-500/15',
              )}
            />
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-8 py-6">
        <div
          className={cn(
            'overflow-hidden rounded-lg border transition-opacity',
            RULE,
            PANEL,
            isFetching && 'opacity-60',
          )}
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-max text-sm">
              <thead>
                <tr className={cn('border-b bg-zinc-50 dark:bg-zinc-950', RULE)}>
                  {data?.columns.map((column) => {
                    const active = sort === column.name;
                    return (
                      <th
                        key={column.name}
                        className={cn(
                          'whitespace-nowrap px-3 py-2 text-left font-normal',
                          isNumeric(column.type) && 'text-right',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => toggleSort(column.name)}
                          className={cn(
                            'group inline-flex items-center gap-1',
                            isNumeric(column.type) && 'flex-row-reverse',
                          )}
                        >
                          <span
                            className={cn(
                              'text-xs',
                              active
                                ? 'text-zinc-950 dark:text-zinc-50'
                                : 'text-zinc-500 dark:text-zinc-400',
                            )}
                          >
                            {column.displayName}
                            {column.unit && (
                              <span className={cn('ml-1 font-mono text-[10px]', MUTED)}>
                                ({column.unit})
                              </span>
                            )}
                          </span>
                          {active ? (
                            dir === 'asc' ? (
                              <ChevronUp size={12} />
                            ) : (
                              <ChevronDown size={12} />
                            )
                          ) : (
                            <ChevronUp
                              size={12}
                              className="opacity-0 transition-opacity group-hover:opacity-40"
                            />
                          )}
                        </button>
                        <div className={cn('font-mono text-[10px] font-normal', MUTED)}>
                          {column.name}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {data?.rows.map((row, index) => (
                  <tr
                    key={String(row[selectedType?.primaryKey[0] ?? 'id'] ?? index)}
                    className={cn(
                      'border-b last:border-0 hover:bg-zinc-50 dark:hover:bg-zinc-950',
                      HAIRLINE,
                    )}
                  >
                    {data.columns.map((column) => (
                      <td
                        key={column.name}
                        className={cn(
                          'whitespace-nowrap px-3 py-2',
                          isNumeric(column.type) && 'text-right font-mono tabular-nums',
                          (row[column.name] === null || row[column.name] === undefined) && MUTED,
                        )}
                      >
                        {formatCell(row[column.name], column.type)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data && data.rows.length === 0 && (
            <EmptyState
              type={selectedType}
              search={debouncedSearch}
              onClear={() => setSearch('')}
            />
          )}
        </div>

        {data && data.pages > 1 && (
          <div className="mt-4 flex items-center justify-between">
            <p className={cn('font-mono text-[11px]', MUTED)}>
              Page {data.page} of {data.pages}
            </p>
            <div className="flex items-center gap-1">
              <PageButton
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={data.page <= 1}
                label="Previous page"
              >
                <ChevronLeft size={14} />
              </PageButton>
              <PageButton
                onClick={() => setPage((p) => Math.min(data.pages, p + 1))}
                disabled={data.page >= data.pages}
                label="Next page"
              >
                <ChevronRight size={14} />
              </PageButton>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({
  type,
  search,
  onClear,
}: {
  type?: CatalogObjectTypeDef;
  search: string;
  onClear: () => void;
}) {
  if (search) {
    return (
      <div className="px-6 py-16 text-center">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Nothing matches “{search}”.</p>
        <button
          type="button"
          onClick={onClear}
          className="mt-2 text-sm text-violet-600 underline underline-offset-2 dark:text-violet-400"
        >
          Clear the search
        </button>
      </div>
    );
  }
  return (
    <div className="px-6 py-16 text-center">
      <p className="text-sm text-zinc-500 dark:text-zinc-400">{type?.tableName} has no rows yet.</p>
      <p className={cn('mt-1 text-xs', MUTED)}>
        The type is in the catalog, so this table will fill in as soon as something writes to it.
      </p>
    </div>
  );
}

function PageButton({
  children,
  onClick,
  disabled,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={cn(
        'rounded-md border p-1.5 transition-colors disabled:opacity-40',
        RULE,
        PANEL,
        'hover:bg-zinc-50 disabled:hover:bg-white dark:hover:bg-zinc-800',
      )}
    >
      {children}
    </button>
  );
}
