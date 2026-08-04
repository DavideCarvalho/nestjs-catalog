// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * The embed components, rendered for real against a fake `CatalogTransport`.
 *
 * WHAT THESE TESTS ARE FOR
 * ------------------------
 * An embed is a chart in an application this project does not own, shown to people this project
 * did not authenticate. The whole design is a subtraction — no refresh, no delete, no width
 * picker, no library picker, no drag handle — and a subtraction has no compile error to protect
 * it. Somebody reusing the console's card and forgetting to strip a control would ship a button
 * that re-runs a query from a stranger's page, past whatever caching the host put in front of it,
 * and nothing would fail.
 *
 * So the assertions are mostly about what is NOT on screen, and they are written against the
 * accessible name rather than the class: a refresh control that arrives under a new icon, or a
 * delete that arrives as a link instead of a button, has to fail these too.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogProvider, type CatalogTransport } from '../context';
import { EmbeddedChart } from './EmbeddedChart';
import { EmbeddedDashboard } from './EmbeddedDashboard';
import { type EmbedActions, resolveEmbedActions } from './actions';
import type { EmbeddedChartPayload } from './payload';

declare global {
  // React refuses to believe a test is a test without this, and warns on every state update.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

interface Fake {
  transport: CatalogTransport;
  paths: string[];
}

/** Answers GETs from a path→value map, and records what was asked for. */
function fakeTransport(answers: Record<string, unknown>): Fake {
  const paths: string[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: `CatalogTransport` is generic on the response and a fixture map cannot be.
  const answer = (path: string): Promise<any> => {
    paths.push(path);
    if (!(path in answers)) return Promise.reject(new Error(`No fake answer for ${path}`));
    const value = answers[path];
    if (value instanceof Error) return Promise.reject(value);
    // A never-settling promise is how a test holds a component in its loading state.
    if (value instanceof Promise) return value;
    return Promise.resolve(value);
  };

  return {
    paths,
    transport: {
      get: (path) => answer(path),
      post: (path) => answer(path),
      patch: (path) => answer(path),
      delete: (path) => answer(path),
    },
  };
}

function mount(transport: CatalogTransport, children: ReactNode) {
  const queryClient = new QueryClient({
    // No retries: a refusal should reach the screen once, not four times over 30 seconds.
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CatalogProvider transport={transport}>{children}</CatalogProvider>
    </QueryClientProvider>,
  );
}

function chartPayload(overrides: Partial<EmbeddedChartPayload> = {}): EmbeddedChartPayload {
  return {
    id: 'q1',
    title: 'Sorties by unit',
    visualization: { kind: 'bar' },
    columns: ['unit', 'n'],
    rows: [{ unit: '21st', n: 4 }],
    rowCount: 1,
    cached: false,
    generatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const CHART_PATH = '/catalog/embed/charts/q1';
const DASHBOARD_PATH = '/catalog/embed/dashboards/d1';

/**
 * Every control the console has and an embed must not: the accessible names of the refresh,
 * delete, reorder, width and library controls on `DashboardBoard`'s card.
 */
const AUTHORING = /refresh|run again|remove|delete|reorder|drag|width|library|add|new/i;

describe('what an embedded chart offers', () => {
  it('draws no controls at all when the host asked for none', async () => {
    // THE default. A host that drops this into a page gets a chart and nothing else — no button
    // it has to style away, and nothing a reader can press that the catalog's operators did not
    // decide to expose.
    const { transport } = fakeTransport({ [CHART_PATH]: chartPayload() });
    mount(transport, <EmbeddedChart chartId="q1" />);

    await screen.findByText('Sorties by unit');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it("draws nothing for an explicit 'none' either", async () => {
    const { transport } = fakeTransport({ [CHART_PATH]: chartPayload() });
    mount(transport, <EmbeddedChart chartId="q1" actions="none" />);

    await screen.findByText('Sorties by unit');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('draws the CSV download when the host asks for it, pointing at the export endpoint', async () => {
    const { transport } = fakeTransport({ [CHART_PATH]: chartPayload() });
    // Where the HOST said its API lives. This assertion used to read
    // `/api/catalog/...` and pass against a transport that had never been asked
    // — `exportUrl` hardcoded the prefix — which made this test a record of the
    // bug rather than of the behaviour. An embed runs inside somebody else's
    // page by definition, so `/api` was wrong for every host but the console.
    const routed: CatalogTransport = { ...transport, url: (path) => `/gateway/v2${path}` };
    mount(routed, <EmbeddedChart chartId="q1" actions={['csv']} />);

    const link = await screen.findByRole('link', { name: 'Download CSV' });
    // The saved query's own export, because an embedded chart IS a saved query — a second
    // endpoint would be a second answer to "what is in this chart".
    expect(link.getAttribute('href')).toBe('/gateway/v2/catalog/saved-queries/q1/export.csv');
  });

  it("draws only what exists under 'all'", async () => {
    // `'all'` is a promise about the set, so it has to be exactly the set. If a member is added
    // to `EmbedAction` before anything draws it, this is the test that says so.
    const { transport } = fakeTransport({ [CHART_PATH]: chartPayload() });
    mount(transport, <EmbeddedChart chartId="q1" actions="all" />);

    await screen.findByText('Sorties by unit');
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('aria-label')).toBe('Download CSV');
  });

  const everyConfig: Array<{ label: string; actions?: EmbedActions }> = [
    { label: 'unset' },
    { label: 'none', actions: 'none' },
    { label: 'all', actions: 'all' },
    { label: 'csv', actions: ['csv'] },
  ];

  it.each(everyConfig)('reaches no authoring control under actions=$label', async ({ actions }) => {
    // The subtraction, asserted directly. Every name in `AUTHORING` is a control the console's
    // card has, and none of them may exist here under ANY configuration — an embed that could
    // re-run a query would bypass the host's caching, and one that could delete would let a page
    // the catalog does not control destroy a board.
    const { transport } = fakeTransport({ [CHART_PATH]: chartPayload() });
    mount(transport, <EmbeddedChart chartId="q1" actions={actions} />);

    await screen.findByText('Sorties by unit');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('link', { name: AUTHORING })).toHaveLength(0);
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
  });
});

describe('resolveEmbedActions', () => {
  it('defaults to nothing', () => {
    expect(resolveEmbedActions()).toEqual([]);
  });

  it("answers the whole set for 'all'", () => {
    expect(resolveEmbedActions('all')).toEqual(['csv', 'png', 'pdf']);
  });

  it('keeps what was asked for', () => {
    expect(resolveEmbedActions(['csv'])).toEqual(['csv']);
  });

  it('draws one control for a duplicated action', () => {
    expect(resolveEmbedActions(['csv', 'csv'])).toEqual(['csv']);
  });

  it('drops an action nobody implemented rather than drawing a dead control', () => {
    // @ts-expect-error — the union stops a TypeScript host, but this package is published and
    // plenty of callers compile nothing. 'xlsx' does not exist, so it must not become a button.
    expect(resolveEmbedActions(['csv', 'xlsx'])).toEqual(['csv']);
  });

  it('answers what was ASKED for, not what is possible', () => {
    // Half the answer on purpose. Whether a PNG can be produced depends on the
    // card — the built-in renderer draws divs, so there is no `<svg>` — and a
    // PDF depends on the host having registered an exporter.
    // `useAvailableEmbedActions` decides that per card; splitting the two is
    // what lets the toolbar's switch stay exhaustive while still drawing
    // nothing when an action cannot be performed.
    expect(resolveEmbedActions(['png', 'pdf'])).toEqual(['png', 'pdf']);
  });

  it('offers no PNG when the chart is drawn without an <svg>', async () => {
    // The built-in renderer draws divs, and a table visualization is the same
    // shape: markup, no `<svg>`. So `'all'` gives the CSV link and no PNG.
    const { transport } = fakeTransport({
      [CHART_PATH]: chartPayload({ visualization: { kind: 'table' } }),
    });
    mount(transport, <EmbeddedChart chartId="q1" actions="all" />);

    await screen.findByText('Sorties by unit');
    expect(screen.queryByLabelText('Download PNG')).toBeNull();
    // CSV is a link to the server and needs nothing from the DOM, so it stays.
    expect(screen.getByLabelText('Download CSV')).toBeTruthy();
  });

  // The PDF branch cannot be reached from here at all, and pretending otherwise
  // would be worse than leaving it uncovered. `usePdfExport().available`
  // requires `canRasterise()`, which is false in jsdom because there is no
  // canvas — so no PDF action appears no matter what is registered.
  //
  // I wrote the two obvious tests first — "no PDF without an exporter" and "it
  // appears when a host registers one" — and mutation-checked them: deleting
  // the exporter check entirely left the first one passing. It was decoration,
  // asserting the absence of a control jsdom could never have drawn.
  //
  // What IS covered: `resolveEmbedActions` returns `'pdf'` when asked, above;
  // and `usePdfExport`'s own spec mutation-checks the availability rule against
  // an injected rasteriser. Their composition — this toolbar reading that hook
  // — is the seam only a real browser can test.
});

describe('loading and failure belong to the host', () => {
  it('shows the host node while fetching, not a spinner of its own', async () => {
    const { transport } = fakeTransport({ [CHART_PATH]: new Promise(() => {}) });
    mount(transport, <EmbeddedChart chartId="q1" loading={<p>host is loading</p>} />);

    expect(await screen.findByText('host is loading')).toBeTruthy();
  });

  it('calls the host render prop while fetching', async () => {
    const { transport } = fakeTransport({ [CHART_PATH]: new Promise(() => {}) });
    mount(transport, <EmbeddedChart chartId="q1" loading={() => <p>rendered lazily</p>} />);

    expect(await screen.findByText('rendered lazily')).toBeTruthy();
  });

  it('hands the failure to the host, error and all', async () => {
    const { transport } = fakeTransport({ [CHART_PATH]: new Error('403 not shared') });
    mount(
      transport,
      <EmbeddedChart chartId="q1" failure={(error) => <p>host says: {error.message}</p>} />,
    );

    expect(await screen.findByText('host says: 403 not shared')).toBeTruthy();
  });

  it('offers no retry when it falls back to its own failure state', async () => {
    // The default failure is deliberately given no `onRetry`: a retry is a re-run, and a re-run
    // from an embedded page is the refresh this component does not have.
    const { transport } = fakeTransport({ [CHART_PATH]: new Error('403 not shared') });
    mount(transport, <EmbeddedChart chartId="q1" actions="all" />);

    await screen.findByText('403 not shared');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('an embedded dashboard', () => {
  const board = {
    id: 'd1',
    name: 'Readiness',
    charts: [
      chartPayload({ id: 'c-last', title: 'Last', layout: { width: 2, position: 2 } }),
      chartPayload({ id: 'c-first', title: 'First', layout: { width: 2, position: 0 } }),
      chartPayload({ id: 'c-middle', title: 'Middle', layout: { width: 2, position: 1 } }),
    ],
    generatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('renders its charts in the order the author laid them out', async () => {
    // The payload here arrives scrambled on purpose. The server sorts, but between it and this
    // component sit the host's HTTP client, a proxy and possibly a cache — and a board read in
    // the wrong order is wrong silently, which is the only way this can fail.
    const { transport } = fakeTransport({ [DASHBOARD_PATH]: board });
    mount(transport, <EmbeddedDashboard dashboardId="d1" />);

    await screen.findByText('First');
    const titles = screen.getAllByRole('heading').map((heading) => heading.textContent);
    expect(titles).toEqual(['First', 'Middle', 'Last']);
  });

  it('asks for the whole board once, not once per card', async () => {
    // One request is the contract of the embed API: N would be N database queries fired from a
    // frontend this deployment does not control.
    const fake = fakeTransport({ [DASHBOARD_PATH]: board });
    mount(fake.transport, <EmbeddedDashboard dashboardId="d1" />);

    await screen.findByText('First');
    expect(fake.paths).toEqual([DASHBOARD_PATH]);
  });

  it('gives every card the actions the host asked for, and nothing else', async () => {
    const { transport } = fakeTransport({ [DASHBOARD_PATH]: board });
    mount(transport, <EmbeddedDashboard dashboardId="d1" actions="all" />);

    await screen.findByText('First');
    expect(screen.getAllByRole('link', { name: 'Download CSV' })).toHaveLength(3);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('says a board with nothing shared is empty rather than failed', async () => {
    const { transport } = fakeTransport({
      [DASHBOARD_PATH]: { ...board, charts: [] },
    });
    mount(transport, <EmbeddedDashboard dashboardId="d1" />);

    await waitFor(() =>
      expect(screen.getByText('Nothing on this dashboard has been shared.')).toBeTruthy(),
    );
  });
});
