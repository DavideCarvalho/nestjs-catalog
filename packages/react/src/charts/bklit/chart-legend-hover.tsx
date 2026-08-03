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
import { type ReactNode, createContext, useContext, useMemo } from 'react';

interface ChartLegendHoverContextValue {
  hoveredIndex: number | null;
  setHoveredIndex: (index: number | null) => void;
}

const ChartLegendHoverContext = createContext<ChartLegendHoverContextValue | null>(null);

export function ChartLegendHoverProvider({
  hoveredIndex,
  onHoverChange,
  children,
}: {
  hoveredIndex: number | null;
  onHoverChange: (index: number | null) => void;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ hoveredIndex, setHoveredIndex: onHoverChange }),
    [hoveredIndex, onHoverChange],
  );

  return (
    <ChartLegendHoverContext.Provider value={value}>{children}</ChartLegendHoverContext.Provider>
  );
}

export function useChartLegendHover(): ChartLegendHoverContextValue {
  const context = useContext(ChartLegendHoverContext);
  return (
    context ?? {
      hoveredIndex: null,
      setHoveredIndex: () => {
        /* noop outside ChartLegendHoverProvider */
      },
    }
  );
}
