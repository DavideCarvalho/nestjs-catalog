// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * The shipped screens, rendered for real against a fake `CatalogTransport`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The console died at first render with "No QueryClient set, use QueryClientProvider to set one",
 * pointing at a provider that was right there — two copies of `@tanstack/react-query` had ended up
 * in the bundle, and React context is per module instance, so the provider mounted by one copy was
 * invisible to the hooks inside the other. `packages/dashboard/vite.config.ts` now dedupes react,
 * react-dom and react-query, but a dedupe list is a claim nobody checks. Every test here mounts a
 * screen inside both providers and lets it fetch — which only works if one `QueryClientProvider`
 * and one `CatalogProvider` are visible to the hooks in this package.
 *
 * The transport is the seam that makes this possible without a server: the library takes one
 * rather than shipping a fetch wrapper, so a fake answers from a path→value map and records every
 * call. The assertions are about behaviour — what reaches the screen, what it asks for, what it
 * says when there is nothing or when it is refused — not about markup.
 */
import type {
  CatalogObjectPage,
  CatalogObjectTypeDef,
  CatalogSnapshot,
} from '@dudousxd/nestjs-catalog/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogManager } from './CatalogManager';
import { ObjectExplorer } from './ObjectExplorer';
import { CatalogProvider, type CatalogTransport } from './context';

declare global {
  // React refuses to believe a test is a test without this, and warns on every state update.
  // Not declared by `@types/react`, so the flag has to be introduced before it can be set.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// Testing Library manages this flag around its own `act` calls; set here as well so a direct
// `act(...)` below — used to resolve a deferred answer — is covered too.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// `screen` queries `document.body`, so a screen left mounted makes the NEXT test's queries
// ambiguous — and the failure reads as a duplicate element rather than as a leak.
afterEach(cleanup);

interface Call {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  params?: Record<string, unknown> | undefined;
  body?: unknown;
}

/**
 * A transport that answers from a path→value map and records every call.
 *
 * Answers are held untyped because `CatalogTransport` is generic on the response and a fixture map
 * cannot be: `any` here is what lets the fake satisfy `<T>(path) => Promise<T>` without an
 * assertion. An `Error` value is answered as a rejection; a function is called, so a path can
 * answer differently the second time, or not answer yet at all.
 */
function fakeTransport(answers: Record<string, unknown>) {
  const calls: Call[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: see above — the seam under test is generic.
  const answer = (path: string): Promise<any> => {
    if (!(path in answers)) return Promise.reject(new Error(`No fake answer for ${path}`));
    const value = answers[path];
    const resolved = typeof value === 'function' ? value() : value;
    return resolved instanceof Error ? Promise.reject(resolved) : Promise.resolve(resolved);
  };

  const transport: CatalogTransport = {
    get: (path, params) => {
      calls.push({ method: 'GET', path, params });
      return answer(path);
    },
    post: (path, body) => {
      calls.push({ method: 'POST', path, body });
      return answer(path);
    },
    patch: (path, body) => {
      calls.push({ method: 'PATCH', path, body });
      return answer(path);
    },
    delete: (path) => {
      calls.push({ method: 'DELETE', path });
      return answer(path);
    },
  };

  /** The most recent request to a path, for asserting on what a click asked for. */
  const lastCallTo = (path: string) => calls.filter((call) => call.path === path).at(-1);

  return { transport, calls, lastCallTo };
}

/**
 * The calls to the catalog library's own endpoints, and only those.
 *
 * The assertions below are about what the CATALOG screens ask the CATALOG
 * controller for — that a filter is applied client-side, that a reset does not
 * cost a second snapshot fetch. The Model screen's type panel also reads the
 * per-type load expectation from the HOST's pipeline endpoints, which is a
 * different question with its own spec (`load-expectation.spec.tsx`), and an
 * unfiltered call list here would fail every time that section changed what it
 * asks for.
 */
function catalogCalls(calls: Call[]) {
  return calls.filter((call) => call.path.startsWith('/catalog'));
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

/**
 * The type list in the sidebar, once the catalog has loaded.
 *
 * Scoped, because the selected type's name also appears in the detail pane — an unscoped
 * `getByText('Vehicle')` matches both and fails as "multiple elements", which reads like a
 * duplicate-render bug rather than an over-broad query.
 */
async function typeList() {
  return within(await screen.findByRole('navigation'));
}

function objectType(overrides: Partial<CatalogObjectTypeDef> = {}): CatalogObjectTypeDef {
  return {
    name: 'Mvr',
    displayName: 'Vehicle',
    pluralDisplayName: 'Vehicles',
    tableName: 'mvr',
    group: 'Fleet',
    primaryKey: ['id'],
    enriched: true,
    properties: [
      {
        name: 'id',
        displayName: 'Identifier',
        type: 'string',
        columnName: 'id',
        nullable: false,
        primary: true,
        hidden: false,
        order: 0,
        enriched: true,
      },
    ],
    relations: [],
    ...overrides,
  };
}

function snapshot(types: CatalogObjectTypeDef[]): CatalogSnapshot {
  return {
    version: 3,
    generatedAt: '2026-01-01T00:00:00.000Z',
    stats: {
      types: types.length,
      properties: types.reduce((n, t) => n + t.properties.length, 0),
      relations: types.reduce((n, t) => n + t.relations.length, 0),
      enrichedTypes: types.filter((t) => t.enriched).length,
    },
    types,
  };
}

describe('CatalogManager', () => {
  it('fetches the snapshot through the transport and renders what came back', async () => {
    const { transport, calls } = fakeTransport({
      '/catalog': snapshot([
        objectType(),
        objectType({
          name: 'Wo',
          displayName: 'Work order',
          tableName: 'wo',
          group: 'Maintenance',
        }),
      ]),
    });

    render(withCatalog(transport, <CatalogManager />));
    const list = await typeList();

    // The seam: one GET, to the path the catalog controller actually serves. Getting here at all
    // is the regression test for the two-react-query bug — a screen whose `useQuery` cannot see
    // the provider throws during render rather than fetching.
    expect(catalogCalls(calls)).toEqual([{ method: 'GET', path: '/catalog', params: undefined }]);
    // The names come from the answer, not from the code name: the whole point of the overlay is
    // that `Mvr` is displayed as "Vehicle".
    expect(list.getByText('Vehicle')).toBeDefined();
    expect(list.getByText('Work order')).toBeDefined();
    // …and grouped by the group the server sent, not by anything the screen invented.
    expect(list.getByText('Fleet')).toBeDefined();
    expect(list.getByText('Maintenance')).toBeDefined();
    expect(screen.queryByText('Reading the catalog…')).toBeNull();
  });

  it('shows the loading state until the answer arrives', async () => {
    // A screen that renders nothing while it waits reads as a screen that found nothing.
    let release: ((value: CatalogSnapshot) => void) | undefined;
    const { transport } = fakeTransport({
      '/catalog': () =>
        new Promise<CatalogSnapshot>((resolve) => {
          release = resolve;
        }),
    });

    render(withCatalog(transport, <CatalogManager />));

    expect(screen.getByText('Reading the catalog…')).toBeDefined();

    await waitFor(() => expect(release).toBeDefined());
    await act(async () => release?.(snapshot([objectType()])));

    // Awaited before the negative assertion: `queryByText` does not wait, so checking it first
    // would pass on a screen that never left the loading state.
    expect((await typeList()).getByText('Vehicle')).toBeDefined();
    expect(screen.queryByText('Reading the catalog…')).toBeNull();
  });

  it('filters the list without asking the server again', async () => {
    // The snapshot is the whole catalog; filtering it is a client-side concern, and a screen that
    // refetched per keystroke would put the catalog endpoint under a typing load for nothing.
    const { transport, calls } = fakeTransport({
      '/catalog': snapshot([
        objectType(),
        objectType({ name: 'Wo', displayName: 'Work order', tableName: 'wo' }),
      ]),
    });

    render(withCatalog(transport, <CatalogManager />));
    const filter = await screen.findByLabelText('Filter object types');

    fireEvent.change(filter, { target: { value: 'work' } });

    const list = await typeList();
    expect(list.queryByText('Vehicle')).toBeNull();
    expect(list.getByText('Work order')).toBeDefined();
    expect(catalogCalls(calls)).toHaveLength(1);
  });

  it('renders an empty catalog as empty, not as a failure', async () => {
    // A catalog with no types is a real state — a fresh install, or an account that may read
    // nothing — and `types[0]` is undefined all the way through the detail pane, so this is also
    // the case that turns a missing `?.` into a blank screen.
    //
    // NOT asserted, because it is wrong and should not be locked in: the sidebar currently says
    // `Nothing matches “”.` here, i.e. it blames a filter nobody typed.
    const { transport } = fakeTransport({ '/catalog': snapshot([]) });

    render(withCatalog(transport, <CatalogManager />));

    expect(await screen.findByText(/of 0 object types carry a name a person chose/)).toBeDefined();
    expect(screen.queryByText('The catalog did not load')).toBeNull();
    expect(screen.queryByText('Reading the catalog…')).toBeNull();
  });

  it('reports a refusal as a failed load, not as an empty one', async () => {
    // The distinction the screen exists to make: "there is nothing here" and "we could not ask"
    // lead a reader to opposite conclusions, and a 403 rendered as an empty list is the worse one.
    const { transport } = fakeTransport({ '/catalog': new Error('Forbidden') });

    render(withCatalog(transport, <CatalogManager />));

    expect(await screen.findByText('The catalog did not load')).toBeDefined();
  });

  it('reloads the catalog from what the reset returned, without a second GET', async () => {
    // The mutation writes its answer straight into the snapshot cache. Invalidating instead would
    // work too, but the screen claims not to: this pins that the button's effect is visible
    // immediately, and that a refactor to `invalidateQueries` has to keep it so.
    const { transport, calls } = fakeTransport({
      '/catalog': snapshot([objectType()]),
      '/catalog/reset': snapshot([objectType({ displayName: 'Mvr', enriched: false })]),
    });

    render(withCatalog(transport, <CatalogManager />));
    expect((await typeList()).getByText('Vehicle')).toBeDefined();

    fireEvent.click(screen.getByText('Reset edits'));

    await waitFor(() =>
      expect(catalogCalls(calls).map((call) => `${call.method} ${call.path}`)).toEqual([
        'GET /catalog',
        'POST /catalog/reset',
      ]),
    );
    expect((await typeList()).queryByText('Vehicle')).toBeNull();
  });
});

describe('ObjectExplorer', () => {
  const page = (rows: Array<Record<string, unknown>>): CatalogObjectPage => ({
    type: 'Mvr',
    page: 1,
    size: 25,
    total: rows.length,
    pages: 1,
    columns: [
      { name: 'id', displayName: 'Identifier', type: 'string' },
      { name: 'tailNumber', displayName: 'Tail number', type: 'string' },
    ],
    rows,
  });

  it('asks for the type it was given, with the paging parameters the API names', async () => {
    const { transport, lastCallTo } = fakeTransport({
      '/catalog': snapshot([objectType()]),
      '/catalog/objects/Mvr': page([{ id: '1', tailNumber: 'AF-101' }]),
    });

    render(withCatalog(transport, <ObjectExplorer type="Mvr" />));
    // The rows and the column labels both come from the answer; nothing here knows what an Mvr is.
    expect(await screen.findByText('AF-101')).toBeDefined();
    expect(screen.getByText('Tail number')).toBeDefined();

    // The parameter names are the contract with the server and are easy to rename by accident:
    // `size` is not `limit`, `dir` is not `order`. Send the wrong ones and a full unsorted first
    // page comes back with no error to notice.
    expect(lastCallTo('/catalog/objects/Mvr')?.params).toEqual({
      page: 1,
      size: 25,
      search: undefined,
      sort: undefined,
      dir: 'asc',
    });
  });

  it('honours a caller-supplied page size', async () => {
    const { transport, lastCallTo } = fakeTransport({
      '/catalog': snapshot([objectType()]),
      '/catalog/objects/Mvr': page([]),
    });

    render(withCatalog(transport, <ObjectExplorer type="Mvr" pageSize={5} />));
    await screen.findByText('mvr has no rows yet.');

    expect(lastCallTo('/catalog/objects/Mvr')?.params).toMatchObject({ size: 5 });
  });

  it('escapes the type name into the path', async () => {
    // Type names are class names today, but the path builder is what stands between a name with a
    // slash in it and a request to a completely different endpoint.
    const odd = 'Odd/Name';
    const { transport, calls } = fakeTransport({
      '/catalog': snapshot([objectType({ name: odd })]),
      '/catalog/objects/Odd%2FName': page([]),
    });

    render(withCatalog(transport, <ObjectExplorer type={odd} />));

    await waitFor(() =>
      expect(calls.map((call) => call.path)).toContain('/catalog/objects/Odd%2FName'),
    );
  });

  it('sorts through the server, not in the browser', async () => {
    // The grid holds one page. Sorting the rows it happens to have would silently reorder 25 of
    // several thousand and present it as the order — so a header click has to go back to the API.
    const { transport, lastCallTo } = fakeTransport({
      '/catalog': snapshot([objectType()]),
      '/catalog/objects/Mvr': page([{ id: '1', tailNumber: 'AF-101' }]),
    });

    render(withCatalog(transport, <ObjectExplorer type="Mvr" />));
    fireEvent.click(await screen.findByText('Tail number'));

    await waitFor(() =>
      expect(lastCallTo('/catalog/objects/Mvr')?.params).toMatchObject({
        sort: 'tailNumber',
        dir: 'asc',
      }),
    );

    // …and clicking the same column again reverses it rather than re-sorting ascending.
    fireEvent.click(screen.getByText('Tail number'));

    await waitFor(() =>
      expect(lastCallTo('/catalog/objects/Mvr')?.params).toMatchObject({
        sort: 'tailNumber',
        dir: 'desc',
      }),
    );
  });

  it('says the table is empty rather than drawing an empty grid', async () => {
    // "No rows" and "no such type" get the same blank screen if this branch is lost, and only one
    // of them is somebody's problem to fix.
    const { transport } = fakeTransport({
      '/catalog': snapshot([objectType()]),
      '/catalog/objects/Mvr': page([]),
    });

    render(withCatalog(transport, <ObjectExplorer type="Mvr" />));

    expect(await screen.findByText('mvr has no rows yet.')).toBeDefined();
    // It still names the physical table, so the reader can go look for themselves.
    expect(
      screen.getByText(/this table will fill in as soon as something writes to it/),
    ).toBeDefined();
  });

  it('does not offer paging for a single page of results', async () => {
    // The pager reads `pages` from the answer rather than counting rows; a screen that always
    // showed it would offer a "next page" that returns the same rows.
    const { transport } = fakeTransport({
      '/catalog': snapshot([objectType()]),
      '/catalog/objects/Mvr': page([{ id: '1', tailNumber: 'AF-101' }]),
    });

    render(withCatalog(transport, <ObjectExplorer type="Mvr" />));
    await screen.findByText('AF-101');

    expect(screen.queryByLabelText('Next page')).toBeNull();
  });

  it('pages by asking for the next page, not by slicing what it has', async () => {
    const { transport, lastCallTo } = fakeTransport({
      '/catalog': snapshot([objectType()]),
      '/catalog/objects/Mvr': {
        ...page([{ id: '1', tailNumber: 'AF-101' }]),
        total: 40,
        pages: 2,
      },
    });

    render(withCatalog(transport, <ObjectExplorer type="Mvr" />));
    fireEvent.click(await screen.findByLabelText('Next page'));

    await waitFor(() =>
      expect(lastCallTo('/catalog/objects/Mvr')?.params).toMatchObject({ page: 2 }),
    );
  });
});
