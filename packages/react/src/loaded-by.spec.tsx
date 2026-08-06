// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * "Loaded by": the model screen answering what commits into a type.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `#model` and `#workflows` were siblings with no path between them. A sink node knew exactly
 * which type it committed and nothing took you there; a type said nothing at all about what
 * loaded it. This file holds the half that is a *derivation* rather than a link, and the
 * derivation is the part with teeth: the answer may be empty, may be several, and is never
 * complete, and every one of those three has a way of being told as a comfortable lie.
 *
 * - **Several.** A type can be written by more than one graph, and one graph can commit more than
 *   one type. So the membership test is over the graph's SINKS. A test here points two graphs at
 *   one type precisely because a screen reading the stored `targetType` — one string — passes
 *   every single-loader case and quietly drops the second.
 * - **None.** An empty list must read as "no graph", not as "nothing loads this".
 * - **Incomplete.** An application POSTing to the publish API is a writer no workflow will ever
 *   explain, so the caveat is asserted in BOTH states. It is the one sentence that would be
 *   cheapest to drop and most expensive to be without.
 * - **Named ≠ loaded.** A draft names its type at a sink and is scheduled by nothing. A row that
 *   said only "af_fleet" beside a graph nobody published would be read as "this type refreshes".
 *
 * `toBeChecked` / `toBeDisabled` are NOT available — this repo registers no jest-dom setup, and
 * they throw rather than fail. Nothing here needs them: the assertions are on text and on hrefs.
 */
import type { CatalogWorkflow } from '@dudousxd/nestjs-catalog/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { LoadedBySection, loadersOf } from './LoadedBySection';
import { CatalogProvider, type CatalogTransport } from './context';

declare global {
  // React refuses to believe a test is a test without this, and warns on every state update.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// `screen` queries `document.body`, so a section left mounted makes the NEXT test's queries
// ambiguous — and the failure reads as a duplicate element rather than as a leak.
afterEach(cleanup);

/**
 * A graph with one sink, which is the shape almost every fixture here starts from.
 *
 * `targetType` is set to the sink's type because the wire type requires it, and it is deliberately
 * NOT what the section reads — `sinks` below is the override that pulls the two apart, and the
 * test using it is the one that catches a screen taking the easy road.
 */
function workflow(overrides: Partial<CatalogWorkflow> = {}): CatalogWorkflow {
  return {
    id: 'wf-1',
    name: 'af_fleet',
    status: 'ready',
    enabled: true,
    version: 3,
    graphHash: 'hash-1',
    targetType: 'Mvr',
    createdBy: 'someone',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    nodes: [
      { id: 'src_1', name: 'Feed', kind: 'source', sourceKind: 'http', config: {} },
      { id: 'snk_1', name: 'Out', kind: 'sink', targetType: 'Mvr' },
    ],
    edges: [{ from: 'src_1', to: 'snk_1' }],
    ...overrides,
  };
}

/** The same graph with its sinks replaced, so a graph can commit two types. */
function committing(id: string, name: string, types: string[]): CatalogWorkflow {
  return workflow({
    id,
    name,
    // Still the FIRST type only, exactly as the server stores it. A section reading this field
    // instead of the sinks would report the second type's graph as loading nothing.
    targetType: types[0] ?? '',
    nodes: [
      { id: 'src_1', name: 'Feed', kind: 'source', sourceKind: 'http', config: {} },
      ...types.map((type, index) => ({
        id: `snk_${index + 1}`,
        name: `Out ${index + 1}`,
        kind: 'sink' as const,
        targetType: type,
      })),
    ],
    edges: types.map((_, index) => ({ from: 'src_1', to: `snk_${index + 1}` })),
  });
}

function fakeTransport(answers: Record<string, unknown>) {
  // biome-ignore lint/suspicious/noExplicitAny: the seam under test is generic over its response.
  const answer = (path: string): Promise<any> => {
    if (!(path in answers)) return Promise.reject(new Error(`No fake answer for ${path}`));
    const value = answers[path];
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  };
  const transport: CatalogTransport = {
    get: (path) => answer(path),
    post: (path) => answer(path),
    patch: (path) => answer(path),
    delete: (path) => answer(path),
  };
  return transport;
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

interface MountOptions {
  workflows?: CatalogWorkflow[] | Error;
  typeName?: string;
  displayName?: string;
  /**
   * Set to render the section as a host that mounts NO screen for a graph.
   *
   * A flag rather than `workflowHref: undefined`, because a destructuring default fires on an
   * explicit `undefined` too — so the obvious spelling would silently mount the ordinary case and
   * the "no dead links" test would pass on a screen that never had the omission handled.
   */
  noWorkflowScreen?: boolean;
}

function mount({
  workflows = [],
  typeName = 'Mvr',
  displayName = 'Vehicle',
  noWorkflowScreen = false,
}: MountOptions = {}) {
  const transport = fakeTransport({ '/pipeline/workflows': workflows });
  return render(
    withCatalog(
      transport,
      <LoadedBySection
        typeName={typeName}
        displayName={displayName}
        {...(noWorkflowScreen ? {} : { workflowHref: (id: string) => `#workflows?workflow=${id}` })}
      />,
    ),
  );
}

/**
 * The section, scoped and settled.
 *
 * Scoped because the caveat, the rows and the empty state share one container and the assertions
 * below are about which of them is present. Settled because the heading and its note render
 * immediately, on the loading pass — so a helper that returned as soon as "Loaded by" appeared
 * would hand back a scope holding nothing but "Reading the workflows…", and every `queryBy`
 * asserting an ABSENCE would pass for the wrong reason.
 */
async function section() {
  const heading = await screen.findByText('Loaded by');
  const found = heading.closest('section');
  if (!found) throw new Error('No section around the "Loaded by" heading');
  const scope = within(found);
  await waitFor(() => expect(scope.queryByText(/^Reading the/)).toBeNull());
  return scope;
}

/** The one sentence that must survive every future tidy-up of this section. */
const PUBLISH_CAVEAT = /publish API/;

describe('which graphs commit this type', () => {
  it('reads the SINKS, so a graph committing two types is found under both', async () => {
    // The whole reason `loadersOf` exists. `CatalogWorkflow.targetType` is one string and this
    // fixture's is `Mvr`, so a screen reading it reports nothing at all for `Subwo` — and looks
    // completely healthy on the `Mvr` page while doing it.
    mount({
      workflows: [committing('wf-1', 'af_fleet', ['Mvr', 'Subwo'])],
      typeName: 'Subwo',
      displayName: 'Work order',
    });

    expect(await screen.findByText('af_fleet')).toBeTruthy();
  });

  it('lists every graph, because a type can be written by more than one', async () => {
    mount({
      workflows: [
        committing('wf-1', 'af_fleet', ['Mvr']),
        committing('wf-2', 'vendor_drop', ['Mvr']),
      ],
    });

    const scope = await section();
    expect(scope.getByText('af_fleet')).toBeTruthy();
    expect(scope.getByText('vendor_drop')).toBeTruthy();
    // Both are links, and to different graphs: two rows sharing one href would be a list that
    // reads as several loaders and navigates as one.
    const hrefs = scope.getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual(['#workflows?workflow=wf-1', '#workflows?workflow=wf-2']);
  });

  it('says the other types a graph commits, since a run of it is one read feeding several', async () => {
    mount({ workflows: [committing('wf-1', 'af_fleet', ['Mvr', 'Subwo'])] });

    expect(await screen.findByText('also commits Subwo')).toBeTruthy();
  });

  it('ignores a graph whose sink names some other type', async () => {
    mount({ workflows: [committing('wf-9', 'billing', ['Invoice'])] });

    const scope = await section();
    expect(scope.queryByText('billing')).toBeNull();
    expect(scope.getByText(/No workflow in this catalog commits Vehicle/)).toBeTruthy();
  });

  it('ignores a half-configured sink rather than attaching every draft to one type', async () => {
    // A sink whose type is still blank names nothing. Matching it would put every unfinished
    // graph in the deployment on whichever type the reader happened to open.
    expect(loadersOf([committing('wf-1', 'unfinished', ['', '  '])], 'Mvr')).toEqual([]);
  });
});

describe('naming a type at a sink is not the same as loading it', () => {
  it('says a draft is scheduled by nothing, rather than listing it as a loader', async () => {
    mount({ workflows: [workflow({ status: 'draft' })] });

    const scope = await section();
    expect(scope.getByText('af_fleet')).toBeTruthy();
    expect(scope.getByText(/nobody has published it/)).toBeTruthy();
  });

  it('says a published graph is turned off', async () => {
    mount({ workflows: [workflow({ enabled: false })] });

    expect(await screen.findByText('published, but turned off')).toBeTruthy();
  });

  it('does not imply a schedule that nothing set', async () => {
    mount({ workflows: [workflow()] });

    expect(await screen.findByText(/runs only when somebody starts it/)).toBeTruthy();
  });

  it('names the cron when there is one, because that is the answer to "does this refresh"', async () => {
    mount({ workflows: [workflow({ schedule: '0 4 * * *' })] });

    expect(await screen.findByText('runs on 0 4 * * *')).toBeTruthy();
  });
});

describe('what the list does not know', () => {
  it('keeps the publish-API caveat when the list is EMPTY, so "none" is not read as "nothing"', async () => {
    mount({ workflows: [] });

    const scope = await section();
    expect(scope.getByText(/No workflow in this catalog commits Vehicle/)).toBeTruthy();
    expect(scope.getByText(PUBLISH_CAVEAT)).toBeTruthy();
  });

  it('keeps it when the list is POPULATED, where it is easiest to think the list is the answer', async () => {
    mount({ workflows: [workflow()] });

    const scope = await section();
    expect(scope.getByText('af_fleet')).toBeTruthy();
    expect(scope.getByText(PUBLISH_CAVEAT)).toBeTruthy();
  });

  it('does not claim the list is empty when it could not read it at all', async () => {
    // The failure this must never flatten: a host that mounts no pipeline endpoints, or an
    // account that may not read them, is not a deployment where nothing loads this type. An
    // empty state here would be the screen inventing an answer out of a 404.
    mount({ workflows: new Error('Cannot GET /pipeline/workflows') });

    const scope = await section();
    expect(scope.getByText(/Could not read the workflows/)).toBeTruthy();
    expect(scope.queryByText(/No workflow in this catalog commits/)).toBeNull();
  });
});

describe('where a row goes', () => {
  it('carries an accessible name that says what is on the other side', async () => {
    mount({ workflows: [workflow()] });

    // The bare graph name is a fine label on screen — the heading above supplies the context —
    // and useless read out of a links list, which is the one place this control is announced
    // without it.
    expect(
      await screen.findByRole('link', {
        name: 'af_fleet — open the workflow that commits Vehicle',
      }),
    ).toBeTruthy();
  });

  it('renders a plain row, not a dead link, when the host mounts no screen for a graph', async () => {
    mount({ workflows: [workflow()], noWorkflowScreen: true });

    const scope = await section();
    expect(scope.getByText('af_fleet')).toBeTruthy();
    // A row that looks clickable and is not is worse than a row that does not. `search-console`
    // makes the same call for a kind whose href the host omitted.
    expect(scope.queryAllByRole('link')).toEqual([]);
  });
});
