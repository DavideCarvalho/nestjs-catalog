/**
 * Resolving `var(--…)` by hand, because a serialised SVG carries no stylesheet.
 *
 * WHY THIS EXISTS
 * ---------------
 * A chart drawn by any of the registered renderers gets its colour from CSS —
 * a class, or a custom property the console theme sets on `:root`. Serialising
 * that SVG and handing it to a canvas drops every stylesheet on the floor: the
 * markup travels, the cascade does not. The result is a black-on-transparent
 * rectangle that looks like a rendering bug rather than a missing stylesheet.
 *
 * `getComputedStyle` in a real browser substitutes custom properties before it
 * hands a value back, so most of the time reading the computed value is enough.
 * Most of the time is not always: a value can survive substitution in the
 * shorthand it came from, jsdom does not substitute at all (which is how the
 * tests for this file can be written), and a caller may want to serialise an
 * element that is not attached to a document at all. So the substitution is
 * done here rather than assumed, against a map collected from the live tree.
 *
 * The theme's variables are named explicitly instead of enumerated. A computed
 * `CSSStyleDeclaration` is not required to list custom properties — Chrome and
 * Firefox do, Safari historically did not, and jsdom does not — so enumerating
 * would work in development and quietly produce a black chart in someone's
 * browser. A named list is boring, deterministic, and extendable by the caller.
 */

/**
 * The custom properties `packages/dashboard/src/client/styles.css` sets.
 *
 * `--accent`, `--text` and `--muted` are the three a chart actually paints
 * with; the rest are here because a card's own background and hairlines are
 * drawn from them and an export that resolves the ink but not the paper is
 * half a fix. `--chart-1` through `--chart-5` are the five shadcn/ui reads.
 */
export const THEME_CUSTOM_PROPERTIES: readonly string[] = [
  '--bg',
  '--panel',
  '--line',
  '--line-soft',
  '--text',
  '--muted',
  '--accent',
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
];

/** How many substitution rounds before we assume the variables reference each other. */
const MAX_SUBSTITUTION_DEPTH = 8;

/**
 * Read the named custom properties as they cascade onto `element`.
 *
 * Starts at the element rather than at `:root` on purpose: custom properties
 * inherit, so a card that overrode `--accent` for itself is what the chart
 * inside it actually painted with, and that is what the PNG should show.
 *
 * The walk up the ancestors is not redundant with that inheritance. A browser's
 * computed style already reports an inherited custom property on the element,
 * but jsdom's does not — it only reports what matched that element directly —
 * so without the walk every one of these resolves to nothing under test and the
 * behaviour under test stops resembling the behaviour shipped. In a browser the
 * first read wins and the loop never runs a second time.
 */
export function collectCustomProperties(
  element: Element,
  names: readonly string[] = THEME_CUSTOM_PROPERTIES,
  read: (element: Element) => CSSStyleDeclaration = (target) => window.getComputedStyle(target),
): Map<string, string> {
  const values = new Map<string, string>();
  const remaining = new Set(names);

  let current: Element | null = element;
  while (current && remaining.size > 0) {
    const computed = read(current);
    for (const name of remaining) {
      const value = computed.getPropertyValue(name).trim();
      if (!value) continue;
      values.set(name, value);
      remaining.delete(name);
    }
    current = current.parentElement;
  }

  return values;
}

/** Index of the first comma that is not inside a nested function, or -1. */
function topLevelComma(value: string): number {
  let depth = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === '(') depth++;
    else if (character === ')') depth--;
    else if (character === ',' && depth === 0) return index;
  }
  return -1;
}

/** The `)` closing the `var(` that opens at `openIndex`, or -1 if unbalanced. */
function matchingParen(value: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < value.length; index++) {
    if (value[index] === '(') depth++;
    else if (value[index] === ')') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Substitute every `var(--name, fallback)` in a CSS value.
 *
 * Written as a scanner rather than a regex because the fallback is itself a
 * full CSS value and may contain both commas and further `var()` calls —
 * `var(--accent, var(--text, #fff))` is legal and a regex that handles it is
 * less readable than this. An unknown variable with no fallback resolves to the
 * empty string, which is what the cascade does, and the caller drops empty
 * declarations rather than writing `fill:` into the markup.
 */
export function resolveCssVariables(
  value: string,
  variables: ReadonlyMap<string, string>,
  depth = 0,
): string {
  if (depth >= MAX_SUBSTITUTION_DEPTH) return value;
  const start = value.indexOf('var(');
  if (start === -1) return value;

  const end = matchingParen(value, start + 3);
  if (end === -1) return value;

  const inner = value.slice(start + 4, end);
  const comma = topLevelComma(inner);
  const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
  const fallback = comma === -1 ? '' : inner.slice(comma + 1).trim();
  const substituted = variables.get(name) ?? fallback;

  const rewritten =
    value.slice(0, start) +
    resolveCssVariables(substituted, variables, depth + 1) +
    value.slice(end + 1);

  return resolveCssVariables(rewritten, variables, depth + 1);
}
