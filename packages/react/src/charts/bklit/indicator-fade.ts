/**
 * Vendored from bklit-ui — https://github.com/bklit/bklit-ui
 * Copyright (c) 2026 uixmat. Released under the MIT licence; the full text is in
 * LICENSE-bklit at the root of this package.
 *
 * Local change: the `@/lib/utils` import was repointed at this package's own
 * `cn`, which is the same function. Nothing else is modified, so re-syncing
 * with upstream stays a diff rather than a merge.
 */
/** Vertical fade on the tooltip crosshair indicator. */
export type IndicatorFadeEdges = 'both' | 'none' | 'top' | 'bottom';

export interface VerticalFadeSides {
  top: boolean;
  bottom: boolean;
  any: boolean;
}

export function resolveVerticalFadeSides(fade: IndicatorFadeEdges | boolean): VerticalFadeSides {
  if (fade === false || fade === 'none') {
    return { top: false, bottom: false, any: false };
  }
  if (fade === true || fade === 'both') {
    return { top: true, bottom: true, any: true };
  }
  if (fade === 'top') {
    return { top: true, bottom: false, any: true };
  }
  return { top: false, bottom: true, any: true };
}

export interface IndicatorFadeGradientStop {
  offset: string;
  opacity: number;
}

/** Opacity stops for the crosshair vertical gradient. */
export function indicatorFadeGradientStops(
  sides: VerticalFadeSides,
  fadeLengthPercent = 10,
): IndicatorFadeGradientStop[] {
  const fade = Math.min(40, Math.max(2, fadeLengthPercent));
  const innerEnd = 100 - fade;

  if (!sides.any) {
    return [{ offset: '0%', opacity: 1 }];
  }

  if (sides.top && sides.bottom) {
    return [
      { offset: '0%', opacity: 0 },
      { offset: `${fade}%`, opacity: 1 },
      { offset: '50%', opacity: 1 },
      { offset: `${innerEnd}%`, opacity: 1 },
      { offset: '100%', opacity: 0 },
    ];
  }

  if (sides.top) {
    return [
      { offset: '0%', opacity: 0 },
      { offset: `${fade}%`, opacity: 1 },
      { offset: '100%', opacity: 1 },
    ];
  }

  return [
    { offset: '0%', opacity: 1 },
    { offset: `${innerEnd}%`, opacity: 1 },
    { offset: '100%', opacity: 0 },
  ];
}
