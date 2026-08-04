import {
  THEME_CUSTOM_PROPERTIES,
  collectCustomProperties,
  resolveCssVariables,
} from './css-variables';

/**
 * Turning a live chart `<svg>` into standalone markup that renders the same.
 *
 * WHAT THE PROBLEM ACTUALLY IS
 * ----------------------------
 * `new XMLSerializer().serializeToString(chartSvg)` is one line and produces
 * something that looks right in a text editor and renders as a black shape on
 * a transparent ground in an `<img>`. Three separate reasons, and each has to
 * be fixed here because none of them is visible in the serialised string:
 *
 *   1. **The cascade does not travel.** Every colour in these charts comes from
 *      a Tailwind class or a theme custom property. The markup keeps the
 *      `class` attribute and loses the stylesheet that gave it meaning, so
 *      every `fill` falls back to its initial value, which is black.
 *   2. **Size is not in the markup.** The responsive renderers size themselves
 *      from their container and emit `width="100%"`, so the standalone document
 *      has no intrinsic size and rasterises to whatever the canvas guesses.
 *   3. **There is no background.** SVG has no page colour. A dark-theme chart
 *      serialised faithfully is light-on-transparent, which is invisible the
 *      moment it lands in a light document.
 *
 * So this module clones the element, walks the clone against the live tree
 * copying resolved presentation styles onto it, stamps an explicit size, and
 * paints a background. The source element is never touched — an export must not
 * be observable in the page it exported.
 */

/**
 * Presentation properties copied from the live tree onto the clone.
 *
 * These are the inherited ones, which is why they are separate: an inherited
 * property whose resolved value equals the parent's is not written at all,
 * because the clone inherits it too. That is not a micro-optimisation. A
 * recharts surface is several hundred elements and writing sixteen inherited
 * declarations onto every one of them produced markup large enough to matter
 * for the data URI the rasteriser then has to parse.
 */
const INHERITED_PROPERTIES: readonly string[] = [
  'color',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'letter-spacing',
  'text-anchor',
  'paint-order',
  'visibility',
];

/**
 * Non-inherited properties, each with the initial value that means "skip it".
 *
 * `clip-path`, `filter` and `mask` are here because they hold `url(#id)`
 * references. The clone carries its own `<defs>` with the same ids, so the
 * reference keeps working — dropping these is how a recharts plot area stops
 * being clipped and the line runs out over the axis.
 */
const NON_INHERITED_PROPERTIES: ReadonlyMap<string, string> = new Map([
  ['opacity', '1'],
  ['display', 'inline'],
  ['dominant-baseline', 'auto'],
  ['mix-blend-mode', 'normal'],
  ['shape-rendering', 'auto'],
  ['clip-path', 'none'],
  ['filter', 'none'],
  ['mask', 'none'],
]);

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';
/**
 * The namespace a namespace declaration itself lives in.
 *
 * `setAttribute('xmlns', …)` looks equivalent and is not: it creates a plain
 * attribute that happens to be spelled `xmlns`, and `XMLSerializer` then adds
 * the real declaration as well. Two `xmlns` attributes on one element is not
 * well-formed XML, and an `<img>` pointed at it fails to load with no useful
 * message — the export appears to hang and then produce nothing.
 */
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';

/** Values that mean "there is nothing painted here". */
const TRANSPARENT = new Set(['', 'transparent', 'rgba(0, 0, 0, 0)', 'rgba(0,0,0,0)']);

/**
 * What to paint behind the chart.
 *
 * `'auto'` walks up from the chart for the first ancestor with a background
 * colour that is actually painted, which is the card, and falls back to white
 * when nothing in the tree paints one. `'transparent'` is available and is
 * never the default: a transparent PNG of a dark-theme chart is unreadable in
 * any light document, and that failure happens after the file has left, in
 * someone else's slide deck, where nobody can connect it back to an export
 * option. Any other CSS colour string is used as given.
 */
export type ExportBackground = string;

export interface SerializeSvgOptions {
  /** @default 'auto' */
  background?: ExportBackground;
  /** Used when `background` is `'auto'` and nothing in the tree paints one. @default '#ffffff' */
  fallbackBackground?: string;
  /** Custom properties to resolve, beyond the console theme's own. */
  customProperties?: readonly string[];
  /**
   * `@font-face` CSS injected into the serialised document.
   *
   * The escape hatch for the font problem described on `svgToPngBlob`. Rules
   * here must carry their font data as `data:` URIs — the rasteriser will not
   * fetch anything.
   */
  fontFaceCss?: string;
  /** Override the measured size. Both must be given for either to apply. */
  width?: number;
  height?: number;
}

export interface SerializedSvg {
  markup: string;
  width: number;
  height: number;
}

/** A length that is a real number of pixels, or null for `100%`, `auto`, `em`… */
function parseLength(value: string | null): number | null {
  if (!value) return null;
  const match = /^\s*(-?[\d.]+)(px)?\s*$/.exec(value);
  if (!match) return null;
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseViewBox(value: string | null): { width: number; height: number } | null {
  if (!value) return null;
  const parts = value
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (parts.length !== 4) return null;
  const [, , width, height] = parts;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * How big the exported image should be, in CSS pixels.
 *
 * The laid-out box first, because that is what the reader is looking at. The
 * `width`/`height` attributes second, and the `viewBox` last — those two only
 * come up when the element has never been laid out, which is the case under
 * jsdom and for an element that was built but not mounted.
 */
export function resolveSvgSize(svg: SVGSVGElement): { width: number; height: number } {
  const rect = svg.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) return { width: rect.width, height: rect.height };

  const attributeWidth = parseLength(svg.getAttribute('width'));
  const attributeHeight = parseLength(svg.getAttribute('height'));
  if (attributeWidth !== null && attributeHeight !== null) {
    return { width: attributeWidth, height: attributeHeight };
  }

  const viewBox = parseViewBox(svg.getAttribute('viewBox'));
  if (viewBox) return viewBox;

  throw new Error(
    'Cannot export this chart: the <svg> has no laid-out size, no numeric width/height and no ' +
      'viewBox, so there is no honest size to rasterise it at. Export it after it has rendered, ' +
      'or pass an explicit width and height.',
  );
}

/**
 * The first painted background colour at or above `element`.
 *
 * Stops at `<html>`. Returns null rather than guessing so the caller can apply
 * its own documented fallback instead of this function inventing white.
 */
export function resolveAncestorBackground(
  element: Element,
  read: (target: Element) => CSSStyleDeclaration = (target) => window.getComputedStyle(target),
): string | null {
  let current: Element | null = element;
  while (current) {
    const color = read(current).getPropertyValue('background-color').trim();
    if (!TRANSPARENT.has(color)) return color;
    current = current.parentElement;
  }
  return null;
}

interface InlineContext {
  variables: ReadonlyMap<string, string>;
  read: (element: Element) => CSSStyleDeclaration;
}

/** Resolved inherited values so far, so a child can skip what it would inherit anyway. */
type Inherited = ReadonlyMap<string, string>;

/** One element's resolved value for a property, already trimmed. */
export type StyleLookup = (property: string) => string;

/**
 * The declarations one element needs, and what its children will inherit.
 *
 * Takes a lookup rather than an `Element` so the rule that decides how much
 * markup an export produces — skip an inherited value the parent already
 * declared, skip a non-inherited value that equals its initial — can be checked
 * against known inputs. Reading it out of a live tree instead would put it at
 * the mercy of whether the DOM under test implements CSS inheritance, and the
 * one these tests run against does not: every child would report no value at
 * all, the skip would never fire, and a test over a real tree would pass
 * whether or not this function did anything.
 */
export function inlineDeclarationsFor(
  read: StyleLookup,
  variables: ReadonlyMap<string, string>,
  inherited: Inherited,
): { declarations: string[]; inheritedByChildren: Map<string, string> } {
  const inheritedByChildren = new Map(inherited);
  const declarations: string[] = [];

  for (const property of INHERITED_PROPERTIES) {
    const value = resolveCssVariables(read(property), variables);
    if (!value) continue;
    inheritedByChildren.set(property, value);
    if (inherited.get(property) === value) continue;
    declarations.push(`${property}:${value}`);
  }

  for (const [property, initial] of NON_INHERITED_PROPERTIES) {
    const value = resolveCssVariables(read(property), variables);
    if (!value || value === initial) continue;
    declarations.push(`${property}:${value}`);
  }

  return { declarations, inheritedByChildren };
}

/**
 * Copy resolved presentation styles from `source` onto `clone`, depth-first.
 *
 * The two trees are walked in lockstep by index, which is sound because `clone`
 * is a deep clone of `source` and nothing has touched either since. Reading
 * from the source and writing to the clone is the whole point: the source is
 * in the document and has a cascade, the clone is detached and has none.
 */
function inlineStyles(
  source: Element,
  clone: Element,
  context: InlineContext,
  inherited: Inherited,
): void {
  const computed = context.read(source);
  const { declarations, inheritedByChildren } = inlineDeclarationsFor(
    (property) => computed.getPropertyValue(property).trim(),
    context.variables,
    inherited,
  );

  if (declarations.length > 0) {
    // Anything already inline on the clone goes last, so it still wins. It is
    // also already folded into the computed value we just read, so this is
    // belt and braces rather than a correction.
    const existing = clone.getAttribute('style');
    const own = declarations.join(';');
    clone.setAttribute('style', existing ? `${own};${existing}` : own);
  }

  const sourceChildren = source.children;
  const cloneChildren = clone.children;
  for (let index = 0; index < sourceChildren.length && index < cloneChildren.length; index++) {
    inlineStyles(sourceChildren[index], cloneChildren[index], context, inheritedByChildren);
  }
}

function cloneSvgRoot(svg: SVGSVGElement): SVGSVGElement {
  const clone = svg.cloneNode(true);
  if (!(clone instanceof SVGSVGElement)) {
    throw new Error('Cloning the chart <svg> did not produce an <svg>; refusing to export it.');
  }
  return clone;
}

/**
 * Serialise a live chart `<svg>` into a standalone, self-contained document.
 *
 * Returns the markup plus the size it was measured at, because the rasteriser
 * needs the same number and re-measuring after the clone is detached would give
 * a different one.
 */
export function serializeSvg(svg: SVGSVGElement, options: SerializeSvgOptions = {}): SerializedSvg {
  const read = (target: Element): CSSStyleDeclaration => window.getComputedStyle(target);

  const measured = resolveSvgSize(svg);
  const width =
    typeof options.width === 'number' && typeof options.height === 'number'
      ? options.width
      : measured.width;
  const height =
    typeof options.width === 'number' && typeof options.height === 'number'
      ? options.height
      : measured.height;

  const names = options.customProperties
    ? [...THEME_CUSTOM_PROPERTIES, ...options.customProperties]
    : THEME_CUSTOM_PROPERTIES;
  const variables = collectCustomProperties(svg, names, read);

  const clone = cloneSvgRoot(svg);
  inlineStyles(svg, clone, { variables, read }, new Map());

  clone.setAttributeNS(XMLNS_NAMESPACE, 'xmlns', SVG_NAMESPACE);
  clone.setAttributeNS(XMLNS_NAMESPACE, 'xmlns:xlink', XLINK_NAMESPACE);
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  if (!clone.getAttribute('viewBox')) {
    clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
  }

  // The variables themselves ride along too. Every declaration we wrote is
  // already substituted, so this is only for markup that carried its own
  // `<style>` block — a renderer is allowed to, and dropping its variables
  // would be the same black-chart failure one level down.
  //
  // Written into the style attribute as text rather than through
  // `style.setProperty`, which is the obvious call and silently does nothing
  // for custom properties in some CSSOM implementations — including the one the
  // tests run against, which is how that was found.
  if (variables.size > 0) {
    const declared = [...variables].map(([name, value]) => `${name}:${value}`).join(';');
    const existing = clone.getAttribute('style');
    clone.setAttribute('style', existing ? `${declared};${existing}` : declared);
  }

  const background = resolveBackgroundColor(svg, options, read);
  if (background) {
    const rect = clone.ownerDocument.createElementNS(SVG_NAMESPACE, 'rect');
    rect.setAttribute('x', '0');
    rect.setAttribute('y', '0');
    rect.setAttribute('width', '100%');
    rect.setAttribute('height', '100%');
    rect.setAttribute('fill', background);
    clone.insertBefore(rect, clone.firstChild);
  }

  if (options.fontFaceCss) {
    const style = clone.ownerDocument.createElementNS(SVG_NAMESPACE, 'style');
    style.textContent = options.fontFaceCss;
    clone.insertBefore(style, clone.firstChild);
  }

  return { markup: new XMLSerializer().serializeToString(clone), width, height };
}

function resolveBackgroundColor(
  svg: SVGSVGElement,
  options: SerializeSvgOptions,
  read: (target: Element) => CSSStyleDeclaration,
): string | null {
  const requested = options.background ?? 'auto';
  if (requested === 'transparent') return null;
  if (requested !== 'auto') return requested;
  return resolveAncestorBackground(svg, read) ?? options.fallbackBackground ?? '#ffffff';
}

/**
 * The serialised document as a `data:` URI an `<img>` can load.
 *
 * `encodeURIComponent` rather than `btoa`: base64 needs Latin-1 and a chart
 * with a `µ`, a `—` or any non-Latin label throws `InvalidCharacterError` in
 * the middle of an export that had nothing to do with encoding.
 */
export function svgToDataUri(markup: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}
