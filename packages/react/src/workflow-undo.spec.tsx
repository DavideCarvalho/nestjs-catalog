// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * Taking an edit back, throwing the draft away, and not losing it by closing the tab.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Before this, the canvas had no undo of any kind and no leave-warning: closing the tab on an
 * unsaved graph lost it silently, and the only trace of unsaved work anywhere on screen was the
 * word on the Save button changing from "Saved" to "Save". Four things were asked for and they are
 * one subject — step back by ACTION, reset to the LAST SAVED version, SHOW that there is unsaved
 * work, and WARN before it is thrown away.
 *
 * WHAT MATTERS HERE, IN ORDER
 * ---------------------------
 * **1. The unit.** An undo that steps a pixel at a time is not an undo. The granularity rule lives
 * in `workflow/history.tsx` and is exercised directly below: a run of edits that belong to one
 * gesture folds into one entry, and edits that belong to different gestures never do. If a
 * refactor makes undo per-change again, the "one drag is one action" test goes red.
 *
 * **2. The boundary.** Undo touches the drawing and nothing the server has done. There is no test
 * that can prove a control did NOT unpublish something, so what is asserted instead is that the
 * boundary is *stated* on screen, in the accessible tree, where somebody can read it before
 * pressing the button.
 *
 * **3. The guard fires only when dirty.** A page that always warns is a page people learn to
 * dismiss. jsdom cannot show the browser's dialog, but it can dispatch a cancelable `beforeunload`
 * and report whether anything cancelled it, which is exactly the fact in question.
 *
 * WHAT IS NOT ASSERTED HERE
 * -------------------------
 * That the browser actually shows its dialog, and that ⌘Z reaches the page ahead of the OS. Both
 * were checked in a real headless Chrome instead; jsdom has no window manager and no chrome, and a
 * test that "passed" on either would be testing the stub.
 */
import type { CatalogWorkflow } from '@dudousxd/nestjs-catalog/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { installCodeSurfaceDom } from '../../../test/jsdom-code-surface';
import { WorkflowCanvas } from './WorkflowCanvas';
import { CatalogProvider, type CatalogTransport } from './context';
import {
  type HistoricDraft,
  UNDO_DEPTH,
  isTypingTarget,
  nodeEditAction,
  reverted,
  snapshotOf,
  undone,
  withEdit,
} from './workflow/history';
import type { WorkflowNode } from './workflow/model';

installCodeSurfaceDom();

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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

afterEach(cleanup);

// ---------------------------------------------------------------------------
// The rule itself, without a canvas around it.
// ---------------------------------------------------------------------------

function node(id: string, name: string): WorkflowNode {
  return { id, name, kind: 'sink', targetType: 'Mvr', position: { x: 0, y: 0 } };
}

function draftOf(nodes: WorkflowNode[]): HistoricDraft {
  const graph = { name: 'Fleet', description: '', nodes, edges: [] };
  return { ...graph, dirty: false, past: [], baseline: snapshotOf(graph) };
}

/** One edit, applied to the nodes and recorded under the given action. */
function edited(
  draft: HistoricDraft,
  nodes: WorkflowNode[],
  action: Parameters<typeof withEdit>[2],
): HistoricDraft {
  return withEdit(draft, { ...draft, nodes }, action);
}

describe('what counts as one action', () => {
  it('folds a whole drag into one entry, however many frames it emitted', () => {
    // The reason this is not a per-change history. React Flow reports a drag as a stream of
    // position changes; `continuing` is the pointer still being down, and while it is, every
    // frame folds into the entry that holds the state from before the drag began.
    let draft = draftOf([node('a', 'A')]);
    const before = draft.nodes;

    for (let frame = 0; frame < 40; frame++) {
      draft = edited(draft, [{ ...node('a', 'A'), position: { x: frame, y: 0 } }], {
        label: 'moving "A"',
        run: 'move',
        continuing: true,
      });
    }
    // The frame that drops it: still the same gesture, and still the same entry.
    draft = edited(draft, [{ ...node('a', 'A'), position: { x: 40, y: 0 } }], {
      label: 'moving "A"',
      run: 'move',
    });

    expect(draft.past).toHaveLength(1);
    const back = undone(draft);
    expect(back?.draft.nodes).toBe(before);
    expect(back?.label).toBe('moving "A"');
  });

  it('never folds two different gestures together', () => {
    // Dragging A and then dragging B are two actions even back to back, because the run key
    // carries which nodes moved. Without that, one undo would put both back.
    let draft = draftOf([node('a', 'A'), node('b', 'B')]);
    draft = edited(draft, draft.nodes, { label: 'moving "A"', run: 'move:a', continuing: true });
    draft = edited(draft, draft.nodes, { label: 'moving "B"', run: 'move:b', continuing: true });

    expect(draft.past.map((entry) => entry.label)).toEqual(['moving "A"', 'moving "B"']);
  });

  it('never folds an unlabelled-run edit into anything', () => {
    // Adding a node twice is two actions. An action with no run key is always its own entry —
    // which is the default, and the safe one.
    let draft = draftOf([]);
    draft = edited(draft, [node('a', 'A')], { label: 'adding a sink node' });
    draft = edited(draft, [node('a', 'A'), node('b', 'B')], { label: 'adding a sink node' });

    expect(draft.past).toHaveLength(2);
  });

  it('keeps typing into one field as one action, and a different field as another', () => {
    // The run key is node + CHANGED FIELDS. Typing a name folds; changing something else on the
    // same node a moment later does not, or undoing the second would silently retype the first.
    const first = node('a', 'A');
    const renamed = { ...first, name: 'Ab' };
    const retargeted = { ...renamed, targetType: 'Subwo' };

    expect(nodeEditAction(first, renamed).run).toBe(
      nodeEditAction(renamed, { ...renamed, name: 'Abc' }).run,
    );
    expect(nodeEditAction(renamed, retargeted).run).not.toBe(nodeEditAction(first, renamed).run);
  });
});

describe('the depth of the stack', () => {
  it('keeps the most recent actions and drops the oldest, rather than refusing', () => {
    let draft = draftOf([]);
    for (let step = 0; step < UNDO_DEPTH + 10; step++) {
      draft = edited(draft, [node(`n${step}`, `N${step}`)], { label: `adding node ${step}` });
    }

    expect(draft.past).toHaveLength(UNDO_DEPTH);
    // The next undo is still the last thing done — the limit costs the far end of the history,
    // never the near one.
    expect(draft.past.at(-1)?.label).toBe(`adding node ${UNDO_DEPTH + 9}`);
    expect(draft.past.at(0)?.label).toBe(`adding node ${10}`);
  });
});

describe('undo against reset', () => {
  it('goes genuinely clean when undone all the way back to the baseline', () => {
    // The fact the leave-warning rests on. Undo restores the very arrays it recorded, so walking
    // back to the loaded graph is indistinguishable from never having edited it.
    let draft = draftOf([node('a', 'A')]);
    draft = edited(draft, [node('a', 'A'), node('b', 'B')], { label: 'adding a sink node' });
    expect(draft.dirty).toBe(true);

    const back = undone(draft);
    expect(back?.draft.dirty).toBe(false);
    expect(back?.draft.past).toHaveLength(0);
  });

  it('reset returns to the last SAVED version, which is not where undo would stop', () => {
    // The difference the two controls exist to draw. A save moves the baseline; undoing past it
    // would walk back to a version the person has already replaced, which is not what "reset"
    // means to anybody.
    const saved = { name: 'Fleet', description: '', nodes: [node('a', 'A')], edges: [] };
    let draft: HistoricDraft = {
      ...saved,
      dirty: false,
      // A history that predates the save, as it would be if the baseline had just moved.
      past: [{ before: { ...saved, nodes: [] }, label: 'adding a sink node', at: Date.now() }],
      baseline: snapshotOf(saved),
    };
    draft = edited(draft, [node('a', 'A'), node('b', 'B')], { label: 'adding a sink node' });

    const back = reverted(draft);
    expect(back.nodes).toBe(saved.nodes);
    expect(back.dirty).toBe(false);
    // And the history goes with it: keeping it would offer to undo the reset, which is a redo of
    // everything by another name.
    expect(back.past).toHaveLength(0);
  });

  it('says there is nothing to take back rather than producing a draft', () => {
    expect(undone(draftOf([]))).toBeNull();
  });
});

describe('where the keyboard shortcut must not fire', () => {
  it('declines every field somebody can be typing in', () => {
    // Ctrl/⌘Z inside a field means "undo my typing". A canvas-level binding firing there would
    // discard a graph edit instead, which is the worst outcome for a control whose whole job is
    // not losing work.
    const host = document.createElement('div');
    host.innerHTML = `
      <input id="text" />
      <textarea id="area"></textarea>
      <div id="code" contenteditable="true"><span id="caret">x</span></div>
      <div id="surface" role="textbox"><span id="inner">x</span></div>
      <div id="modal" role="dialog"><button id="in-modal" type="button">ok</button></div>
      <button id="toolbar" type="button">undo</button>
    `;
    document.body.append(host);

    for (const id of ['text', 'area', 'code', 'caret', 'surface', 'inner', 'in-modal']) {
      expect([id, isTypingTarget(host.querySelector(`#${id}`))]).toEqual([id, true]);
    }
    // …and fires everywhere else, including on chrome, because the canvas is rarely the focused
    // thing when somebody reaches for undo.
    expect(isTypingTarget(host.querySelector('#toolbar'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);

    host.remove();
  });
});

// ---------------------------------------------------------------------------
// The canvas, with the controls on it.
// ---------------------------------------------------------------------------

function fakeTransport(gets: Record<string, unknown>) {
  // biome-ignore lint/suspicious/noExplicitAny: the seam under test is generic over its response.
  const answer = (path: string): Promise<any> => {
    if (!(path in gets)) return Promise.reject(new Error(`No fake answer for ${path}`));
    return Promise.resolve(gets[path]);
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

function wholeWorkflow(): CatalogWorkflow {
  return {
    id: 'wf1',
    name: 'Fleet',
    enabled: true,
    version: 3,
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
        position: { x: 0, y: 0 },
      },
      { id: 'snk_1', name: 'Out', kind: 'sink', targetType: 'Mvr', position: { x: 320, y: 0 } },
    ],
    edges: [{ from: 'src_1', to: 'snk_1' }],
  };
}

function answers(): Record<string, unknown> {
  return {
    '/pipeline/workflows': [wholeWorkflow()],
    '/pipeline/transforms': [],
    '/pipeline/connections': [],
    '/pipeline/capabilities': {
      languages: ['javascript'],
      pythonPackages: [],
      durable: { available: true },
    },
    '/pipeline/callable-workflows': {
      supported: false,
      workflows: [],
      observedAt: '2026-01-01T00:00:00.000Z',
      detail: 'No durable engine resolved in this process.',
    },
    '/catalog': {
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
    },
  };
}

async function openCanvas() {
  render(withCatalog(fakeTransport(answers()), <WorkflowCanvas />));
  await screen.findAllByText('Feed');
}

/** The undo control, whose accessible name carries what it would take back. */
function undoButton(): HTMLButtonElement {
  const button = screen.getByLabelText(/^Undo/);
  if (!(button instanceof HTMLButtonElement)) throw new Error('Undo is not a button');
  return button;
}

function resetButton(): HTMLButtonElement {
  const button = screen.getByLabelText(/^Reset to the last saved version/);
  if (!(button instanceof HTMLButtonElement)) throw new Error('Reset is not a button');
  return button;
}

/** Whether anything on the page would stop the tab closing. */
function wouldWarnOnLeave(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('the canvas, before anything has been edited', () => {
  it('offers no undo, no reset, and no leave-warning', async () => {
    await openCanvas();

    expect(undoButton()).toHaveProperty('disabled', true);
    expect(undoButton().getAttribute('aria-label')).toMatch(/nothing to take back/i);
    expect(resetButton()).toHaveProperty('disabled', true);
    // The one that matters most. A page that warns on a graph nobody has touched is a page whose
    // warning people learn to dismiss without reading.
    expect(wouldWarnOnLeave()).toBe(false);
  });

  it('says what undo does not reach, in the accessible tree rather than only in a tooltip', async () => {
    await openCanvas();

    // A tooltip is a pointer affordance and is announced unevenly. This sentence has to be
    // readable by somebody deciding whether "Undo" on a screen with a Publish button on it is
    // safe to press.
    expect(
      screen.getByText(
        /saving, publishing, running and deleting the workflow are not undone here/i,
      ),
    ).toBeDefined();
  });
});

describe('the canvas, with an unsaved edit on it', () => {
  it('shows that there is unsaved work, names what undo would take back, and arms the guard', async () => {
    await openCanvas();

    fireEvent.click(screen.getByLabelText('Add a sink node'));

    await waitFor(() => expect(undoButton()).toHaveProperty('disabled', false));
    expect(undoButton().getAttribute('aria-label')).toBe('Undo: adding a sink node');
    // Not a word on a button. Something that says "your work is at risk" and is announced when it
    // appears, because it appears exactly once per clean→dirty transition.
    expect(screen.getByText('Unsaved')).toBeDefined();
    expect(wouldWarnOnLeave()).toBe(true);
  });

  it('takes the node back, says so out loud, and disarms the guard again', async () => {
    await openCanvas();
    fireEvent.click(screen.getByLabelText('Add a sink node'));
    await waitFor(() => expect(screen.getAllByText('Sink').length).toBeGreaterThan(0));

    fireEvent.click(undoButton());

    // The announcement is half the feature: undo can revert something scrolled off the canvas,
    // and a silent revert of an invisible thing is indistinguishable from a dead button.
    await waitFor(() => expect(screen.getByText(/Undone: adding a sink node/)).toBeDefined());
    expect(screen.queryByText('Unsaved')).toBeNull();
    expect(wouldWarnOnLeave()).toBe(false);
  });

  it('undoes from the keyboard, and not while somebody is typing a name', async () => {
    await openCanvas();
    fireEvent.click(screen.getByLabelText('Add a sink node'));
    await waitFor(() => expect(undoButton()).toHaveProperty('disabled', false));

    // The canvas has a name field and a code editor on it. A binding that fired in either would
    // discard a graph edit instead of the character somebody just typed.
    const nameField = within(screen.getByRole('dialog')).getByLabelText(/^Name/);
    fireEvent.keyDown(nameField, { key: 'z', ctrlKey: true });
    expect(undoButton()).toHaveProperty('disabled', false);

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(undoButton()).toHaveProperty('disabled', true));
  });

  it('says there is no redo rather than doing nothing at all', async () => {
    await openCanvas();
    fireEvent.click(screen.getByLabelText('Add a sink node'));
    await waitFor(() => expect(undoButton()).toHaveProperty('disabled', false));

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true, shiftKey: true });

    // The hands that reach for shift+⌘Z expect a redo. Silence reads as a broken shortcut, so it
    // says which control does the job instead.
    await waitFor(() => expect(screen.getByText(/There is no redo on this canvas/)).toBeDefined());
    // …and it did not quietly undo anything on the way past.
    expect(undoButton()).toHaveProperty('disabled', false);
  });

  it('asks before reset throws the work away, and says how much of it there is', async () => {
    await openCanvas();
    fireEvent.click(screen.getByLabelText('Add a sink node'));
    await waitFor(() => expect(resetButton()).toHaveProperty('disabled', false));

    fireEvent.click(resetButton());

    // Reset destroys unsaved work, so it is confirmed exactly as deleting the workflow is — and
    // the confirmation says what it means by "the last saved version".
    const dialog = await screen.findByText('Discard every unsaved edit?');
    expect(dialog).toBeDefined();
    expect(screen.getByText(/1 action will be thrown away/)).toBeDefined();

    fireEvent.click(screen.getByText('Discard and reset'));

    await waitFor(() => expect(screen.queryByText('Unsaved')).toBeNull());
    expect(wouldWarnOnLeave()).toBe(false);
    expect(undoButton()).toHaveProperty('disabled', true);
  });
});
