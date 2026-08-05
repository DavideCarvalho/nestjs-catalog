// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * The filter controls and the snapshot picker, rendered for real.
 *
 * Both features are "derived from what the server said", and that claim is only
 * worth anything if a test can change what the server says and watch the screen
 * change with it. So every case here answers `/catalog/objects/Mvr` differently
 * and asserts on what the screen offers and on what it asks for next.
 *
 * `userEvent` rather than `fireEvent` for the selects: they are Base UI popups
 * driven by pointer events, and `fireEvent.click` opens one without ever
 * committing a choice.
 */
import type {
  CatalogObjectPage,
  CatalogSnapshot,
  SnapshotRef,
} from '@dudousxd/nestjs-catalog/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ObjectExplorer } from './ObjectExplorer';
import { CatalogProvider, type CatalogTransport } from './context';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

interface Call {
  path: string;
  params?: Record<string, unknown> | undefined;
}

function fakeTransport(answers: Record<string, unknown>) {
  const calls: Call[] = [];
  // The transport is generic on its response and a fixture map cannot be; `any` here is what lets
  // the fake satisfy `<T>(path) => Promise<T>` without an assertion. Same trick as screens.spec.
  // biome-ignore lint/suspicious/noExplicitAny: see above — the seam under test is generic.
  const answer = (path: string): Promise<any> => {
    if (!(path in answers)) return Promise.reject(new Error(`No fake answer for ${path}`));
    const value = answers[path];
    const resolved = typeof value === 'function' ? value() : value;
    return resolved instanceof Error ? Promise.reject(resolved) : Promise.resolve(resolved);
  };

  const transport: CatalogTransport = {
    get: (path, params) => {
      calls.push({ path, params });
      return answer(path);
    },
    post: (path) => answer(path),
    patch: (path) => answer(path),
    delete: (path) => answer(path),
  };

  return {
    transport,
    calls,
    lastCallTo: (path: string) => calls.filter((c) => c.path === path).at(-1),
  };
}

function withCatalog(transport: CatalogTransport, children: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <CatalogProvider transport={transport}>{children}</CatalogProvider>
    </QueryClientProvider>
  );
}

const CATALOG: CatalogSnapshot = {
  version: 1,
  generatedAt: '2026-01-01T00:00:00.000Z',
  stats: { types: 1, properties: 3, relations: 0, enrichedTypes: 1 },
  types: [
    {
      name: 'Mvr',
      displayName: 'Vehicle',
      pluralDisplayName: 'Vehicles',
      tableName: 'obj_mvr',
      group: 'Fleet',
      primaryKey: ['Asset_Id'],
      enriched: true,
      properties: [],
      relations: [],
    },
  ],
};

/**
 * A page whose columns carry what the server will accept.
 *
 * `Asset_Id` is the property and `Asset Id` is how the source spelled it — the
 * pair this screen has to keep straight, and the reason the two are separate
 * fields at all.
 */
function page(overrides: Partial<CatalogObjectPage> = {}): CatalogObjectPage {
  return {
    type: 'Mvr',
    page: 1,
    size: 25,
    total: 1,
    pages: 1,
    columns: [
      {
        name: 'Asset_Id',
        displayName: 'Asset',
        type: 'string',
        columnName: 'Asset Id',
        filterOperators: ['contains', 'eq', 'ne', 'empty', 'notEmpty'],
      },
      {
        name: 'miles',
        displayName: 'Miles',
        type: 'number',
        columnName: 'miles',
        filterOperators: ['eq', 'ne', 'gte', 'lte', 'gt', 'lt', 'empty', 'notEmpty'],
      },
      {
        name: 'operator',
        displayName: 'Operator',
        type: 'string',
        columnName: 'operator',
        classification: 'CUI',
        filterOperators: [],
      },
    ],
    rows: [{ Asset_Id: 'A-71', miles: 1200, operator: 'redacted' }],
    snapshot: { id: 'run-9', current: true },
    ...overrides,
  };
}

const SNAPSHOTS: SnapshotRef[] = [
  { id: 'run-9', createdAt: '2026-03-04T09:00:00.000Z', rowCount: 40_000, principalId: 'loader' },
  { id: 'run-4', createdAt: '2026-02-25T09:00:00.000Z', rowCount: 39_880, principalId: 'loader' },
];

/**
 * Opens a Base UI select by its label and chooses the first option whose text
 * starts with what was asked for.
 *
 * Scoped to the popup's options rather than to text anywhere on the page: a
 * column's display name is also in the table header, and an unscoped query
 * matches both and fails as "multiple elements" — which reads like a duplicate
 * render rather than an over-broad query.
 */
async function choose(label: string, startsWith: string) {
  const user = userEvent.setup();
  await user.click(screen.getByLabelText(label));
  const options = await screen.findAllByRole('option');
  const match = options.find((option) => (option.textContent ?? '').startsWith(startsWith));
  if (!match) {
    throw new Error(
      `No option starting with "${startsWith}". Got: ${options
        .map((option) => option.textContent)
        .join(' | ')}`,
    );
  }
  await user.click(match);
}

/** The text of every option in the open popup. */
async function openOptions(label: string): Promise<string[]> {
  const user = userEvent.setup();
  await user.click(screen.getByLabelText(label));
  const options = await screen.findAllByRole('option');
  return options.map((option) => option.textContent ?? '');
}

describe('filters derived from the type', () => {
  it('offers a filter for every column the server said can take one, and none it did not', async () => {
    const { transport } = fakeTransport({
      '/catalog': CATALOG,
      '/catalog/objects/Mvr': page(),
      '/catalog/objects/Mvr/snapshots': [],
    });

    render(withCatalog(transport, <ObjectExplorer type="Mvr" />));
    await screen.findByText('A-71');
    const offered = await openOptions('Add a filter');

    // Derived: nothing in the component names a column. `operator` is classified
    // and the server sent it no operators, so it is not on offer.
    expect(offered.some((text) => text.startsWith('Asset'))).toBe(true);
    expect(offered.some((text) => text.startsWith('Miles'))).toBe(true);
    expect(offered.some((text) => text.startsWith('Operator'))).toBe(false);
  });

  it('sends the property name, not the spelling the source used', async () => {
    const { transport, lastCallTo } = fakeTransport({
      '/catalog': CATALOG,
      '/catalog/objects/Mvr': page(),
      '/catalog/objects/Mvr/snapshots': [],
    });

    render(withCatalog(transport, <ObjectExplorer type="Mvr" />));
    await screen.findByText('A-71');
    await choose('Add a filter', 'Asset');
    fireEvent.change(await screen.findByLabelText('Value for Asset'), {
      target: { value: 'A-7' },
    });

    // `Asset_Id`, which is what resolves against the type. `Asset Id` — the
    // source column, and what the reader recognises — resolves to nothing.
    await waitFor(() =>
      expect(lastCallTo('/catalog/objects/Mvr')?.params).toMatchObject({
        filter: ['Asset_Id:contains:A-7'],
      }),
    );
  });

  it('shows the source spelling so the column is recognisable', async () => {
    const { transport } = fakeTransport({
      '/catalog': CATALOG,
      '/catalog/objects/Mvr': page(),
      '/catalog/objects/Mvr/snapshots': [],
    });

    render(withCatalog(transport, <ObjectExplorer type="Mvr" />));

    // Both halves of the split, in the header: the property name for whoever is
    // writing SQL, the source name for whoever sent the file.
    expect(await screen.findByText(/Asset_Id ← Asset Id/)).toBeDefined();
  });

  it('offers a number the range ends, as two filters that compose', async () => {
    const { transport, lastCallTo } = fakeTransport({
      '/catalog': CATALOG,
      '/catalog/objects/Mvr': page(),
      '/catalog/objects/Mvr/snapshots': [],
    });

    render(withCatalog(transport, <ObjectExplorer type="Mvr" />));
    await screen.findByText('A-71');
    await choose('Add a filter', 'Miles');
    await choose('Operator for Miles', 'is at least');
    fireEvent.change(screen.getByLabelText('Value for Miles'), { target: { value: '1000' } });

    await waitFor(() =>
      expect(lastCallTo('/catalog/objects/Mvr')?.params).toMatchObject({
        filter: ['miles:gte:1000'],
      }),
    );
  });

  it('holds back a value that is not of the column’s type, and says so', async () => {
    const { transport, lastCallTo } = fakeTransport({
      '/catalog': CATALOG,
      '/catalog/objects/Mvr': page(),
      '/catalog/objects/Mvr/snapshots': [],
    });

    render(withCatalog(transport, <ObjectExplorer type="Mvr" />));
    await screen.findByText('A-71');
    await choose('Add a filter', 'Miles');
    fireEvent.change(screen.getByLabelText('Value for Miles'), { target: { value: 'abc' } });
    // A second, valid filter beside it. Without one there is nothing to wait for
    // — "no filter has been sent yet" is also true a millisecond after typing,
    // and the assertion would pass whether or not the bad value was held back.
    await choose('Add a filter', 'Asset');
    fireEvent.change(screen.getByLabelText('Value for Asset'), { target: { value: 'A-7' } });

    // Not applied, and not silently: `miles = abc` is `miles = 0` in MySQL, so
    // sending it would come back as a full page that looks filtered.
    expect(await screen.findByText(/Not applied/)).toBeDefined();
    await waitFor(() =>
      expect(lastCallTo('/catalog/objects/Mvr')?.params?.filter).toEqual(['Asset_Id:contains:A-7']),
    );
  });

  it('asks for nothing filtered until a value has been typed', async () => {
    const { transport, lastCallTo } = fakeTransport({
      '/catalog': CATALOG,
      '/catalog/objects/Mvr': page(),
      '/catalog/objects/Mvr/snapshots': [],
    });

    render(withCatalog(transport, <ObjectExplorer type="Mvr" />));
    await screen.findByText('A-71');
    await choose('Add a filter', 'Asset');

    // A row with an empty box is a filter somebody is in the middle of building.
    expect(lastCallTo('/catalog/objects/Mvr')?.params?.filter).toBeUndefined();
  });

  it('drops the filters when the type changes', async () => {
    const catalog: CatalogSnapshot = {
      ...CATALOG,
      types: [
        ...CATALOG.types,
        {
          ...CATALOG.types[0],
          name: 'Wo',
          displayName: 'Work order',
          pluralDisplayName: 'Work orders',
          tableName: 'obj_wo',
        },
      ],
    };
    const { transport, lastCallTo } = fakeTransport({
      '/catalog': catalog,
      '/catalog/objects/Mvr': page(),
      '/catalog/objects/Wo': page({ type: 'Wo' }),
      '/catalog/objects/Mvr/snapshots': [],
      '/catalog/objects/Wo/snapshots': [],
    });

    render(withCatalog(transport, <ObjectExplorer />));
    await screen.findByText('A-71');
    await choose('Add a filter', 'Asset');
    fireEvent.change(screen.getByLabelText('Value for Asset'), { target: { value: 'A-7' } });
    await waitFor(() => expect(lastCallTo('/catalog/objects/Mvr')?.params?.filter).toBeDefined());

    fireEvent.click(screen.getByText('Vehicles'));
    fireEvent.click(await screen.findByText('Work orders'));

    // `Asset_Id` is a property of the type being left. Carried across it would be
    // refused by the read, and the refusal would be about a type the reader is no
    // longer looking at.
    await waitFor(() => expect(lastCallTo('/catalog/objects/Wo')).toBeDefined());
    expect(lastCallTo('/catalog/objects/Wo')?.params?.filter).toBeUndefined();
  });

  it('offers no controls at all when the server sends no operators', async () => {
    const { transport } = fakeTransport({
      '/catalog': CATALOG,
      '/catalog/objects/Mvr': page({
        columns: [{ name: 'Asset_Id', displayName: 'Asset', type: 'string' }],
      }),
      '/catalog/objects/Mvr/snapshots': [],
    });

    render(withCatalog(transport, <ObjectExplorer type="Mvr" />));
    await screen.findByText('A-71');

    // Absent is read as "not filterable", never as "all of them": a server that
    // predates the field has not been asked, and a control it would refuse is
    // worse than no control.
    expect(screen.queryByLabelText('Add a filter')).toBeNull();
  });

  it('shows the server’s refusal instead of an empty table', async () => {
    const { transport } = fakeTransport({
      '/catalog': CATALOG,
      '/catalog/objects/Mvr': new Error('miles is number and cannot be filtered with contains'),
      '/catalog/objects/Mvr/snapshots': [],
    });

    render(withCatalog(transport, <ObjectExplorer type="Mvr" />));

    // The previous behaviour drew an empty grid, which says "no rows match" for
    // every possible refusal.
    expect(await screen.findByText(/cannot be filtered with contains/)).toBeDefined();
  });
});

describe('the snapshot picker', () => {
  it('reads the current load unless somebody says otherwise', async () => {
    const { transport, lastCallTo } = fakeTransport({
      '/catalog': CATALOG,
      '/catalog/objects/Mvr': page(),
      '/catalog/objects/Mvr/snapshots': SNAPSHOTS,
    });

    render(withCatalog(transport, <ObjectExplorer type="Mvr" />));
    await screen.findByText('A-71');

    expect(lastCallTo('/catalog/objects/Mvr')?.params?.snapshot).toBeUndefined();
    expect(screen.queryByText(/You are reading an earlier load/)).toBeNull();
  });

  it('asks for the load that was picked', async () => {
    const { transport, lastCallTo } = fakeTransport({
      '/catalog': CATALOG,
      '/catalog/objects/Mvr': page({ snapshot: { id: 'run-4', current: false } }),
      '/catalog/objects/Mvr/snapshots': SNAPSHOTS,
    });

    render(withCatalog(transport, <ObjectExplorer type="Mvr" />));
    await screen.findByText('A-71');

    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Load to read'));
    // The options are dated for a person and carry who loaded them and how many
    // rows; what goes on the wire is the id. Index 2 is the older load — index 0
    // is "Current load", which is the default and not what is being tested.
    const options = await screen.findAllByRole('option');
    await user.click(options[2]);

    await waitFor(() => expect(lastCallTo('/catalog/objects/Mvr')?.params?.snapshot).toBe('run-4'));
  });

  it('says unmistakably that these rows are not the current data', async () => {
    const { transport } = fakeTransport({
      '/catalog': CATALOG,
      '/catalog/objects/Mvr': page({ snapshot: { id: 'run-4', current: false } }),
      '/catalog/objects/Mvr/snapshots': SNAPSHOTS,
    });

    render(withCatalog(transport, <ObjectExplorer type="Mvr" />));

    // Driven by what the SERVER said it read, not by this screen's own state —
    // somebody who left the tab open over lunch has no memory of the selection,
    // and stale data that looks live is the failure this exists to prevent.
    const banner = await screen.findByRole('status');
    expect(banner.textContent).toContain('You are reading an earlier load');
    expect(banner.textContent).toContain('loader');
  });

  it('gets back to the current load from the banner', async () => {
    const { transport, calls } = fakeTransport({
      '/catalog': CATALOG,
      '/catalog/objects/Mvr': page({ snapshot: { id: 'run-4', current: false } }),
      '/catalog/objects/Mvr/snapshots': SNAPSHOTS,
    });

    render(withCatalog(transport, <ObjectExplorer type="Mvr" />));
    fireEvent.click(await screen.findByText('Back to the current load'));

    await waitFor(() => {
      const params = calls.filter((call) => call.path === '/catalog/objects/Mvr').at(-1)?.params;
      expect(params?.snapshot).toBeUndefined();
    });
  });

  it('hides itself when the store keeps no history', async () => {
    const { transport } = fakeTransport({
      '/catalog': CATALOG,
      '/catalog/objects/Mvr': page({ snapshot: undefined }),
      '/catalog/objects/Mvr/snapshots': [],
    });

    render(withCatalog(transport, <ObjectExplorer type="Mvr" />));
    await screen.findByText('A-71');

    expect(screen.queryByLabelText('Load to read')).toBeNull();
  });

  it('asks for the list once per type rather than once per page', async () => {
    const { transport, calls } = fakeTransport({
      '/catalog': CATALOG,
      '/catalog/objects/Mvr': page(),
      '/catalog/objects/Mvr/snapshots': SNAPSHOTS,
    });

    render(withCatalog(transport, <ObjectExplorer type="Mvr" />));
    await screen.findByText('A-71');
    fireEvent.click(screen.getByText('Miles'));
    await waitFor(() =>
      expect(calls.filter((call) => call.path === '/catalog/objects/Mvr').length).toBeGreaterThan(
        1,
      ),
    );

    // Sorting refetched the rows. The list of loads is a property of the type and
    // must not be re-asked for with them — a query per keystroke is how a catalog
    // degrades the application it is embedded in.
    expect(calls.filter((call) => call.path === '/catalog/objects/Mvr/snapshots')).toHaveLength(1);
  });
});
