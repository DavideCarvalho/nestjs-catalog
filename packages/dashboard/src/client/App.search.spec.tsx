// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * The console's own wiring of `CatalogSearch`, which is the half the library cannot test.
 *
 * `search-console.spec.tsx` in the React package already holds what the screen does with an
 * answer. What it cannot hold is whether anybody mounted it, and for a whole release nobody had:
 * the box shipped, the console did not render it, and finding a type still meant knowing which of
 * nine tabs it lived on. So the three things asserted here are the three this file owns.
 *
 * - **That the screen exists at a route.** `#search` has no tab, on purpose — the nav needs
 *   ~1150px for nine of them and scrolls below that — so the only thing standing between a
 *   bookmarked `#search` and the model screen is `routeFromHash` naming it.
 * - **That every kind of hit is a link, and to somewhere this console parses.** A kind whose
 *   href is omitted renders as a plain row; four groups where two are dead ends is a worse
 *   answer than the tabs. The hrefs are followed here rather than merely read, because a link
 *   whose route the hash router does not recognise changes the address and nothing else — the
 *   exact failure `tabFromHash` was rewritten to fix.
 * - **That the shortcut lands the cursor in the box.** A search box that has to be aimed at is
 *   one people do not use, and one that opens without focus has only moved the aiming.
 *
 * `toBeChecked` / `toBeDisabled` are NOT available — this repo registers no jest-dom setup, and
 * they throw rather than fail. `toHaveProperty` is the equivalent that works. jsdom also has no
 * layout, so nothing here asserts on width or overflow: that the launcher stays out of the
 * scrolling strip is checked structurally, as containment, which is the part that is actually
 * true regardless of viewport.
 */
import type { CatalogSearchResult } from '@dudousxd/nestjs-catalog/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCodeSurfaceDom } from '../../../../test/jsdom-code-surface';

// Search reaches a screen that mounts the query console, and the editor is a
// real code surface — canvas metrics, a firing ResizeObserver, constructable
// stylesheets. Without the shim React throws `sheet.replaceSync is not a
// function` during render, which surfaces as an UNHANDLED rejection rather than
// a failing test: vitest exits non-zero with every case still green.
installCodeSurfaceDom();

declare global {
  // React refuses to believe a test is a test without this, and warns on every state update.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The two things the tab strip uses that jsdom does not implement, because it does no layout.
 *
 * Stubbed rather than worked around. `TabStrip` observes its own size to decide whether to show
 * the overflow arrows, and scrolls the selected tab into view on mount; neither has an observable
 * effect without layout, and both throw. Anything asserting on what they compute would be
 * asserting on a zero — so nothing here does, and the console is rendered whole instead of with
 * its nav replaced by a mock.
 */
class NoopResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = NoopResizeObserver;
Element.prototype.scrollIntoView = () => {};

/**
 * Told before `App` is imported, because the flag is read at module scope.
 *
 * `HOST_AUTHENTICATES` decides whether the console wraps itself in its own sign-in gate, and it
 * is a `const` evaluated on first import — so setting it after a static import would be setting
 * it too late, and every test here would render a sign-in form instead of a console.
 */
Object.assign(window, { __CATALOG_HOST_AUTH__: true });
const { App } = await import('./App');

/** One hit of each kind, which is the only shape that can catch a missing href. */
const RESULT: CatalogSearchResult = {
  term: 'risk',
  total: 4,
  truncated: false,
  hits: [
    {
      kind: 'objectType',
      id: 'Mvr',
      label: 'Vehicle',
      typeName: 'Mvr',
      rank: 'name',
      field: 'description',
    },
    {
      kind: 'property',
      id: 'riskScore',
      label: 'Risk Score',
      typeName: 'Mvr',
      rank: 'prefix',
      field: 'name',
    },
    { kind: 'savedQuery', id: 'q-7', label: 'Risk by base', rank: 'name', field: 'name' },
    { kind: 'dashboard', id: 'd-3', label: 'Risk overview', rank: 'name', field: 'name' },
  ],
};

/**
 * The whole API this console talks to, answered from memory.
 *
 * Everything unrecognised answers an empty LIST rather than throwing or 404ing. Following a search
 * link means the screen on the other side actually mounts, and every list screen in this console
 * maps over what it was given — so the empty list is the answer that lets each of them render its
 * "nothing here yet" state instead of dying on `undefined.map`. A test about where a link goes
 * should not fail because the screen it arrives at grew a call.
 */
function stubFetch() {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input), window.location.origin);
    const body = (() => {
      if (url.pathname === '/api/catalog/search') return RESULT;
      if (url.pathname === '/api/auth/me') return { kind: 'user', principalId: 'p-1' };
      if (url.pathname === '/api/catalog') return { types: [], stats: { types: 0 } };
      if (url.pathname === '/api/query-ai/capabilities')
        return { available: false, provider: null };
      // An empty PAGE, not an empty list: the object explorer reads `total` and `columns` off
      // the answer before it has a row to draw, so a bare `[]` crashes the screen a search link
      // is supposed to arrive at — and a crashed destination looks exactly like a bad href.
      if (url.pathname.startsWith('/api/catalog/objects/')) {
        return { type: 'Mvr', page: 1, size: 25, total: 0, pages: 0, columns: [], rows: [] };
      }
      return [];
    })();
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = stubFetch();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.location.hash = '';
});

function renderConsole() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

/**
 * Real timers, and the same reasoning the library's own spec gives: `vi.useFakeTimers()` and
 * Testing Library's `waitFor` do not compose, because `waitFor` polls on a timer of its own. The
 * box debounces for 200ms, so this waits it out for real.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Types into the box and waits for the debounced answer to land. */
async function searchFor(term: string) {
  const box = await screen.findByLabelText('Search the catalog');
  await act(async () => {
    fireEvent.change(box, { target: { value: term } });
    await sleep(300);
  });
  return box;
}

/** Moves the address bar, and lets the console's `hashchange` listener catch up. */
async function navigate(hash: string) {
  await act(async () => {
    window.location.hash = hash;
    await sleep(0);
  });
}

describe('the search screen is mounted', () => {
  it('answers #search, which nothing in the tab list does', async () => {
    await navigate('#search');
    renderConsole();

    expect(await screen.findByLabelText('Search the catalog')).toBeTruthy();
  });

  it('is reachable by pointer, from a launcher pinned outside the scrolling tab strip', async () => {
    renderConsole();

    const launcher = await screen.findByRole('button', { name: 'Search' });
    // Structural, not visual: jsdom has no layout, so "does not scroll away with the tabs" can
    // only honestly be asserted as "is not inside the thing that scrolls". The strip is the
    // element with `role="tablist"`; the environment picker and store badge are its neighbours,
    // and this belongs with them.
    const strip = screen.getByRole('tablist');
    expect(strip.contains(launcher)).toBe(false);

    await act(async () => {
      fireEvent.click(launcher);
      await sleep(0);
    });

    expect(await screen.findByLabelText('Search the catalog')).toBeTruthy();
  });

  it('opens on ⌘K from another screen, with the cursor already in the box', async () => {
    await navigate('#activity');
    renderConsole();

    await act(async () => {
      fireEvent.keyDown(window, { key: 'k', metaKey: true });
      await sleep(0);
    });

    const box = await screen.findByLabelText('Search the catalog');
    // The half that makes it a shortcut rather than a second way to click: opening the screen
    // and leaving focus behind has only moved the aiming somewhere else.
    expect(document.activeElement).toBe(box);
  });

  it('opens on Ctrl-K too, since most of the people using this are not on a Mac', async () => {
    renderConsole();

    await act(async () => {
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
      await sleep(0);
    });

    expect(await screen.findByLabelText('Search the catalog')).toBeTruthy();
  });

  it('gives Escape back the screen you came from', async () => {
    renderConsole();
    // Navigated to AFTER the first render, not before it, which is the case that catches a
    // console only remembering where it was opened at: the screen you want back is the one you
    // walked to, and on a hash router that is a `hashchange` rather than an initial state.
    await navigate('#activity');
    await act(async () => {
      fireEvent.keyDown(window, { key: 'k', metaKey: true });
      await sleep(0);
    });
    expect(screen.queryByLabelText('Search the catalog')).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
      await sleep(0);
    });

    // Back to where the shortcut was pressed, not to the console's default screen: a search
    // opened mid-task that returns you to the model screen has cost you your place.
    expect(window.location.hash).toBe('#activity');
    expect(screen.queryByLabelText('Search the catalog')).toBeNull();
  });
});

describe('what a row does when you click it', () => {
  it('makes every kind a link, because a kind with no href renders as a dead row', async () => {
    await navigate('#search');
    renderConsole();
    await searchFor('risk');

    const links = await screen.findAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '#objects?type=Mvr',
      '#objects?type=Mvr',
      '#query?savedQuery=q-7',
      '#dashboards?dashboard=d-3',
    ]);
  });

  it('sends a property to the type it belongs to, since there is no screen for one', async () => {
    await navigate('#search');
    renderConsole();
    await searchFor('risk');

    const properties = await screen.findByText('Properties');
    const group = properties.closest('section');
    expect(group).not.toBeNull();
    const row = within(group ?? document.body).getByRole('link');

    // The same string the model screen generates for the same destination. A second spelling
    // here would mean this console navigates to one type two different ways.
    expect(row.getAttribute('href')).toBe('#objects?type=Mvr');
  });

  it('names routes the hash router actually parses, on all three kinds', async () => {
    await navigate('#search');
    renderConsole();
    await searchFor('risk');

    const links = await screen.findAllByRole('link');
    const expected: Array<[number, string]> = [
      [0, 'Objects'],
      [2, 'Query'],
      [3, 'Dashboards'],
    ];

    for (const [index, tab] of expected) {
      const href = links[index]?.getAttribute('href') ?? '';
      // Followed rather than read. A link whose route the router does not recognise falls back
      // to the model screen — the address changes and the console does not, which reads as a
      // click that never registered, and asserting on the href alone cannot see it.
      await navigate(href);
      await waitFor(() =>
        expect(screen.getByRole('tab', { name: tab })).toHaveProperty('ariaSelected', 'true'),
      );
      await navigate('#search');
      await searchFor('risk');
    }
  });
});
