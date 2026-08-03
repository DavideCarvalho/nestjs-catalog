import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from 'recharts';
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '../ui/chart';
import { type ChartRendererProps, seriesFrom } from './registry';

/**
 * The shadcn/ui chart renderer.
 *
 * Not "Recharts with our own styling" — the actual shadcn chart primitives,
 * vendored in `../ui/chart`. A host already using shadcn gets charts that match
 * the rest of their app because it is the same component they have.
 *
 * Series are coloured through `var(--color-<key>)`, which `ChartContainer`
 * emits from the config. That is worth the indirection: a colour bound to a key
 * survives a series being reordered or dropped, and an index into a palette
 * array does not.
 *
 * ```tsx
 * import { registerChartRenderer } from "@dudousxd/nestjs-catalog-react";
 * import { ShadcnChartRenderer } from "@dudousxd/nestjs-catalog-react/recharts";
 * registerChartRenderer("shadcn", ShadcnChartRenderer);
 * ```
 *
 * Every axis, grid and legend below is written out per chart rather than shared
 * through a variable. Recharts finds them by walking its *direct* children, so
 * a fragment becomes one child it does not recognise — the chart still draws
 * its series and silently loses its axes, which reads as a styling problem and
 * is not.
 */
export function ShadcnChartRenderer({ result, visualization, height = 220 }: ChartRendererProps) {
  const { labelColumn, valueColumns, data } = seriesFrom(result, visualization);

  // The five `--chart-*` variables shadcn's own charts use, so a host that
  // themed them once gets these for free.
  const config: ChartConfig = Object.fromEntries(
    valueColumns.map((column, index) => [
      column,
      { label: column, color: `var(--chart-${(index % 5) + 1})` },
    ]),
  );

  const axis = { tickLine: false, axisLine: false, tickMargin: 8 } as const;
  const style = { height } as const;

  if (visualization.kind === 'line') {
    return (
      <ChartContainer config={config} className="aspect-auto w-full" style={style}>
        <LineChart data={data} margin={{ top: 4, right: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey={labelColumn} {...axis} />
          <YAxis width={44} {...axis} />
          <ChartTooltip content={<ChartTooltipContent />} />
          {valueColumns.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
          {valueColumns.map((column) => (
            <Line
              key={column}
              type="monotone"
              dataKey={column}
              stroke={`var(--color-${column})`}
              strokeWidth={2}
              dot={false}
            />
          ))}
        </LineChart>
      </ChartContainer>
    );
  }

  if (visualization.kind === 'area') {
    return (
      <ChartContainer config={config} className="aspect-auto w-full" style={style}>
        <AreaChart data={data} margin={{ top: 4, right: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey={labelColumn} {...axis} />
          <YAxis width={44} {...axis} />
          <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
          {valueColumns.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
          {valueColumns.map((column) => (
            <Area
              key={column}
              type="monotone"
              dataKey={column}
              stroke={`var(--color-${column})`}
              fill={`var(--color-${column})`}
              fillOpacity={0.18}
              strokeWidth={2}
            />
          ))}
        </AreaChart>
      </ChartContainer>
    );
  }

  return (
    <ChartContainer config={config} className="aspect-auto w-full" style={style}>
      <BarChart data={data} margin={{ top: 4, right: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey={labelColumn} {...axis} />
        <YAxis width={44} {...axis} />
        <ChartTooltip content={<ChartTooltipContent />} />
        {valueColumns.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
        {valueColumns.map((column) => (
          <Bar
            key={column}
            dataKey={column}
            fill={`var(--color-${column})`}
            radius={[3, 3, 0, 0]}
          />
        ))}
      </BarChart>
    </ChartContainer>
  );
}

/** The name this shipped under before it used the shadcn primitives. */
export { ShadcnChartRenderer as RechartsRenderer };
