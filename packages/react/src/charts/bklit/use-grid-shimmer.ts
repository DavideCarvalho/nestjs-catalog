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
import { animate, useMotionValue, useReducedMotion, useTransform } from 'motion/react';
import { useEffect } from 'react';
import {
  LINE_LOADING_LOOP_PAUSE_MS,
  LINE_LOADING_PULSE_CYCLE_S,
  LINE_LOADING_PULSE_EASE,
} from './line-loading-timing';

export interface UseGridShimmerOptions {
  innerWidth: number;
  shimmer: boolean;
  shimmerLength: number;
  shimmerSpeed: number;
  shimmerSync: boolean;
  /** When false, shimmer animation is paused (e.g. during exit transition). */
  active: boolean;
  /** Run a single synced sweep (loading → ready handoff). */
  oneShot?: boolean;
}

export function useGridShimmer({
  innerWidth,
  shimmer,
  shimmerLength,
  shimmerSpeed,
  shimmerSync,
  active,
  oneShot = false,
}: UseGridShimmerOptions) {
  const progress = useMotionValue(0);
  const reducedMotion = useReducedMotion();
  const shimmerCycleS = LINE_LOADING_PULSE_CYCLE_S / Math.max(shimmerSpeed, 0.1);
  const shimmerEnabled = active && shimmer && reducedMotion !== true && innerWidth > 0;

  useEffect(() => {
    if (!shimmerEnabled) {
      return;
    }

    let cancelled = false;
    let timeoutId: number | undefined;
    let controls: ReturnType<typeof animate> | undefined;

    const runSyncedCycle = () => {
      if (cancelled) {
        return;
      }

      progress.set(0);
      controls = animate(progress, 1, {
        duration: shimmerCycleS,
        ease: [...LINE_LOADING_PULSE_EASE],
        onComplete: () => {
          if (cancelled) {
            return;
          }
          timeoutId = window.setTimeout(runSyncedCycle, LINE_LOADING_LOOP_PAUSE_MS);
        },
      });
    };

    if (shimmerSync && oneShot) {
      progress.set(0);
      controls = animate(progress, 1, {
        duration: shimmerCycleS / 2,
        ease: [...LINE_LOADING_PULSE_EASE],
      });
      return () => controls?.stop();
    }

    if (shimmerSync) {
      runSyncedCycle();
      return () => {
        cancelled = true;
        controls?.stop();
        if (timeoutId !== undefined) {
          window.clearTimeout(timeoutId);
        }
      };
    }

    progress.set(0);
    controls = animate(progress, 1, {
      duration: shimmerCycleS,
      repeat: Number.POSITIVE_INFINITY,
      ease: [...LINE_LOADING_PULSE_EASE],
    });

    return () => controls?.stop();
  }, [oneShot, progress, shimmerCycleS, shimmerEnabled, shimmerSync]);

  const shimmerX = useTransform(
    progress,
    (value) => -shimmerLength + value * (innerWidth + shimmerLength * 2),
  );
  const shimmerTransform = useTransform(shimmerX, (x) => `translate(${x}, 0)`);

  return { shimmerEnabled, shimmerTransform };
}
