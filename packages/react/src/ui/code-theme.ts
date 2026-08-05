import { useEffect, useState } from 'react';

/**
 * Which way round every code surface in this package should be painted.
 *
 * WHY THIS IS NOT JUST `themeType: 'system'`
 * -----------------------------------------
 * `@pierre/diffs` paints itself from a Shiki theme and takes a `themeType` of
 * `'system' | 'light' | 'dark'`, where `'system'` means `prefers-color-scheme`.
 * Everything else in this package is painted by Tailwind's `dark:` variant, and
 * Tailwind supports TWO strategies for that: `media` (which is
 * `prefers-color-scheme`, and matches `'system'`) and `class` (which is a `dark`
 * class the host toggles, and does not).
 *
 * This package ships no Tailwind config — the host owns it — so it cannot know
 * which one is in play, and guessing wrong is the failure the old Prism theme
 * had: a code box painted for one surface sitting on the other, which reads as
 * dark-on-dark rather than as a bug. So both are honoured. A `dark` class on
 * `<html>` or `<body>` is a deliberate statement and wins; with no class the
 * question falls back to the media query, which is what `'system'` already does.
 *
 * The class is watched rather than read once, because a theme toggle is a
 * runtime event and a code editor that keeps yesterday's palette until a reload
 * is the same complaint in a slower form.
 */
export type CodeThemeType = 'system' | 'light' | 'dark';

/** The class Tailwind's `class` strategy toggles, and every host that uses it toggles. */
const DARK_CLASS = 'dark';

function readThemeType(): CodeThemeType {
  if (typeof document === 'undefined') return 'system';
  const marked =
    document.documentElement.classList.contains(DARK_CLASS) ||
    document.body?.classList.contains(DARK_CLASS);
  return marked ? 'dark' : 'system';
}

export function useCodeThemeType(): CodeThemeType {
  const [themeType, setThemeType] = useState<CodeThemeType>(readThemeType);

  useEffect(() => {
    const sync = () => setThemeType(readThemeType());
    sync();
    const observer = new MutationObserver(sync);
    // `class` only. Observing everything would re-run this on every attribute
    // React writes to `<body>`, and the answer can only change with the class.
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    if (document.body) {
      observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
    return () => observer.disconnect();
  }, []);

  return themeType;
}
