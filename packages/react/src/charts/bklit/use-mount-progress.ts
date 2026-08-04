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
import { type Transition, animate, useMotionValue } from 'motion/react';
import { useEffect, useRef } from 'react';
import { DEFAULT_CHART_ENTER_TRANSITION } from './animation';

/** Drives 0→1 enter progress using the studio motion transition (spring or tween). */
export function useMountProgress(
  enterTransition: Transition | undefined,
  delaySeconds: number,
  replayKey: number | string,
) {
  const progress = useMotionValue(0);
  const transitionRef = useRef(enterTransition);
  transitionRef.current = enterTransition;

  // replayKey intentionally retriggers enter when motion settings change
  useEffect(() => {
    progress.set(0);
    const controls = animate(progress, 1, {
      ...(transitionRef.current ?? DEFAULT_CHART_ENTER_TRANSITION),
      delay: delaySeconds,
    });
    return () => controls.stop();
  }, [delaySeconds, replayKey, progress]);

  return progress;
}
