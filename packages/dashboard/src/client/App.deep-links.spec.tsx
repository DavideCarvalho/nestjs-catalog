// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * That the link the search box generates opens the thing it names.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A deep link is an agreement between two files that nothing checks. `SearchScreen` writes
 * `#query?savedQuery=<id>`; `App` reads `params.get('savedQuery')` and hands it to `QueryConsole`.
 * Rename the parameter on one side and the link goes back to landing on the right screen and
 * stopping — the address changes, the screen does not, and it reads as a click that never
 * registered. That is precisely the state this console shipped in: the box generated
 * `?savedQuery=` and `?dashboard=` for a whole release while `QueryConsole` took no id at all and
 * `DashboardBoard` took no props at all.
 *
 * `deep-links.spec.tsx` in the React package holds what each screen does with an id it is given.
 * What it cannot hold is whether the id ever arrives — that is this file, and the reason nothing
 * here asserts on an href it wrote down itself. Every test reads the href off the rendered row and
 * follows it, so the two spellings are compared against each other rather than both against a
 * third copy in a test.
 *
 * The address-writing half is here for the same reason: whether a selection is a history entry you
 * have to press Back through is a decision about the address bar, and the host owns the address
 * bar. The library screens report; this file is where `replaceState` versus a `location.hash`
 * assignment is actually decided, so it is where it has to be asserted.
 *
 * `toBeChecked` / `toBeDisabled` are NOT available — this repo registers no jest-dom setup, and
 * they throw rather than fail. `toHaveProperty` is the equivalent that works.
 */
import type { CatalogSearchResult, Dashboard, SavedQuery } from '@dudousxd/nestjs-catalog/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

declare global {
  // React refuses to believe a test is a test without this, and warns on every state update.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** The two things the tab strip and the boards use that jsdom, having no layout, does not. */
class NoopResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = NoopResizeObserver;
Element.prototype.scrollIntoView = () => {};

/**
 * Told before `App` is imported, because the flag is read at module scope — setting it after a
 * static import would render a sign-in form instead of a console in every test here.
 */
Object.assign(window, { __CATALOG_HOST_AUTH__: true });
const { App } = await import('./App');

function savedQuery(id: string, name: string, sql: string): SavedQuery {
  return {
    id,
    name,
    sql,
    createdBy: 'someone',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cacheTtlSeconds: 0,
    visualization: { kind: 'table' },
    shared: false,
  };
}

function board(id: string, name: string): Dashboard {
  return {
    id,
    name,
    createdBy: 'someone',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cards: [],
    shared: false,
  };
}

/**
 * Two of each, and the one the search hit names is deliberately NOT first.
 *
 * With one saved query and one board every test passes on a console that ignores the id entirely,
 * because the default and the answer are the same row. The second row is the whole experiment.
 */
const QUERIES = [
  savedQuery('q-1', 'Vehicles by base', 'SELECT * FROM mvr'),
  savedQuery('q-7', 'Risk by base', 'SELECT assetId, risk FROM subwo'),
];
const BOARDS = [board('d-1', 'Fleet overview'), board('d-3', 'Risk overview')];

/** One hit of each kind that carries an id, which is what the two broken links were. */
const RESULT: CatalogSearchResult = {
  term: 'risk',
  total: 2,
  truncated: false,
  hits: [
    { kind: 'savedQuery', id: 'q-7', label: 'Risk by base', rank: 'name', field: 'name' },
    { kind: 'dashboard', id: 'd-3', label: 'Risk overview', rank: 'name', field: 'name' },
  ],
};

/**
 * The whole API this console talks to, answered from memory.
 *
 * Everything unrecognised answers an empty LIST, so a screen a link arrives at renders its "nothing
 * here yet" state rather than dying on `undefined.map`. A test about where a link goes should not
 * fail because the screen it arrives at grew a call.
 */
const ANSWERS: Record<string, unknown> = {
  '/api/catalog/search': RESULT,
  '/api/auth/me': { kind: 'user', principalId: 'p-1' },
  '/api/catalog': { types: [], stats: { types: 0 } },
  '/api/catalog/saved-queries': QUERIES,
  '/api/catalog/dashboards': BOARDS,
  '/api/query-ai/capabilities': { available: false, provider: null },
};

function stubFetch() {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input), window.location.origin);
    const body = url.pathname in ANSWERS ? ANSWERS[url.pathname] : [];
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

/** Moves the address bar, and lets the console's `hashchange` listener catch up. */
async function navigate(hash: string) {
  await act(async () => {
    window.location.hash = hash;
    await sleep(0);
  });
}

/** Types into the box and waits for the debounced answer to land. */
async function searchFor(term: string) {
  const box = await screen.findByLabelText('Search the catalog');
  await act(async () => {
    fireEvent.change(box, { target: { value: term } });
    await sleep(300);
  });
}

/**
 * The address a search row actually hands the browser, for a hit of the given kind.
 *
 * Read off the DOM rather than written out here, which is the point of the whole file: a link
 * asserted against a string in a test proves the two copies in the test agree, not that the box
 * and the console do. Following what the row says is what compares the two real spellings.
 */
async function hrefForGroup(group: string): Promise<string> {
  // All matches, then the one inside a `<section>`: "Dashboards" is also the name of a TAB, which
  // is always on screen, so a `findByText` would resolve against the nav on the first tick and
  // never wait for the results at all. The result groups are the sections.
  const groupHeading = () => {
    const found = screen
      .getAllByText(group)
      .map((heading) => heading.closest('section'))
      .find((el) => el !== null);
    if (!found) throw new Error(`No result group called "${group}" yet`);
    return found;
  };
  const section = await waitFor(groupHeading);
  const row = within(section).getByRole('link');
  const href = row.getAttribute('href');
  expect(href).toBeTruthy();
  return href ?? '';
}

describe('a search result opens the thing it names', () => {
  it('sends a saved-query hit to that saved query, not to an empty editor', async () => {
    await navigate('#search');
    renderConsole();
    await searchFor('risk');

    await navigate(await hrefForGroup('Saved queries'));

    // `q-7` is the SECOND saved query, so a console that navigated and dropped the id would show
    // the starter SQL here and look perfectly healthy doing it.
    await waitFor(() =>
      expect(screen.getByLabelText('SQL query')).toHaveProperty(
        'value',
        'SELECT assetId, risk FROM subwo',
      ),
    );
  });

  it('sends a dashboard hit to that dashboard, not to whichever board is first', async () => {
    await navigate('#search');
    renderConsole();
    await searchFor('risk');

    await navigate(await hrefForGroup('Dashboards'));

    // The exact failure the search box shipped with: `d-3` is second, so ignoring the id renders
    // "Fleet overview" under an address promising "Risk overview".
    expect(await screen.findByRole('heading', { name: 'Risk overview' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Fleet overview' })).toBeNull();
  });
});

describe('the address follows what you select, so a link can be copied out of it', () => {
  it('names the board you clicked', async () => {
    await navigate('#dashboards');
    renderConsole();

    fireEvent.click(await screen.findByText('Risk overview'));

    // The same spelling `SearchScreen` generates. If these two ever disagree the console will hand
    // out links it cannot itself follow.
    await waitFor(() => expect(window.location.hash).toBe('#dashboards?dashboard=d-3'));
  });

  it('names the saved query you opened', async () => {
    await navigate('#query');
    renderConsole();

    fireEvent.click(await screen.findByText('Risk by base'));

    await waitFor(() => expect(window.location.hash).toBe('#query?savedQuery=q-7'));
  });

  it('does not leave a history entry behind for every board you look at', async () => {
    // The hazard weighed against writing the address at all. Assigning `location.hash` pushes an
    // entry per selection, so clicking through eleven boards puts eleven presses of Back between
    // you and the screen you were on before. `replaceState` keeps the address current and costs
    // nothing to leave — and, not incidentally, fires no `hashchange`, so the console's own router
    // is not re-entered by a write it made itself.
    await navigate('#dashboards');
    renderConsole();
    await screen.findByText('Risk overview');

    const entries = window.history.length;
    let hashChanges = 0;
    const count = () => {
      hashChanges += 1;
    };
    window.addEventListener('hashchange', count);

    await act(async () => {
      fireEvent.click(screen.getByText('Risk overview'));
      await sleep(0);
      fireEvent.click(screen.getByText('Fleet overview'));
      await sleep(0);
    });
    window.removeEventListener('hashchange', count);

    expect(window.location.hash).toBe('#dashboards?dashboard=d-1');
    expect(window.history.length).toBe(entries);
    expect(hashChanges).toBe(0);
  });

  it('keeps naming the board after you switch, rather than freezing on the first one', async () => {
    // A console that wrote the address once would hand out a link to whatever you opened first,
    // which is a subtler version of the bug this whole change is about.
    await navigate('#dashboards');
    renderConsole();

    fireEvent.click(await screen.findByText('Risk overview'));
    await waitFor(() => expect(window.location.hash).toBe('#dashboards?dashboard=d-3'));
    fireEvent.click(screen.getByText('Fleet overview'));

    await waitFor(() => expect(window.location.hash).toBe('#dashboards?dashboard=d-1'));
  });

  it('produces a link the console can follow back, which is the whole round trip', async () => {
    // Select, copy the address, arrive on it fresh. This is the sentence the feature is for, and
    // it is the only test here that exercises the write and the read against each other.
    await navigate('#dashboards');
    const first = renderConsole();
    fireEvent.click(await screen.findByText('Risk overview'));
    await waitFor(() => expect(window.location.hash).toBe('#dashboards?dashboard=d-3'));
    const copied = window.location.hash;

    first.unmount();
    await navigate('#model');
    await navigate(copied);
    renderConsole();

    expect(await screen.findByRole('heading', { name: 'Risk overview' })).toBeTruthy();
  });
});

describe('a link naming something that is gone', () => {
  it('says so rather than opening a different board', async () => {
    // A stale link — a board somebody deleted — must not read as a working link showing the wrong
    // thing. Asserted through the console rather than the component alone because the id has to
    // survive the hash parse to get there at all.
    await navigate('#dashboards?dashboard=d-gone');
    renderConsole();

    expect(await screen.findByText('That dashboard is not here')).toBeTruthy();
    expect(screen.getByText('d-gone')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Fleet overview' })).toBeNull();
  });

  it('leaves the dead id in the address, because it is the only evidence of which link broke', async () => {
    await navigate('#dashboards?dashboard=d-gone');
    renderConsole();
    await screen.findByText('That dashboard is not here');

    expect(window.location.hash).toBe('#dashboards?dashboard=d-gone');
  });
});
