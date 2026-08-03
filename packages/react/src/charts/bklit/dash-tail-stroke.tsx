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
import { useId } from 'react';

export interface DashTailStrokeProps {
  /** SVG path `d` for the full series (single curved path). */
  pathD: string | null;
  /** Total length of `pathD` in user units. */
  pathLength: number;
  /** Path length at which the dashed tail begins. */
  dashStartLength: number;
  /** X coordinate (chart inner space) where the tail clip begins. */
  dashStartX: number;
  innerWidth: number;
  innerHeight: number;
  /** Stroke paint — solid color or gradient url. */
  stroke: string;
  strokeWidth: number;
  dashArray: string;
}

export function DashTailStroke({
  pathD,
  pathLength,
  dashStartLength,
  dashStartX,
  innerWidth,
  innerHeight,
  stroke,
  strokeWidth,
  dashArray,
}: DashTailStrokeProps) {
  const clipPathId = useId().replace(/:/g, '');

  if (!pathD || pathLength <= 0 || dashStartLength >= pathLength) {
    return null;
  }

  const pad = strokeWidth * 2;
  const tailWidth = Math.max(0, innerWidth - dashStartX + pad);

  return (
    <>
      <defs>
        <clipPath id={clipPathId}>
          <rect
            height={innerHeight + pad}
            width={tailWidth}
            x={dashStartX - strokeWidth}
            y={-strokeWidth}
          />
        </clipPath>
      </defs>
      {/* Solid head — same curved path, gradient/fade preserved */}
      <path
        d={pathD}
        fill="none"
        stroke={stroke}
        strokeDasharray={`${dashStartLength} ${Math.max(1, pathLength - dashStartLength)}`}
        strokeLinecap="round"
        strokeWidth={strokeWidth}
      />
      {/* Dashed tail — clipped to x ≥ dashStartX so dashes follow the curve */}
      <path
        clipPath={`url(#${clipPathId})`}
        d={pathD}
        fill="none"
        stroke={stroke}
        strokeDasharray={dashArray}
        strokeLinecap="round"
        strokeWidth={strokeWidth}
      />
    </>
  );
}
