// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * The search screen, rendered for real against a fake `CatalogTransport`.
 *
 * What is worth pinning here is NOT the ranking — that is the server's, and
 * `search.spec.ts` in the catalog package holds it. It is the three things a
 * screen can get wrong on its own:
 *
 * - **What it asks for.** `q` is the parameter the route reads. Send `search`,
 *   or `term`, and the server answers an empty term with an empty result — a 200
 *   that renders as "nothing matches", which is indistinguishable from a term
 *   that genuinely matched nothing.
 * - **What it does with the order it was given.** The screen groups by kind,
 *   which trades the global ranking for scannability; within a group the
 *   server's order has to survive untouched, or the trade has cost both.
 *   Re-sorting client-side would be a second ranking, and the answer to any
 *   question about relevance would then depend on which one you read.
 * - **What it says when there is nothing.** "Nothing matched" and "we could not
 *   ask" lead a reader to opposite conclusions.
 *
 * `toBeChecked` / `toBeDisabled` are NOT available — this repo registers no
 * jest-dom setup, and they throw rather than fail. `toHaveProperty` is the
 * equivalent that works.
 */
import type { CatalogSearchHit, CatalogSearchResult } from '@dudousxd/nestjs-catalog/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogProvider, type CatalogTransport } from './context';
import { CatalogSearch } from './search-console';

declare global {
  // React refuses to believe a test is a test without this, and warns on every state update.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// `screen` queries `document.body`, so a screen left mounted makes the NEXT test's queries
// ambiguous — and the failure reads as a duplicate element rather than as a leak.
afterEach(cleanup);

/**
 * Real timers, not fake ones, and this is the whole reason the debounce is 200ms rather than 400.
 *
 * `vi.useFakeTimers()` and Testing Library's `waitFor` do not compose here: `waitFor` polls on a
 * timer of its own, so with the clock frozen it never gets a second look and every assertion in
 * this file times out after five seconds. The first draft of this spec did exactly that and took
 * 152 seconds to report fourteen failures in code that worked.
 *
 * So the debounce is waited out for real. It costs a quarter of a second per test, and it is also
 * the only version of this that tests the debounce rather than the mock of it.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Call {
  path: string;
  params?: Record<string, unknown> | undefined;
}

/** Answers `/catalog/search` from a function of the params, and records every call. */
function fakeTransport(answer: (params: Record<string, unknown> | undefined) => unknown) {
  const calls: Call[] = [];
  const reject = (path: string) => Promise.reject(new Error(`No fake answer for ${path}`));

  const transport: CatalogTransport = {
    get: (path, params) => {
      calls.push({ path, params });
      if (path !== '/catalog/search') return reject(path);
      const value = answer(params);
      // biome-ignore lint/suspicious/noExplicitAny: the seam under test is generic on the response.
      return (value instanceof Error ? Promise.reject(value) : Promise.resolve(value)) as any;
    },
    post: (path) => reject(path),
    patch: (path) => reject(path),
    delete: (path) => reject(path),
  };

  return { transport, calls };
}

function withCatalog(transport: CatalogTransport, children: ReactNode) {
  const queryClient = new QueryClient({
    // No retries: a refusal should reach the screen once, not four times over 30 seconds.
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <CatalogProvider transport={transport}>{children}</CatalogProvider>
    </QueryClientProvider>
  );
}

function hit(overrides: Partial<CatalogSearchHit> = {}): CatalogSearchHit {
  return {
    kind: 'objectType',
    id: 'Mvr',
    label: 'Vehicle',
    typeName: 'Mvr',
    detail: 'Fleet',
    rank: 'exact',
    field: 'name',
    ...overrides,
  };
}

function result(hits: CatalogSearchHit[], overrides: Partial<CatalogSearchResult> = {}) {
  return {
    term: 'vehicle',
    total: hits.length,
    truncated: false,
    hits,
    ...overrides,
  } satisfies CatalogSearchResult;
}

/** Types into the box and lets the 200ms debounce elapse. */
async function type(term: string) {
  fireEvent.change(screen.getByLabelText('Search the catalog'), { target: { value: term } });
  await act(async () => {
    await sleep(DEBOUNCE_ELAPSED_MS);
  });
}

/** Comfortably past the component's 200ms debounce, without being slow enough to notice. */
const DEBOUNCE_ELAPSED_MS = 260;

// ---------------------------------------------------------------------------

describe('CatalogSearch', () => {
  it('asks the search route with the parameter name the route reads', async () => {
    const { transport, calls } = fakeTransport(() => result([hit()]));

    render(withCatalog(transport, <CatalogSearch explorerHref={(t) => `#objects?type=${t}`} />));
    await type('vehicle');

    // `q`, not `search` or `term`. The wrong name reaches the route as an empty
    // term, which answers 200 with an empty result — a screen that says "nothing
    // matches" for every search anybody ever runs.
    await waitFor(() =>
      expect(calls).toEqual([{ path: '/catalog/search', params: { q: 'vehicle' } }]),
    );
  });

  it('asks nothing at all until somebody types', async () => {
    const { transport, calls } = fakeTransport(() => result([]));

    render(withCatalog(transport, <CatalogSearch />));
    await act(async () => {
      await sleep(DEBOUNCE_ELAPSED_MS * 2);
    });

    expect(calls).toEqual([]);
    expect(screen.getByText(/Types, properties, saved queries and dashboards/)).toBeDefined();
  });

  it('debounces, so a typed word is one request rather than one per keystroke', async () => {
    // Half the answer is free, half is two reads against the workspace store. A
    // request per keystroke puts a database under a typing load for rows that
    // were going to be thrown away.
    const { transport, calls } = fakeTransport(() => result([hit()]));

    render(withCatalog(transport, <CatalogSearch />));
    const box = screen.getByLabelText('Search the catalog');
    for (const value of ['v', 've', 'veh', 'vehi', 'vehic', 'vehicle']) {
      fireEvent.change(box, { target: { value } });
      // Well inside the debounce window, six times over, so the timer is reset
      // rather than fired — which is the behaviour under test.
      await act(async () => {
        await sleep(20);
      });
    }
    await act(async () => {
      await sleep(DEBOUNCE_ELAPSED_MS);
    });

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.params).toEqual({ q: 'vehicle' });
  });

  it('omits limit entirely when the host named none', async () => {
    // A transport that serialises `limit=` hands the route an empty string, and
    // `Number('')` is 0 — floored back to 1, which answers with a single row
    // that reads as "there is only one match".
    const { transport, calls } = fakeTransport(() => result([hit()]));

    render(withCatalog(transport, <CatalogSearch />));
    await type('vehicle');

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(Object.hasOwn(calls[0]?.params ?? {}, 'limit')).toBe(false);
  });

  it('passes a limit the host did name', async () => {
    const { transport, calls } = fakeTransport(() => result([hit()]));

    render(withCatalog(transport, <CatalogSearch limit={5} />));
    await type('vehicle');

    await waitFor(() => expect(calls[0]?.params).toEqual({ q: 'vehicle', limit: 5 }));
  });

  it('groups by kind, in the order the server ranks them', async () => {
    const { transport } = fakeTransport(() =>
      result([
        hit({ kind: 'objectType', id: 'Mvr', label: 'Vehicle' }),
        hit({ kind: 'property', id: 'tailNumber', label: 'Tail number', detail: 'string' }),
        hit({ kind: 'savedQuery', id: 'q-1', label: 'Fleet report', typeName: undefined }),
        hit({ kind: 'dashboard', id: 'd-1', label: 'Fleet board', typeName: undefined }),
      ]),
    );

    render(withCatalog(transport, <CatalogSearch />));
    await type('fleet');

    const headings = await screen.findAllByText(
      /^(Object types|Properties|Saved queries|Dashboards)$/,
    );
    expect(headings.map((node) => node.textContent)).toEqual([
      'Object types',
      'Properties',
      'Saved queries',
      'Dashboards',
    ]);
  });

  it('draws no heading for a kind that matched nothing', async () => {
    // A screen that always draws four sections reports "Dashboards" above an
    // empty space, which reads as a board this reader cannot open rather than as
    // no board at all.
    const { transport } = fakeTransport(() => result([hit({ kind: 'objectType' })]));

    render(withCatalog(transport, <CatalogSearch />));
    await type('vehicle');

    expect(await screen.findByText('Object types')).toBeDefined();
    expect(screen.queryByText('Dashboards')).toBeNull();
    expect(screen.queryByText('Properties')).toBeNull();
  });

  it('keeps the server order within a group rather than re-sorting it', async () => {
    // The screen does no ranking. If it ever sorts — by label, "helpfully" —
    // there are two rankings for one question and the answer depends on which
    // one you read.
    const { transport } = fakeTransport(() =>
      result([
        hit({ kind: 'property', id: 'zulu', label: 'Zulu', rank: 'exact' }),
        hit({ kind: 'property', id: 'alpha', label: 'Alpha', rank: 'text', field: 'description' }),
      ]),
    );

    render(withCatalog(transport, <CatalogSearch />));
    await type('zulu');

    const rows = await screen.findAllByText(/^(Zulu|Alpha)$/);
    expect(rows.map((node) => node.textContent)).toEqual(['Zulu', 'Alpha']);
  });

  it('links a type and a property to the type the host said where to find', async () => {
    // A property has no screen of its own, so it navigates to its owning type —
    // through the SAME `explorerHref` the model screen takes, so a host wires
    // one destination once.
    const { transport } = fakeTransport(() =>
      result([
        hit({ kind: 'objectType', id: 'Mvr', label: 'Vehicle', typeName: 'Mvr' }),
        hit({ kind: 'property', id: 'tailNumber', label: 'Tail number', typeName: 'Mvr' }),
      ]),
    );

    render(withCatalog(transport, <CatalogSearch explorerHref={(t) => `#objects?type=${t}`} />));
    await type('vehicle');

    const links = await screen.findAllByRole('link');
    expect(links.map((node) => node.getAttribute('href'))).toEqual([
      '#objects?type=Mvr',
      '#objects?type=Mvr',
    ]);
  });

  it('renders a row as a plain row when the host mounted no screen for its kind', async () => {
    // Not a dead link and not `href="#"`. A row that looks clickable and is not
    // is worse than one that does not.
    const { transport } = fakeTransport(() =>
      result([hit({ kind: 'dashboard', id: 'd-1', label: 'Fleet board', typeName: undefined })]),
    );

    render(withCatalog(transport, <CatalogSearch explorerHref={(t) => `#objects?type=${t}`} />));
    await type('fleet');

    expect(await screen.findByText('Fleet board')).toBeDefined();
    expect(screen.queryAllByRole('link')).toEqual([]);
  });

  it('says which field matched and how well, on every row', async () => {
    // The rank is what grouping costs — an exact match no longer sits visually
    // above a description hit — so the row has to carry it back, in words rather
    // than in the server's vocabulary.
    const { transport } = fakeTransport(() =>
      result([hit({ kind: 'property', id: 'range', label: 'Range', rank: 'text', field: 'unit' })]),
    );

    render(withCatalog(transport, <CatalogSearch />));
    await type('miles');

    const row = within(
      await screen.findByText('Range').then((node) => node.parentElement?.parentElement ?? node),
    );
    expect(row.getByText('in the text')).toBeDefined();
    expect(row.getByText('unit')).toBeDefined();
  });

  it('names the owning type on a property row', async () => {
    // "Status" on its own is meaningless, and a property called it is the single
    // most common kind of hit in a real catalog.
    const { transport } = fakeTransport(() =>
      result([hit({ kind: 'property', id: 'status', label: 'Status', typeName: 'Mvr' })]),
    );

    render(withCatalog(transport, <CatalogSearch />));
    await type('status');

    expect(await screen.findByText(/Mvr · status/)).toBeDefined();
  });

  it('says how many were cut when the answer was capped', async () => {
    // A list that silently stops at fifty reads as "there are fifty", and the
    // next search somebody runs is the one they run because they did not find it
    // in the first.
    const { transport } = fakeTransport(() => result([hit()], { total: 312, truncated: true }));

    render(withCatalog(transport, <CatalogSearch />));
    await type('e');

    expect(await screen.findByText('1 of 312 matches')).toBeDefined();
  });

  it('reports nothing found as nothing found, naming the term', async () => {
    const { transport } = fakeTransport(() => result([], { term: 'zzz' }));

    render(withCatalog(transport, <CatalogSearch />));
    await type('zzz');

    expect(await screen.findByText(/Nothing matches/)).toBeDefined();
  });

  it('reports a refusal as a failed search, not as an empty one', async () => {
    // The distinction the status line exists to make. A 403 rendered as "nothing
    // matches" tells a reader their term was wrong when their access was.
    const { transport } = fakeTransport(() => new Error('Forbidden'));

    render(withCatalog(transport, <CatalogSearch />));
    await type('vehicle');

    expect(await screen.findByText('The search did not run')).toBeDefined();
    expect(screen.queryByText(/Nothing matches/)).toBeNull();
  });
});
