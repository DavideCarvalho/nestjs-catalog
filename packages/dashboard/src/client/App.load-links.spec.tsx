// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * The two links between `#model` and `#workflows`, followed rather than read.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The two screens were siblings with nothing between them. A sink node knew which type it
 * committed and could not take you there; a type said nothing about what loaded it. The library
 * halves are tested in `packages/react` — `sink-model-link.spec.tsx` for the sink's link,
 * `loaded-by.spec.tsx` for the derivation on the model screen. What neither can hold is whether
 * this console PARSES what they generate, and that is the whole hazard here:
 *
 * `routeFromHash` falls back to `model` for anything it does not recognise. So a link naming a
 * route that does not exist changes the address, changes nothing else, and lands on the model
 * screen — which for the sink's link is the screen it was aiming at anyway. It would look like it
 * worked in every way except being right. That is the exact failure `tabFromHash` was rewritten
 * to fix, and it is why `App.search.spec.tsx` follows each search href instead of reading it, and
 * why nothing below asserts on a string it wrote down itself.
 *
 * The type parameter is the second agreement with nothing enforcing it: the canvas writes
 * `#model?type=<name>` and this console reads `params.get('type')` and hands it to
 * `CatalogManager`. Rename either and the link goes back to landing on the model screen's FIRST
 * type — a screen that renders perfectly under an address promising something else.
 *
 * WHAT THIS FILE CANNOT CATCH, SAID OUT LOUD
 * ------------------------------------------
 * The two directions are not symmetric under the fallback, and pretending otherwise would be the
 * same false comfort the tests exist to remove. `#workflows` is falsifiable: misspell the route and
 * the console lands on the model screen and the tab assertion goes red. `#model` is NOT — the
 * fallback IS its destination, so `#modell?type=Subwo` selects the same tab and, because
 * `paramsFromHash` reads the hash's query whatever the route was, shows the same type. Following it
 * therefore proves the type parameter arrived and proves nothing about the route.
 *
 * That is a fact about this router rather than a gap to be papered over with a string comparison,
 * and it is worth knowing which of these two assertions is load-bearing: for the sink's link it is
 * the PARAMETER, and the mutation that must go red is a renamed `type=`.
 *
 * `toBeChecked` / `toBeDisabled` are NOT available — this repo registers no jest-dom setup, and
 * they throw rather than fail. `toHaveProperty` is the equivalent that works.
 */
import type {
  CatalogSnapshot,
  CatalogWorkflow,
  ResolvedLoadExpectation,
} from '@dudousxd/nestjs-catalog/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCodeSurfaceDom } from '../../../../test/jsdom-code-surface';

declare global {
  // React refuses to believe a test is a test without this, and warns on every state update.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The things the tab strip, the canvas and the SQL editor use that jsdom, having no layout, does
 * not. The canvas additionally needs a DOMMatrix to read its viewport transform through and node
 * dimensions to measure; both are stubbed flat, and nothing below depends on what they return.
 */
installCodeSurfaceDom();
Element.prototype.scrollIntoView = () => {};

class FlatDOMMatrix {
  m22 = 1;
}
Object.defineProperty(globalThis, 'DOMMatrixReadOnly', { value: FlatDOMMatrix, writable: true });
Object.defineProperty(globalThis, 'DOMMatrix', { value: FlatDOMMatrix, writable: true });
Object.defineProperties(globalThis.HTMLElement.prototype, {
  offsetHeight: { get: () => 80, configurable: true },
  offsetWidth: { get: () => 224, configurable: true },
});
Object.defineProperty(globalThis.SVGElement.prototype, 'getBBox', {
  value: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  configurable: true,
});

/**
 * Told before `App` is imported, because the flag is read at module scope — setting it after a
 * static import would render a sign-in form instead of a console in every test here.
 */
Object.assign(window, { __CATALOG_HOST_AUTH__: true });
const { App } = await import('./App');

/**
 * Two types, and the one the links name is deliberately NOT first.
 *
 * With one type every test here passes on a console that drops the parameter entirely, because
 * the default and the answer are the same row. `Subwo` being second is the whole experiment —
 * exactly the shape `App.deep-links.spec.tsx` uses for its second saved query.
 */
const SNAPSHOT: CatalogSnapshot = {
  version: 1,
  generatedAt: '2026-01-01T00:00:00.000Z',
  stats: { types: 2, properties: 0, relations: 0, enrichedTypes: 2 },
  types: [
    {
      name: 'Mvr',
      displayName: 'Vehicle',
      pluralDisplayName: 'Vehicles',
      tableName: 'mvr',
      group: 'Fleet',
      primaryKey: ['id'],
      enriched: true,
      properties: [],
      relations: [],
    },
    {
      name: 'Subwo',
      displayName: 'Work order',
      pluralDisplayName: 'Work orders',
      tableName: 'subwo',
      group: 'Fleet',
      primaryKey: ['id'],
      enriched: true,
      properties: [],
      relations: [],
    },
  ],
};

/** One graph, one source, one sink committing the SECOND type. */
const AF_FLEET: CatalogWorkflow = {
  id: 'wf-1',
  name: 'af_fleet',
  status: 'ready',
  enabled: true,
  version: 1,
  graphHash: 'hash-1',
  targetType: 'Subwo',
  createdBy: 'someone',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  nodes: [
    {
      id: 'src_1',
      name: 'Feed',
      kind: 'source',
      sourceKind: 'http',
      config: {},
      position: { x: 0, y: 0 },
    },
    {
      id: 'snk_1',
      name: 'Orders out',
      kind: 'sink',
      targetType: 'Subwo',
      position: { x: 320, y: 0 },
    },
  ],
  edges: [{ from: 'src_1', to: 'snk_1' }],
};

/**
 * Nothing declared about how this type reconciles deletes.
 *
 * The type panel's other pipeline-backed section reads this, and it is answered properly rather
 * than left to the empty-list default below: it takes an OBJECT, and `[]` reaches
 * `view.resolved.deletes` as `undefined.deletes` — which throws inside a render and lands as an
 * unhandled rejection, so vitest exits non-zero with every case still reporting green.
 */
const NO_EXPECTATION: ResolvedLoadExpectation = {
  typeName: 'Subwo',
  resolved: {},
  deletesFrom: 'none',
  rowCountFrom: 'default',
  hostLocked: { deletes: false, rowCount: false },
};

/**
 * The whole API this console talks to, answered from memory.
 *
 * Everything unrecognised answers an empty LIST, so a screen a link arrives at renders its
 * "nothing here yet" state rather than dying on `undefined.map`. A test about where a link goes
 * should not fail because the screen it arrives at grew a call.
 */
const ANSWERS: Record<string, unknown> = {
  '/api/catalog': SNAPSHOT,
  '/api/auth/me': { kind: 'user', principalId: 'p-1' },
  '/api/query-ai/capabilities': { available: false, provider: null },
  '/api/pipeline/workflows': [AF_FLEET],
  '/api/pipeline/capabilities': {
    languages: ['javascript'],
    pythonPackages: [],
    durable: { available: true },
  },
};

function stubFetch() {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input), window.location.origin);
    const body = (() => {
      if (url.pathname in ANSWERS) return ANSWERS[url.pathname];
      // Per type, so one entry cannot serve both — and the name is echoed back, because the
      // section renders it.
      if (url.pathname.startsWith('/api/pipeline/expectations/')) {
        const typeName = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
        return { ...NO_EXPECTATION, typeName };
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Moves the address bar, and lets the console's `hashchange` listener catch up. */
async function navigate(hash: string) {
  await act(async () => {
    window.location.hash = hash;
    await sleep(0);
  });
}

/** Which tab the console believes it is on, which is the thing a bad route hides. */
async function expectTab(name: string) {
  await waitFor(() =>
    expect(screen.getByRole('tab', { name })).toHaveProperty('ariaSelected', 'true'),
  );
}

describe('from a sink to the type it commits', () => {
  it('lands on the model screen, showing the type the sink named', async () => {
    await navigate('#workflows');
    renderConsole();

    // Open the sink's inspector from the wiring rail — jsdom does no layout, so React Flow's own
    // nodes are 0×0 and the rail is the same `onInspect`. The rail renders before the graph
    // arrives, so the wait is on the NODE rather than on the rail: finding the container proves
    // only that the canvas mounted.
    const rail = within(await screen.findByLabelText('Workflow wiring and problems'));
    await waitFor(() => expect(rail.getAllByText('Orders out').length).toBeGreaterThan(0));
    fireEvent.click(rail.getAllByText('Orders out')[0]);

    const link = await screen.findByRole('link', { name: 'Open Subwo on the model screen' });
    const href = link.getAttribute('href') ?? '';

    // Followed rather than read. `routeFromHash` answers `model` for anything it cannot parse, so
    // a link with a typo in the route would still land on the model screen and read as working —
    // which is why the type below, and not merely the tab, is what is asserted.
    await navigate(href);
    await expectTab('Model');

    // `Subwo` is the SECOND type in the catalog. A console that dropped the parameter would show
    // "Vehicle" here, under an address naming the work order, and look perfectly healthy.
    //
    // Asserted through the detail pane's own explorer link, which carries the type's plural name.
    // The type's title is an `EditableField` rather than a heading — it has to be clickable to be
    // renamed — so there is no `role="heading"` to match on, and the link is the one control on
    // the pane that is unambiguously about the type being shown.
    expect(await screen.findByRole('link', { name: /Open Work orders/ })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Open Vehicles/ })).toBeNull();
  });

  it('follows a SECOND link without a reload, which is what the prop is for', async () => {
    // The case that separates the `type` prop from the library's own URL sniffing. `CatalogManager`
    // falls back to reading `?type=` off the hash, so a console that passed nothing still lands
    // correctly on ARRIVAL — and then never moves again, because that fallback only fires while
    // nothing is selected. A graph with two sinks links to two types, and pressing the second one
    // on a console already showing the first is the ordinary way to use this.
    await navigate('#model?type=Mvr');
    renderConsole();
    expect(await screen.findByRole('link', { name: /Open Vehicles/ })).toBeTruthy();

    await navigate('#model?type=Subwo');

    expect(await screen.findByRole('link', { name: /Open Work orders/ })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Open Vehicles/ })).toBeNull();
  });

  it('says so when the sink names a type nothing has published yet', async () => {
    // A sink may commit into a type that does not exist — that is how a type comes to exist at
    // all. The link is therefore holdable before its destination is, and the model screen must
    // not answer it with an unrelated type: `?? types[0]` used to, silently.
    await navigate('#model?type=Fleet');
    renderConsole();

    const note = await screen.findByText(/Nothing in this catalog is called/);
    // Scoped to that sentence: "Fleet" is also the GROUP both fixture types are filed under, so an
    // unscoped query matches the sidebar heading and fails as a duplicate — which reads like a
    // rendering bug rather than an over-broad query. The dead name has to be echoed somewhere,
    // because it is the only evidence left of which link broke.
    expect(within(note).getByText('Fleet')).toBeTruthy();
    // And emphatically not the first type instead, which is what `?? types[0]` used to do.
    expect(screen.queryByRole('link', { name: /Open Vehicles/ })).toBeNull();
  });
});

describe('from a type to what loads it', () => {
  it('names the graph whose sink commits it, on the type screen', async () => {
    await navigate('#model?type=Subwo');
    renderConsole();

    // The question the maintainer actually asked, answered on the type's own page.
    expect(await screen.findByRole('link', { name: /^af_fleet —/ })).toBeTruthy();
  });

  it('lands on the workflow canvas, and not on the model screen by fallback', async () => {
    await navigate('#model?type=Subwo');
    renderConsole();

    const link = await screen.findByRole('link', { name: /^af_fleet —/ });
    const href = link.getAttribute('href') ?? '';

    await navigate(href);

    // The assertion the whole file is for. `#workflows` parses; `#workflow` would not, and would
    // land back on the model screen — the address changed, the screen did not, and the reader is
    // looking at the page they pressed the link on.
    await expectTab('Workflows');
    expect(await screen.findAllByText('af_fleet')).toBeTruthy();
  });

  it('says no graph commits a type nothing loads, without claiming nothing writes it', async () => {
    // `Mvr` has no workflow behind it here. "No workflow commits this" is the true statement; "no
    // load ever touches this" is not, because an application with a key can publish straight in.
    await navigate('#model?type=Mvr');
    renderConsole();

    expect(await screen.findByText(/No workflow in this catalog commits Vehicle/)).toBeTruthy();
    expect(screen.getByText(/publish API/)).toBeTruthy();
  });
});
