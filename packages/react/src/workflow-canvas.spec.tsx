// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * The workflow canvas, on the two things a reader said were wrong with it.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * **1. A node reported problems the instant it was created.** Clicking "+ Sink" produced, in the
 * same breath, `Node "Sink" (sink_…) is not reachable from any source, so it would never run` and
 * `"Sink" does not say which object type it writes`. Both true, both useless: a node that was just
 * added is unwired and unconfigured by construction, and firing the checks' own prose at somebody
 * mid-click is how a validator becomes something people scroll past — which is the exact failure
 * `workflow/validate.ts` opens by describing. The canvas now separates INCOMPLETE from WRONG.
 *
 * The thing that must survive that change is the reason the checks exist, so the two most
 * load-bearing tests here are a pair: *adding a node says nothing alarming*, and *a graph that
 * would never run still cannot be saved quietly*. If a future refactor makes the first pass by
 * suppressing checks rather than deferring them, the second goes red.
 *
 * **2. There was no way to connect from a node.** The only gesture that made an edge was a drag
 * between two React Flow handles — perfectly discoverable to somebody who has used a node editor,
 * invisible to everybody else. There is now a control on the node offering an existing target or a
 * new node wired in one action, and the tests that matter are that what it offers is what the
 * graph allows (a sink is offered nothing downstream, ever) and that "new" really does produce
 * both the node and the edge.
 *
 * **3. A transform node on a fresh catalog was a dead end.** An empty picker promising a choice,
 * and an "Open the code" button that was correctly disabled and did not look it.
 *
 * WHAT THESE TESTS DO NOT ASSERT
 * ------------------------------
 * Anything about geometry as drawn. jsdom does no layout: every element is 0×0, so a test that
 * checked a node's rendered position would pass for the wrong reason. Placement is asserted where
 * it is honest — on the `position` in the graph that gets SAVED, which is arithmetic over the
 * parent's coordinates and nothing to do with the viewport.
 *
 * `toBeChecked` / `toBeDisabled` are NOT available — this repo registers no jest-dom setup, and
 * they throw rather than fail. `toHaveProperty('disabled', true)` is the equivalent that works.
 */
import type {
  CatalogSnapshot,
  CatalogTransform,
  CatalogWorkflow,
} from '@dudousxd/nestjs-catalog/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { installCodeSurfaceDom } from '../../../test/jsdom-code-surface';
import { WorkflowCanvas } from './WorkflowCanvas';
import { CatalogProvider, type CatalogTransport } from './context';

// This canvas opens a transform node's code, and the editor is a real code
// surface: it needs canvas metrics, a firing ResizeObserver and constructable
// stylesheets, none of which jsdom has. Without the shim it does not merely
// render blank — React throws `sheet.replaceSync is not a function` from inside
// `renderRootSync`, which lands as an UNHANDLED rejection rather than a failed
// assertion, so vitest exits non-zero while every test still reports green.
installCodeSurfaceDom();

declare global {
  // React refuses to believe a test is a test without this, and warns on every state update.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The browser APIs React Flow and Base UI reach for that jsdom does not implement.
 *
 * All of them are measurement, and jsdom does no layout, so none of them can have an observable
 * effect here — they are stubbed so the canvas mounts, and nothing below depends on what they
 * return. React Flow observes the pane's size, reads the viewport transform through a DOMMatrix,
 * and measures nodes; Base UI's tooltips observe their anchor.
 */
class NoopResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = NoopResizeObserver;

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

interface Call {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
}

/**
 * A transport that answers from a path→value map and records every call.
 *
 * Answers are held untyped because `CatalogTransport` is generic on the response and a fixture map
 * cannot be. An `Error` value is answered as a rejection, which is how the server's refusal of an
 * incomplete graph is staged.
 *
 * GET and POST answers are kept in SEPARATE maps, which is not tidiness: the pipeline API serves
 * both from one path — `GET /pipeline/workflows` lists, `POST /pipeline/workflows` saves — and a
 * single map makes a save answer the next list with whatever the save returned. That is one object
 * where an array belongs, and it surfaces as `.map is not a function` deep inside a render, which
 * looks like a bug in the screen.
 */
function fakeTransport(gets: Record<string, unknown>, posts: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: the seam under test is generic over its response.
  const answer = (from: Record<string, unknown>, path: string): Promise<any> => {
    if (!(path in from)) return Promise.reject(new Error(`No fake answer for ${path}`));
    const value = from[path];
    const resolved = typeof value === 'function' ? value() : value;
    return resolved instanceof Error ? Promise.reject(resolved) : Promise.resolve(resolved);
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

  return { transport, calls, lastPostTo };
}

function withCatalog(transport: CatalogTransport, children: ReactNode) {
  const queryClient = new QueryClient({
    // No retries: a refusal should reach the screen once, not four times over 30 seconds.
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <CatalogProvider transport={transport}>{children}</CatalogProvider>
    </QueryClientProvider>
  );
}

/** A source wired straight into a sink: the smallest graph with nothing wrong with it. */
function wholeWorkflow(overrides: Partial<CatalogWorkflow> = {}): CatalogWorkflow {
  return {
    id: 'wf1',
    name: 'Fleet',
    enabled: true,
    version: 1,
    // `ready` rather than `draft`: this fixture is a stored, complete graph, which is what makes
    // the node added on top of it the only unfinished thing on the canvas.
    status: 'ready',
    graphHash: 'hash-1',
    // Derived by the server from the sinks, never sent — it is here because the type requires it.
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
      { id: 'snk_1', name: 'Out', kind: 'sink', targetType: 'Mvr', position: { x: 320, y: 0 } },
    ],
    edges: [{ from: 'src_1', to: 'snk_1' }],
    ...overrides,
  };
}

function transform(overrides: Partial<CatalogTransform> = {}): CatalogTransform {
  return {
    id: 'tr_1',
    name: 'Map vehicles',
    language: 'javascript',
    code: 'return records;',
    version: 1,
    createdBy: 'someone',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function snapshot(): CatalogSnapshot {
  return {
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
}

function answersFor(
  workflows: CatalogWorkflow[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
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

/** Mount the canvas and wait until the stored graph is on screen. */
async function openCanvas(transport: CatalogTransport) {
  render(withCatalog(transport, <WorkflowCanvas />));
  await screen.findAllByText('Feed');
}

/**
 * A panel of the rail beside the canvas, by its heading.
 *
 * Scoped to the rail and not to the document, because the inspector opens itself on a node that
 * was just added and carries a "Still to do" heading of its own — an unscoped query matches both
 * and fails as "multiple elements", which reads like a duplicate-render bug rather than an
 * over-broad query.
 */
function rail() {
  return within(screen.getByLabelText('Workflow wiring and problems'));
}

function panel(heading: string) {
  const section = rail().getByText(heading).closest('section');
  if (!section) throw new Error(`No section around "${heading}"`);
  return within(section);
}

function queryPanel(heading: string) {
  return rail().queryByText(heading);
}

/**
 * The Save button, whose colour is the only signal, before it is pressed, that the graph would be
 * refused.
 *
 * Matched on its text rather than on its accessible name, and the label is a regex because it
 * alternates between "Save" and "Saved" with the draft's dirtiness. By text because the icon
 * beside it leaves whitespace in the computed name, so an anchored name matcher misses it — which
 * fails as "no such button" and reads like a rendering bug.
 */
function saveButton(): HTMLButtonElement {
  const button = screen.getByText(/^Saved?$/).closest('button');
  if (!(button instanceof HTMLButtonElement)) throw new Error('Save is not a button');
  return button;
}

/**
 * The inspector sheet, scoped.
 *
 * The node's Name field and the workflow's Name field carry the same label, so an unscoped
 * `getByLabelText('Name')` matches both. The sheet is a real dialog — Base UI's, which is why the
 * role query works — and scoping to it is also what stops a query reaching a control on the canvas
 * behind a modal that has focus.
 */
function inspector() {
  return within(screen.getByRole('dialog'));
}

/**
 * Choose an option in one of Base UI's selects, which are comboboxes and not `<select>` elements.
 *
 * Two steps because that is what they are: the trigger opens a listbox, and the option is a button
 * in it. `fireEvent.change` does nothing to one of these — there is no native control to change.
 */
async function chooseOption(comboboxLabel: string, option: RegExp) {
  fireEvent.click(screen.getByLabelText(comboboxLabel));
  await waitFor(() => expect(screen.queryAllByRole('option').length).toBeGreaterThan(0));
  fireEvent.click(screen.getByRole('option', { name: option }));
}

/** Press one of the three add buttons, by the accessible name that says what it does. */
function addNodeOfKind(kind: 'source' | 'transform' | 'sink') {
  fireEvent.click(screen.getByLabelText(`Add a ${kind} node`));
}

describe('a node that was just added', () => {
  it('says nothing alarming about itself', async () => {
    // THE REPORT, VERBATIM. One click on "+ Sink" produced both of core's messages at once, about
    // a node nobody had had a chance to wire or configure. Neither may appear here.
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    addNodeOfKind('sink');

    await waitFor(() => expect(panel('Still to do')).toBeDefined());
    // The two sentences from the report. Matched loosely on purpose: the point is that this class
    // of prose is absent, not that one particular wording is.
    expect(screen.queryByText(/is not reachable from any source/)).toBeNull();
    expect(screen.queryByText(/nothing for the run to commit into/)).toBeNull();
    // …and the Problems list is still saying there is nothing to flag, rather than listing two.
    expect(panel('Problems').getByText(/Nothing to flag here/)).toBeDefined();
  });

  it('lists what is left to do on it, by name, as work', async () => {
    // Deferring is not hiding. The node is named the whole time, with the outstanding checks
    // rewritten as imperatives — the same facts, addressed to somebody who is still working.
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    addNodeOfKind('sink');

    const todo = panel('Still to do');
    await waitFor(() => expect(todo.getByText('Sink')).toBeDefined());
    expect(todo.getByText(/wire something into it/)).toBeDefined();
    expect(todo.getByText(/choose the object type it commits/)).toBeDefined();
  });

  it('reports in full once somebody has touched it and moved on', async () => {
    // The answer to "a node touched once and abandoned". Acting on a node and stopping is exactly
    // the statement "I think this is done", which is the case core's prose was written for.
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    addNodeOfKind('sink');
    await waitFor(() => expect(panel('Still to do')).toBeDefined());

    // Renaming is the smallest possible act on a node.
    // Anchored rather than exact: the `<label>` wraps the field's hint text too, so its full text
    // is "Name" followed by a paragraph, and an exact matcher finds nothing.
    fireEvent.change(inspector().getByLabelText(/^Name/), { target: { value: 'Work orders' } });

    await waitFor(() =>
      expect(screen.getAllByText(/is not reachable from any source/).length).toBeGreaterThan(0),
    );
    expect(queryPanel('Still to do')).toBeNull();
  });

  it('reports a problem that is also about a finished node, in full, at once', async () => {
    // A check is held back only when EVERY node it names is unfinished — two sinks writing the
    // same type is a fact about the stored one too. It is also the only check core raises that
    // names two nodes, which is why the `every` is exercised here and nowhere else.
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    addNodeOfKind('sink');
    await waitFor(() => expect(panel('Still to do')).toBeDefined());

    // The type the stored sink already commits.
    await chooseOption('Which object type this sink writes', /Vehicle/);

    await waitFor(() => expect(panel('Problems').getByText(/both commit Mvr/)).toBeDefined());
  });

  it('never holds back a node that came off the server', async () => {
    // `unstarted` is empty on load, and that is the whole basis of the distinction: a node that
    // arrived from the server is one somebody saved and walked away from, so it is finished as far
    // as its author was concerned, and its checks get their own wording immediately.
    const orphan = wholeWorkflow({
      nodes: [
        ...wholeWorkflow().nodes,
        { id: 'snk_2', name: 'Stale', kind: 'sink', targetType: '', position: { x: 320, y: 200 } },
      ],
    });
    const { transport } = fakeTransport(answersFor([orphan]));
    await openCanvas(transport);

    expect(await screen.findAllByText(/is not reachable from any source/)).toBeDefined();
    expect(queryPanel('Still to do')).toBeNull();
  });
});

describe('a graph that would never run', () => {
  it('cannot be saved quietly: the Save button is coloured as refused from the first click', async () => {
    // THE GUARANTEE. Deferring changes what is SAID, never what is known: `hasBlockingProblem` is
    // still asked about every check, held back or not. The button's colour is the user-visible
    // consequence and the only one available before the click, so it is what is asserted —
    // computing `blocked` from the visible problems alone turns this amber back to black.
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    expect(saveButton().className).not.toContain('bg-amber-600');

    addNodeOfKind('sink');

    await waitFor(() => expect(saveButton().className).toContain('bg-amber-600'));
  });

  it('cannot be saved quietly: saving stops the checks being held back', async () => {
    // Pressing Save is the declaration that the graph is finished, which is precisely the
    // condition core's wording was written for. So the deferral cannot outlive a save attempt —
    // the reasons are on screen in full beside whatever the server answers.
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]), {
      '/pipeline/workflows': new Error('Sink "Sink" writes no object type.'),
    });
    await openCanvas(transport);

    addNodeOfKind('sink');
    await waitFor(() => expect(panel('Still to do')).toBeDefined());

    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(screen.getAllByText(/is not reachable from any source/).length).toBeGreaterThan(0),
    );
    expect(queryPanel('Still to do')).toBeNull();
  });

  it('sends the incomplete graph anyway, and shows what the server said', async () => {
    // The canvas is not the gate and must not become one — see `CanvasActions`. The request goes,
    // and the server's own words are what the reader gets.
    const { transport, lastPostTo } = fakeTransport(answersFor([wholeWorkflow()]), {
      '/pipeline/workflows': new Error('Sink "Sink" writes no object type.'),
    });
    await openCanvas(transport);

    addNodeOfKind('sink');
    await waitFor(() => expect(panel('Still to do')).toBeDefined());

    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(screen.getByText(/Sink "Sink" writes no object type/)).toBeDefined(),
    );
    // …and it really was sent, with the unfinished node in it.
    const nodes = readNodes(lastPostTo('/pipeline/workflows')?.body);
    expect(nodes.map((node) => node.name)).toContain('Sink');
  });
});

describe('names', () => {
  it('does not call the second sink "Sink" as well', async () => {
    // `Sink (sink_3b5a…)` in the original report is what a message has to fall back to when the
    // name it was given identifies nothing.
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    addNodeOfKind('sink');
    await waitFor(() => expect(panel('Still to do').getByText('Sink')).toBeDefined());

    addNodeOfKind('sink');
    await waitFor(() => expect(panel('Still to do').getByText('Sink 2')).toBeDefined());

    addNodeOfKind('sink');
    await waitFor(() => expect(panel('Still to do').getByText('Sink 3')).toBeDefined());
  });
});

describe('the wiring menu on a node', () => {
  /** Hover a node by its accessible description, then open its menu. */
  async function openMenuOn(label: string) {
    const node = document.querySelector(`.react-flow__node[aria-label^="${label}"]`);
    if (!node) throw new Error(`No canvas node whose description starts "${label}"`);
    fireEvent.mouseEnter(node);
    fireEvent.click(await screen.findByLabelText(/^Wire /));
    return screen.getByRole('menu');
  }

  it('offers only what the graph allows: a sink is offered nothing downstream', async () => {
    // The rule is `canConnect`'s and nothing here restates it — `newKindsFrom` asks it with a
    // throwaway probe of each kind. A menu that offered an edge the drag refuses would teach
    // somebody the menu is a guess.
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    const menu = await openMenuOn('sink node, Out');

    expect(within(menu).getByText(/Nothing runs after one/)).toBeDefined();
    expect(within(menu).queryByText('New transform')).toBeNull();
    expect(within(menu).queryByText('New sink')).toBeNull();
    // …but the wire it already has can be removed from here, which is otherwise a hunt for a line.
    expect(within(menu).getByText('Disconnect Feed')).toBeDefined();
  });

  it('offers a transform and a sink from a source, and never another source', async () => {
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    const menu = await openMenuOn('source node, Feed');

    expect(within(menu).getByText('New transform')).toBeDefined();
    expect(within(menu).getByText('New sink')).toBeDefined();
    // Nothing feeds a source, so "New source" is not an option — the probe is refused by the same
    // rule that refuses the drag.
    expect(within(menu).queryByText('New source')).toBeNull();
  });

  it('makes the node and the edge in one action', async () => {
    // The whole point of "new": adding a node and connecting it used to be two gestures, the
    // second of which was a drag between handles nothing on screen advertised.
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    const menu = await openMenuOn('source node, Feed');
    fireEvent.click(within(menu).getByText('New transform'));

    // The wiring rail is the linear reading of the graph, so it is where the edge is checked.
    await waitFor(() =>
      expect(panel('Wiring').getByLabelText('Disconnect Feed from Transform')).toBeDefined(),
    );
  });

  it('places the new node one column right of its parent, clear of what is there', async () => {
    // jsdom does no layout, so nothing here looks at the DOM. What is asserted is the `position`
    // that gets SAVED — arithmetic over the parent's coordinates, which is the part that decides
    // whether the node lands on top of another one.
    //
    // The stored sink is at x:320, the source at x:0. A node made from the source belongs at
    // x:320 too, and row 0 there is taken, so it drops one row: 80 high plus a 32 gap.
    const { transport, lastPostTo } = fakeTransport(answersFor([wholeWorkflow()]), {
      '/pipeline/workflows': wholeWorkflow({ version: 2 }),
    });
    await openCanvas(transport);

    const menu = await openMenuOn('source node, Feed');
    fireEvent.click(within(menu).getByText('New transform'));
    await waitFor(() =>
      expect(panel('Wiring').getByLabelText('Disconnect Feed from Transform')).toBeDefined(),
    );

    fireEvent.click(saveButton());

    await waitFor(() => expect(lastPostTo('/pipeline/workflows')).toBeDefined());
    const made = readNodes(lastPostTo('/pipeline/workflows')?.body).find(
      (node) => node.name === 'Transform',
    );
    expect(made?.position).toEqual({ x: 320, y: 112 });
  });

  it('removes a wire from the node it belongs to', async () => {
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    const menu = await openMenuOn('sink node, Out');
    fireEvent.click(within(menu).getByText('Disconnect Feed'));

    await waitFor(() =>
      expect(panel('Wiring').getByText(/Nothing is wired together yet/)).toBeDefined(),
    );
  });
});

describe('a transform node on a catalog with no transforms', () => {
  it('says the catalog is empty instead of offering a choice it does not have', async () => {
    // The old form rendered "Choose a transform…" over an empty list: a promise the screen could
    // not keep, with the way out on another tab and nothing saying so.
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    addNodeOfKind('transform');

    expect(await screen.findByText(/no transforms in this catalog yet/)).toBeDefined();
    expect(screen.queryByText('Choose the code…')).toBeNull();
    expect(screen.getByText('Write the first transform')).toBeDefined();
  });

  it('does not render a code button that cannot open anything', async () => {
    // It used to be disabled at `opacity-40`, which reads as faint rather than as off — so it got
    // clicked, and answered with silence. A control that cannot act is better absent.
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    addNodeOfKind('transform');
    await screen.findByText('Write the first transform');

    expect(screen.queryByText('Open the code')).toBeNull();
  });

  it('creates one from here and points the node at it', async () => {
    // The detour this removes: leave the canvas, go to Transforms, write one, come back, find the
    // node, pick it.
    const created = transform({ id: 'tr_new', name: 'Transform' });
    // The list answers empty until the POST lands, then answers with it — the save invalidates the
    // transforms query, and a fixture that kept answering `[]` would delete what was just made.
    let stored: CatalogTransform[] = [];
    const { transport, lastPostTo } = fakeTransport(
      answersFor([wholeWorkflow()], { '/pipeline/transforms': () => stored }),
      {
        '/pipeline/transforms': () => {
          stored = [created];
          return created;
        },
      },
    );
    await openCanvas(transport);

    addNodeOfKind('transform');
    fireEvent.click(await screen.findByText('Write the first transform'));

    await waitFor(() => expect(lastPostTo('/pipeline/transforms')).toBeDefined());
    // Named after the node, so the two are findable from each other, and created in the
    // deployment's own first language rather than in whatever this file happens to prefer.
    const sent = readRecord(lastPostTo('/pipeline/transforms')?.body);
    expect(sent.name).toBe('Transform');
    expect(sent.language).toBe('javascript');
    // The code sheet opens on the transform that now exists, rather than on the note explaining
    // that this node names none.
    await waitFor(() => expect(screen.queryByText(/does not name a transform yet/)).toBeNull());
  });

  it('asks for the code, not for "a transform", once there are some', async () => {
    // "the transform node needs another transform, it reads a bit strange" — and it does, when a
    // field called Transform sits inside a sheet describing a transform node. The field is
    // labelled by what it asks for; the node is deliberately NOT renamed, because half its
    // vocabulary is drawn by `workflow/nodes.tsx`.
    const { transport } = fakeTransport(
      answersFor([wholeWorkflow()], { '/pipeline/transforms': [transform()] }),
    );
    await openCanvas(transport);

    addNodeOfKind('transform');

    expect(await screen.findByLabelText("Which transform's code runs at this step")).toBeDefined();
    expect(screen.getByText(/stored on its own so a connector and several steps/)).toBeDefined();
  });
});

/* --- narrowing helpers, so nothing here needs an `as` --------------------- */

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {};
  const record: Record<string, unknown> = {};
  for (const key of Object.keys(value)) record[key] = Reflect.get(value, key);
  return record;
}

interface SentNode {
  name?: string;
  position?: { x: number; y: number };
}

/** The nodes out of a saved body, narrowed field by field rather than asserted. */
function readNodes(body: unknown): SentNode[] {
  const nodes = readRecord(body).nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.map((raw) => {
    const record = readRecord(raw);
    const name = typeof record.name === 'string' ? record.name : undefined;
    const position = readRecord(record.position);
    const x = position.x;
    const y = position.y;
    return {
      name,
      position: typeof x === 'number' && typeof y === 'number' ? { x, y } : undefined,
    };
  });
}
