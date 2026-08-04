// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * The serialisation half of PNG export, which is the half that can be tested here.
 *
 * WHAT jsdom CAN AND CANNOT DO, MEASURED RATHER THAN ASSUMED
 * ---------------------------------------------------------
 * Can: parse a stylesheet and resolve `fill` and `stroke-width` through a class selector; report a
 * custom property declared on the element the rule matched; serialise an SVG subtree with
 * `XMLSerializer`; parse the result back with `DOMParser` — which is what lets the well-formedness
 * test below stand in for the `<img>` load that cannot happen here.
 *
 * Cannot: lay anything out — `getBoundingClientRect()` is all zeros for every element, which is
 * why `resolveSvgSize` has attribute and viewBox fallbacks and why they are what these tests
 * exercise. Cannot handle `var()` in a property value at all: its CSS parser treats
 * `fill: var(--accent)` as invalid and drops the declaration, so an end-to-end substitution test
 * is impossible here and `resolveCssVariables` is unit-tested directly instead. Does not inherit
 * custom properties down the tree the way a browser does, which is why `collectCustomProperties`
 * walks ancestors. Cannot rasterise at all: `canvas.getContext('2d')` returns null and
 * `URL.createObjectURL` does not exist.
 *
 * So there is no test below that asserts anything about pixels, and there is deliberately no
 * mocked canvas. A fake `getContext` returning a fake `drawImage` would assert that this file
 * calls the methods it obviously calls, while proving nothing about whether the resulting image
 * has the right colours in it — which is the only question that matters and the one only a real
 * browser can answer. The rasterisation step is covered by exactly one test: that it fails loudly
 * and legibly when there is no canvas, which is a real path a consumer can hit.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCssVariables } from './css-variables';
import { findExportableSvg, resolveScale, svgToPngBlob } from './png';
import {
  inlineDeclarationsFor,
  resolveAncestorBackground,
  resolveSvgSize,
  serializeSvg,
  svgToDataUri,
} from './serialize';

const SVG_NS = 'http://www.w3.org/2000/svg';

function makeSvg(attributes: Record<string, string> = {}): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [key, value] of Object.entries(attributes)) svg.setAttribute(key, value);
  if (!(svg instanceof SVGSVGElement)) throw new Error('jsdom did not produce an SVGSVGElement');
  return svg;
}

function child(parent: Element, name: string, attributes: Record<string, string> = {}): Element {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  parent.appendChild(element);
  return element;
}

function styleSheet(css: string): void {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
}

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('resolveCssVariables', () => {
  const vars = new Map([
    ['--accent', '#38bdf8'],
    ['--text', '#e7e7ea'],
  ]);

  it('substitutes a variable the theme defines', () => {
    expect(resolveCssVariables('var(--accent)', vars)).toBe('#38bdf8');
  });

  it('substitutes a variable inside a larger value', () => {
    expect(resolveCssVariables('1px solid var(--accent)', vars)).toBe('1px solid #38bdf8');
  });

  it('substitutes every occurrence, not only the first', () => {
    expect(resolveCssVariables('var(--accent) var(--text)', vars)).toBe('#38bdf8 #e7e7ea');
  });

  it('uses the fallback when the variable is undefined', () => {
    expect(resolveCssVariables('var(--nope, #ff0000)', vars)).toBe('#ff0000');
  });

  it('resolves a variable nested in a fallback', () => {
    expect(resolveCssVariables('var(--nope, var(--accent))', vars)).toBe('#38bdf8');
  });

  it('resolves to empty when the variable is undefined and there is no fallback', () => {
    expect(resolveCssVariables('var(--nope)', vars)).toBe('');
  });

  it('keeps a fallback containing commas intact', () => {
    expect(resolveCssVariables('var(--nope, rgba(1, 2, 3, 0.5))', vars)).toBe('rgba(1, 2, 3, 0.5)');
  });

  it('leaves a value with no variables untouched', () => {
    expect(resolveCssVariables('rgb(1, 2, 3)', vars)).toBe('rgb(1, 2, 3)');
  });

  it('terminates on a variable that refers to itself', () => {
    const cyclic = new Map([['--a', 'var(--a)']]);
    expect(() => resolveCssVariables('var(--a)', cyclic)).not.toThrow();
  });
});

describe('resolveSvgSize', () => {
  it('reads numeric width and height attributes when there is no layout', () => {
    expect(resolveSvgSize(makeSvg({ width: '480', height: '240' }))).toEqual({
      width: 480,
      height: 240,
    });
  });

  it('accepts px-suffixed attributes', () => {
    expect(resolveSvgSize(makeSvg({ width: '480px', height: '240px' }))).toEqual({
      width: 480,
      height: 240,
    });
  });

  it('falls through a percentage width to the viewBox', () => {
    const svg = makeSvg({ width: '100%', height: '100%', viewBox: '0 0 600 300' });
    expect(resolveSvgSize(svg)).toEqual({ width: 600, height: 300 });
  });

  it('reads a comma-separated viewBox', () => {
    expect(resolveSvgSize(makeSvg({ viewBox: '0,0,600,300' }))).toEqual({
      width: 600,
      height: 300,
    });
  });

  it('throws a legible error when there is no size anywhere', () => {
    expect(() => resolveSvgSize(makeSvg({ width: '100%' }))).toThrow(/no honest size/);
  });
});

describe('inlineDeclarationsFor', () => {
  // Driven by a lookup rather than a real element on purpose. The rule under test is "skip what
  // the child would inherit anyway", and jsdom does not implement CSS inheritance at all — over a
  // live tree every child reports no value, nothing is ever written, and the test would pass with
  // this function gutted. That was not hypothetical: the earlier version of this test did exactly
  // that and survived deleting the skip.
  const noVariables = new Map<string, string>();
  const lookup =
    (values: Record<string, string>): ((property: string) => string) =>
    (property) =>
      values[property] ?? '';

  it('writes an inherited property the parent did not already declare', () => {
    const { declarations } = inlineDeclarationsFor(
      lookup({ fill: '#38bdf8' }),
      noVariables,
      new Map(),
    );
    expect(declarations).toContain('fill:#38bdf8');
  });

  it('skips an inherited property whose value the child would inherit anyway', () => {
    const { declarations } = inlineDeclarationsFor(
      lookup({ fill: '#38bdf8' }),
      noVariables,
      new Map([['fill', '#38bdf8']]),
    );
    expect(declarations).not.toContain('fill:#38bdf8');
  });

  it('writes an inherited property the child actually overrides', () => {
    const { declarations } = inlineDeclarationsFor(
      lookup({ fill: '#f43f5e' }),
      noVariables,
      new Map([['fill', '#38bdf8']]),
    );
    expect(declarations).toContain('fill:#f43f5e');
  });

  it('passes its own resolved values down to its children', () => {
    const { inheritedByChildren } = inlineDeclarationsFor(
      lookup({ fill: '#38bdf8', 'font-size': '11px' }),
      noVariables,
      new Map([['stroke', '#000']]),
    );
    expect(inheritedByChildren.get('fill')).toBe('#38bdf8');
    expect(inheritedByChildren.get('font-size')).toBe('11px');
    // And keeps what it inherited but did not restate.
    expect(inheritedByChildren.get('stroke')).toBe('#000');
  });

  it('substitutes a custom property while inlining', () => {
    const { declarations } = inlineDeclarationsFor(
      lookup({ fill: 'var(--accent)' }),
      new Map([['--accent', '#38bdf8']]),
      new Map(),
    );
    expect(declarations).toContain('fill:#38bdf8');
  });

  it('skips a non-inherited property that is already at its initial value', () => {
    const { declarations } = inlineDeclarationsFor(
      lookup({ opacity: '1', display: 'inline' }),
      noVariables,
      new Map(),
    );
    expect(declarations).toEqual([]);
  });

  it('writes a non-inherited property that is not at its initial value', () => {
    const { declarations } = inlineDeclarationsFor(
      lookup({ opacity: '0.4', 'clip-path': 'url(#plot)' }),
      noVariables,
      new Map(),
    );
    expect(declarations).toContain('opacity:0.4');
    // The recharts plot clip. Dropping it is how a line runs out over its own axis.
    expect(declarations).toContain('clip-path:url(#plot)');
  });

  it('never writes a non-inherited property against the parent, which does not inherit it', () => {
    const { declarations } = inlineDeclarationsFor(
      lookup({ opacity: '0.4' }),
      noVariables,
      new Map([['opacity', '0.4']]),
    );
    expect(declarations).toContain('opacity:0.4');
  });
});

describe('resolveAncestorBackground', () => {
  it('finds the nearest painted background above the chart', () => {
    document.body.innerHTML = '<div id="card"><div id="inner"></div></div>';
    styleSheet('#card { background-color: rgb(12, 12, 15); }');
    const inner = document.getElementById('inner');
    if (!inner) throw new Error('fixture missing');
    expect(resolveAncestorBackground(inner)).toBe('rgb(12, 12, 15)');
  });

  it('returns null when nothing in the tree paints one', () => {
    document.body.innerHTML = '<div id="inner"></div>';
    const inner = document.getElementById('inner');
    if (!inner) throw new Error('fixture missing');
    expect(resolveAncestorBackground(inner)).toBeNull();
  });
});

describe('serializeSvg', () => {
  it('inlines a fill that only a stylesheet class knew about', () => {
    styleSheet('.bar { fill: #38bdf8; }');
    const svg = makeSvg({ width: '400', height: '200' });
    child(svg, 'rect', { class: 'bar' });
    document.body.appendChild(svg);

    expect(serializeSvg(svg).markup).toContain('fill:#38bdf8');
  });

  // The end-to-end case — a class whose `fill` is `var(--accent)` — cannot be written here:
  // jsdom's CSS parser rejects `fill: var(--accent)` as an invalid value and drops the whole
  // declaration, so `getComputedStyle` reports no fill at all rather than an unsubstituted one.
  // The substitution itself is unit-tested against `resolveCssVariables` above. What IS testable
  // end to end is that the theme's variables travel with the clone, which is what keeps a
  // renderer's own inline `<style>` block from resolving to nothing.
  it('carries the theme custom properties onto the serialised root', () => {
    styleSheet(':root { --accent: #38bdf8; --text: #e7e7ea; }');
    const svg = makeSvg({ width: '400', height: '200' });
    document.body.appendChild(svg);

    const { markup } = serializeSvg(svg);
    expect(markup).toContain('--accent:#38bdf8');
    expect(markup).toContain('--text:#e7e7ea');
  });

  it('produces well-formed XML, which is all an <img> will agree to load', () => {
    styleSheet('.bar { fill: #38bdf8; }');
    const svg = makeSvg({ width: '400', height: '200' });
    child(svg, 'rect', { class: 'bar' });
    document.body.appendChild(svg);

    const { markup } = serializeSvg(svg);
    const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
    expect(parsed.querySelector('parsererror')).toBeNull();
  });

  it('declares the SVG namespace exactly once', () => {
    // Twice is not well-formed, and the only symptom is an <img> that never fires `load`.
    const svg = makeSvg({ width: '400', height: '200' });
    document.body.appendChild(svg);
    expect(
      serializeSvg(svg).markup.match(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g),
    ).toHaveLength(1);
  });

  it('leaves the live chart untouched', () => {
    styleSheet('.bar { fill: #38bdf8; }');
    const svg = makeSvg({ width: '400', height: '200' });
    const rect = child(svg, 'rect', { class: 'bar' });
    document.body.appendChild(svg);

    serializeSvg(svg);

    expect(rect.getAttribute('style')).toBeNull();
    expect(svg.getAttribute('viewBox')).toBeNull();
    expect(svg.querySelector('rect[width="100%"]')).toBeNull();
  });

  it('lets an existing inline style win over the computed one', () => {
    styleSheet('.bar { fill: #38bdf8; }');
    const svg = makeSvg({ width: '400', height: '200' });
    const rect = child(svg, 'rect', { class: 'bar' });
    rect.setAttribute('style', 'fill: rgb(9, 9, 9)');
    document.body.appendChild(svg);

    const { markup } = serializeSvg(svg);
    expect(markup.indexOf('fill:#38bdf8')).toBeLessThan(markup.indexOf('fill: rgb(9, 9, 9)'));
  });

  it('stamps an explicit size and a viewBox so the standalone document has one', () => {
    const svg = makeSvg({ width: '100%', height: '100%', viewBox: '0 0 600 300' });
    document.body.appendChild(svg);

    const result = serializeSvg(svg);
    expect(result).toMatchObject({ width: 600, height: 300 });
    expect(result.markup).toContain('width="600"');
    expect(result.markup).toContain('height="300"');
  });

  it('derives a viewBox when the element had none', () => {
    const svg = makeSvg({ width: '400', height: '200' });
    document.body.appendChild(svg);
    expect(serializeSvg(svg).markup).toContain('viewBox="0 0 400 200"');
  });

  it('carries the SVG namespace, which a detached clone needs to load as an image', () => {
    const svg = makeSvg({ width: '400', height: '200' });
    document.body.appendChild(svg);
    expect(serializeSvg(svg).markup).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('paints the card background behind the chart by default', () => {
    document.body.innerHTML = '<div id="card"></div>';
    styleSheet('#card { background-color: rgb(12, 12, 15); }');
    const card = document.getElementById('card');
    if (!card) throw new Error('fixture missing');
    const svg = makeSvg({ width: '400', height: '200' });
    card.appendChild(svg);

    expect(serializeSvg(svg).markup).toContain('fill="rgb(12, 12, 15)"');
  });

  it('falls back to white rather than shipping a transparent PNG', () => {
    const svg = makeSvg({ width: '400', height: '200' });
    document.body.appendChild(svg);
    expect(serializeSvg(svg).markup).toContain('fill="#ffffff"');
  });

  it('honours an explicit background colour', () => {
    const svg = makeSvg({ width: '400', height: '200' });
    document.body.appendChild(svg);
    expect(serializeSvg(svg, { background: '#09090b' }).markup).toContain('fill="#09090b"');
  });

  it('omits the background only when transparency is asked for by name', () => {
    const svg = makeSvg({ width: '400', height: '200' });
    document.body.appendChild(svg);
    expect(serializeSvg(svg, { background: 'transparent' }).markup).not.toContain('width="100%"');
  });

  it('puts the background behind the chart, not over it', () => {
    const svg = makeSvg({ width: '400', height: '200' });
    child(svg, 'rect', { class: 'bar', id: 'series' });
    document.body.appendChild(svg);

    const { markup } = serializeSvg(svg, { background: '#09090b' });
    expect(markup.indexOf('fill="#09090b"')).toBeLessThan(markup.indexOf('id="series"'));
  });

  it('injects host-supplied @font-face rules', () => {
    const svg = makeSvg({ width: '400', height: '200' });
    document.body.appendChild(svg);
    const css = "@font-face{font-family:'Space Grotesk';src:url(data:font/woff2;base64,AAAA)}";
    expect(serializeSvg(svg, { fontFaceCss: css }).markup).toContain('Space Grotesk');
  });
});

describe('svgToDataUri', () => {
  it('percent-encodes rather than base64-encoding, so a non-Latin-1 label survives', () => {
    const uri = svgToDataUri('<svg><text>µ — 温度</text></svg>');
    expect(uri.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(uri.slice('data:image/svg+xml;charset=utf-8,'.length))).toContain(
      '温度',
    );
  });

  it('encodes the characters that would otherwise terminate the URI', () => {
    expect(svgToDataUri('<svg id="a#b"/>')).not.toContain('#');
  });
});

describe('resolveScale', () => {
  it('defaults to 2x even on a 1x display, because a 1x chart is soft in any document', () => {
    expect(resolveScale(undefined, 400, 200, 1)).toBe(2);
  });

  it('follows a higher device pixel ratio', () => {
    expect(resolveScale(undefined, 400, 200, 3)).toBe(3);
  });

  it('honours an explicit scale', () => {
    expect(resolveScale(4, 400, 200, 1)).toBe(4);
  });

  it('ignores a nonsensical explicit scale', () => {
    expect(resolveScale(0, 400, 200, 1)).toBe(2);
    expect(resolveScale(Number.NaN, 400, 200, 1)).toBe(2);
  });

  it('clamps so the canvas never exceeds the per-side limit every browser enforces', () => {
    // 10000 × 4 would be 40000px, past which drawImage yields a blank canvas with no error.
    expect(resolveScale(4, 10_000, 200, 1)).toBeCloseTo(16384 / 10_000);
  });
});

describe('findExportableSvg', () => {
  it('finds the chart inside a card wrapper', () => {
    document.body.innerHTML = '<div id="card"><div><svg id="chart"></svg></div></div>';
    const card = document.getElementById('card');
    expect(findExportableSvg(card)?.id).toBe('chart');
  });

  it('accepts the svg itself', () => {
    const svg = makeSvg();
    expect(findExportableSvg(svg)).toBe(svg);
  });

  it('returns null for the CSS fallback chart, which is divs and cannot be rasterised', () => {
    document.body.innerHTML = '<div id="card"><div class="h-3 bg-sky-500/80"></div></div>';
    expect(findExportableSvg(document.getElementById('card'))).toBeNull();
  });

  it('returns null for nothing at all', () => {
    expect(findExportableSvg(null)).toBeNull();
  });
});

describe('svgToPngBlob', () => {
  // The one and only assertion about the rasterisation step, and it is about the failure. jsdom
  // has no canvas implementation, so `getContext('2d')` returns null — the same value a locked-
  // down browser returns. What matters is that the export says so instead of drawing nothing.
  it('fails with a legible error where there is no 2D context, rather than producing a blank PNG', async () => {
    const svg = makeSvg({ width: '400', height: '200' });
    document.body.appendChild(svg);
    await expect(svgToPngBlob(svg)).rejects.toThrow(/No 2D canvas context/);
  });
});
