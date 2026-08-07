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
  CatalogPropertyDef,
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
 * One property of the type a sink writes.
 *
 * `columnName` defaults to the name because that is what an ORM-derived type
 * looks like — the two only diverge on a *published* type whose source spelled a
 * column in a way SQL cannot use, which is the case the shape tests below are
 * about and the one place they pass it explicitly.
 */
function property(name: string, overrides: Partial<CatalogPropertyDef> = {}): CatalogPropertyDef {
  return {
    name,
    displayName: name,
    type: 'string',
    columnName: name,
    nullable: true,
    primary: false,
    hidden: false,
    order: 0,
    enriched: false,
    ...overrides,
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
    // The shape a deployment whose workers announce nothing answers with, which
    // is also the shape every test that is not about the picker wants: the call
    // node's two typed fields, and a sentence saying why there is no list.
    '/pipeline/callable-workflows': {
      supported: false,
      workflows: [],
      observedAt: '2026-01-01T00:00:00.000Z',
      detail: 'No durable engine resolved in this process.',
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

/** Press one of the add buttons, by the accessible name that says what it does. */
function addNodeOfKind(kind: 'source' | 'transform' | 'sink' | 'call') {
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

/**
 * The column check, where a reader actually meets it.
 *
 * `workflow/shape.spec.ts` pins what the answer is. What these pin is where the question gets
 * asked and where the answer comes out, which are two different screens: the button is on the
 * source node's inspector, and the verdict is in the Problems rail beside the canvas. The fixture
 * graph is `Feed → Out`, a source wired straight into a sink, which is the one shape the check has
 * anything to say about.
 *
 * **Nothing is discovered on the canvas's behalf, and that is the point of driving these through
 * the button.** Discovery is a read of a live source behind a `POST`; a canvas that fired it for
 * every source node on load would open a database connection nobody asked for, four of them on a
 * graph with four sources. So the check speaks about a node somebody asked about and stays silent
 * about every other one, and the first test here is that silence.
 *
 * The Save button's colour is asserted rather than described because it is the only signal before
 * the click, and it is driven by `hasBlockingProblem` over `level`. A refactor that reported an
 * unproven column as an error would turn this button amber, which is the whole failure: a panel
 * that shouts about what it could not prove is one people stop reading.
 */
describe('whether the source fits the sink', () => {
  /** `Asset Id` in the source, `Asset_Id` on the type. The 6,905-row case, on screen. */
  const respelled = [property('Asset_Id', { columnName: 'Asset Id' })];

  /** Where `discoverSourceSchema` lands for the source node in `wholeWorkflow`. */
  const DISCOVER = '/pipeline/workflows/wf1/nodes/src_1/discover';

  /**
   * A driver description of one column, exactly as the route answers.
   *
   * `basis: 'driver'` with `sampled: 0` is what a real deployment came back with, and it is what
   * makes a type difference a question rather than a refusal — the driver described the result set
   * and not one row was read.
   */
  function discovery(name: string, type: 'string' | 'number') {
    return {
      workflowId: 'wf1',
      nodeId: 'src_1',
      nodeName: 'Feed',
      kind: 'http',
      targetType: 'Mvr',
      typeExists: true,
      basis: 'driver',
      sampled: 0,
      caveat: 'The driver described the result set. No rows were read.',
      columns: [{ name, type, confidence: 'reported', sourceType: 'VARCHAR', nullable: null }],
      drift: null,
    };
  }

  /** Open the source's inspector from the wiring list, and ask what it reads. */
  async function discoverOnFeed() {
    fireEvent.click(panel('Wiring').getByText('Feed'));
    fireEvent.click(await screen.findByText('Discover schema'));
  }

  /** Close the inspector, which is what the answer has to outlive. */
  function closeInspector() {
    fireEvent.click(inspector().getByLabelText('Close'));
  }

  it('says nothing until somebody has asked what the source reads', async () => {
    // The state every graph opens in, and the state a deployment that has never run discovery
    // stays in. Silence here is "nobody asked", not "it fits" — the type on screen is the one
    // whose columns do NOT line up, and the canvas has no business guessing at that unasked.
    const { transport, calls } = fakeTransport(
      answersFor([wholeWorkflow()], { '/catalog': snapshot(respelled) }),
    );
    await openCanvas(transport);

    expect(panel('Problems').getByText(/Nothing to flag here/)).toBeDefined();
    // …and not because the answer was fetched and ignored. Nothing asked the source anything.
    expect(calls.some((call) => call.path === DISCOVER)).toBe(false);
  });

  it('reports the column the source spells its own way, and colours Save as refused', async () => {
    const { transport } = fakeTransport(
      answersFor([wholeWorkflow()], { '/catalog': snapshot(respelled) }),
      { [DISCOVER]: discovery('Asset Id', 'string') },
    );
    await openCanvas(transport);

    await discoverOnFeed();

    await waitFor(() =>
      expect(panel('Problems').getByText(/knows under a different name/)).toBeDefined(),
    );
    expect(saveButton().className).toContain('bg-amber-600');
  });

  it('keeps what it read after the inspector that read it has closed', async () => {
    // The reason the canvas holds these and the panel does not. The panel is unmounted with the
    // sheet, and the rail that has something to say about the columns is on the other side of it —
    // a report that died with its own dialog would never be read by anybody.
    const { transport } = fakeTransport(
      answersFor([wholeWorkflow()], { '/catalog': snapshot(respelled) }),
      { [DISCOVER]: discovery('Asset Id', 'string') },
    );
    await openCanvas(transport);

    await discoverOnFeed();
    await waitFor(() =>
      expect(panel('Problems').getByText(/knows under a different name/)).toBeDefined(),
    );

    closeInspector();

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(panel('Problems').getByText(/knows under a different name/)).toBeDefined();
  });

  it('forgets what it read once the node is pointed somewhere else', async () => {
    // A discovered shape describes the source as it was addressed when it was read. Change the
    // address and those columns stop being about this node — so the check goes quiet rather than
    // reporting a missing column against a query somebody has since rewritten. Over-forgetting
    // costs a second press of the button; under-forgetting is the validator inventing a fact.
    const { transport } = fakeTransport(
      answersFor([wholeWorkflow()], { '/catalog': snapshot(respelled) }),
      { [DISCOVER]: discovery('Asset Id', 'string') },
    );
    await openCanvas(transport);

    await discoverOnFeed();
    await waitFor(() =>
      expect(panel('Problems').getByText(/knows under a different name/)).toBeDefined(),
    );

    fireEvent.change(inspector().getByLabelText(/^URL/), {
      target: { value: 'https://example.test/other' },
    });

    await waitFor(() =>
      expect(panel('Problems').queryByText(/knows under a different name/)).toBeNull(),
    );
  });

  it('keeps what it read when the node is only renamed', async () => {
    // The other half of that rule. A name is not an address, and dropping the check for the most
    // ordinary edit there is would make it disappear for reasons nobody could connect to it.
    const { transport } = fakeTransport(
      answersFor([wholeWorkflow()], { '/catalog': snapshot(respelled) }),
      { [DISCOVER]: discovery('Asset Id', 'string') },
    );
    await openCanvas(transport);

    await discoverOnFeed();
    await waitFor(() =>
      expect(panel('Problems').getByText(/knows under a different name/)).toBeDefined(),
    );

    fireEvent.change(inspector().getByLabelText(/^Name/), { target: { value: 'Vehicle feed' } });

    await waitFor(() => expect(panel('Wiring').getByText('Vehicle feed')).toBeDefined());
    expect(panel('Problems').getByText(/knows under a different name/)).toBeDefined();
  });

  it('lists a column it could not decide about without blocking the save', async () => {
    // `string` from the driver into a `number` property. It loads perfectly when every value is
    // numeric, and `sampled: 0` means not one was read — so the honest answer is a question.
    const { transport } = fakeTransport(
      answersFor([wholeWorkflow()], {
        '/catalog': snapshot([property('miles', { type: 'number' })]),
      }),
      { [DISCOVER]: discovery('miles', 'string') },
    );
    await openCanvas(transport);

    await discoverOnFeed();

    await waitFor(() =>
      expect(
        panel('Problems').getByText(/could not be decided from the schemas alone/),
      ).toBeDefined(),
    );
    expect(saveButton().className).not.toContain('bg-amber-600');
  });

  it('still says nothing alarming about a sink somebody just added', async () => {
    // The tension the top of this file is about, with the column check switched on: a node
    // created a second ago has no type yet, so there is nothing to compare, and a check that
    // found something to say here would be the original report all over again.
    const { transport } = fakeTransport(
      answersFor([wholeWorkflow()], { '/catalog': snapshot(respelled) }),
      { [DISCOVER]: discovery('Asset Id', 'string') },
    );
    await openCanvas(transport);

    await discoverOnFeed();
    await waitFor(() =>
      expect(panel('Problems').getByText(/knows under a different name/)).toBeDefined(),
    );
    closeInspector();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    addNodeOfKind('sink');

    await waitFor(() => expect(panel('Still to do')).toBeDefined());
    expect(panel('Still to do').queryByText(/knows under a different name/)).toBeNull();
  });
});

/**
 * "Discover schema — Save first … ué mas ta desabilitado não vejo nada."
 *
 * Two separable complaints hide in that sentence, and only one of them is about wording.
 *
 * The first is whether the refusal is even TRUE. Discovery reads the stored node, so refusing it
 * on a draft with unsaved edits is right — but only if `dirty` means what it says. Merely opening
 * a workflow must not set it, and the trap is close by: `draftFrom` runs `layoutIfUnarranged` on
 * the way in, so a change that made arranging a graph count as editing it would leave discovery
 * permanently unreachable on every graph the server laid out. That is the first test here, and it
 * is why it asserts on a graph whose nodes came from the server already positioned as well as on
 * the plain path.
 *
 * The second is that being told "Save first" is useless where the save control is somewhere else —
 * the panel is inside a side sheet and the Save button is in the header behind it. The remedy now
 * sits beside the sentence.
 */
describe('asking a source what it reads', () => {
  it('is offered straight away on a workflow nobody has edited', async () => {
    // The reported symptom, checked at its cause. If this goes red, the refusal is firing on a
    // graph nobody touched, and no amount of better wording fixes that.
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    fireEvent.click(panel('Wiring').getByText('Feed'));

    const discover = await screen.findByRole('button', { name: 'Discover schema' });
    expect(discover).toHaveProperty('disabled', false);
    expect(screen.queryByText(/Save first/)).toBeNull();
  });

  it('stays offered when the server sent a graph with no positions and the canvas arranged it', async () => {
    // `layoutIfUnarranged` rewrites every position on the way in for a graph created through the
    // API. That is a derived layout, not an edit — it re-derives identically next time and there
    // is nothing to save — so it must not mark the draft dirty. A version of this that did would
    // make discovery unreachable on exactly the graphs that most need it.
    const unarranged = wholeWorkflow({
      nodes: [
        { id: 'src_1', name: 'Feed', kind: 'source', sourceKind: 'http', config: {} },
        { id: 'snk_1', name: 'Out', kind: 'sink', targetType: 'Mvr' },
      ],
    });
    const { transport } = fakeTransport(answersFor([unarranged]));
    await openCanvas(transport);

    // Nothing was edited, so the button reads "Saved" rather than "Save".
    expect(saveButton().textContent).toContain('Saved');

    fireEvent.click(panel('Wiring').getByText('Feed'));

    expect(await screen.findByRole('button', { name: 'Discover schema' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('offers the save it asks for, in the panel that asks for it', async () => {
    // Being told to do something with no way to do it where you are standing is what produced
    // "it's disabled and I can't see anything" rather than "ah, I should save".
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    // An edit, which is what makes the stored node differ from the one on screen.
    fireEvent.click(panel('Wiring').getByText('Feed'));
    fireEvent.change(inspector().getByLabelText(/^Name/), { target: { value: 'Vehicle feed' } });

    await waitFor(() => expect(screen.getByText(/Save first/)).toBeDefined());
    expect(inspector().getByRole('button', { name: /Save now/ })).toHaveProperty('disabled', false);
  });

  it('says the save does not publish, because a reader told to save would reasonably fear it did', async () => {
    // The same care the `!draft.id` refusal already takes. Publishing is a different, louder thing
    // on this screen, and somebody nudged into saving must not think they have just done it.
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    fireEvent.click(panel('Wiring').getByText('Feed'));
    fireEvent.change(inspector().getByLabelText(/^Name/), { target: { value: 'Vehicle feed' } });

    await waitFor(() => expect(screen.getByText(/Save first/)).toBeDefined());
    expect(inspector().getByText(/does not publish it/)).toBeDefined();
  });

  it('offers no save when there is nothing to save first', async () => {
    // An enabled panel showing a save button would be offering an action with no bearing on the
    // one thing the panel does.
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    fireEvent.click(panel('Wiring').getByText('Feed'));
    await screen.findByRole('button', { name: 'Discover schema' });

    expect(inspector().queryByRole('button', { name: /Save now/ })).toBeNull();
  });
});

describe('the actions menu on a node', () => {
  /**
   * Hover a node by its accessible description, then open its menu.
   *
   * The pill is called **Actions** now and used to be called "Wire", which is the
   * whole reason this feature exists: the handle beside it starts the
   * click-to-connect gesture, that gesture is also called wiring, and the person
   * who asked for a right-click menu had pressed the handle, got a wire, and
   * concluded that was the feature — "Apertei na borda e só deu wire ué". Two
   * affordances with one name, and the one carrying the menu was the smaller.
   *
   * `findByRole` rather than `getByRole` on the way out: the popup is portalled
   * and positioned, so it is not in the document on the tick the trigger is
   * clicked.
   */
  async function openMenuOn(label: string) {
    const node = document.querySelector(`.react-flow__node[aria-label^="${label}"]`);
    if (!node) throw new Error(`No canvas node whose description starts "${label}"`);
    fireEvent.mouseEnter(node);
    fireEvent.click(await screen.findByLabelText(/^Actions for /));
    return await screen.findByRole('menu');
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

/**
 * The node that hands a step to a workflow somebody else registered.
 *
 * What is worth testing here is the pair of fields and nothing about how they look: the version is
 * the half that decides which code runs, and a canvas that let it be left blank would store a node
 * that silently follows whatever gets deployed next. So the assertions are that both fields are
 * typed, that both are demanded, and that what is typed reaches the save.
 *
 * There USED to be no picker to test, because nothing could enumerate a deployment's
 * registrations. `announcedWorkflows()` (durable 0.65.0) changed that, and the picker's own tests
 * are in the describe below this one — with the manual fields still tested here, because a
 * deployment whose workers have not been upgraded announces nothing and a picker that became the
 * only path would make this node unusable there.
 */
describe('a node that calls another workflow', () => {
  it('asks for the version as well as the name, and says why on the node', async () => {
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    addNodeOfKind('call');

    const todo = panel('Still to do');
    await waitFor(() => expect(todo.getByText('Call')).toBeDefined());
    expect(todo.getByText(/name the workflow it calls, and the version to pin/)).toBeDefined();
  });

  it('still refuses to save quietly when only the name was filled in', async () => {
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    addNodeOfKind('call');
    await waitFor(() => expect(panel('Still to do')).toBeDefined());

    fireEvent.change(inspector().getByLabelText(/^Workflow/), {
      target: { value: 'billing.reconcile' },
    });

    // Touching it is the statement "I think this is done", so the check gets its full wording —
    // and it is about the version, which is the half people leave behind.
    await waitFor(() =>
      expect(
        screen.getAllByText(/does not name a version of the workflow it calls/).length,
      ).toBeGreaterThan(0),
    );
    expect(saveButton().className).toContain('bg-amber-600');
  });

  it('sends the name, the version and the parameters it was given', async () => {
    const { transport, lastPostTo } = fakeTransport(answersFor([wholeWorkflow()]), {
      '/pipeline/workflows': wholeWorkflow(),
    });
    await openCanvas(transport);

    addNodeOfKind('call');
    await waitFor(() => expect(panel('Still to do')).toBeDefined());

    fireEvent.change(inspector().getByLabelText(/^Workflow/), {
      target: { value: 'billing.reconcile' },
    });
    fireEvent.change(inspector().getByLabelText(/^Version/), { target: { value: '2' } });
    fireEvent.change(inspector().getByLabelText(/^Parameters/), {
      target: { value: '{"region":"gov-west"}' },
    });

    fireEvent.click(saveButton());

    await waitFor(() => expect(lastPostTo('/pipeline/workflows')).toBeDefined());
    const sent = readCallNodes(lastPostTo('/pipeline/workflows')?.body);
    expect(sent).toEqual([
      { callName: 'billing.reconcile', callVersion: '2', config: { region: 'gov-west' } },
    ]);
  });

  // Half-typed JSON must not reach the node: a config that parsed a moment ago and does not now
  // would otherwise be replaced by whatever the last keystroke left behind.
  it('keeps the last parameters that parsed while the box does not', async () => {
    const { transport, lastPostTo } = fakeTransport(answersFor([wholeWorkflow()]), {
      '/pipeline/workflows': wholeWorkflow(),
    });
    await openCanvas(transport);

    addNodeOfKind('call');
    await waitFor(() => expect(panel('Still to do')).toBeDefined());

    fireEvent.change(inspector().getByLabelText(/^Workflow/), { target: { value: 'billing' } });
    fireEvent.change(inspector().getByLabelText(/^Version/), { target: { value: '1' } });
    fireEvent.change(inspector().getByLabelText(/^Parameters/), {
      target: { value: '{"region":"gov-west"}' },
    });
    fireEvent.change(inspector().getByLabelText(/^Parameters/), { target: { value: '{"region"' } });

    await waitFor(() => expect(screen.getByText(/not valid JSON yet/)).toBeDefined());

    fireEvent.click(saveButton());
    await waitFor(() => expect(lastPostTo('/pipeline/workflows')).toBeDefined());
    expect(readCallNodes(lastPostTo('/pipeline/workflows')?.body)).toEqual([
      { callName: 'billing', callVersion: '1', config: { region: 'gov-west' } },
    ]);
  });

  // A called workflow may itself read from a system, so this is a real graph and core says so.
  // The canvas must not add an opinion of its own on top of it.
  it('accepts a graph whose only reader is a call', async () => {
    const calling = wholeWorkflow({
      nodes: [
        {
          id: 'call_1',
          name: 'Reconcile',
          kind: 'call',
          callName: 'billing.reconcile',
          callVersion: '2',
          config: {},
          position: { x: 0, y: 0 },
        },
        { id: 'snk_1', name: 'Out', kind: 'sink', targetType: 'Mvr', position: { x: 320, y: 0 } },
      ],
      edges: [{ from: 'call_1', to: 'snk_1' }],
    });
    const { transport } = fakeTransport(answersFor([calling]));
    render(withCatalog(transport, <WorkflowCanvas />));

    await screen.findAllByText('Reconcile');
    // The pinned version is on the face of the node, not only in the inspector: `billing` and
    // `billing@2` are different loads.
    expect(screen.getAllByText('billing.reconcile@2').length).toBeGreaterThan(0);
    expect(panel('Problems').getByText(/Nothing to flag here/)).toBeDefined();
  });
});

/**
 * The two searchable fields over the pair above.
 *
 * WHY THIS BLOCK EXISTS
 * ---------------------
 * The call node shipped without a picker on purpose, and the reason was written into it: nothing
 * could enumerate a deployment's registrations, because `workflowBody(name, version)` answers only
 * for the process asking and a missing body reads identically to "registered through
 * `registerRemote` in another SDK" and to "a group resolved by convention against a live worker".
 * Durable 0.65.0's `announcedWorkflows()` replaced that inference with a statement live workers
 * publish about themselves, and `GET pipeline/callable-workflows` serves it.
 *
 * The FIRST picker built on it was one select of combined `name@version` keys with the two text
 * fields still underneath, and it was wrong three ways: no search, so a real fleet is a scroll; one
 * question asked as two, so the name list was as long as the version count; and three controls for
 * two values. It is now two `Combobox`es — searchable, and typeable past what is on the list.
 *
 * Every test here is about the picker NOT being tidier than the thing it renders:
 *
 * - Choosing a NAME writes the version as well, whenever the fleet leaves no choice. Splitting one
 *   select into two is what made that possible to get wrong: a node with a name and no version
 *   looks configured and runs whatever is newest on the day it runs, which is the exact failure
 *   the pin exists to prevent. Where the fleet does NOT leave a single answer, the version is left
 *   blank on purpose — visible, said out loud, and refused by the save.
 * - An entry two live workers claim from two different groups is SHOWN and cannot be chosen.
 *   Nobody can say which queue such a run would land on, so picking one would be acting on a claim
 *   nobody made; dropping it from the list would be the "picker that hides what you are looking
 *   for" the original docblock refused to build.
 * - A bare, unversioned announcement — what an un-upgraded worker of any SDK publishes — is
 *   likewise offered and refused, because a name with no version cannot satisfy the pin.
 * - Both fields take text nobody announced, including when there is no list at all.
 *
 * There is deliberately nothing here about STEPS. `announcedWorkflows()` covers workflows only,
 * and durable says why in its own source: a step is identified by its `(runId, seq)` position
 * inside one run's history, `ctx.step` is callable only from a replaying body, and no engine entry
 * point starts one. "Call this step" is not an operation that exists, so a field offering steps
 * would be offering something nothing could then run.
 */
describe('choosing a workflow a live worker announces', () => {
  /** The route's answer, with the fleet speaking with one voice unless told otherwise. */
  function fleet(workflows: unknown[], supported = true) {
    return {
      supported,
      workflows,
      observedAt: '2026-01-01T00:00:00.000Z',
      detail: 'Every workflow a live worker announces it can execute, read just now.',
    };
  }

  async function openCallInspector(fleetAnswer: unknown) {
    const fixture = fakeTransport(
      answersFor([wholeWorkflow()], { '/pipeline/callable-workflows': fleetAnswer }),
      { '/pipeline/workflows': wholeWorkflow() },
    );
    await openCanvas(fixture.transport);
    addNodeOfKind('call');
    await waitFor(() => expect(panel('Still to do')).toBeDefined());
    return fixture;
  }

  it('offers one row per NAME, and the versions in the field below it', async () => {
    // The split this pair of fields exists to make. A single list of `name@version` keys answers
    // the version question inside the name question, and a workflow with eight versions takes
    // eight rows of a list somebody is scanning for a name.
    await openCallInspector(
      fleet([
        { name: 'billing.reconcile', version: '1', group: 'billing', workers: 2 },
        { name: 'billing.reconcile', version: '2', group: 'billing', workers: 2 },
        { name: 'orders.sync', version: '4', group: 'orders', workers: 1 },
      ]),
    );

    await openField('Workflow');
    expect(offered()).toEqual(['billing.reconcile', 'orders.sync']);
    await close();

    await openField('Version');
    // Nothing is named yet, so there is nothing to list versions OF — and the popup says that
    // rather than showing every version in the fleet under a name nobody picked.
    expect(offered()).toEqual([]);
    expect(screen.getByText(/Name a workflow first/)).toBeDefined();
  });

  it('narrows the list to what is typed, which is the whole point of a search', async () => {
    // A fleet announcing three hundred workflows renders three hundred rows, and the only gesture
    // over a plain popup is "scroll until you see it".
    await openCallInspector(
      fleet([
        { name: 'billing.reconcile', version: '1', group: 'billing', workers: 1 },
        { name: 'orders.sync', version: '4', group: 'orders', workers: 1 },
        { name: 'orders.reconcile', version: '1', group: 'orders', workers: 1 },
      ]),
    );

    await openField('Workflow');
    fireEvent.change(field('Workflow'), { target: { value: 'reconcile' } });

    await waitFor(() => expect(offered()).toEqual(['billing.reconcile', 'orders.reconcile']));
  });

  it('finds a workflow by its group, which is how somebody looks for the Python half', async () => {
    // The group is the one signal a missing `workflowBody` could never give, so it is also the
    // thing people search by when they do not yet know the name.
    await openCallInspector(
      fleet([
        { name: 'billing.reconcile', version: '1', group: 'ts-billing', workers: 1 },
        { name: 'fleet.posture', version: '1', group: 'python-analytics', workers: 1 },
      ]),
    );

    await openField('Workflow');
    fireEvent.change(field('Workflow'), { target: { value: 'python' } });

    await waitFor(() => expect(offered()).toEqual(['fleet.posture']));
  });

  it('writes the version with the name when the fleet announces exactly one', async () => {
    // THE LOAD-BEARING ONE. `engine.start` resolves `latest.get(name)` unless a version is passed,
    // so a name committed on its own would silently run whatever is newest. One announced version
    // means there is nothing to choose between, so the common case stays ONE action.
    const { lastPostTo } = await openCallInspector(
      fleet([{ name: 'billing.reconcile', version: '2', group: 'billing', workers: 1 }]),
    );

    await choose('Workflow', 'billing.reconcile');

    await waitFor(() => expect(field('Version')).toHaveProperty('value', '2'));
    expect(field('Workflow')).toHaveProperty('value', 'billing.reconcile');

    fireEvent.click(saveButton());
    await waitFor(() => expect(lastPostTo('/pipeline/workflows')).toBeDefined());
    expect(readCallNodes(lastPostTo('/pipeline/workflows')?.body)).toEqual([
      { callName: 'billing.reconcile', callVersion: '2', config: {} },
    ]);
  });

  it('leaves the version blank when there is a choice, says so, and still refuses the save', async () => {
    // The failure two fields can have that one combined select could not: a name committed alone.
    // Blank is deliberate — guessing between 1 and 2 is precisely what the pin exists to stop —
    // and it must be VISIBLE as unfinished rather than merely absent.
    await openCallInspector(
      fleet([
        { name: 'billing.reconcile', version: '1', group: 'billing', workers: 2 },
        { name: 'billing.reconcile', version: '2', group: 'billing', workers: 2 },
      ]),
    );

    await choose('Workflow', 'billing.reconcile');

    await waitFor(() => expect(field('Workflow')).toHaveProperty('value', 'billing.reconcile'));
    expect(field('Version')).toHaveProperty('value', '');
    expect(screen.getByText(/announces more than one version/)).toBeDefined();

    // Touching the save is the statement "I think this is done", so the check gets its full
    // wording and the button stops looking like an ordinary one.
    await waitFor(() =>
      expect(
        screen.getAllByText(/does not name a version of the workflow it calls/).length,
      ).toBeGreaterThan(0),
    );
    expect(saveButton().className).toContain('bg-amber-600');
  });

  it('lists that name’s versions in the second field, and finishing it saves both', async () => {
    const { lastPostTo } = await openCallInspector(
      fleet([
        { name: 'billing.reconcile', version: '1', group: 'billing', workers: 2 },
        { name: 'billing.reconcile', version: '2', group: 'billing', workers: 2 },
        { name: 'orders.sync', version: '9', group: 'orders', workers: 1 },
      ]),
    );

    await choose('Workflow', 'billing.reconcile');
    await waitFor(() => expect(field('Workflow')).toHaveProperty('value', 'billing.reconcile'));

    await openField('Version');
    // `orders.sync`'s 9 is not here: this field answers "which version of THIS", not "which
    // version in the fleet".
    expect(offered()).toEqual(['1', '2']);
    await close();

    await choose('Version', '2');

    await waitFor(() => expect(field('Version')).toHaveProperty('value', '2'));
    fireEvent.click(saveButton());
    await waitFor(() => expect(lastPostTo('/pipeline/workflows')).toBeDefined());
    expect(readCallNodes(lastPostTo('/pipeline/workflows')?.body)).toEqual([
      { callName: 'billing.reconcile', callVersion: '2', config: {} },
    ]);
  });

  it('does not disturb a version the fleet still announces for the name re-picked', async () => {
    await openCallInspector(
      fleet([
        { name: 'billing.reconcile', version: '1', group: 'billing', workers: 1 },
        { name: 'billing.reconcile', version: '2', group: 'billing', workers: 1 },
      ]),
    );

    fireEvent.change(field('Version'), { target: { value: '1' } });
    await choose('Workflow', 'billing.reconcile');

    await waitFor(() => expect(field('Workflow')).toHaveProperty('value', 'billing.reconcile'));
    expect(field('Version')).toHaveProperty('value', '1');
  });

  it('drops a version that was the OLD name’s, because it is now a pin nobody announced', async () => {
    // `billing.reconcile@2` is real; `orders.sync@2` is not, and leaving the 2 behind would look
    // exactly like a pin somebody chose.
    await openCallInspector(
      fleet([
        { name: 'billing.reconcile', version: '2', group: 'billing', workers: 1 },
        { name: 'orders.sync', version: '8', group: 'orders', workers: 1 },
        { name: 'orders.sync', version: '9', group: 'orders', workers: 1 },
      ]),
    );

    await choose('Workflow', 'billing.reconcile');
    await waitFor(() => expect(field('Version')).toHaveProperty('value', '2'));

    await choose('Workflow', 'orders.sync');

    await waitFor(() => expect(field('Workflow')).toHaveProperty('value', 'orders.sync'));
    expect(field('Version')).toHaveProperty('value', '');
  });

  it('leaves alone a version somebody typed that the fleet never offered', async () => {
    // The inverse of the test above, and the reason it is not simply "clear it": a version nobody
    // announced was never this field's to give, so it is not this field's to take away.
    await openCallInspector(
      fleet([
        { name: 'billing.reconcile', version: '1', group: 'billing', workers: 1 },
        { name: 'billing.reconcile', version: '2', group: 'billing', workers: 1 },
      ]),
    );

    fireEvent.change(field('Version'), { target: { value: '7' } });
    await choose('Workflow', 'billing.reconcile');

    await waitFor(() => expect(field('Workflow')).toHaveProperty('value', 'billing.reconcile'));
    expect(field('Version')).toHaveProperty('value', '7');
  });

  it('shows an entry two groups claim, and refuses to let it be chosen', async () => {
    await openCallInspector(
      fleet([
        {
          name: 'billing.reconcile',
          version: '2',
          workers: 2,
          disagreements: [{ axis: 'group', values: ['billing', 'billing-legacy'] }],
        },
      ]),
    );

    // Shown, not hidden: an option silently dropped is the failure the old docblock was about.
    // And both groups are named in full under the fields, where nothing truncates them.
    await screen.findByText(/2 different groups \(billing, billing-legacy\)/);

    // The NAME is refused too, because every announcement under it is — but it is still listed.
    await openField('Workflow');
    const name = screen.getByRole('option', { name: /billing\.reconcile/ });
    expect(name.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(name);
    expect(field('Workflow')).toHaveProperty('value', '');
    await close();

    // And so is the version, reached the other way: by typing the name the fleet does announce and
    // opening the field that lists what it announces for it.
    fireEvent.change(field('Workflow'), { target: { value: 'billing.reconcile' } });
    await openField('Version');
    const version = screen.getByRole('option', { name: /^2/ });
    expect(version.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(version);

    await waitFor(() => expect(field('Version')).toHaveProperty('value', ''));
  });

  it('shows a bare, unversioned announcement and refuses that too', async () => {
    // What an un-upgraded worker of any SDK publishes: a name, no version, no group. Offering it
    // as though it could satisfy the pin would be a lie the node then carries.
    await openCallInspector(fleet([{ name: 'legacy.sweep', workers: 1 }]));

    await screen.findByText(/without saying which version it runs/);

    fireEvent.change(field('Workflow'), { target: { value: 'legacy.sweep' } });
    await openField('Version');

    // Present, greyed, and labelled as what it is — rather than absent, which would leave the
    // sentence under the field disagreeing with the list above it.
    const row = screen.getByRole('option', { name: /no version announced/ });
    expect(row.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(row);

    await waitFor(() => expect(field('Version')).toHaveProperty('value', ''));
  });

  it('names the group, which is the one signal a missing body could never give', async () => {
    await openCallInspector(
      fleet([{ name: 'billing.reconcile', version: '2', group: 'python-billing', workers: 1 }]),
    );

    await openField('Workflow');
    expect(
      within(screen.getByRole('option', { name: /billing\.reconcile/ })).getByText(
        /group python-billing/,
      ),
    ).toBeDefined();
  });

  it('says when it looked, rather than presenting a snapshot as a standing fact', async () => {
    await openCallInspector(
      fleet([{ name: 'billing.reconcile', version: '2', group: 'billing', workers: 1 }]),
    );

    expect(inspector().getByText(/a worker that stops beating drops off it/)).toBeDefined();
  });

  it('confirms a pin the fleet actually announces, and not one it does not', async () => {
    await openCallInspector(
      fleet([{ name: 'billing.reconcile', version: '2', group: 'billing', workers: 1 }]),
    );

    fireEvent.change(field('Workflow'), { target: { value: 'billing.reconcile' } });
    fireEvent.change(field('Version'), { target: { value: '2' } });
    await screen.findByText(/This exact pin is announced right now/);

    // A version nobody announced gets no confirmation. It is still perfectly saveable — it is just
    // not something the fleet said, and the line would be claiming that it was.
    fireEvent.change(field('Version'), { target: { value: '7' } });
    await waitFor(() =>
      expect(screen.queryByText(/This exact pin is announced right now/)).toBeNull(),
    );
  });

  it('does not confirm a half-filled node beside a bare announcement of its name', async () => {
    // The refusal arriving by a different door. A node with a name and no version yet, beside a
    // bare announcement of that name, must not read as though the fleet had confirmed a pin —
    // there is no version to have confirmed.
    await openCallInspector(fleet([{ name: 'legacy.sweep', workers: 1 }]));

    fireEvent.change(field('Workflow'), { target: { value: 'legacy.sweep' } });

    await waitFor(() => expect(field('Workflow')).toHaveProperty('value', 'legacy.sweep'));
    expect(screen.queryByText(/This exact pin is announced right now/)).toBeNull();
  });

  it('keeps both fields usable when nobody could be asked, and says why', async () => {
    // A deployment with no durable engine announces nothing. The fields are text boxes first and
    // lists second, so there is nothing to fall back to — and the popup carries the server's own
    // sentence instead of being an empty promise of a choice.
    const { lastPostTo } = await openCallInspector({
      supported: false,
      workflows: [],
      observedAt: '2026-01-01T00:00:00.000Z',
      detail: 'No durable engine resolved in this process, so nothing here can read the fleet.',
    });

    await openField('Workflow');
    expect(offered()).toEqual([]);
    expect(screen.getByText(/No durable engine resolved in this process/)).toBeDefined();
    await close();

    fireEvent.change(field('Workflow'), { target: { value: 'legacy.sweep' } });
    fireEvent.change(field('Version'), { target: { value: '7' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(lastPostTo('/pipeline/workflows')).toBeDefined());
    expect(readCallNodes(lastPostTo('/pipeline/workflows')?.body)).toEqual([
      { callName: 'legacy.sweep', callVersion: '7', config: {} },
    ]);
  });

  it('lets a name the fleet is not announcing be typed over the list', async () => {
    // The list is a suggestion over a text box, not a gate in front of one. A workflow served by a
    // worker too old to announce its registrations is missing from it and perfectly callable.
    const { lastPostTo } = await openCallInspector(
      fleet([{ name: 'billing.reconcile', version: '2', group: 'billing', workers: 1 }]),
    );

    fireEvent.change(field('Workflow'), { target: { value: 'legacy.sweep' } });
    fireEvent.change(field('Version'), { target: { value: '7' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(lastPostTo('/pipeline/workflows')).toBeDefined());
    expect(readCallNodes(lastPostTo('/pipeline/workflows')?.body)).toEqual([
      { callName: 'legacy.sweep', callVersion: '7', config: {} },
    ]);
  });
});

/** One of the call inspector's two comboboxes, by its visible label. */
function field(label: 'Workflow' | 'Version') {
  return inspector().getByLabelText(new RegExp(`^${label}`));
}

/**
 * Open a combobox's popup the way a pointer does.
 *
 * Four events rather than one, and none is optional: Base UI opens on the pointer sequence, not on
 * `click`, and jsdom dispatches no pointer pipeline of its own. A bare `fireEvent.click` leaves the
 * popup shut, and every assertion then fails on "no options" — which reads like a filtering bug
 * and is not one.
 */
async function openField(label: 'Workflow' | 'Version') {
  const input = field(label);
  fireEvent.focus(input);
  fireEvent.pointerDown(input, { pointerType: 'mouse', button: 0 });
  fireEvent.mouseDown(input, { button: 0 });
  fireEvent.click(input);
  await waitFor(() => expect(screen.getByRole('listbox')).toBeDefined());
}

/** Shut it again, so the NEXT `getByRole('option')` is not answered by the last popup. */
async function close() {
  const list = screen.queryByRole('listbox');
  if (list) fireEvent.keyDown(list, { key: 'Escape' });
  await waitFor(() => expect(screen.queryAllByRole('option').length).toBe(0));
}

/**
 * The row LABELS currently on offer, in order.
 *
 * Read from the `title` the label carries for truncation rather than from `textContent`, which
 * would fold the hint line in behind it and turn every assertion into a substring match against a
 * sentence that is allowed to change.
 */
function offered() {
  return screen
    .queryAllByRole('option')
    .map((option) => option.querySelector('[title]')?.getAttribute('title') ?? '');
}

/**
 * Open a combobox and commit one row.
 *
 * A click on the row, which is what Base UI's `Autocomplete.Item` fires its `onClick` on — the
 * same handler <kbd>Enter</kbd> reaches when the row is highlighted.
 */
async function choose(label: 'Workflow' | 'Version', option: string) {
  await openField(label);
  fireEvent.click(screen.getByRole('option', { name: new RegExp(`^${option}`) }));
}

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

/** The call nodes out of a saved body, narrowed field by field rather than asserted. */
function readCallNodes(body: unknown): Array<Record<string, unknown>> {
  const nodes = readRecord(body).nodes;
  if (!Array.isArray(nodes)) return [];
  const calls: Array<Record<string, unknown>> = [];
  for (const raw of nodes) {
    const record = readRecord(raw);
    if (record.kind !== 'call') continue;
    calls.push({
      callName: record.callName,
      callVersion: record.callVersion,
      config: readRecord(record.config),
    });
  }
  return calls;
}

/**
 * Right-clicking the canvas.
 *
 * WHAT IS CHECKED HERE AND WHAT IS NOT
 * ------------------------------------
 * The *contents* of every menu are pinned in `workflow/canvas-menu.spec.ts`, against the model,
 * because that is where the rules live and a portalled popup in a layout-less DOM is a bad place
 * to ask "is a sink offered anything downstream". What is checked here is the wiring — that the
 * right event on the right target opens the right menu — and the one thing only observable at this
 * level: **which right-clicks the canvas declines to take over.** Placement near a viewport edge is
 * checked in a real browser; jsdom has no layout and would pass it for the wrong reason.
 */
describe('right-clicking the canvas', () => {
  async function rightClick(target: Element) {
    // `button: 2` is what `anchorFor` reads to tell a pointer from the context-menu key.
    fireEvent.contextMenu(target, { button: 2, clientX: 400, clientY: 300 });
    return await screen.findByRole('menu');
  }

  it('opens a node’s own menu, and the browser’s does not also appear', async () => {
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    const target = document.querySelector('.react-flow__node[aria-label^="source node, Feed"]');
    if (!target) throw new Error('No source node on the canvas');
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: 400,
      clientY: 300,
    });
    target.dispatchEvent(event);

    // Cancelled, which is what stops the browser drawing its own menu over this one.
    expect(event.defaultPrevented).toBe(true);
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('New transform')).toBeDefined();
    expect(within(menu).getByText('Open Feed')).toBeDefined();
  });

  it('leaves the browser’s menu alone inside a text field', async () => {
    // The one thing a canvas must not do: take over right-click everywhere. Cut, copy, paste and
    // spell-check are the only useful menu inside an input, and this canvas has nothing better.
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    const field = screen.getByLabelText('Name');
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    field.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('offers to add a node where the pointer is, on empty canvas', async () => {
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    const pane = document.querySelector('.react-flow__pane');
    if (!pane) throw new Error('No React Flow pane');
    const menu = await rightClick(pane);

    // Every kind, derived from `WORKFLOW_NODE_KINDS` — the row this replaced was hand-written, and
    // that is exactly how `filter` shipped with no way to create it.
    expect(within(menu).getByText('New source')).toBeDefined();
    expect(within(menu).getByText('New filter')).toBeDefined();
    expect(within(menu).getByText('Tidy the layout')).toBeDefined();
  });
});

/**
 * Deleting a node without opening its inspector.
 *
 * The gestures were asked for — *"tem que ter uma forma mais rápida de deletar o nó… talvez no
 * hover tipo o wire"* — and what makes them safe to add is that the canvas now has a real undo.
 * What undo does NOT do is make it visible that a node took two other nodes' wiring with it, so
 * that is the part checked here.
 */
describe('removing a node without opening its inspector', () => {
  /**
   * Hover a node and return its delete button.
   *
   * Matched on the exact accessible name — "Delete Feed" and not `/^Delete /` — because the header
   * carries "Delete this workflow", and a loose matcher finds both. That failure reads as a
   * duplicate render rather than as an over-broad query, and the whole point of naming the node in
   * the button's label is that a screen reader hears which box it is about.
   */
  async function hover(label: string, name: string) {
    const node = document.querySelector(`.react-flow__node[aria-label^="${label}"]`);
    if (!node) throw new Error(`No canvas node whose description starts "${label}"`);
    fireEvent.mouseEnter(node);
    return await screen.findByLabelText(`Delete ${name}`);
  }

  it('removes it from the hover toolbar in one click', async () => {
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    fireEvent.click(await hover('source node, Feed', 'Feed'));

    await waitFor(() => expect(screen.queryAllByText('Feed')).toHaveLength(0));
  });

  it('says the wires went too, rather than leaving it to be noticed later', async () => {
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    fireEvent.click(await hover('source node, Feed', 'Feed'));

    // In the polite live region, which is a canvas's only feedback to somebody who cannot see it:
    // a node vanishing is silence.
    expect(await screen.findByText(/connection it was part of went with it/)).toBeDefined();
  });

  it('is one undo entry, and Ctrl+Z puts the node and its wiring back', async () => {
    // The trade this whole feature rests on: no confirmation dialog — which is friction people
    // learn to click through without reading — and the canvas's own undo instead.
    const { transport } = fakeTransport(answersFor([wholeWorkflow()]));
    await openCanvas(transport);

    fireEvent.click(await hover('source node, Feed', 'Feed'));
    await waitFor(() => expect(screen.queryAllByText('Feed')).toHaveLength(0));

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });

    await waitFor(() => expect(screen.queryAllByText('Feed').length).toBeGreaterThan(0));
    expect(panel('Wiring').getByLabelText('Disconnect Feed from Out')).toBeDefined();
  });
});
