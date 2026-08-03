'use client';

/**
 * Vendored from bklit-ui — https://github.com/bklit/bklit-ui
 * Copyright (c) 2026 uixmat. Released under the MIT licence; the full text is in
 * LICENSE-bklit at the root of this package.
 *
 * Local change: the `@/lib/utils` import was repointed at this package's own
 * `cn`, which is the same function. Nothing else is modified, so re-syncing
 * with upstream stays a diff rather than a merge.
 */
import { useSpring } from 'motion/react';
import { useMemo, useRef } from 'react';
import { useChartConfig } from './chart-config-context';
import { useChartHover, useChartStable } from './chart-context';
import { INACTIVE_SEGMENT, computeSegmentBounds } from './highlight-segment-bounds';

// Hover-highlight band for `line.tsx` and `area.tsx`. Computes the segment
// bounds and springs its x/width; `<HighlightSegment>` renders the clipped
// re-stroke. Spring tuning comes from `ChartConfigProvider.highlightSpring`.
// Stable + hover slices are read separately so callers can see the exact
// subscription surface (anything calling this hook will re-render on hover).

export interface HighlightSegmentResult {
  xSpring: ReturnType<typeof useSpring>;
  widthSpring: ReturnType<typeof useSpring>;
  isActive: boolean;
}

/**
 * @param enabled set false when there is no stroke to highlight (e.g. an area
 *   with `showLine={false}`); defaults true.
 */
export function useHighlightSegment({
  enabled = true,
}: {
  enabled?: boolean;
} = {}): HighlightSegmentResult {
  const { data, xScale, xAccessor } = useChartStable();
  const { tooltipData, selection } = useChartHover();
  const { highlightSpring } = useChartConfig();

  const bounds = useMemo(
    () =>
      enabled
        ? computeSegmentBounds(data, xScale, xAccessor, tooltipData, selection)
        : INACTIVE_SEGMENT,
    [enabled, data, xScale, xAccessor, tooltipData, selection],
  );

  const xSpring = useSpring(0, highlightSpring);
  const widthSpring = useSpring(0, highlightSpring);

  // Jump on inactive→active so the band appears at the hovered point instead
  // of sliding in from x=0; ease on subsequent moves.
  const wasActive = useRef(false);
  if (bounds.isActive && !wasActive.current) {
    xSpring.jump(bounds.x);
    widthSpring.jump(bounds.width);
  } else {
    xSpring.set(bounds.x);
    widthSpring.set(bounds.width);
  }
  wasActive.current = bounds.isActive;

  return { xSpring, widthSpring, isActive: bounds.isActive };
}
