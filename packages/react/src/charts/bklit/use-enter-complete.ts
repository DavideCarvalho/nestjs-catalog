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
import type { MotionValue } from 'motion/react';
import { useEffect, useState } from 'react';

/**
 * Returns true once a mount-progress MotionValue reaches 1.
 * Use to swap animated MotionValue-driven props for static values after
 * enter completes — drops per-frame subscriptions during pan/hover.
 */
export function useEnterComplete(mountProgress: MotionValue<number>): boolean {
  const [complete, setComplete] = useState(() => mountProgress.get() >= 1);

  useEffect(() => {
    if (mountProgress.get() >= 1) {
      setComplete(true);
      return;
    }

    return mountProgress.on('change', (value) => {
      if (value >= 1) {
        setComplete(true);
      }
    });
  }, [mountProgress]);

  return complete;
}
