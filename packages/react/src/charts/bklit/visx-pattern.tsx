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
import {
  PatternCircles as VisxPatternCircles,
  PatternHexagons as VisxPatternHexagons,
  PatternLines as VisxPatternLines,
  PatternWaves as VisxPatternWaves,
} from '@visx/pattern';
import type { ComponentProps } from 'react';

export function PatternLines(props: ComponentProps<typeof VisxPatternLines>) {
  return <VisxPatternLines {...props} />;
}
PatternLines.displayName = 'PatternLines';

export function PatternCircles(props: ComponentProps<typeof VisxPatternCircles>) {
  return <VisxPatternCircles {...props} />;
}
PatternCircles.displayName = 'PatternCircles';

export function PatternWaves(props: ComponentProps<typeof VisxPatternWaves>) {
  return <VisxPatternWaves {...props} />;
}
PatternWaves.displayName = 'PatternWaves';

export function PatternHexagons(props: ComponentProps<typeof VisxPatternHexagons>) {
  return <VisxPatternHexagons {...props} />;
}
PatternHexagons.displayName = 'PatternHexagons';
