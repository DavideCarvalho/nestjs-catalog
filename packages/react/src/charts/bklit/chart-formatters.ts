/**
 * Vendored from bklit-ui — https://github.com/bklit/bklit-ui
 * Copyright (c) 2026 uixmat. Released under the MIT licence; the full text is in
 * LICENSE-bklit at the root of this package.
 *
 * Local change: the `@/lib/utils` import was repointed at this package's own
 * `cn`, which is the same function. Nothing else is modified, so re-syncing
 * with upstream stays a diff rather than a merge.
 */
export const shortDateFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
});

export const weekdayDateFmt = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

export const hmsTimeFmt = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

// `Intl.NumberFormat.prototype.format` is a bound getter — safe to extract.
export const intFmt = new Intl.NumberFormat('en-US').format;
