import {
  type RowData,
  type TableOptions,
  coreCellsFeature,
  coreColumnsFeature,
  coreHeadersFeature,
  coreRowModelsFeature,
  coreRowsFeature,
  coreTablesFeature,
  createCoreRowModel,
  flexRender,
  useTable,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import { cn } from '../cn';

/**
 * The console's data tables, on TanStack Table v9.
 *
 * Four screens hand-rolled `<table>` markup with the same header row, the same
 * hairlines and the same "numbers go right" rule, each slightly differently.
 * What TanStack owns here is the column model, the header groups and the cell
 * rendering; what it deliberately does NOT own is where the data comes from.
 *
 * **Sorting is a prop, not a row model.** The object explorer sorts, pages and
 * searches on the SERVER — it has to, because it is reading a warehouse table
 * that does not fit in a browser. Handing those columns to
 * `createSortedRowModel` would sort the fifty rows currently on screen and
 * present the result as if it were the whole answer, which is a worse bug than
 * no sorting at all: it looks right. So this component renders the sort
 * affordance and reports clicks, and the caller decides whether that means a
 * refetch or a client-side reorder.
 */

/** What a header needs to know to draw and drive a sort indicator. */
export interface DataTableSort {
  /** Column id currently sorted, or null. */
  by: string | null;
  dir: 'asc' | 'desc';
  /** Called with the column id. The caller decides what sorting means. */
  onSort: (columnId: string) => void;
  /** Column ids that can be sorted. Absent means all of them. */
  sortable?: (columnId: string) => boolean;
}

export interface DataTableProps<TData extends RowData> {
  data: TData[];
  /**
   * Typed as exactly what `useTable` accepts for THIS feature set, rather than
   * as a hand-written `ColumnDef<...>`. A literal type here widens `TFeatures`
   * to the full `TableFeatures` union at the call below and stops assigning —
   * v9's column type is parameterised by the features in play, which is the
   * whole point of opting into them.
   */
  columns: TableOptions<DataTableFeatures, TData>['columns'];
  /** Stable per row. Falls back to the index, which is right for a SQL result. */
  getRowId?: (row: TData, index: number) => string;
  sort?: DataTableSort;
  /** Rendered instead of the body when there are no rows. */
  empty?: ReactNode;
  /** Right-aligns and tabular-nums a column — numbers read down a column badly otherwise. */
  numeric?: (columnId: string) => boolean;
  className?: string;
  /** `text-sm` for a full screen, `text-[11px]` for a card preview. */
  density?: string;
  /**
   * Per-row classes — a hidden property is dimmed rather than removed, so the
   * screen can say "this exists and is not shown" instead of just not saying.
   */
  rowClassName?: (row: TData) => string | undefined;
  /**
   * Per-column classes. Column WIDTH lives here rather than being derived,
   * because a table of editable fields needs the columns to hold still while
   * you type in them — content-sized columns reflow on every keystroke.
   */
  columnClassName?: (columnId: string) => string | undefined;
  /** Cells, when a column needs `align-top` for multi-line editors. */
  cellClassName?: (columnId: string) => string | undefined;
}

/**
 * The v9 feature set, listed once.
 *
 * v9 is opt-in per feature rather than v8's batteries-included table, which is
 * the point of the rewrite — a table that never groups should not ship the
 * grouping code. Everything here is core: this component renders rows and
 * columns and leaves sorting, filtering and pagination to whoever owns the data.
 */
function featureSet() {
  return {
    coreCellsFeature,
    coreColumnsFeature,
    coreHeadersFeature,
    coreRowModelsFeature,
    coreRowsFeature,
    coreTablesFeature,
    // Built here rather than at module scope, and per table rather than once:
    // a row model factory carries a cache, and one shared across every table on
    // the screen is a cache keyed by nothing.
    coreRowModel: createCoreRowModel(),
  };
}

export type DataTableFeatures = ReturnType<typeof featureSet>;

const RULE = 'border-zinc-200 dark:border-zinc-800';
const MUTED = 'text-zinc-400 dark:text-zinc-500';

export function DataTable<TData extends RowData>({
  data,
  columns,
  getRowId,
  sort,
  empty,
  numeric,
  className,
  density = 'text-sm',
  rowClassName,
  columnClassName,
  cellClassName,
}: DataTableProps<TData>) {
  // Explicit type arguments rather than inference: `columns` and `data` are
  // two inference sites for the same pair, and with a third parameter
  // (`TFeatures`) in play TS gives up and falls back to the constraints —
  // `TableFeatures`/`RowData` — which then refuse the narrower columns.
  const features = useMemo(featureSet, []);
  const table = useTable<DataTableFeatures, TData>({
    // The row model factories live INSIDE `features`, not in a sibling option.
    // v9 folded them in so a feature and the row model it needs are registered
    // together; a separate `rowModels` option does not typecheck and would be
    // ignored at runtime.
    features,
    data,
    columns,
    ...(getRowId ? { getRowId } : {}),
  });

  const rows = table.getRowModel().rows;
  if (rows.length === 0 && empty) return <>{empty}</>;

  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className={cn('w-full min-w-max', density)}>
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id} className={cn('border-b bg-zinc-50 dark:bg-zinc-950', RULE)}>
              {group.headers.map((header) => {
                const id = header.column.id;
                const canSort = sort ? (sort.sortable?.(id) ?? true) : false;
                const isNumeric = numeric?.(id) ?? false;
                const label = flexRender(header.column.columnDef.header, header.getContext());

                return (
                  <th
                    key={header.id}
                    // `aria-sort` on the header cell, not on the button. Screen
                    // readers announce it as part of the column, and a button
                    // carrying it says "this control is sorted" instead.
                    {...(canSort && sort?.by === id
                      ? { 'aria-sort': sort.dir === 'asc' ? 'ascending' : ('descending' as const) }
                      : {})}
                    className={cn(
                      'whitespace-nowrap px-3 py-2 text-left font-normal',
                      isNumeric && 'text-right',
                      columnClassName?.(id),
                    )}
                  >
                    {canSort && sort ? (
                      <button
                        type="button"
                        onClick={() => sort.onSort(id)}
                        className={cn(
                          'group inline-flex items-center gap-1',
                          // The arrow follows the text to the edge it is
                          // aligned to, rather than sitting between the label
                          // and the numbers it describes.
                          isNumeric && 'flex-row-reverse',
                        )}
                      >
                        <span
                          className={cn(
                            'text-xs',
                            sort.by === id
                              ? 'text-zinc-950 dark:text-zinc-50'
                              : 'text-zinc-500 dark:text-zinc-400',
                          )}
                        >
                          {label}
                        </span>
                        <SortIcon active={sort.by === id} dir={sort.dir} />
                      </button>
                    ) : (
                      <span
                        className={cn('font-mono text-[10px] uppercase tracking-[0.12em]', MUTED)}
                      >
                        {label}
                      </span>
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className={cn(
                'border-b border-zinc-100 last:border-0 dark:border-zinc-900',
                rowClassName?.(row.original),
              )}
            >
              {row.getAllCells().map((cell) => (
                <td
                  key={cell.id}
                  className={cn(
                    'whitespace-nowrap px-3 py-1.5',
                    cellClassName?.(cell.column.id),
                    // `tabular-nums` so digits line up down the column; without
                    // it a proportional font makes 1,111 narrower than 8,888 and
                    // the eye cannot compare magnitudes at a glance.
                    (numeric?.(cell.column.id) ?? false) && 'text-right font-mono tabular-nums',
                  )}
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Three states, not two.
 *
 * A sortable column that is not currently sorted shows a neutral glyph on hover
 * rather than nothing: a header that looks inert until you click it is one
 * people do not think to click.
 */
function SortIcon({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  if (!active) {
    return <ChevronsUpDown size={11} className={cn('opacity-0 group-hover:opacity-100', MUTED)} />;
  }
  return dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />;
}

/**
 * A value from an arbitrary query, as a cell.
 *
 * Exported because two screens render untyped rows and both had their own copy
 * of this ladder — and the interesting case is the one people skip: `null` and
 * `undefined` must render as a visible mark rather than as an empty cell, or
 * "no value" and "a value that happens to be blank" look identical.
 */
export function renderUnknown(value: unknown): ReactNode {
  if (value === null || value === undefined) {
    return <span className={MUTED}>—</span>;
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
