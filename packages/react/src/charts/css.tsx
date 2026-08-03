import type { CatalogQueryResult } from '@dudousxd/nestjs-catalog/client';
import { seriesFrom } from './registry';
import type { ChartRendererProps } from './registry';

/**
 * A bar chart in CSS, not a charting library.
 *
 * Eight rows of one series is the shape a dashboard card actually holds, and a
 * charting dependency would be larger than the whole package for it. When a
 * card needs axes and tooltips, the honest answer is a real library — not a
 * bigger version of this.
 *
 * Lifted out of `DashboardBoard` and given the `ChartRenderer` shape because it
 * is not only the dashboard's fallback: it is *the* fallback, the thing every
 * other renderer degrades to when it cannot draw what a saved query asked for.
 * A registered library that hits data it does not support has to land somewhere,
 * and before this it had nowhere to land but an error.
 */
export function CssBarChart({ result, visualization }: ChartRendererProps) {
  const label = visualization.labelColumn ?? result.columns[0];
  const value =
    visualization.valueColumns?.[0] ??
    result.columns.find(
      (column) => column !== label && typeof result.rows[0]?.[column] === 'number',
    ) ??
    result.columns[1];

  const rows = result.rows.slice(0, 8);
  const max = Math.max(...rows.map((row) => Number(row[value]) || 0).filter(Number.isFinite), 0);

  return (
    <div className="space-y-1.5">
      {rows.map((row, index) => {
        const raw = Number(row[value]) || 0;
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no key
            key={index}
            className="flex items-center gap-2"
          >
            <span className="w-24 shrink-0 truncate text-[11px]">{String(row[label] ?? '—')}</span>
            <div className="h-3 flex-1 overflow-hidden rounded-sm bg-zinc-100 dark:bg-zinc-800">
              <div
                className="h-full rounded-sm bg-violet-500/80"
                style={{ width: max > 0 ? `${(raw / max) * 100}%` : '0%' }}
              />
            </div>
            <span className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums">
              {raw}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Whether a column holds something a time scale can actually place.
 *
 * This exists because a chart library that plots time and one that plots
 * categories are not interchangeable, and the difference does not show up as an
 * error — it shows up as `new Date("Cargo truck")` being `Invalid Date`, an
 * axis whose extent is `NaN`, and a chart that renders as an empty box. A saved
 * query's label column is arbitrary: it may be a month, or it may be a vehicle
 * type, and nothing in the model distinguishes them.
 *
 * Deliberately strict. A bare number would parse as a millisecond timestamp, so
 * "5 work orders" would silently become 1 January 1970, and a `snapshotId` of
 * `20260301` would parse as a year. Strings only, and only ones that parse.
 */
export function looksLikeTimeSeries(result: CatalogQueryResult, labelColumn: string): boolean {
  const sample = result.rows
    .slice(0, 12)
    .map((row) => row[labelColumn])
    .filter((value) => value !== null && value !== undefined);

  if (sample.length === 0) return false;

  return sample.every((value) => {
    if (value instanceof Date) return !Number.isNaN(value.getTime());
    if (typeof value !== 'string') return false;
    // A plain integer string is a category far more often than it is a date,
    // and `new Date("2026")` succeeds — which is exactly the silent misreading
    // this guard is for.
    if (/^\d+$/.test(value)) return false;
    return !Number.isNaN(new Date(value).getTime());
  });
}

/** Re-exported so a renderer needs one import to read a result the shared way. */
export { seriesFrom };
