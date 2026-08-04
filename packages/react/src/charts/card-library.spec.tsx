// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * Which chart library draws a card.
 *
 * Three places can have an opinion — the card, the saved query, and the
 * built-in fallback — and the order between them is the whole feature. Getting
 * it backwards does not throw: the board simply draws with the wrong library
 * and looks like a board that mixes two styles, which is what putting the
 * choice on the card was meant to fix.
 *
 * The other half is that the picker must only offer libraries the host actually
 * registered. Offering one nobody installed would be offering a choice that
 * silently degrades to the built-in — the control would say one thing and the
 * card draw another.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getChartRenderer,
  registerChartRenderer,
  registeredChartLibraries,
  visualizationFor,
} from './registry';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

/** The function the board actually calls — not a mirror of it. */
function resolveLibrary(card: string | undefined, query: string | undefined) {
  return visualizationFor({ kind: 'bar', ...(query ? { library: query } : {}) }, card);
}

describe('which library draws a card', () => {
  it("uses the card's choice over the query's", () => {
    // THE case. The card is the more specific statement: it says how this
    // answer should look on THIS board, and the query says how it looks
    // everywhere. Reading them the other way round means editing one board
    // changes every other board using the same query.
    expect(resolveLibrary('bklit', 'recharts').library).toBe('bklit');
  });

  it("falls through to the query's choice when the card has none", () => {
    expect(resolveLibrary(undefined, 'recharts').library).toBe('recharts');
  });

  it('leaves the library unset when neither chose, so the built-in draws', () => {
    // Not `library: undefined` — absent. A renderer lookup on an explicit
    // undefined and on a missing key behave the same today, but the stored card
    // is JSON, and "the key is there and empty" is a different statement from
    // "nobody chose" the moment anything reads it.
    const viz = resolveLibrary(undefined, undefined);
    expect('library' in viz).toBe(false);
  });

  it("keeps the rest of the query's visualization when the card overrides", () => {
    // Overriding the library must not drop the axis columns with it.
    const merged = visualizationFor(
      { kind: 'bar', library: 'recharts', labelColumn: 'unit', valueColumns: ['n'] },
      'bklit',
    );

    expect(merged).toMatchObject({
      kind: 'bar',
      labelColumn: 'unit',
      valueColumns: ['n'],
      library: 'bklit',
    });
  });

  it('falls back to a table when the query has no visualization at all', () => {
    expect(visualizationFor(undefined, undefined).kind).toBe('table');
  });
});

describe('the registry the picker reads', () => {
  it('lists only what was registered', () => {
    const before = registeredChartLibraries();
    expect(before).not.toContain('probe-only');

    registerChartRenderer('probe-only', () => null);

    expect(registeredChartLibraries()).toContain('probe-only');
  });

  it('answers nothing for a library nobody registered', () => {
    // Which is why the picker is built from the registry rather than from a
    // hardcoded list: an option for an unregistered library is an option that
    // does nothing visible.
    expect(getChartRenderer('never-installed')).toBeUndefined();
  });

  it('answers nothing when no library was named at all', () => {
    expect(getChartRenderer(undefined)).toBeUndefined();
  });

  it('returns the renderer that was registered under the name', () => {
    const Renderer = vi.fn(() => null);
    registerChartRenderer('probe-returns', Renderer);

    expect(getChartRenderer('probe-returns')).toBe(Renderer);
  });

  it('renders through the registered renderer', () => {
    registerChartRenderer('probe-renders', () => <p>drawn by the probe</p>);
    const Renderer = getChartRenderer('probe-renders');
    expect(Renderer).toBeTruthy();
    if (!Renderer) return;

    render(
      <Renderer
        result={{ columns: ['a'], rows: [{ a: 1 }], rowCount: 1, truncated: false, ms: 0 }}
        visualization={{ kind: 'bar' }}
      />,
    );

    expect(screen.getByText('drawn by the probe')).toBeTruthy();
  });
});
