import type { QueryVisualization } from '@dudousxd/nestjs-catalog/client';
import type { ReactNode } from 'react';
import { cn } from '../cn';

/**
 * The chart that is coming, drawn in grey.
 *
 * One skeleton shared by every renderer rather than one per renderer, and the
 * reason is that a skeleton describes the *shape of the visualization*, not the
 * library that will draw it: bars are bars whether Recharts or anything else
 * ends up placing them. Per-renderer skeletons would drift — the day somebody
 * tightens the spacing in one, the dashboard loads unevenly depending on which
 * library each card happens to name, and nobody would ever look there for it.
 *
 * The one exception is a renderer that ships its own loading state as part of
 * its own animation vocabulary; that renderer should use its own, because a
 * generic pulse handing over to a bespoke sweep looks like two different things
 * loading.
 *
 * Two rules this must not break:
 *
 * 1. It occupies exactly the space the real chart will. The renderers take a
 *    `height` and default to 220, so this takes the same one and defaults the
 *    same way. A skeleton of a different height is a layout shift the moment
 *    data lands, and on a dashboard of several cards that is the whole grid
 *    jumping under somebody's cursor.
 * 2. It animates only for people who did not ask for less motion. The pulse is
 *    behind `motion-safe:`, which is a core Tailwind variant rather than a
 *    plugin — the placeholder stays, the movement goes.
 */
export interface ChartSkeletonProps {
  kind: QueryVisualization['kind'];
  /** Must match what the real renderer will be given. */
  height?: number;
  /** How many bars or points to suggest. Only affects the drawing. */
  points?: number;
  className?: string;
}

/** Deterministic, so the skeleton does not reshuffle on every render. */
function heights(count: number): number[] {
  const pattern = [0.55, 0.8, 0.42, 0.95, 0.62, 0.74, 0.35, 0.86, 0.5, 0.68];
  return Array.from({ length: count }, (_, index) => pattern[index % pattern.length]);
}

const BAR = 'bg-zinc-200 dark:bg-zinc-800';
const RAIL = 'bg-zinc-100 dark:bg-zinc-900';
const PULSE = 'motion-safe:animate-pulse';

export function ChartSkeleton({ kind, height = 220, points = 8, className }: ChartSkeletonProps) {
  // A table is not a chart and must not be given a chart's silhouette — a
  // reader who sees bars appear and then a table has been told something wrong.
  if (kind === 'table') {
    return (
      <div
        style={{ height }}
        className={cn('flex flex-col gap-1.5 overflow-hidden', PULSE, className)}
        aria-hidden
      >
        <div className={cn('h-5 w-full rounded-sm', BAR)} />
        {heights(6).map((width, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have no identity
            key={index}
            className={cn('h-4 rounded-sm', RAIL)}
            style={{ width: `${70 + width * 30}%` }}
          />
        ))}
      </div>
    );
  }

  // A single number is a block of text, so its placeholder is a block of text —
  // sized to where the digits will actually sit rather than centred in a box
  // the real value will not fill the same way.
  if (kind === 'number') {
    return (
      <div
        style={{ height }}
        className={cn('flex flex-col items-center justify-center gap-3', PULSE, className)}
        aria-hidden
      >
        <div className={cn('h-10 w-32 rounded-md', BAR)} />
        <div className={cn('h-3 w-20 rounded-sm', RAIL)} />
      </div>
    );
  }

  if (kind === 'bar') {
    return (
      <Frame height={height} className={className}>
        <div className="flex h-full items-end gap-2">
          {heights(points).map((fraction, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholder bars have no identity
              key={index}
              className={cn('flex-1 rounded-t-sm', BAR)}
              style={{ height: `${fraction * 100}%` }}
            />
          ))}
        </div>
      </Frame>
    );
  }

  // Line and area share a silhouette, because they are the same shape with and
  // without a fill under it — which is exactly the difference drawn here.
  const filled = kind === 'area';
  const path = heights(points)
    .map((fraction, index) => {
      const x = (index / (points - 1)) * 100;
      const y = 100 - fraction * 100;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <Frame height={height} className={className}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full" aria-hidden>
        <title>Loading</title>
        {filled && (
          <path
            d={`${path} L100,100 L0,100 Z`}
            className="fill-zinc-200/70 dark:fill-zinc-800/70"
          />
        )}
        <path
          d={path}
          fill="none"
          // `vectorEffect` keeps the stroke one pixel wide despite the viewBox
          // being stretched by `preserveAspectRatio="none"`. Without it, a wide
          // card draws a hairline and a narrow one draws a slab.
          vectorEffect="non-scaling-stroke"
          strokeWidth={2}
          className="stroke-zinc-300 dark:stroke-zinc-700"
        />
      </svg>
    </Frame>
  );
}

/**
 * The axis rails and the plot area, which every non-table chart has.
 *
 * Drawn rather than left blank because they are most of what makes a loading
 * card read as a chart rather than as a box that failed to render.
 */
function Frame({
  height,
  className,
  children,
}: {
  height: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div style={{ height }} className={cn('flex flex-col', PULSE, className)} aria-hidden>
      <div className="flex min-h-0 flex-1 gap-2">
        {/* The y rail: four ticks, because a chart with none reads as an image. */}
        <div className="flex w-8 shrink-0 flex-col justify-between py-1">
          {[0, 1, 2, 3].map((tick) => (
            <div key={tick} className={cn('h-2 w-full rounded-sm', RAIL)} />
          ))}
        </div>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
      <div className={cn('mt-2 h-px w-full', BAR)} />
      <div className="mt-1.5 flex justify-between">
        {[0, 1, 2, 3, 4].map((tick) => (
          <div key={tick} className={cn('h-2 w-8 rounded-sm', RAIL)} />
        ))}
      </div>
    </div>
  );
}

/**
 * What a card shows when the query finished and there was nothing to draw.
 *
 * Beside the skeleton, in the same file, because the bug this pair exists to
 * prevent is the one where they are confused: a query that returned no rows is
 * not loading, and leaving it under a placeholder means a chart that will never
 * arrive looks like a chart that is about to. This project treats a failure
 * that looks like something else as its worst class of bug.
 */
export function ChartEmpty({
  height = 220,
  message = 'The query ran and matched nothing.',
}: {
  height?: number;
  message?: string;
}) {
  return (
    <div
      style={{ height }}
      className="flex items-center justify-center px-4 text-center text-xs text-zinc-400 dark:text-zinc-500"
    >
      {message}
    </div>
  );
}

/** And what it shows when the query failed, which is not the same thing at all. */
export function ChartFailed({
  height = 220,
  message,
  onRetry,
}: {
  height?: number;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      style={{ height }}
      className="flex flex-col items-center justify-center gap-2 px-4 text-center"
    >
      <p className="font-mono text-[11px] leading-relaxed text-red-600 dark:text-red-400">
        {message}
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-red-300 px-2.5 py-1 text-[11px] text-red-700 dark:border-red-800 dark:text-red-300"
        >
          Try again
        </button>
      )}
    </div>
  );
}
