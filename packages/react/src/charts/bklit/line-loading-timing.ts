/**
 * Vendored from bklit-ui — https://github.com/bklit/bklit-ui
 * Copyright (c) 2026 uixmat. Released under the MIT licence; the full text is in
 * LICENSE-bklit at the root of this package.
 *
 * Local change: the `@/lib/utils` import was repointed at this package's own
 * `cn`, which is the same function. Nothing else is modified, so re-syncing
 * with upstream stays a diff rather than a merge.
 */
/** Grow + exit timeline for `LineLoadingPulse` (seconds). */
export const LINE_LOADING_PULSE_CYCLE_S = 2.2;

/** Idle gap before the loading line pulse restarts (milliseconds). */
export const LINE_LOADING_LOOP_PAUSE_MS = 280;

/** Loading label exit on loading → ready (seconds). */
export const LOADING_LABEL_EXIT_S = 0.45;

/** Loading label drops this many pixels while exiting. */
export const LOADING_LABEL_EXIT_Y_PX = 30;

export const LINE_LOADING_PULSE_EASE = [0.85, 0, 0.15, 1] as const;
