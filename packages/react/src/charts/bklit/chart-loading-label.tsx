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
import { motion } from 'motion/react';
import { cn } from '../../cn';
import { ShimmeringText } from '../components/shimmering-text';
import {
  LINE_LOADING_PULSE_EASE,
  LOADING_LABEL_EXIT_S,
  LOADING_LABEL_EXIT_Y_PX,
} from './line-loading-timing';

export interface ChartLoadingLabelProps {
  /** Label shown centered over the chart. */
  text?: string;
  className?: string;
  /** Animate down, fade, and blur during loading → ready handoff. */
  exiting?: boolean;
}

export function ChartLoadingLabel({
  text = 'Loading',
  className,
  exiting = false,
}: ChartLoadingLabelProps) {
  if (!text.trim()) {
    return null;
  }

  return (
    <motion.div
      animate={{
        y: exiting ? LOADING_LABEL_EXIT_Y_PX : 0,
        opacity: exiting ? 0 : 1,
        filter: exiting ? 'blur(2px)' : 'blur(0px)',
      }}
      aria-live="polite"
      className={cn(
        'pointer-events-none absolute inset-0 flex items-center justify-center',
        className,
      )}
      initial={false}
      role="status"
      transition={{
        duration: LOADING_LABEL_EXIT_S,
        ease: [...LINE_LOADING_PULSE_EASE],
      }}
    >
      <ShimmeringText
        className="font-medium text-sm tracking-wide [--color:var(--muted-foreground)] [--shimmering-color:var(--foreground)]"
        text={text}
      />
    </motion.div>
  );
}

export default ChartLoadingLabel;
