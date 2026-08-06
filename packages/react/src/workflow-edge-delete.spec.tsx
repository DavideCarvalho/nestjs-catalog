// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * Removing a connection by clicking it, and the two things that used to make that impossible.
 *
 * WHY THIS FILE IS SEPARATE FROM `workflow-canvas.spec.tsx`
 * --------------------------------------------------------
 * That file installs a **no-op** `ResizeObserver`, which is right for what it tests and fatal for
 * what this one does. React Flow will not place an edge until it has measured the nodes at both
 * ends, measurement arrives through the observer, and an observer that never fires leaves
 * `handleBounds` null — at which point `EdgeWrapper` renders nothing at all. Every assertion here
 * would then fail with "no such element", which reads like a broken component rather than like a
 * missing shim. `installCodeSurfaceDom` already ships an observer that fires once with a real box,
 * so this file simply does not override it.
 *
 * WHAT IS ASSERTED, AND WHAT CANNOT BE
 * ------------------------------------
 * jsdom does no layout, so nothing here MEASURES where the × landed — every element is 0×0 and a
 * `getBoundingClientRect` assertion would pass for any placement at all, including the broken one.
 * What is checked is what exists, what it is called, what pressing it does to the graph that gets
 * SAVED, and — see "WHERE THE × IS TOLD TO GO" below — the instruction it was given about where to
 * be, read off the element that carries it.
 *
 * `toBeChecked` / `toBeDisabled` are NOT available — this repo registers no jest-dom setup, and
 * they throw rather than fail.
 *
 * WHERE THE × IS TOLD TO GO
 * -------------------------
 * Everything in the first version of this file passed while the × was invisible and unclickable.
 * It was in the document, it had the right accessible name, and clicking it removed the right
 * edge — and it was painted 414px away from its line, underneath a node, because the element that
 * carried `transform: translate(…labelX…, …labelY…)` also animated `scale`, and Motion composes
 * the whole `transform` property from the values it animates. At rest it wrote `transform: none`.
 *
 * So one test here reads the transform. Not the rect: jsdom lays nothing out, and the property
 * under test is not "the button is at coordinates" but "the positioning element still carries the
 * translate after the animated element has mounted and settled" — which is precisely what Motion
 * took away. An inline transform is a string this component wrote, so reading it back is reading
 * the instruction, and the instruction is what went missing.
 *
 * THE PAIR THAT MATTERS
 * ---------------------
 * "The × appears when the connection is selected" and "the connection can be removed without ever
 * reaching the ×" are both here on purpose. If a later change makes the button the only way
 * through, the second goes red — and an affordance that has quietly become the sole route is
 * exactly the regression an animated, pointer-summoned control invites.
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

// Canvas metrics, constructable stylesheets, a firing ResizeObserver and a `matchMedia`. The last
// two are load-bearing here rather than incidental: the observer is what lets an edge exist at all
// (see above), and `matchMedia` answers `matches: false`, which is what makes `useReducedMotion`
// report "no preference" — the branch this file exercises. The reduced branch has its own file.
installCodeSurfaceDom();

declare global {
  // React refuses to believe a test is a test without this, and warns on every state update.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class FlatDOMMatrix {
  m22 = 1;
}
Object.defineProperty(globalThis, 'DOMMatrixReadOnly', { value: FlatDOMMatrix, writable: true });
Object.defineProperty(globalThis, 'DOMMatrix', { value: FlatDOMMatrix, writable: true });

/**
 * A non-zero offset box, which is the shim an edge actually depends on.
 *
 * React Flow **skips** a node whose measured `offsetWidth` or `offsetHeight` is zero, and jsdom
 * reports zero for everything. A skipped node has no handle bounds, an edge with no handle bounds
 * at either end is dropped by `EdgeWrapper` before it renders, and the whole of this file then
 * fails looking for a line that was never drawn. The numbers match the constants the canvas lays
 * out with, so nothing here is measuring anything it made up.
 */
Object.defineProperties(globalThis.HTMLElement.prototype, {
  offsetHeight: { get: () => 80, configurable: true },
  offsetWidth: { get: () => WORKFLOW_NODE_WIDTH, configurable: true },
});
Object.defineProperty(globalThis.SVGElement.prototype, 'getBBox', {
  value: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  configurable: true,
});

afterEach(cleanup);

interface Call {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
}

/** A transport that answers from a path→value map and records every call. See the sibling spec. */
function fakeTransport(gets: Record<string, unknown>, posts: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: the seam under test is generic over its response.
  const answer = (from: Record<string, unknown>, path: string): Promise<any> => {
    if (!(path in from)) return Promise.reject(new Error(`No fake answer for ${path}`));
    const value = from[path];
    return Promise.resolve(typeof value === 'function' ? value() : value);
  };

  const transport: CatalogTransport = {
    get: (path) => {
      calls.push({ method: 'GET', path });
      return answer(gets, path);
    },
    post: (path, body) => {
      calls.push({ method: 'POST', path, body });
      return answer(path in posts ? posts : gets, path);
    },
    patch: (path, body) => {
      calls.push({ method: 'PATCH', path, body });
      return answer(gets, path);
    },
    delete: (path) => {
      calls.push({ method: 'DELETE', path });
      return answer(gets, path);
    },
  };

  const lastPostTo = (path: string) =>
    calls.filter((call) => call.method === 'POST' && call.path === path).at(-1);

  return { transport, lastPostTo };
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

/** A source wired straight into a sink, laid out on the canvas's own column spacing. */
function wholeWorkflow(overrides: Partial<CatalogWorkflow> = {}): CatalogWorkflow {
  return {
    id: 'wf1',
    name: 'Fleet',
    enabled: true,
    version: 1,
    status: 'ready',
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
        id: 'snk_1',
        name: 'Out',
        kind: 'sink',
        targetType: 'Mvr',
        position: { x: workflowColumnX(1), y: 0 },
      },
    ],
    edges: [{ from: 'src_1', to: 'snk_1' }],
    ...overrides,
  };
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

function answersFor(workflows: CatalogWorkflow[], extra: Record<string, unknown> = {}) {
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
    ...extra,
  };
}

async function openCanvas(transport: CatalogTransport, canEdit = true) {
  render(withCatalog(transport, <WorkflowCanvas canEdit={canEdit} />));
  await screen.findAllByText('Feed');
}

/**
 * The connection on the canvas, as the element React Flow makes focusable.
 *
 * By `data-id` rather than by role: React Flow gives an edge `role="group"` and an
 * `aria-roledescription`, and there is no accessible-name query that distinguishes one line from
 * another without restating the label this very file is checking elsewhere.
 */
async function edgeElement(id = 'src_1->snk_1'): Promise<Element> {
  // Awaited rather than read, because an edge appears a tick after its nodes do: React Flow will
  // not place one until the `ResizeObserver` has reported both ends, and the shim reports on a
  // `setTimeout`. Reading synchronously finds the nodes on screen and no edges, which is a race
  // that fails as "no such element" and reads exactly like the component being broken.
  let found: Element | null = null;
  await waitFor(() => {
    found = document.querySelector(`.react-flow__edge[data-id="${id}"]`);
    expect(found, `no edge "${id}" on the canvas`).not.toBeNull();
  });
  if (!found) throw new Error(`No edge "${id}" on the canvas`);
  return found;
}

function removeButtons(): HTMLElement[] {
  return screen.queryAllByLabelText(/^Remove the connection/);
}

function saveButton(): HTMLButtonElement {
  const button = screen.getByText(/^Saved?$/).closest('button');
  if (!(button instanceof HTMLButtonElement)) throw new Error('Save is not a button');
  return button;
}

/** The edges out of a saved body, narrowed field by field rather than asserted. */
function readEdges(body: unknown): Array<{ from: unknown; to: unknown }> {
  if (typeof body !== 'object' || body === null) return [];
  const edges = Reflect.get(body, 'edges');
  if (!Array.isArray(edges)) return [];
  return edges.map((raw) => ({ from: Reflect.get(raw, 'from'), to: Reflect.get(raw, 'to') }));
}

describe('clicking a connection', () => {
  it('offers nothing until it is clicked', async () => {
    // The whole point of putting this on selection rather than on hover: a canvas of six wires
    // must not be a canvas of six delete buttons.
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);
    // Waited for, so this cannot pass by being asked before the connection exists.
    await edgeElement();

    expect(removeButtons()).toHaveLength(0);
  });

  it('offers a control that names both ends of the connection it would remove', async () => {
    // The names, not the ids. "Remove the connection from src_1 to snk_1" names two things nobody
    // on this screen can see, and it is the only description a screen-reader user gets.
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    fireEvent.click(await edgeElement());

    await waitFor(() => expect(removeButtons()).toHaveLength(1));
    expect(removeButtons()[0].getAttribute('aria-label')).toBe(
      'Remove the connection from Feed to Out',
    );
  });

  it('removes that connection from the graph that gets saved', async () => {
    // Asserted on the POST body rather than on the canvas, because the canvas is where an edge can
    // disappear from the picture while still being sent — which is the bug worth catching.
    const { transport, lastPostTo } = fakeTransport(answersFor([wholeWorkflow()]), {
      '/pipeline/workflows': wholeWorkflow({ version: 2, edges: [] }),
    });
    await openCanvas(transport);

    fireEvent.click(await edgeElement());
    await waitFor(() => expect(removeButtons()).toHaveLength(1));
    fireEvent.click(removeButtons()[0]);

    await waitFor(() => expect(screen.getByText('Connection removed.')).toBeDefined());

    fireEvent.click(saveButton());
    await waitFor(() => expect(lastPostTo('/pipeline/workflows')).toBeDefined());
    expect(readEdges(lastPostTo('/pipeline/workflows')?.body)).toEqual([]);
  });

  it('takes its own control away with the connection', async () => {
    // A button hovering over a line that no longer exists is worse than no button: the next thing
    // it points at is whatever React Flow put at those coordinates.
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    fireEvent.click(await edgeElement());
    await waitFor(() => expect(removeButtons()).toHaveLength(1));
    fireEvent.click(removeButtons()[0]);

    await waitFor(() => expect(removeButtons()).toHaveLength(0));
  });

  it('offers nothing at all to a viewer who cannot edit', async () => {
    // The endpoints refuse regardless. This is about not offering a control that always 403s.
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport, false);

    const edge = await edgeElement();
    fireEvent.click(edge);

    // Selection still happens — a read-only viewer may still want to highlight a wire — so this
    // waits for a render to have been given the chance to add the button.
    await waitFor(() => expect(edge.getAttribute('class')).toContain('selected'));
    expect(removeButtons()).toHaveLength(0);
  });
});

describe('reaching the same thing without a pointer', () => {
  it('selects the connection from the keyboard, which is what summons the control', async () => {
    // React Flow makes an edge focusable under `edgesFocusable` and selects it on Enter. That is
    // the whole keyboard route to the ×: Tab to the line, Enter, then Tab to the button.
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    const edge = await edgeElement();
    expect(edge.getAttribute('tabindex')).toBe('0');

    fireEvent.keyDown(edge, { key: 'Enter' });

    await waitFor(() => expect(removeButtons()).toHaveLength(1));
  });

  it('is a real button, so the tab order and Enter reach it like any other', async () => {
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    fireEvent.keyDown(await edgeElement(), { key: 'Enter' });
    await waitFor(() => expect(removeButtons()).toHaveLength(1));

    const control = removeButtons()[0];
    expect(control.tagName).toBe('BUTTON');
    // Not a submit button on a form somebody is filling in, and not removed from the tab order.
    expect(control.getAttribute('type')).toBe('button');
    expect(control.getAttribute('tabindex')).toBeNull();
    expect(control).toHaveProperty('disabled', false);
  });

  it('leaves the wiring rail able to remove the same connection, so the × is never the only way', async () => {
    // The route that predates this whole change, and the one that needs no pointer, no animation
    // and no knowledge that a × exists: the rail lists every connection as a row with a button.
    //
    // This is the half of the pair that keeps the other half honest. A later refactor that made
    // the canvas control the sole route — by dropping the row, or by disabling it once an edge is
    // selected — would leave the screen looking better and operable by fewer people, and this is
    // what goes red.
    const { transport, lastPostTo } = fakeTransport(answersFor([wholeWorkflow()]), {
      '/pipeline/workflows': wholeWorkflow({ version: 2, edges: [] }),
    });
    await openCanvas(transport);
    await edgeElement();

    const viaRail = screen.getByLabelText('Disconnect Feed from Out');
    expect(viaRail.tagName).toBe('BUTTON');
    fireEvent.click(viaRail);

    await waitFor(() => expect(removeButtons()).toHaveLength(0));
    fireEvent.click(saveButton());
    await waitFor(() => expect(lastPostTo('/pipeline/workflows')).toBeDefined());
    expect(readEdges(lastPostTo('/pipeline/workflows')?.body)).toEqual([]);
  });
});

/**
 * The element that says where the × goes, and the translate read back off it.
 *
 * `.nodrag.nopan` is the positioning wrapper — the one React Flow must not treat as canvas to
 * drag, which is the same element the placement belongs on. Found from the button rather than by
 * querying the layer, so a second edge control appearing somewhere else cannot satisfy this.
 */
function placementOf(control: HTMLElement): HTMLElement {
  const wrapper = control.closest('.nodrag.nopan');
  if (!(wrapper instanceof HTMLElement)) throw new Error('The × has no positioning wrapper');
  return wrapper;
}

/** The `translate(Xpx, Ypx)` half of the placement, or null if there is not one. */
function translateIn(transform: string): { x: number; y: number } | null {
  const found = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(transform);
  if (!found) return null;
  return { x: Number(found[1]), y: Number(found[2]) };
}

describe('where the × is placed', () => {
  /**
   * The regression. See "WHERE THE × IS TOLD TO GO" at the top of this file.
   *
   * The property under test is the INLINE TRANSFORM, not a rect: jsdom lays nothing out, so every
   * element here is 0×0 and `getBoundingClientRect` would agree with any placement, including the
   * one that put this control under a node. The transform is a string this component wrote, and
   * the bug was that something else wrote over it.
   */
  it('carries the translate to its own line, on an element no animation composes', async () => {
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    fireEvent.click(await edgeElement());
    await waitFor(() => expect(removeButtons()).toHaveLength(1));

    // Retried rather than read once: the mount animation is what used to clobber the transform, so
    // this has to keep holding after Motion has had frames to write to the element it owns.
    await waitFor(() => {
      const placement = placementOf(removeButtons()[0]);
      const moved = translateIn(placement.style.transform);
      expect(moved, `the × was placed with "${placement.style.transform}"`).not.toBeNull();
    });

    const placement = placementOf(removeButtons()[0]);
    const moved = translateIn(placement.style.transform);
    if (!moved) throw new Error('unreachable — asserted above');

    // Somewhere along its own line, which for these two nodes means somewhere between the column
    // the source is in and the column the sink is in. The broken version put it at 0.
    expect(moved.x).toBeGreaterThan(workflowColumnX(0));
    expect(moved.x).toBeLessThan(workflowColumnX(1) + WORKFLOW_NODE_WIDTH);
    // And still centred on that point rather than hanging off it by its top-left corner.
    expect(placement.style.transform).toContain('-50%');

    // The split that keeps it true: the element being animated is INSIDE the one being placed. Put
    // both jobs back on one element and Motion composes `transform` from its own values again.
    expect(removeButtons()[0].parentElement).not.toBe(placement);
  });
});

describe('the width a node is drawn at', () => {
  /**
   * The pin behind the overlap fix.
   *
   * Adoption spaces its columns with `workflowColumnX`, which is built on `WORKFLOW_NODE_WIDTH`.
   * That is only worth anything if the node is actually drawn that wide — so the node sets its
   * width FROM the constant, and this checks that it did. A `w-56` class, or any second number,
   * puts the layout and the drawing back where they were: agreeing by luck.
   *
   * Read off the inline style rather than measured, deliberately. jsdom lays nothing out, so
   * `getBoundingClientRect` here is whatever the shim returns and would pass for any width at all.
   */
  it('is the width the layout spaces columns by, not a separate number', async () => {
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    const label = screen.getAllByText('Feed')[0];
    const box = label.closest('[style*="width"]');
    if (!(box instanceof HTMLElement)) throw new Error('The node sets no width of its own');

    expect(box.style.width).toBe(`${WORKFLOW_NODE_WIDTH}px`);
    // And the spacing clears it, which is the property the adopted graphs violated.
    expect(workflowColumnX(1)).toBeGreaterThanOrEqual(WORKFLOW_NODE_WIDTH);
  });
});
