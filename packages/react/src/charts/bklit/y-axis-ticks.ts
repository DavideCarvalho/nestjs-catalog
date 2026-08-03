/**
 * Vendored from bklit-ui — https://github.com/bklit/bklit-ui
 * Copyright (c) 2026 uixmat. Released under the MIT licence; the full text is in
 * LICENSE-bklit at the root of this package.
 *
 * Local change: the `@/lib/utils` import was repointed at this package's own
 * `cn`, which is the same function. Nothing else is modified, so re-syncing
 * with upstream stays a diff rather than a merge.
 */
/** Default hint passed to `scale.ticks()` (d3 — approximate tick count). */
export const Y_AXIS_DEFAULT_TICK_COUNT = 5;

/** Minimum valid `numTicks` for `scale.ticks()` — values ≤ 0 yield no ticks. */
export const Y_AXIS_MIN_TICK_COUNT = 1;

/**
 * Upper bound for the tick count hint. D3 may return more "nice" ticks above ~10;
 * keeping the hint in a modest range avoids overcrowded axes.
 */
export const Y_AXIS_MAX_TICK_COUNT = 10;

/** Clamps a user `numTicks` value to a valid d3 tick-count hint. */
export function resolveYAxisTickCount(numTicks?: number): number {
  if (numTicks == null || !Number.isFinite(numTicks)) {
    return Y_AXIS_DEFAULT_TICK_COUNT;
  }
  const rounded = Math.round(numTicks);
  if (rounded < Y_AXIS_MIN_TICK_COUNT) {
    return Y_AXIS_MIN_TICK_COUNT;
  }
  if (rounded > Y_AXIS_MAX_TICK_COUNT) {
    return Y_AXIS_MAX_TICK_COUNT;
  }
  return rounded;
}
