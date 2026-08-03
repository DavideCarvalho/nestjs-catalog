import { useMemo } from 'react';
import { Area } from './bklit/area';
import { AreaChart } from './bklit/area-chart';
import { Bar } from './bklit/bar';
import { BarChart } from './bklit/bar-chart';
import { Grid } from './bklit/grid';
import { Line } from './bklit/line';
import { LineChart } from './bklit/line-chart';
import { ChartTooltip } from './bklit/tooltip';
import { XAxis } from './bklit/x-axis';
import { CssBarChart, looksLikeTimeSeries } from './css';
import { CHART_COLORS, type ChartRendererProps, seriesFrom } from './registry';

/**
 * The bklit-ui renderer.
 *
 * bklit-ui (https://github.com/bklit/bklit-ui, MIT, Copyright (c) 2026 uixmat)
 * is vendored under `./bklit` rather than depended on, because it is a shadcn
 * registry — components you own, not a package you install. The full licence is
 * in LICENSE-bklit at the root of this package.
 *
 * Registered like any other library, so a host that never selects it pays for
 * none of the visx, d3 or motion peers it needs:
 *
 * ```tsx
 * import { registerChartRenderer } from "@dudousxd/nestjs-catalog-react";
 * import { BklitRenderer } from "@dudousxd/nestjs-catalog-react/bklit";
 *
 * registerChartRenderer("bklit", BklitRenderer);
 * ```
 */

/** How many series a card can carry before the colours stop being telling apart. */
const MAX_SERIES = 5;

export function BklitRenderer({ result, visualization, height = 220 }: ChartRendererProps) {
  const { labelColumn, valueColumns } = seriesFrom(result, visualization);
  const series = valueColumns.slice(0, MAX_SERIES);

  /**
   * bklit's line and area charts are time-series charts: they build a
   * `scaleTime` and coerce the x value with `new Date(...)`. A saved query's
   * label column is arbitrary — it may be a month, or it may be a vehicle type
   * — and nothing in `QueryVisualization` distinguishes them.
   *
   * This is the failure worth spelling out, because it is silent rather than
   * loud: `new Date("Cargo truck")` is `Invalid Date`, the axis extent becomes
   * `NaN`, and the card renders as an empty box with no error anywhere. So the
   * data is checked before a time scale is handed anything, and categorical
   * data degrades to the built-in bars instead — a plainer chart, which is the
   * documented behaviour, rather than a blank one.
   *
   * bklit's *bar* chart has no such constraint: it is banded and categorical,
   * so it takes whatever the label column holds.
   */
  const timeSeries = useMemo(() => looksLikeTimeSeries(result, labelColumn), [result, labelColumn]);

  /**
   * bklit reads its x value from a named key, so the label column is copied to
   * the name it expects rather than the charts being told which column to read.
   *
   * Copied rather than renamed: the original column is left in place because
   * the tooltip renders the row, and a row that lost the column somebody
   * labelled the chart with is a tooltip missing its own heading.
   */
  const data = useMemo(() => {
    if (!timeSeries) {
      return result.rows.map((row) => ({ ...row, name: row[labelColumn] }));
    }
    return result.rows.map((row) => {
      const raw = row[labelColumn];
      return {
        ...row,
        date: raw instanceof Date ? raw : new Date(String(raw)),
      };
    });
  }, [result.rows, labelColumn, timeSeries]);

  // Nothing numeric to plot. Degrading rather than rendering empty axes, for
  // the same reason as above: an empty chart looks like a chart that is still
  // loading, and this one never will be.
  if (series.length === 0) {
    return <CssBarChart result={result} visualization={visualization} height={height} />;
  }

  if (visualization.kind === 'bar') {
    return (
      <div style={{ height }}>
        <BarChart data={data} xDataKey="name" aspectRatio="auto" className="h-full">
          <Grid />
          <XAxis />
          {series.map((column, index) => (
            <Bar key={column} dataKey={column} fill={CHART_COLORS[index % CHART_COLORS.length]} />
          ))}
          <ChartTooltip />
        </BarChart>
      </div>
    );
  }

  if (!timeSeries) {
    return <CssBarChart result={result} visualization={visualization} height={height} />;
  }

  if (visualization.kind === 'area') {
    return (
      <div style={{ height }}>
        <AreaChart data={data} xDataKey="date" aspectRatio="auto" className="h-full">
          <Grid />
          <XAxis />
          {series.map((column, index) => (
            <Area
              key={column}
              dataKey={column}
              fill={CHART_COLORS[index % CHART_COLORS.length]}
              stroke={CHART_COLORS[index % CHART_COLORS.length]}
            />
          ))}
          <ChartTooltip />
        </AreaChart>
      </div>
    );
  }

  return (
    <div style={{ height }}>
      <LineChart data={data} xDataKey="date" aspectRatio="auto" className="h-full">
        <Grid />
        <XAxis />
        {series.map((column, index) => (
          <Line key={column} dataKey={column} stroke={CHART_COLORS[index % CHART_COLORS.length]} />
        ))}
        <ChartTooltip />
      </LineChart>
    </div>
  );
}
