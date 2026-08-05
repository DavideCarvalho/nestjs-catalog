import type {
  CatalogFilterOperator,
  CatalogObjectFilter,
  CatalogObjectPage,
  CatalogObjectTypeDef,
  ScalarType,
  SnapshotRef,
} from '@dudousxd/nestjs-catalog/client';
import {
  coerceFilterValue,
  encodeObjectFilter,
  filterOperatorTakesValue,
} from '@dudousxd/nestjs-catalog/client';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  History,
  Search,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { cn } from './cn';
import { catalogQueryKeys, useCatalogClient } from './context';
import { Button } from './ui/button';
import { DataTable } from './ui/data-table';
import { Select } from './ui/select';

/**
 * One table for every object type in the catalog.
 *
 * Nothing here knows what any of your types are. The columns, their labels,
 * their alignment and their units all arrive with the data — which is the
 * point: the screen that replaces N hand-written tables cannot afford to know
 * about any of them.
 *
 * **The filter controls are derived, not listed.** Which columns can be filtered
 * and what each one may be filtered with come from `filterOperators` on the
 * page's own columns, which the server computes with `filterOperatorsFor` and
 * narrows to what its store can apply. So a type published this morning with a
 * new column is filterable this morning, and a control this screen draws is one
 * the read will accept. A list of filterable columns kept here would be a list
 * that goes quiet the day somebody publishes a column nobody edited it for.
 *
 * **A property's `name` is what a filter names; its `columnName` is how the
 * source spells it.** On a published type those differ whenever the source used
 * something SQL cannot: `Asset Id` becomes the property `Asset_Id`. The source
 * spelling is what a reader recognises, so it is shown; the property name is what
 * the server resolves, so it is what is sent.
 */

const MUTED = 'text-zinc-400 dark:text-zinc-500';
const PANEL = 'bg-white dark:bg-zinc-900';
const RULE = 'border-zinc-200 dark:border-zinc-800';

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

/**
 * How each operator reads in a control.
 *
 * A total map rather than a lookup with a fallback: an operator added to the
 * contract and not to this table fails to compile here, instead of appearing in
 * a dropdown as its own wire name.
 */
const OPERATOR_LABELS: Record<CatalogFilterOperator, string> = {
  eq: 'is',
  ne: 'is not',
  contains: 'contains',
  gte: 'is at least',
  lte: 'is at most',
  gt: 'is more than',
  lt: 'is less than',
  empty: 'has no value',
  notEmpty: 'has a value',
};

/** The page's own column shape — what a filter control is derived from. */
type PageColumn = CatalogObjectPage['columns'][number];

export interface ObjectExplorerProps {
  /** Which type to open. Omit to fall back to `?type=` then the first type. */
  type?: string;
  pageSize?: number;
  /** Where to send the "back" link. Omit to hide it. */
  backHref?: string;
  backLabel?: string;
}

/**
 * A parameter asked for in the URL, wherever the host keeps it.
 *
 * Both the real query string and the hash's own query, because a console like
 * this is very often hash-routed and `#objects?type=Mvr` leaves
 * `location.search` empty. Reading only one of the two made a link that
 * changed the address and nothing else — the worst kind of broken, because it
 * looks like the click did not register.
 *
 * A convenience, not the contract: hosts that route properly should pass the
 * `type` prop and never depend on this.
 *
 * **Why the other deep-linkable screens import it from here.** This was
 * `typeFromLocation`, private to this file, and it is the only argued precedent
 * in the package for how a screen finds a parameter: prop first, this second,
 * and the prop is what a real host is expected to pass. `QueryConsole` and
 * `DashboardBoard` learned the same trick for `?savedQuery=` and `?dashboard=`,
 * and a second copy of these eight lines would have been a second place for the
 * hash-versus-search rule above to be got wrong. Its home is a screen only
 * because a shared module for it does not exist yet; nothing here knows what an
 * object type is, and it should move the day a third concern needs it.
 */
export function paramFromLocation(name: string): string | null {
  if (typeof window === 'undefined') return null;
  const fromSearch = new URLSearchParams(window.location.search).get(name);
  if (fromSearch) return fromSearch;
  const hash = window.location.hash;
  const mark = hash.indexOf('?');
  if (mark === -1) return null;
  return new URLSearchParams(hash.slice(mark + 1)).get(name);
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

  const [typeName, setTypeName] = useSelectedType(snapshot?.types, typeProp);
  const [page, setPage] = useState(1);
  const { sort, dir, toggleSort, clearSort } = useSort(() => setPage(1));
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [filters, setFilters] = useState<CatalogObjectFilter[]>([]);
  // Empty string, not undefined: the picker is a `Select`, whose value is a
  // string, and "" is the option that means the load readers get by default.
  // That default is not negotiable — nobody opening this screen may silently be
  // reading an old load — so it is the initial state and the state a type change
  // returns to.
  const [snapshotId, setSnapshotId] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  /**
   * The filters actually in force, as the server parses them.
   *
   * Filled by a debounce rather than derived on the spot: what is being typed and
   * what has been asked for are two different facts, and a table that refetched
   * on every keystroke of a filter value would ask a warehouse a question per
   * character. The columns it needs to check a value against come from the read
   * below, which is why the hook is fed twice — see {@link useAppliedFilters}.
   */
  const [applied, setApplied] = useState<string[]>([]);
  // Stable, so the debounce inside the hook can depend on it honestly rather
  // than restarting its timer on every render. Back to page one whenever the
  // filters change: page 7 of an unfiltered table is very often past the end of
  // a filtered one, and a page past the end reads as "nothing matches".
  const apply = useCallback((encoded: string[]) => {
    setApplied(encoded);
    setPage(1);
  }, []);

  const params = useMemo(
    () => ({
      page,
      size: pageSize,
      search: debouncedSearch || undefined,
      sort,
      dir,
      // Omitted rather than sent empty, so a screen with no filters asks the
      // same question it always did.
      filter: applied.length > 0 ? applied : undefined,
      snapshot: snapshotId || undefined,
    }),
    [page, pageSize, debouncedSearch, sort, dir, applied, snapshotId],
  );

  const { data, isFetching, error } = useQuery({
    queryKey: catalogQueryKeys.objects(typeName, params),
    queryFn: () => client.objects(typeName, params),
    enabled: Boolean(typeName),
    placeholderData: (previous) => previous,
  });

  /**
   * Every load of this type, for the picker.
   *
   * One request per type rather than per page: it is keyed on the type and held
   * for half a minute, so paging, sorting and filtering never re-ask. A store
   * that keeps no history answers with an empty list and the picker does not
   * appear at all.
   */
  const { data: snapshots } = useQuery({
    queryKey: catalogQueryKeys.objectSnapshots(typeName),
    queryFn: () => client.snapshots(typeName),
    enabled: Boolean(typeName),
    staleTime: 30_000,
  });

  useAppliedFilters(filters, data?.columns, apply);

  const selectedType = snapshot?.types.find((t) => t.name === typeName);

  // Derived from what the SERVER said the columns are, not from a type this
  // file knows: the explorer renders whatever was published. The second header
  // line is the physical column name, which is what somebody writing SQL
  // against the same table needs and the display name will not give them —
  // followed by the source's own spelling when the two differ, which is what the
  // person who sent the file recognises.
  const columns = useMemo(
    () =>
      (data?.columns ?? []).map((column) => ({
        id: column.name,
        accessorFn: (row: Record<string, unknown>) => row[column.name],
        header: () => <ColumnHeading column={column} />,
        cell: (context: { getValue: () => unknown }) => formatCell(context.getValue(), column.type),
      })),
    [data?.columns],
  );

  const numericColumns = useMemo(
    () => new Set((data?.columns ?? []).filter((c) => isNumeric(c.type)).map((c) => c.name)),
    [data?.columns],
  );

  /**
   * The columns this deployment will accept a filter on.
   *
   * `filterOperators` absent is read as "not filterable" rather than as "all of
   * them": a server older than the field has not been asked, and offering a
   * control it would refuse is worse than offering none.
   */
  const filterable = useMemo(
    () => (data?.columns ?? []).filter((column) => (column.filterOperators ?? []).length > 0),
    [data?.columns],
  );

  function readSnapshot(next: string) {
    setSnapshotId(next);
    setPage(1);
  }

  function backToCurrent() {
    readSnapshot('');
  }

  function chooseType(name: string) {
    setTypeName(name);
    setSwitcherOpen(false);
    setPage(1);
    clearSort();
    setSearch('');
    // Filters name properties of the type that is leaving, and a snapshot id
    // belongs to it too — carried across, they would be refused by the read, and
    // the refusal would be about a type the reader is no longer looking at.
    //
    // Both halves, and the second is the one that bites: the controls are
    // emptied by `setFilters`, but what the read sends is the debounced copy, so
    // clearing only the controls left the very next request — the one for the new
    // type — carrying the old type's filters and coming back a 400.
    setFilters([]);
    apply([]);
    setSnapshotId('');
  }

  if (loadingCatalog) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className={cn('font-mono text-sm', MUTED)}>Reading the catalog…</p>
      </div>
    );
  }

  // What the SERVER says it read, never what this screen believes it asked for.
  // A request in flight, a stale cache or a snapshot that has since been dropped
  // all make those two disagree, and only one of them is evidence.
  const stale = data?.snapshot?.current === false;

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
          <TypeSwitcher
            types={snapshot?.types ?? []}
            selected={selectedType}
            open={switcherOpen}
            onToggle={() => setSwitcherOpen((o) => !o)}
            onChoose={chooseType}
            caption={tableCaption(selectedType, data)}
          />

          <SearchBox value={search} onChange={setSearch} what={selectedType?.pluralDisplayName} />
        </div>

        <FilterBar
          columns={filterable}
          filters={filters}
          onChange={setFilters}
          snapshots={snapshots ?? []}
          snapshotId={snapshotId}
          onSnapshot={readSnapshot}
        />

        {stale && (
          <StaleSnapshotBanner
            snapshots={snapshots ?? []}
            id={data?.snapshot?.id}
            onCurrent={backToCurrent}
          />
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-8 py-6">
        {error ? (
          <RefusedRead error={error} />
        ) : (
          <div
            className={cn(
              'overflow-hidden rounded-lg border transition-opacity',
              // The stale border is not decoration: the banner is at the top of a
              // scrolling page, and somebody who came back to this tab after
              // lunch may only ever see the grid.
              stale ? 'border-amber-400 dark:border-amber-500/60' : RULE,
              PANEL,
              isFetching && 'opacity-60',
            )}
          >
            {/* Sorting is reported, not performed. This screen reads a warehouse
              table through a PAGED endpoint, so the rows on screen are a window
              — sorting them here would reorder the window and present it as the
              whole answer, which looks right and is not. `toggleSort` refetches. */}
            <DataTable
              data={data?.rows ?? []}
              columns={columns}
              getRowId={(row, index) => String(row[selectedType?.primaryKey[0] ?? 'id'] ?? index)}
              sort={{ by: sort ?? null, dir, onSort: toggleSort }}
              numeric={(id) => numericColumns.has(id)}
            />

            {data && data.rows.length === 0 && (
              <EmptyState
                type={selectedType}
                search={debouncedSearch}
                filtered={applied.length > 0}
                onClear={() => {
                  setSearch('');
                  setFilters([]);
                }}
              />
            )}
          </div>
        )}

        {data && <Pager page={data.page} pages={data.pages} onPage={setPage} />}
      </div>
    </div>
  );
}

/**
 * The line under the title: the physical table, the row count, the columns.
 *
 * The row count is the page's `total`, so it moves with the filters — which is
 * the point of putting it here rather than on the pager. An ellipsis rather than
 * a zero while the read is in flight: "0 rows" and "not yet answered" are
 * different facts and only one of them is worth reacting to.
 */
function tableCaption(type: CatalogObjectTypeDef | undefined, data: CatalogObjectPage | undefined) {
  const rows = data ? `${data.total.toLocaleString()} rows` : '…';
  return `${type?.tableName} · ${rows} · ${data?.columns.length ?? 0} columns from the catalog`;
}

/** The one control that searches every text column at once. */
function SearchBox({
  value,
  onChange,
  what,
}: {
  value: string;
  onChange: (value: string) => void;
  what?: string;
}) {
  return (
    <div className="relative">
      <Search
        size={14}
        className={cn('pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2', MUTED)}
      />
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={`Search ${what?.toLowerCase() ?? 'objects'}`}
        aria-label="Search objects"
        className={cn(
          'w-72 rounded-md border bg-zinc-50 py-2 pl-8 pr-3 text-sm outline-none dark:bg-zinc-950',
          RULE,
          'placeholder:text-zinc-400 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15',
        )}
      />
    </div>
  );
}

/**
 * The sort, which this screen reports rather than performs.
 *
 * A hook so the three-state toggle — a new column sorts ascending, the same
 * column reverses, a type change clears — is in one place. Every one of those
 * sends the reader back to the first page, which is what `onSorted` is for: the
 * rows on screen are a window onto a warehouse table, and page 7 of one order is
 * not page 7 of another.
 */
function useSort(onSorted: () => void) {
  const [sort, setSort] = useState<string | undefined>();
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');

  function toggleSort(column: string) {
    if (sort === column) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSort(column);
      setDir('asc');
    }
    onSorted();
  }

  return { sort, dir, toggleSort, clearSort: () => setSort(undefined) };
}

/**
 * Which type this screen is showing, and how it gets chosen.
 *
 * A hook rather than two effects in the component because the rules are fiddly
 * and none of them are about rows:
 *
 * - **The prop wins whenever it changes**, not only on the first render. Guarding
 *   it on "no type chosen yet" meant a host that linked from one type to another
 *   — the ordinary way to arrive here — set the prop, watched it be ignored, and
 *   showed the previous type under a URL naming the new one.
 * - Failing a prop, the URL, and failing that the first type in the catalog.
 */
function useSelectedType(
  types: CatalogObjectTypeDef[] | undefined,
  typeProp: string | undefined,
): [string, (name: string) => void] {
  const [typeName, setTypeName] = useState<string>(typeProp ?? '');

  useEffect(() => {
    if (!typeProp || !types?.length) return;
    const match = types.find((type) => type.name === typeProp);
    if (match) setTypeName(match.name);
  }, [types, typeProp]);

  useEffect(() => {
    if (typeName || !types?.length) return;
    const requested = typeProp ?? paramFromLocation('type');
    const match = types.find((type) => type.name === requested);
    setTypeName(match?.name ?? types[0].name);
  }, [types, typeName, typeProp]);

  return [typeName, setTypeName];
}

/**
 * Debounce what has been built into what will be asked for.
 *
 * Only the filters that are ready go through. A half-typed filter is not a
 * filter: a row whose value box is still empty, or whose text is not yet a
 * number, would either narrow nothing or be refused — and a refusal for something
 * somebody is in the middle of typing reads as the screen being broken.
 * `coerceFilterValue` is the server's own check, imported rather than
 * reimplemented, so what is held back here is exactly what would have been
 * rejected there.
 *
 * `columns` comes from the read the applied filters feed, which sounds circular
 * and is not: the applied list is state, so this runs after the render that used
 * it. A filter can only have been built out of a column that had already arrived.
 */
function useAppliedFilters(
  filters: CatalogObjectFilter[],
  columns: PageColumn[] | undefined,
  onApplied: (encoded: string[]) => void,
): void {
  const encoded = useMemo(() => {
    const byName = new Map((columns ?? []).map((column) => [column.name, column]));
    return filters
      .filter((filter) => filterIsReady(filter, byName.get(filter.property)))
      .map((filter) => encodeObjectFilter(filter));
  }, [filters, columns]);

  // One string, so the debounce below depends on a value rather than on an array
  // identity that is new on every render.
  const key = encoded.join('\n');

  useEffect(() => {
    const timer = setTimeout(() => onApplied(key ? key.split('\n') : []), 250);
    return () => clearTimeout(timer);
    // `onApplied` has to be stable — a callback with a new identity every render
    // would restart this timer on every render and never fire. The caller wraps it
    // in `useCallback` for exactly that reason, which is what makes listing it
    // here honest rather than decorative.
  }, [key, onApplied]);
}

/**
 * Whether a filter is complete enough to send.
 *
 * The value is checked with the server's own coercion, so nothing leaves here
 * that would come back a 400 — the alternative is a refusal fired at every
 * keystroke of a number somebody is halfway through typing.
 */
function filterIsReady(filter: CatalogObjectFilter, column?: PageColumn): boolean {
  if (!filterOperatorTakesValue(filter.op)) return true;
  const value = filter.value ?? '';
  if (value.trim() === '') return false;
  if (!column) return true;
  return coerceFilterValue(column.type, value).ok;
}

/** The reason a filter is not being applied, when there is one worth saying. */
function filterProblem(filter: CatalogObjectFilter, column: PageColumn): string | undefined {
  if (!filterOperatorTakesValue(filter.op)) return undefined;
  const value = filter.value ?? '';
  if (value.trim() === '') return undefined;
  const coerced = coerceFilterValue(column.type, value);
  return coerced.ok ? undefined : coerced.problem;
}

/**
 * The filter and snapshot controls, both derived from what the server said.
 *
 * Together in one bar because they answer the same question in two directions —
 * which rows, and which load — and because a reader who has narrowed to eleven
 * rows should be able to see, without scrolling, whether those eleven are
 * current.
 */
function FilterBar({
  columns,
  filters,
  onChange,
  snapshots,
  snapshotId,
  onSnapshot,
}: {
  columns: PageColumn[];
  filters: CatalogObjectFilter[];
  onChange: (filters: CatalogObjectFilter[]) => void;
  snapshots: SnapshotRef[];
  snapshotId: string;
  onSnapshot: (id: string) => void;
}) {
  const addable = columns.filter(
    (column) => !filters.some((filter) => filter.property === column.name),
  );

  function add(name: string) {
    const column = columns.find((each) => each.name === name);
    const [first] = column?.filterOperators ?? [];
    if (!column || !first) return;
    onChange([...filters, { property: column.name, op: first, value: '' }]);
  }

  // Nothing to offer and no history to pick from: draw nothing rather than an
  // empty toolbar. That is the honest state on a store that neither filters nor
  // keeps snapshots.
  if (columns.length === 0 && snapshots.length === 0) return null;

  return (
    <div className="mt-4 flex flex-wrap items-start gap-2">
      {columns.length > 0 && (
        <Select
          value=""
          onValueChange={add}
          ariaLabel="Add a filter"
          placeholder="Add a filter…"
          className="w-56"
          options={addable.map((column) => ({
            value: column.name,
            label: column.displayName,
            // The property name is what the filter will carry; the source
            // spelling is what the reader recognises. Both, when they differ.
            hint:
              column.columnName && column.columnName !== column.name
                ? `${column.name} ← ${column.columnName}`
                : column.name,
          }))}
        />
      )}

      {snapshots.length > 0 && (
        <div className="flex items-center gap-1.5">
          <History size={13} className={MUTED} />
          <Select
            value={snapshotId}
            onValueChange={onSnapshot}
            ariaLabel="Load to read"
            className="w-72"
            options={[
              { value: '', label: 'Current load' },
              ...snapshots.map((each) => ({
                value: each.id,
                label: describeSnapshot(each),
                hint: `${each.rowCount.toLocaleString()} rows · ${each.principalId}`,
              })),
            ]}
          />
        </div>
      )}

      {filters.map((filter, index) => {
        const column = columns.find((each) => each.name === filter.property);
        if (!column) return null;
        return (
          <FilterRow
            key={filter.property}
            column={column}
            filter={filter}
            onChange={(next) => onChange(filters.map((each, at) => (at === index ? next : each)))}
            onRemove={() => onChange(filters.filter((_, at) => at !== index))}
          />
        );
      })}
    </div>
  );
}

/** One filter: the column, an operator it actually offers, and a value. */
function FilterRow({
  column,
  filter,
  onChange,
  onRemove,
}: {
  column: PageColumn;
  filter: CatalogObjectFilter;
  onChange: (filter: CatalogObjectFilter) => void;
  onRemove: () => void;
}) {
  const problem = filterProblem(filter, column);
  const label = column.displayName;

  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-md border px-2 py-1.5',
        problem ? 'border-amber-400 dark:border-amber-500/60' : RULE,
        PANEL,
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium">{label}</span>
        <Select
          value={filter.op}
          onValueChange={(op) => {
            if (isOfferedOperator(column, op)) onChange({ ...filter, op });
          }}
          ariaLabel={`Operator for ${label}`}
          className="w-36"
          options={(column.filterOperators ?? []).map((operator) => ({
            value: operator,
            label: OPERATOR_LABELS[operator],
          }))}
        />
        {filterOperatorTakesValue(filter.op) && (
          <FilterValue
            column={column}
            value={filter.value ?? ''}
            onChange={(value) => onChange({ ...filter, value })}
          />
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={onRemove}
          aria-label={`Remove the filter on ${label}`}
        >
          <X size={12} />
        </Button>
      </div>
      {problem && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          {problem} Not applied — these rows are not filtered by {label}.
        </p>
      )}
    </div>
  );
}

/**
 * The value box, typed by the column.
 *
 * A `date` column gets a date field, which is what makes a range on a date usable
 * at all: the control cannot produce something that is not a date.
 *
 * A `number` column deliberately does NOT get `type="number"`. That control drops
 * characters it dislikes as they are typed, so `1,200` — which is how people
 * write a mileage — becomes `1200` or nothing with no explanation, and a pasted
 * `12 000` vanishes. A text box with a numeric keypad accepts it, and the
 * coercion the SERVER would apply runs here instead and says why the filter is
 * not being applied. That check is the same function, imported, so the two can
 * never disagree about what a number is.
 */
function FilterValue({
  column,
  value,
  onChange,
}: {
  column: PageColumn;
  value: string;
  onChange: (value: string) => void;
}) {
  const label = `Value for ${column.displayName}`;
  const className = cn(
    'w-40 rounded-md border bg-white px-2 py-1 text-xs outline-none dark:bg-zinc-900',
    RULE,
    'focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15',
  );

  if (column.type === 'boolean') {
    return (
      <Select
        value={value}
        onValueChange={onChange}
        ariaLabel={label}
        className="w-28"
        options={[
          { value: 'true', label: 'Yes' },
          { value: 'false', label: 'No' },
        ]}
      />
    );
  }

  return (
    <input
      type={column.type === 'date' ? 'date' : 'text'}
      inputMode={column.type === 'number' ? 'numeric' : undefined}
      value={value}
      aria-label={label}
      onChange={(event) => onChange(event.target.value)}
      className={className}
    />
  );
}

/** Narrowed rather than asserted: a select hands back a string. */
function isOfferedOperator(column: PageColumn, value: string): value is CatalogFilterOperator {
  return (column.filterOperators ?? []).some((operator) => operator === value);
}

function describeSnapshot(snapshot: SnapshotRef): string {
  const at = new Date(snapshot.createdAt);
  if (Number.isNaN(at.getTime())) return snapshot.id;
  return at.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * That these rows are not the current data.
 *
 * Loud, and phrased as a fact about the data rather than about the control:
 * somebody who selected a load an hour ago and came back to the tab has no
 * memory of the selection, and "as of 4 March" beside a table is exactly as
 * misleading as no label at all if it reads like a caption. The way back is here
 * rather than only in the picker, because the picker is what they did not notice.
 */
function StaleSnapshotBanner({
  snapshots,
  id,
  onCurrent,
}: {
  snapshots: SnapshotRef[];
  id?: string;
  onCurrent: () => void;
}) {
  const snapshot = snapshots.find((each) => each.id === id);
  return (
    // `<output>` rather than a div with `role="status"`: it carries that role
    // already, so an assistive reader announces the change of load when the
    // banner appears, and it is the element the linter asks for.
    <output
      className={cn(
        'mt-3 flex flex-wrap items-center gap-3 rounded-md border px-3 py-2',
        'border-amber-400 bg-amber-50 text-amber-900',
        'dark:border-amber-500/60 dark:bg-amber-950/40 dark:text-amber-200',
      )}
    >
      <History size={14} className="shrink-0" />
      <p className="text-xs">
        <span className="font-semibold">You are reading an earlier load.</span>{' '}
        {snapshot
          ? `These rows are ${describeSnapshot(snapshot)}, loaded by ${snapshot.principalId}, and are not what this type currently serves.`
          : `These rows are an earlier snapshot${id ? ` (${id})` : ''} and are not what this type currently serves.`}
      </p>
      <Button variant="outline" size="sm" onClick={onCurrent}>
        Back to the current load
      </Button>
    </output>
  );
}

/**
 * What the server refused, verbatim.
 *
 * A read can now be refused for a reason the reader can act on — a filter this
 * store cannot apply, a value that is not a number, a snapshot on a store with no
 * history — and the previous behaviour was to render an empty grid, which says
 * "no rows match" for every one of them.
 */
function RefusedRead({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className={cn('rounded-lg border px-6 py-10 text-center', RULE, PANEL)}>
      <p className="text-sm text-zinc-900 dark:text-zinc-100">This read was refused.</p>
      <p className={cn('mt-2 font-mono text-xs', MUTED)}>{message}</p>
    </div>
  );
}

function EmptyState({
  type,
  search,
  filtered,
  onClear,
}: {
  type?: CatalogObjectTypeDef;
  search: string;
  filtered: boolean;
  onClear: () => void;
}) {
  if (search || filtered) {
    return (
      <div className="px-6 py-16 text-center">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {search ? `Nothing matches “${search}”.` : 'Nothing matches these filters.'}
        </p>
        <button
          type="button"
          onClick={onClear}
          className="mt-2 text-sm text-sky-600 underline underline-offset-2 dark:text-sky-400"
        >
          {search && filtered
            ? 'Clear the search and the filters'
            : search
              ? 'Clear the search'
              : 'Clear the filters'}
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

/**
 * The type being read, and every other type, in one control.
 *
 * Its own component because the dropdown is the branchiest thing on the screen
 * and none of its branches are about reading rows.
 */
function TypeSwitcher({
  types,
  selected,
  open,
  onToggle,
  onChoose,
  caption,
}: {
  types: CatalogObjectTypeDef[];
  selected?: CatalogObjectTypeDef;
  open: boolean;
  onToggle: () => void;
  onChoose: (name: string) => void;
  caption: string;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex items-baseline gap-2 text-left"
      >
        <span className="text-2xl leading-none">{selected?.icon ?? '◈'}</span>
        <span className="text-2xl font-semibold tracking-tight">
          {selected?.pluralDisplayName ?? 'Objects'}
        </span>
        <ChevronDown size={16} className={MUTED} />
      </button>
      <p className={cn('mt-1 pl-1 font-mono text-[11px]', MUTED)}>{caption}</p>

      {open && (
        <div
          className={cn(
            'absolute left-0 top-full z-20 mt-2 max-h-96 w-80 overflow-y-auto',
            'rounded-lg border p-1 shadow-lg',
            RULE,
            PANEL,
          )}
        >
          {types.map((t) => (
            <button
              key={t.name}
              type="button"
              onClick={() => onChoose(t.name)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                t.name === selected?.name
                  ? 'bg-sky-100 dark:bg-sky-950'
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
  );
}

/**
 * A column's label, its unit, and the two names it goes by.
 *
 * The mono line is the property name — what somebody writing SQL against the
 * same table needs, and what a filter carries — followed by the source's own
 * spelling when the two differ, which is what the person who sent the file
 * recognises. Neither is the display name, which is the curated label above.
 */
function ColumnHeading({ column }: { column: PageColumn }) {
  return (
    <>
      <span>
        {column.displayName}
        {column.unit && (
          <span className={cn('ml-1 font-mono text-[10px]', MUTED)}>({column.unit})</span>
        )}
      </span>
      <div className={cn('font-mono text-[10px] font-normal', MUTED)}>
        {column.name}
        {column.columnName && column.columnName !== column.name && ` ← ${column.columnName}`}
      </div>
    </>
  );
}

/** Nothing to page when there is one page: a lone disabled pair is noise. */
function Pager({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (update: (page: number) => number) => void;
}) {
  if (pages <= 1) return null;
  return (
    <div className="mt-4 flex items-center justify-between">
      <p className={cn('font-mono text-[11px]', MUTED)}>
        Page {page} of {pages}
      </p>
      <div className="flex items-center gap-1">
        <PageButton
          onClick={() => onPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1}
          label="Previous page"
        >
          <ChevronLeft size={14} />
        </PageButton>
        <PageButton
          onClick={() => onPage((p) => Math.min(pages, p + 1))}
          disabled={page >= pages}
          label="Next page"
        >
          <ChevronRight size={14} />
        </PageButton>
      </div>
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
