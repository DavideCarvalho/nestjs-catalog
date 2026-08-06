// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * Wiring two nodes together by clicking twice, which is the whole of the gesture people expect.
 *
 * WHAT WAS WRONG WITH THE ONE THAT SHIPPED
 * ----------------------------------------
 * Nothing you could see. React Flow's `connectOnClick` is on by default and it does connect — but
 * it draws no line while the connection is open, because the line renders from `connection.inProgress`
 * and that flag is only set by the pointer-DRAG path, past a 1px threshold a click never crosses.
 * And it cannot explain a refusal: the state it hands `onClickConnectEnd` after a click has no
 * target in it. So a click on a handle looked exactly like a click on nothing, and an illegal pair
 * looked exactly like a missed one. The gesture is owned by `workflow/wiring.tsx` instead.
 *
 * WHAT IS ASSERTED HERE
 * ---------------------
 * The gesture's OUTCOMES, in the draft and on the screen: that two clicks make an edge, that a
 * refusal is written somewhere a person can read rather than only in the live region, that Escape
 * and the pane put a half-drawn wire away, and that a read-only viewer gets none of it.
 *
 * Not the rubber-band line: it is positioned from `screenToFlowPosition` and `handleBounds`, both
 * of which are measurements, and jsdom measures everything as zero. A test of where that line
 * starts would pass for any answer at all — the same trap `workflow-edge-delete.spec.tsx` documents
 * for the × — so its placement is checked in a browser instead.
 *
 * `installCodeSurfaceDom` ships a `ResizeObserver` that actually fires, which is what lets React
 * Flow measure a node and therefore place an edge. Do not override it here. See the sibling spec.
 */
import type {
  CatalogPropertyDef,
  CatalogSnapshot,
  CatalogWorkflow,
} from '@dudousxd/nestjs-catalog/client';
import { WORKFLOW_NODE_WIDTH, workflowColumnX } from '@dudousxd/nestjs-catalog/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { installCodeSurfaceDom } from '../../../test/jsdom-code-surface';
import { WorkflowCanvas } from './WorkflowCanvas';
import { CatalogProvider, type CatalogTransport } from './context';

installCodeSurfaceDom();

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class FlatDOMMatrix {
  m22 = 1;
}
Object.defineProperty(globalThis, 'DOMMatrixReadOnly', { value: FlatDOMMatrix, writable: true });
Object.defineProperty(globalThis, 'DOMMatrix', { value: FlatDOMMatrix, writable: true });

// React Flow skips a node it measures as 0×0, and jsdom measures everything as 0×0. See the
// sibling spec for the whole story; without this there are no nodes, so no handles to click.
Object.defineProperties(globalThis.HTMLElement.prototype, {
  offsetHeight: { get: () => 80, configurable: true },
  offsetWidth: { get: () => WORKFLOW_NODE_WIDTH, configurable: true },
});
Object.defineProperty(globalThis.SVGElement.prototype, 'getBBox', {
  value: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  configurable: true,
});

afterEach(cleanup);

function fakeTransport(gets: Record<string, unknown>, posts: Record<string, unknown> = {}) {
  // biome-ignore lint/suspicious/noExplicitAny: the seam under test is generic over its response.
  const answer = (from: Record<string, unknown>, path: string): Promise<any> => {
    if (!(path in from)) return Promise.reject(new Error(`No fake answer for ${path}`));
    const value = from[path];
    return Promise.resolve(typeof value === 'function' ? value() : value);
  };
  const transport: CatalogTransport = {
    get: (path) => answer(gets, path),
    post: (path) => answer(path in posts ? posts : gets, path),
    patch: (path) => answer(gets, path),
    delete: (path) => answer(gets, path),
  };
  return transport;
}

function snapshot(properties: CatalogPropertyDef[] = []): CatalogSnapshot {
  return {
    version: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    stats: { types: 1, properties: properties.length, relations: 0, enrichedTypes: 1 },
    types: [
      {
        name: 'Mvr',
        displayName: 'Vehicle',
        pluralDisplayName: 'Vehicles',
        tableName: 'mvr',
        group: 'Fleet',
        primaryKey: ['id'],
        enriched: true,
        properties,
        relations: [],
      },
    ],
  };
}

/**
 * A source, TWO transforms and a sink, with nothing wired — so every legal edge is still available.
 *
 * Two transforms rather than one because a loop needs two nodes that can each feed the other, and
 * a source has no input handle at all: `nodes.tsx` does not render a handle that could never take
 * a connection, so "wire something into the source" is not even a click somebody can make.
 */
function looseWorkflow(overrides: Partial<CatalogWorkflow> = {}): CatalogWorkflow {
  return {
    id: 'wf1',
    name: 'Fleet',
    enabled: true,
    version: 1,
    status: 'draft',
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
        position: { x: workflowColumnX(0), y: 0 },
      },
      {
        id: 'tr_1',
        name: 'Shape',
        kind: 'transform',
        transformId: 'tf_1',
        position: { x: workflowColumnX(1), y: 0 },
      },
      {
        id: 'tr_2',
        name: 'Polish',
        kind: 'transform',
        transformId: 'tf_2',
        position: { x: workflowColumnX(2), y: 0 },
      },
      {
        id: 'snk_1',
        name: 'Out',
        kind: 'sink',
        targetType: 'Mvr',
        position: { x: workflowColumnX(3), y: 0 },
      },
    ],
    edges: [],
    ...overrides,
  };
}

function answersFor(workflows: CatalogWorkflow[]) {
  return {
    '/pipeline/workflows': workflows,
    '/pipeline/transforms': [],
    '/pipeline/connections': [],
    '/pipeline/capabilities': {
      languages: ['javascript'],
      pythonPackages: [],
      durable: { available: true },
    },
    '/catalog': snapshot(),
  };
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

async function openCanvas(transport: CatalogTransport, canEdit = true) {
  render(withCatalog(transport, <WorkflowCanvas canEdit={canEdit} />));
  await screen.findAllByText('Feed');
}

/** A handle, by the name it is announced under. `output of X` is the source end. */
function handle(name: string): HTMLElement {
  return screen.getByLabelText(name);
}

/**
 * A sentence somebody can actually read, as opposed to one only a screen reader gets.
 *
 * The canvas announces everything into an `sr-only` live region, so `getByText` alone would be
 * satisfied by the announcement and would pass with nothing drawn. The whole requirement for the
 * click gesture is that a refusal is VISIBLE — the drag could refuse by turning a handle red under
 * the cursor and a click has no such moment — so this filters the live region out.
 */
function onScreen(pattern: RegExp): HTMLElement[] {
  return screen.queryAllByText(pattern).filter((node) => node.closest('.sr-only') === null);
}

describe('wiring by clicking twice', () => {
  it('connects the two handles that were clicked, with no drag anywhere', async () => {
    const transport = fakeTransport(answersFor([looseWorkflow()]));
    await openCanvas(transport);

    fireEvent.click(handle('output of Feed'));
    fireEvent.click(handle('input of Shape'));

    // Read off the wiring rail rather than off the canvas: the rail lists the DRAFT's connections,
    // which is the thing that gets saved, and a line drawn on a canvas is not evidence of one.
    await waitFor(() => expect(screen.getByLabelText('Disconnect Feed from Shape')).toBeDefined());
  });

  it('connects the same pair when the wire is started from the input end', async () => {
    // Somebody who thinks "this transform needs feeding" starts at the transform. The edge that
    // comes out still runs source → transform, because that is the only direction it can run.
    const transport = fakeTransport(answersFor([looseWorkflow()]));
    await openCanvas(transport);

    fireEvent.click(handle('input of Shape'));
    fireEvent.click(handle('output of Feed'));

    await waitFor(() => expect(screen.getByLabelText('Disconnect Feed from Shape')).toBeDefined());
  });

  it('says on the canvas what it is waiting for, so a started wire is not a dead click', async () => {
    const transport = fakeTransport(answersFor([looseWorkflow()]));
    await openCanvas(transport);

    fireEvent.click(handle('output of Feed'));

    await waitFor(() => expect(onScreen(/Wiring out of/)).toHaveLength(1));
  });
});

describe('a connection the graph will not allow', () => {
  it('refuses a loop in words, on the screen, and does not make the edge', async () => {
    // Shape → Polish, then Polish → Shape. The second closes a loop, which `canConnect` refuses
    // with a sentence — and the whole point of this file is that the sentence is legible to
    // somebody holding a mouse, not only to a screen reader.
    const transport = fakeTransport(
      answersFor([looseWorkflow({ edges: [{ from: 'tr_1', to: 'tr_2' }] })]),
    );
    await openCanvas(transport);

    fireEvent.click(handle('output of Polish'));
    fireEvent.click(handle('input of Shape'));

    await waitFor(() => expect(onScreen(/would close a loop/)).toHaveLength(1));
    expect(screen.queryByLabelText('Disconnect Polish from Shape')).toBeNull();
  });

  it('refuses a second copy of a connection that already exists, and says which', async () => {
    const transport = fakeTransport(
      answersFor([looseWorkflow({ edges: [{ from: 'src_1', to: 'tr_1' }] })]),
    );
    await openCanvas(transport);

    fireEvent.click(handle('output of Feed'));
    fireEvent.click(handle('input of Shape'));

    await waitFor(() => expect(onScreen(/already wired together/)).toHaveLength(1));
  });

  it('keeps the wire in hand after a refusal, so a mistake is one more click and not a restart', async () => {
    // The refusal is information, not a punishment. The next click is very likely the target they
    // actually meant, and cancelling the gesture would make them re-start it to correct it.
    const transport = fakeTransport(
      answersFor([looseWorkflow({ edges: [{ from: 'src_1', to: 'tr_1' }] })]),
    );
    await openCanvas(transport);

    fireEvent.click(handle('output of Feed'));
    fireEvent.click(handle('input of Shape'));
    await waitFor(() => expect(onScreen(/already wired together/)).toHaveLength(1));

    fireEvent.click(handle('input of Out'));

    await waitFor(() => expect(screen.getByLabelText('Disconnect Feed from Out')).toBeDefined());
  });
});

describe('putting a half-drawn wire away', () => {
  it('cancels on Escape', async () => {
    const transport = fakeTransport(answersFor([looseWorkflow()]));
    await openCanvas(transport);

    fireEvent.click(handle('output of Feed'));
    await waitFor(() => expect(onScreen(/Wiring out of/)).toHaveLength(1));

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(onScreen(/Wiring out of/)).toHaveLength(0));
  });

  it('cancels when the same handle is clicked again, which is the natural "never mind"', async () => {
    const transport = fakeTransport(answersFor([looseWorkflow()]));
    await openCanvas(transport);

    fireEvent.click(handle('output of Feed'));
    await waitFor(() => expect(onScreen(/Wiring out of/)).toHaveLength(1));

    fireEvent.click(handle('output of Feed'));

    await waitFor(() => expect(onScreen(/Wiring out of/)).toHaveLength(0));
  });
});

describe('a viewer who cannot edit', () => {
  it('starts no wire at all, rather than one that can never be finished', async () => {
    // The endpoints refuse regardless. This is about not opening a gesture whose only possible
    // ending is a 403.
    const transport = fakeTransport(answersFor([looseWorkflow()]));
    await openCanvas(transport, false);

    fireEvent.click(handle('output of Feed'));
    fireEvent.click(handle('input of Shape'));

    await waitFor(() => expect(onScreen(/Wiring out of/)).toHaveLength(0));
    expect(screen.queryByLabelText('Disconnect Feed from Shape')).toBeNull();
  });
});

describe('reaching the gesture without a pointer', () => {
  it('starts and finishes a wire from the keyboard, because a handle is now a control', async () => {
    // React Flow renders a handle as a plain `<div>`, so the button semantics are stated by the
    // node rather than inherited. A control only a mouse can operate is not one.
    const transport = fakeTransport(answersFor([looseWorkflow()]));
    await openCanvas(transport);

    expect(handle('output of Feed').getAttribute('role')).toBe('button');
    expect(handle('output of Feed').getAttribute('tabindex')).toBe('0');

    fireEvent.keyDown(handle('output of Feed'), { key: 'Enter' });
    fireEvent.keyDown(handle('input of Shape'), { key: 'Enter' });

    await waitFor(() => expect(screen.getByLabelText('Disconnect Feed from Shape')).toBeDefined());
  });
});
