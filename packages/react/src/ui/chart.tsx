import * as React from 'react';
import * as RechartsPrimitive from 'recharts';
import { cn } from '../cn';

/**
 * shadcn/ui's chart primitives, vendored.
 *
 * Vendored rather than imported because that is what shadcn is — components you
 * own. A host already using shadcn gets charts that match the rest of their app
 * exactly, because this *is* the same file they have; one that is not gets
 * Recharts with a sensible wrapper.
 *
 * The part that earns its keep is `ChartStyle`: it turns a `ChartConfig` into
 * `--color-<key>` CSS variables scoped to the chart, so a series is coloured by
 * `fill="var(--color-desktop)"` rather than by an index into a palette array.
 * That means a chart keeps its colours when a series is reordered or removed,
 * which an index never survives.
 */

const THEMES = { light: '', dark: '.dark' } as const;

export type ChartConfig = {
  [k in string]: {
    label?: React.ReactNode;
    icon?: React.ComponentType;
  } & (
    | { color?: string; theme?: never }
    | { color?: never; theme: Record<keyof typeof THEMES, string> }
  );
};

type ChartContextProps = { config: ChartConfig };

const ChartContext = React.createContext<ChartContextProps | null>(null);

function useChart() {
  const context = React.useContext(ChartContext);
  if (!context) {
    throw new Error('useChart must be used within a <ChartContainer />');
  }
  return context;
}

export function ChartContainer({
  id,
  className,
  children,
  config,
  ...props
}: React.ComponentProps<'div'> & {
  config: ChartConfig;
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>['children'];
}) {
  const uniqueId = React.useId();
  const chartId = `chart-${id || uniqueId.replace(/:/g, '')}`;

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-slot="chart"
        data-chart={chartId}
        className={cn(
          'flex aspect-video justify-center text-xs',
          '[&_.recharts-cartesian-axis-tick_text]:fill-zinc-400',
          "[&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-zinc-200/50",
          '[&_.recharts-curve.recharts-tooltip-cursor]:stroke-zinc-200',
          "[&_.recharts-dot[stroke='#fff']]:stroke-transparent",
          '[&_.recharts-layer]:outline-hidden',
          '[&_.recharts-sector]:outline-hidden',
          '[&_.recharts-surface]:outline-hidden',
          "dark:[&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-zinc-800/50",
          className,
        )}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer>{children}</RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

export const ChartStyle = ({
  id,
  config,
}: {
  id: string;
  config: ChartConfig;
}) => {
  const colorConfig = Object.entries(config).filter(([, item]) => item.theme || item.color);
  if (!colorConfig.length) return null;

  return (
    <style
      // biome-ignore lint/security/noDangerouslySetInnerHtml: the only way to scope generated CSS variables to one chart instance
      dangerouslySetInnerHTML={{
        __html: Object.entries(THEMES)
          .map(
            ([theme, prefix]) => `
${prefix} [data-chart=${id}] {
${colorConfig
  .map(([key, itemConfig]) => {
    const color = itemConfig.theme?.[theme as keyof typeof itemConfig.theme] || itemConfig.color;
    return color ? `  --color-${key}: ${color};` : null;
  })
  .filter(Boolean)
  .join('\n')}
}
`,
          )
          .join('\n'),
      }}
    />
  );
};

export const ChartTooltip = RechartsPrimitive.Tooltip;

type TooltipProps = React.ComponentProps<typeof RechartsPrimitive.Tooltip>;
type TooltipPayloadItem = NonNullable<TooltipProps['payload']>[number];

/** The swatch to the left of a tooltip row — a dot, a bar, or a dashed rule. */
function ChartTooltipIndicator({
  color,
  indicator,
  nestLabel,
}: {
  color: string | undefined;
  indicator: 'line' | 'dot' | 'dashed';
  nestLabel: boolean;
}) {
  return (
    <div
      className={cn('shrink-0 rounded-[2px] border-(--color-border) bg-(--color-bg)', {
        'h-2.5 w-2.5': indicator === 'dot',
        'w-1': indicator === 'line',
        'w-0 border-[1.5px] border-dashed bg-transparent': indicator === 'dashed',
        'my-0.5': nestLabel && indicator === 'dashed',
      })}
      style={
        {
          '--color-bg': color,
          '--color-border': color,
        } as React.CSSProperties
      }
    />
  );
}

/**
 * The right-hand side of a tooltip row: the series name, then its value.
 *
 * When the tooltip holds a single non-dot series the shared label is nested in
 * here instead of sitting above the rows, so it reads as part of the one entry
 * rather than as a heading over a list of one.
 */
function ChartTooltipNameAndValue({
  name,
  value,
  nestLabel,
  tooltipLabel,
}: {
  name: React.ReactNode;
  value: TooltipPayloadItem['value'];
  nestLabel: boolean;
  tooltipLabel: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex flex-1 justify-between leading-none',
        nestLabel ? 'items-end' : 'items-center',
      )}
    >
      <div className="grid gap-1.5">
        {nestLabel ? tooltipLabel : null}
        <span className="text-zinc-500 dark:text-zinc-400">{name}</span>
      </div>
      {value !== undefined && (
        <span className="font-mono font-medium tabular-nums">
          {typeof value === 'number' ? value.toLocaleString() : String(value)}
        </span>
      )}
    </div>
  );
}

/**
 * One series inside the tooltip: swatch, name, value.
 *
 * A caller's `formatter` replaces the whole row rather than any part of it,
 * which is why it short-circuits everything below it.
 */
function ChartTooltipRow({
  item,
  index,
  config,
  color,
  formatter,
  indicator,
  hideIndicator,
  nestLabel,
  nameKey,
  tooltipLabel,
}: {
  item: TooltipPayloadItem;
  index: number;
  config: ChartConfig;
  color: string | undefined;
  formatter: TooltipProps['formatter'];
  indicator: 'line' | 'dot' | 'dashed';
  hideIndicator: boolean;
  nestLabel: boolean;
  nameKey: string | undefined;
  tooltipLabel: React.ReactNode;
}) {
  const key = `${nameKey || item.name || item.dataKey || 'value'}`;
  const itemConfig = getPayloadConfigFromPayload(config, item, key);
  const indicatorColor = color || item.payload?.fill || item.color;

  return (
    <div
      className={cn(
        'flex w-full flex-wrap items-stretch gap-2',
        '[&>svg]:h-2.5 [&>svg]:w-2.5 [&>svg]:text-zinc-400',
        indicator === 'dot' && 'items-center',
      )}
    >
      {formatter && item?.value !== undefined && item.name ? (
        formatter(item.value, item.name, item, index, item.payload)
      ) : (
        <>
          {itemConfig?.icon ? (
            <itemConfig.icon />
          ) : (
            !hideIndicator && (
              <ChartTooltipIndicator
                color={indicatorColor}
                indicator={indicator}
                nestLabel={nestLabel}
              />
            )
          )}
          <ChartTooltipNameAndValue
            name={itemConfig?.label || item.name}
            value={item.value}
            nestLabel={nestLabel}
            tooltipLabel={tooltipLabel}
          />
        </>
      )}
    </div>
  );
}

export function ChartTooltipContent({
  active,
  payload,
  className,
  indicator = 'dot',
  hideLabel = false,
  hideIndicator = false,
  label,
  labelFormatter,
  labelClassName,
  formatter,
  color,
  nameKey,
  labelKey,
}: React.ComponentProps<typeof RechartsPrimitive.Tooltip> &
  React.ComponentProps<'div'> & {
    hideLabel?: boolean;
    hideIndicator?: boolean;
    indicator?: 'line' | 'dot' | 'dashed';
    nameKey?: string;
    labelKey?: string;
  }) {
  const { config } = useChart();

  const tooltipLabel = React.useMemo(() => {
    if (hideLabel || !payload?.length) return null;
    const [item] = payload;
    const key = `${labelKey || item?.dataKey || item?.name || 'value'}`;
    const itemConfig = getPayloadConfigFromPayload(config, item, key);
    const value =
      !labelKey && typeof label === 'string'
        ? config[label as keyof typeof config]?.label || label
        : itemConfig?.label;

    if (labelFormatter) {
      return (
        <div className={cn('font-medium', labelClassName)}>{labelFormatter(value, payload)}</div>
      );
    }
    if (!value) return null;
    return <div className={cn('font-medium', labelClassName)}>{value}</div>;
  }, [label, labelFormatter, payload, hideLabel, labelClassName, config, labelKey]);

  if (!active || !payload?.length) return null;

  const nestLabel = payload.length === 1 && indicator !== 'dot';

  return (
    <div
      className={cn(
        'grid min-w-[8rem] items-start gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs shadow-xl',
        'dark:border-zinc-800 dark:bg-zinc-900',
        className,
      )}
    >
      {!nestLabel ? tooltipLabel : null}
      <div className="grid gap-1.5">
        {payload.map((item, index) => (
          <ChartTooltipRow
            key={item.dataKey ?? index}
            item={item}
            index={index}
            config={config}
            color={color}
            formatter={formatter}
            indicator={indicator}
            hideIndicator={hideIndicator}
            nestLabel={nestLabel}
            nameKey={nameKey}
            tooltipLabel={tooltipLabel}
          />
        ))}
      </div>
    </div>
  );
}

export const ChartLegend = RechartsPrimitive.Legend;

export function ChartLegendContent({
  className,
  hideIcon = false,
  payload,
  verticalAlign = 'bottom',
  nameKey,
}: React.ComponentProps<'div'> &
  Pick<RechartsPrimitive.LegendProps, 'payload' | 'verticalAlign'> & {
    hideIcon?: boolean;
    nameKey?: string;
  }) {
  const { config } = useChart();
  if (!payload?.length) return null;

  return (
    <div
      className={cn(
        'flex items-center justify-center gap-4',
        verticalAlign === 'top' ? 'pb-3' : 'pt-3',
        className,
      )}
    >
      {payload.map((item) => {
        const key = `${nameKey || item.dataKey || 'value'}`;
        const itemConfig = getPayloadConfigFromPayload(config, item, key);
        return (
          <div
            key={String(item.value)}
            className="flex items-center gap-1.5 [&>svg]:h-3 [&>svg]:w-3 [&>svg]:text-zinc-400"
          >
            {itemConfig?.icon && !hideIcon ? (
              <itemConfig.icon />
            ) : (
              <div
                className="h-2 w-2 shrink-0 rounded-[2px]"
                style={{ backgroundColor: item.color }}
              />
            )}
            {itemConfig?.label}
          </div>
        );
      })}
    </div>
  );
}

/** Recharts payload items are loosely shaped; this digs the config key out safely. */
function getPayloadConfigFromPayload(config: ChartConfig, payload: unknown, key: string) {
  if (typeof payload !== 'object' || payload === null) return undefined;

  const payloadPayload =
    'payload' in payload && typeof payload.payload === 'object' && payload.payload !== null
      ? payload.payload
      : undefined;

  let configLabelKey: string = key;
  if (key in payload && typeof payload[key as keyof typeof payload] === 'string') {
    configLabelKey = payload[key as keyof typeof payload] as string;
  } else if (
    payloadPayload &&
    key in payloadPayload &&
    typeof payloadPayload[key as keyof typeof payloadPayload] === 'string'
  ) {
    configLabelKey = payloadPayload[key as keyof typeof payloadPayload] as string;
  }

  return configLabelKey in config ? config[configLabelKey] : config[key];
}
