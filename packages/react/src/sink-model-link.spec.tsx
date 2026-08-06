// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * The other direction: a sink saying where the type it commits lives.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A sink node has always known exactly which object type it writes, and the canvas has never done
 * anything with that knowledge except store it. So "there is an `af_fleet` workflow — how is it
 * tied to the model?" had no answer on this screen at all, and the only way across was to read the
 * type name off the picker and go and find it by hand.
 *
 * A file of its own rather than more cases in `workflow-canvas.spec.tsx`, deliberately: that file
 * is where the canvas's structure is asserted and is under active work on two other branches, and
 * this is one prop threaded to one inspector. Keeping them apart is what makes both rebasable.
 *
 * WHAT IS ACTUALLY WORTH ASSERTING
 * --------------------------------
 * The href itself is one line and the interesting cases are the ones where a link would be a lie:
 *
 * - **A sink with no type chosen.** `targetType` starts as the empty string. `#model?type=` names
 *   nothing, and the model screen's fallback is its first type — so the link would land somewhere
 *   plausible and unrelated, which is indistinguishable from working.
 * - **A host with no model screen.** Omitting `modelHref` must produce no link at all, not an
 *   anchor to nowhere.
 * - **Following the type that is CHOSEN**, not the one the workflow record happens to store:
 *   `CatalogWorkflow.targetType` is one string, and a graph may have two sinks.
 *
 * jsdom does no layout, so React Flow's measurements are stubbed below and nothing here asserts on
 * geometry. `toBeChecked` / `toBeDisabled` are NOT available — this repo registers no jest-dom
 * setup, and they throw rather than fail.
 */
import type { CatalogWorkflow } from '@dudousxd/nestjs-catalog/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { installCodeSurfaceDom } from '../../../test/jsdom-code-surface';
import { WorkflowCanvas } from './WorkflowCanvas';
import { CatalogProvider, type CatalogTransport } from './context';

// The canvas can open a transform's code, and the editor is a real code surface — canvas metrics,
// a firing ResizeObserver, constructable stylesheets. Without the shim React throws
// `sheet.replaceSync is not a function` during render, which lands as an UNHANDLED rejection
// rather than a failing test: vitest exits non-zero with every case still green.
installCodeSurfaceDom();

declare global {
  // React refuses to believe a test is a test without this, and warns on every state update.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * What React Flow and Base UI reach for that jsdom, doing no layout, does not implement.
 *
 * All measurement, so none of it can have an observable effect here — it is stubbed so the canvas
 * mounts, and nothing below depends on what any of it returns. `installCodeSurfaceDom` above
 * supplies a `ResizeObserver` that actually fires, which React Flow is content with.
 */
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

// `screen` queries `document.body`, so a canvas left mounted makes the NEXT test's queries
// ambiguous — and the failure reads as a duplicate element rather than as a leak.
afterEach(cleanup);

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
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <CatalogProvider transport={transport}>{children}</CatalogProvider>
    </QueryClientProvider>
  );
}

/**
 * A source into two sinks, committing two different types.
 *
 * Two sinks and not one, because `CatalogWorkflow.targetType` below is `Mvr` and only one of the
 * two matches it — so a link built from the workflow record rather than from the node being
 * inspected gets the second sink wrong while looking right on the first.
 */
function twoSinkWorkflow(overrides: Partial<CatalogWorkflow> = {}): CatalogWorkflow {
  return {
    id: 'wf-1',
    name: 'af_fleet',
    status: 'ready',
    enabled: true,
    version: 1,
    graphHash: 'hash-1',
    targetType: 'Mvr',
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
        name: 'Vehicles out',
        kind: 'sink',
        targetType: 'Mvr',
        position: { x: 320, y: 0 },
      },
      {
        id: 'snk_2',
        name: 'Orders out',
        kind: 'sink',
        targetType: 'Subwo',
        position: { x: 320, y: 160 },
      },
    ],
    edges: [
      { from: 'src_1', to: 'snk_1' },
      { from: 'src_1', to: 'snk_2' },
    ],
    ...overrides,
  };
}

/** A sink nobody has finished: it is on the graph and names no type at all. */
function unconfiguredSinkWorkflow(): CatalogWorkflow {
  return twoSinkWorkflow({
    targetType: '',
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
        name: 'Vehicles out',
        kind: 'sink',
        targetType: '',
        position: { x: 320, y: 0 },
      },
    ],
    edges: [{ from: 'src_1', to: 'snk_1' }],
  });
}

const CATALOG = {
  version: 1,
  generatedAt: '2026-01-01T00:00:00.000Z',
  stats: { types: 1, properties: 0, relations: 0, enrichedTypes: 1 },
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
  ],
};

function answersFor(workflows: CatalogWorkflow[]): Record<string, unknown> {
  return {
    '/pipeline/workflows': workflows,
    '/pipeline/transforms': [],
    '/pipeline/connections': [],
    '/pipeline/capabilities': {
      languages: ['javascript'],
      pythonPackages: [],
      durable: { available: true },
    },
    '/catalog': CATALOG,
  };
}

/** Mount the canvas, with or without a host that has a model screen. */
async function openCanvas(workflows: CatalogWorkflow[], withModelScreen = true) {
  const transport = fakeTransport(answersFor(workflows));
  render(
    withCatalog(
      transport,
      <WorkflowCanvas
        {...(withModelScreen
          ? { modelHref: (type: string) => `#model?type=${encodeURIComponent(type)}` }
          : {})}
      />,
    ),
  );
  await screen.findAllByText('Feed');
}

/**
 * Open one node's inspector from the wiring rail.
 *
 * Through the rail rather than the canvas node, because jsdom does no layout and React Flow's
 * nodes are 0×0 — the rail is the same `onInspect` and is a plain list of buttons.
 */
function inspect(nodeName: string) {
  const rail = within(screen.getByLabelText('Workflow wiring and problems'));
  fireEvent.click(rail.getAllByText(nodeName)[0]);
}

function inspector() {
  return within(screen.getByRole('dialog'));
}

describe("a sink's way out to the type it commits", () => {
  it('links to the type this node names, not the one the workflow record stores', async () => {
    await openCanvas([twoSinkWorkflow()]);

    inspect('Orders out');

    // `Subwo`, from the node. The workflow's own `targetType` is `Mvr`, which is what a link
    // derived from the record would have produced — right on one sink, wrong on the other, and
    // wrong in a way that lands on a real type and looks entirely fine.
    const link = await screen.findByRole('link', { name: 'Open Subwo on the model screen' });
    expect(link.getAttribute('href')).toBe('#model?type=Subwo');
  });

  it('links to the other sink from the other sink, which is what makes it per-node', async () => {
    await openCanvas([twoSinkWorkflow()]);

    inspect('Vehicles out');

    const link = await screen.findByRole('link', { name: 'Open Mvr on the model screen' });
    expect(link.getAttribute('href')).toBe('#model?type=Mvr');
  });

  it('offers nothing when the sink has not been told what it commits', async () => {
    // `#model?type=` names nothing, and the model screen falls back to its first type — so this
    // link would open an unrelated type and be indistinguishable from one that worked. Absent is
    // the only honest state for a control with nothing behind it, which is the same call the
    // transform inspector makes about "Open the code".
    await openCanvas([unconfiguredSinkWorkflow()]);

    inspect('Vehicles out');

    await waitFor(() => expect(inspector().getByLabelText(/^Name/)).toBeDefined());
    expect(inspector().queryByRole('link')).toBeNull();
  });

  it('offers nothing when the host mounts no model screen', async () => {
    await openCanvas([twoSinkWorkflow()], false);

    inspect('Vehicles out');

    await waitFor(() => expect(inspector().getByLabelText(/^Name/)).toBeDefined());
    expect(inspector().queryByRole('link')).toBeNull();
  });
});
