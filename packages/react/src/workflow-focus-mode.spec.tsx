// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * Focus mode: the chrome compacts, and nothing that stops a mistake goes with it.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The canvas became the screen and the tooling started floating on it, which fixed the shape of
 * the surface and left its size: on a 1600×913 window the floating chrome still covered ~20% of
 * the canvas, most of it a top-left card that is ~400×280 and mostly two fields. Focus mode is one
 * gesture — a button, or `f` — that collapses the card to its head, drops the node dock to icons
 * and puts the details rail away.
 *
 * A mode that hides things is only safe if it cannot hide the things that prevent a mistake, so
 * that is what most of this file asserts, and it asserts it from the OUTSIDE — by accessible name
 * and rendered text — because the guarantee is "somebody using this screen can still see it", not
 * "a prop was passed".
 *
 * The four protected signals, and where each is checked below:
 *
 *   1. **Problems.** The rail is what focus puts away, and the rail is what lists them. The rail
 *      toggle carries the count and its colour while it is gone, which already existed; what is
 *      new is that focus is the thing most likely to take the rail, so the count is asserted
 *      through the focus gesture rather than through the rail's own button.
 *   2. **Unsaved state.** Save doubles as the indicator ("Save" vs "Saved"). Focus does not touch
 *      the action cluster at all, and the test says so by name.
 *   3. **Refusal notes.** They hang under the button that caused them, in that same cluster.
 *   4. **Publish state.** The status badges are in the card's HEAD, which is the half that stays.
 *
 * WHAT IS NOT ASSERTED HERE
 * -------------------------
 * Anything about area. jsdom does no layout — every element is 0×0 — so "the canvas got 21% more
 * room" is not a thing this file can know and a test claiming it would pass for the wrong reason.
 * That number was measured in a real browser and lives in the changeset. What jsdom CAN answer is
 * which controls are in the document, what they are called, and what the keyboard does to them,
 * and that is the whole of the safety argument.
 *
 * `toBeDisabled` / `toBeChecked` are NOT available — this repo registers no jest-dom setup, and
 * they throw rather than fail. `toHaveProperty('disabled', true)` is the equivalent that works.
 */
import type { CatalogSnapshot, CatalogWorkflow } from '@dudousxd/nestjs-catalog/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCodeSurfaceDom } from '../../../test/jsdom-code-surface';
import { WorkflowCanvas } from './WorkflowCanvas';
import { CatalogProvider, type CatalogTransport } from './context';

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

/**
 * The mode is remembered per TAB, so every test starts in a tab that has not chosen one.
 *
 * Without this the second test inherits the first one's decision, and the failure reads as "the
 * card was already collapsed" — which is indistinguishable from the bug where focus turns itself
 * on. jsdom gives the whole FILE one `sessionStorage`, not one per test.
 */
const FOCUS_STORAGE_KEY = 'catalog.workflowCanvas.focus';
beforeEach(() => window.sessionStorage.clear());

function fakeTransport(gets: Record<string, unknown>) {
  // biome-ignore lint/suspicious/noExplicitAny: the seam under test is generic over its response.
  const answer = (path: string): Promise<any> =>
    path in gets
      ? Promise.resolve(gets[path])
      : Promise.reject(new Error(`No fake answer for ${path}`));

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

/** A source wired into a sink: a stored graph with nothing wrong with it. */
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
        position: { x: 0, y: 0 },
      },
      { id: 'snk_1', name: 'Out', kind: 'sink', targetType: 'Mvr', position: { x: 320, y: 0 } },
    ],
    edges: [{ from: 'src_1', to: 'snk_1' }],
    ...overrides,
  };
}

/**
 * A graph the checks refuse, so the problem count has something to be.
 *
 * Two sinks: the model allows exactly one, which is the loudest error `validateWorkflow` produces
 * and the one least likely to be re-spelled by a later change to the prose.
 */
function refusedWorkflow(): CatalogWorkflow {
  const base = wholeWorkflow();
  return {
    ...base,
    nodes: [
      ...base.nodes,
      {
        id: 'snk_2',
        name: 'Also out',
        kind: 'sink',
        targetType: 'Mvr',
        position: { x: 320, y: 200 },
      },
    ],
    edges: [...base.edges, { from: 'src_1', to: 'snk_2' }],
  };
}

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
    '/pipeline/callable-workflows': {
      supported: false,
      workflows: [],
      observedAt: '2026-01-01T00:00:00.000Z',
      detail: 'No durable engine resolved in this process.',
    },
    '/catalog': snapshot(),
  };
}

async function openCanvas(workflows: CatalogWorkflow[] = [wholeWorkflow()]) {
  render(withCatalog(fakeTransport(answersFor(workflows)), <WorkflowCanvas />));
  await screen.findAllByText('Feed');
}

/** The one control, by the half of its name that does not change with its state. */
function focusToggle(): HTMLButtonElement {
  const button = screen
    .getAllByRole('button')
    .find((el) => /^Turn (on|off) focus mode/.test(el.getAttribute('aria-label') ?? ''));
  if (!(button instanceof HTMLButtonElement)) throw new Error('No focus toggle on screen');
  return button;
}

/**
 * Save, matched on its text rather than its accessible name.
 *
 * The icon beside it leaves whitespace in the computed name, so an anchored name matcher misses
 * it — which fails as "no such button" and reads like a rendering bug. Same reasoning as the
 * sibling spec's helper.
 */
function saveButton(): HTMLButtonElement {
  const button = screen.getByText(/^Saved?$/).closest('button');
  if (!(button instanceof HTMLButtonElement)) throw new Error('Save is not a button');
  return button;
}

/**
 * The gesture, from the keyboard, on the surface rather than on a control.
 *
 * `Element` rather than `EventTarget`, which is what the handler under test
 * narrows: `fireEvent` will not accept the wider type, and the whole point of
 * the test below is that the handler asks what the target IS.
 */
function pressShortcut(target: Element = document.body) {
  fireEvent.keyDown(target, { key: 'f' });
}

describe('collapsing the chrome', () => {
  it('takes away the card body, the dock labels and the rail in one gesture', async () => {
    await openCanvas();

    // Before: the picker and the name field are on screen, and so is the rail.
    expect(screen.getByLabelText('Which workflow to edit')).toBeDefined();
    expect(screen.getByLabelText('Workflow wiring and problems')).toBeDefined();

    fireEvent.click(focusToggle());

    // The two fields are UNMOUNTED, not hidden. A hidden control is still a tab stop, which is the
    // "focus stranded on something invisible" failure this had to avoid.
    await waitFor(() => expect(screen.queryByLabelText('Which workflow to edit')).toBeNull());
    // Its own `waitFor`, because the rail leaves on a spring and the card body on a tween, so the
    // two do not finish on the same frame — asserting the second inside the first's wait is a
    // flake that only shows up on a loaded machine.
    await waitFor(() => expect(screen.queryByLabelText('Workflow wiring and problems')).toBeNull());
  });

  it('keeps every add-node button reachable, by name, once the dock is icons', async () => {
    // The dock compacts by dropping its LABELS, and the accessible names were always separate
    // from the labels — that is the whole reason dropping them is safe. If a later change made the
    // name come from the visible text, this goes red rather than shipping six unnamed buttons.
    await openCanvas();
    fireEvent.click(focusToggle());

    await waitFor(() => expect(screen.queryByLabelText('Which workflow to edit')).toBeNull());
    for (const name of ['a source', 'a transform', 'a sink', 'a call', 'an if', 'a filter']) {
      expect(screen.getByLabelText(`Add ${name} node`)).toBeDefined();
    }
    expect(screen.getByLabelText('Tidy the layout')).toBeDefined();
  });

  it('says which state it is in, to a screen reader', async () => {
    await openCanvas();
    const toggle = focusToggle();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggle);

    await waitFor(() => expect(focusToggle().getAttribute('aria-pressed')).toBe('true'));
  });
});

describe('what focus mode may not hide', () => {
  it('leaves Save, and therefore whether the work is at risk', async () => {
    await openCanvas();
    fireEvent.click(focusToggle());

    await waitFor(() => expect(screen.queryByLabelText('Which workflow to edit')).toBeNull());
    // Still there, and still saying which of the two states it is in.
    expect(saveButton().textContent).toBe('Saved');
  });

  it('leaves the problem count on the toggle of the rail it just took away', async () => {
    // The load-bearing one. Focus is the gesture most likely to remove the problems list, so the
    // fact of a problem has to survive the gesture — as a number and as words, because a red 2 is
    // not information if you cannot see it.
    await openCanvas([refusedWorkflow()]);

    // `getAll`: an OPEN rail carries that name twice — once on the toggle beside the actions and
    // once on the × inside the panel itself. Two ways to shut one thing is deliberate; a `getBy`
    // here fails as "multiple elements", which reads like a duplicate render.
    await waitFor(() => expect(screen.getAllByLabelText('Hide the details panel').length).toBe(2));
    fireEvent.click(focusToggle());

    const shown = await screen.findByLabelText(/^Show the details panel, \d+ errors?$/);
    expect(shown).toBeDefined();
  });

  it('leaves the publish state, because the badges are in the half that stays', async () => {
    await openCanvas();
    fireEvent.click(focusToggle());

    await waitFor(() => expect(screen.queryByLabelText('Which workflow to edit')).toBeNull());
    // `ready` is what `wholeWorkflow` stores, and the badge is the only thing on this screen that
    // says a graph has been declared finished. Matched exactly, and as a `getAll`: the word also
    // appears in the badge's own tooltip copy and in the publish controls, and the point here is
    // that it is still SOMEWHERE — the badge did not go with the card body.
    expect(screen.getAllByText('ready').length).toBeGreaterThan(0);
  });

  it('leaves the delete and run controls, which is the cluster staying whole', async () => {
    await openCanvas();
    fireEvent.click(focusToggle());

    await waitFor(() => expect(screen.queryByLabelText('Which workflow to edit')).toBeNull());
    expect(screen.getByLabelText('Delete this workflow')).toBeDefined();
    expect(screen.getByText('Run')).toBeDefined();
  });
});

describe('the refusal', () => {
  it('will not collapse the card while the graph has no name', async () => {
    // The one way this mode could become a trap: Save is disabled on an empty name, and the field
    // that fills it in is inside the card. Collapsing it would leave a dead Save button, a tooltip
    // about a field that is not on screen, and no way to connect the two.
    await openCanvas();

    const name = screen.getByLabelText('Name');
    fireEvent.change(name, { target: { value: '' } });

    fireEvent.click(focusToggle());

    // Focus is ON — the dock has compacted and the rail is gone — and the card stayed.
    await waitFor(() => expect(screen.queryByLabelText('Workflow wiring and problems')).toBeNull());
    expect(screen.getByLabelText('Which workflow to edit')).toBeDefined();
    expect(screen.getByLabelText('Name')).toBeDefined();
  });

  it('says it is refusing rather than looking broken', async () => {
    await openCanvas();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '' } });
    fireEvent.click(focusToggle());

    // In the accessible name, not only in the tooltip: this is the one state where the button's
    // behaviour differs from its label, and a tooltip is a pointer affordance.
    await waitFor(() =>
      expect(
        screen.getByLabelText(/the card is staying: this workflow has no name yet/),
      ).toBeDefined(),
    );
  });

  it('lifts the moment a name is typed, without asking again', async () => {
    await openCanvas();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '' } });
    fireEvent.click(focusToggle());
    await waitFor(() => expect(screen.getByLabelText('Name')).toBeDefined());

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Fleet again' } });

    // Focus was already on, so the card collapses on its own — chrome that asserts itself while it
    // has something to say and goes quiet when it stops.
    await waitFor(() => expect(screen.queryByLabelText('Which workflow to edit')).toBeNull());
  });

  it('does not fold out from under the caret that is filling the name in', async () => {
    // The bug the previous test cannot see, because `fireEvent.change` does not focus anything.
    // In a browser the refusal is lifted by TYPING, on the first character — so without a guard
    // the field vanishes mid-word and the rest of the name is typed into nothing.
    await openCanvas();
    const name = screen.getByLabelText('Name');
    fireEvent.change(name, { target: { value: '' } });
    fireEvent.click(focusToggle());
    await waitFor(() => expect(screen.getByLabelText('Name')).toBeDefined());

    fireEvent.focus(name);
    fireEvent.change(name, { target: { value: 'F' } });

    // Still there, and still holding the caret, half a second after the condition that was keeping
    // it open stopped being true.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(screen.getByLabelText('Name')).toBeDefined();

    // It folds when the field is left, which is the moment nobody is mid-word.
    fireEvent.blur(name, { relatedTarget: document.body });
    await waitFor(() => expect(screen.queryByLabelText('Name')).toBeNull());
  });
});

describe('the keyboard', () => {
  it('toggles on the shortcut, from anywhere on the screen', async () => {
    await openCanvas();

    pressShortcut();

    await waitFor(() => expect(screen.queryByLabelText('Which workflow to edit')).toBeNull());

    pressShortcut();
    await waitFor(() => expect(screen.getByLabelText('Which workflow to edit')).toBeDefined());
  });

  it('does not fire on the f of a name somebody is typing', async () => {
    // The bug a bare-letter shortcut invites, and the reason `typingInto` exists: this screen is
    // covered in text fields, and "the panels vanish while I name a node" is how it would be
    // reported.
    await openCanvas();
    const name = screen.getByLabelText('Name');

    pressShortcut(name);

    // Still expanded, half a second of waiting later than any state update would have taken.
    await waitFor(() => expect(screen.getByLabelText('Which workflow to edit')).toBeDefined());
    expect(focusToggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('leaves Ctrl+F and Cmd+F to the browser', async () => {
    // A shortcut that swallowed either would be reported as "find is broken on this screen".
    await openCanvas();

    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'f', metaKey: true });

    await waitFor(() => expect(screen.getByLabelText('Which workflow to edit')).toBeDefined());
    expect(focusToggle().getAttribute('aria-pressed')).toBe('false');
  });
});

describe('remembering the mode', () => {
  it('is remembered per tab, so a reload keeps it', async () => {
    await openCanvas();
    fireEvent.click(focusToggle());

    await waitFor(() => expect(window.sessionStorage.getItem(FOCUS_STORAGE_KEY)).toBe('1'));

    // A remount is what a reload is, from this component's point of view.
    cleanup();
    await openCanvas();

    // Waited for rather than asserted flat, and the wait is the honest part: a fresh mount starts
    // on a blank draft, so for the tick before the list arrives the graph has no name and the
    // refusal above holds the card open. It collapses as soon as there is a name to show in its
    // head, which is the same rule, applied to the same fact, one render earlier.
    await waitFor(() => expect(screen.queryByLabelText('Which workflow to edit')).toBeNull());
    // …and the rail does NOT come back, rather than the mode arriving half-applied. Measured in a
    // browser first: press F, reload, and the rail was open with the toggle still saying "off".
    expect(screen.queryByLabelText('Workflow wiring and problems')).toBeNull();
  });

  it('is not remembered beyond the tab, so nobody inherits a hidden control', async () => {
    // `sessionStorage` and deliberately not `localStorage`. The whole argument is on
    // `FOCUS_STORAGE_KEY`; what this asserts is that nothing was written to the store that
    // outlives the tab.
    await openCanvas();
    fireEvent.click(focusToggle());

    await waitFor(() => expect(window.sessionStorage.getItem(FOCUS_STORAGE_KEY)).toBe('1'));
    expect(window.localStorage.getItem(FOCUS_STORAGE_KEY)).toBeNull();
  });

  it('opens with the chrome present when the tab has never chosen', async () => {
    await openCanvas();
    expect(screen.getByLabelText('Which workflow to edit')).toBeDefined();
    expect(focusToggle().getAttribute('aria-pressed')).toBe('false');
  });
});

/* ---------------------------------------------------------------------------
 * The overview.
 * ------------------------------------------------------------------------- */

/**
 * A pointer that can hover, or one that cannot.
 *
 * jsdom implements no `matchMedia` AT ALL, and the code under test answers "cannot hover" to every
 * failure — so without a stub every test in this section would run as the touch case, and the ones
 * asserting that the map shrinks would pass by never shrinking and never noticing. The stub is
 * what makes the fine-pointer case reachable, and the touch case is then the SAME stub answering
 * the other way rather than the absence of one.
 *
 * `prefers-reduced-motion` is answered `true` deliberately. It is what jsdom's missing `matchMedia`
 * already means for `useReducedMotion()` in the rest of this file — the card body folds instantly
 * — so installing this stub does not quietly turn a 220ms tween on underneath the tests above.
 * Nothing in this section depends on that answer: the minimap's animation is CSS, so it is asserted
 * as a class rather than as a settled value.
 */
function pointerThatCan(hover: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes('hover: hover') ? hover : query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

/**
 * The panel the overview lives in — the element that carries the scale, the focus stop and the
 * transition.
 *
 * Reached through the minimap's own test id and up one, rather than by a test id of its own: the
 * relationship being asserted is "React Flow's minimap is INSIDE the thing focus mode resizes", and
 * a query that walks it will fail if that ever stops being true.
 */
function overviewPanel(): HTMLElement {
  const minimap = document.querySelector('[data-testid="rf__minimap"]');
  const panel = minimap?.parentElement;
  if (!(panel instanceof HTMLElement)) throw new Error('The overview is not in a panel');
  return panel;
}

/** The `svg` React Flow measures its pan gain from. */
function overviewSvg(): SVGElement {
  const svg = document.querySelector('[data-testid="rf__minimap"] svg');
  if (!(svg instanceof SVGElement)) throw new Error('The overview draws no svg');
  return svg;
}

/** Turn focus mode on and wait for the card to have actually folded. */
async function enterFocus(): Promise<void> {
  fireEvent.click(focusToggle());
  await waitFor(() => expect(focusToggle().getAttribute('aria-pressed')).toBe('true'));
}

describe('the overview, while focus mode has the screen', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'matchMedia');
  });

  it('is left at full size until focus mode asks for the room', async () => {
    pointerThatCan(true);
    await openCanvas();

    expect(overviewPanel().className).not.toContain('scale-[0.48]');
  });

  it('shrinks once focus mode has the screen', async () => {
    pointerThatCan(true);
    await openCanvas();
    await enterFocus();

    expect(overviewPanel().className).toContain('scale-[0.48]');
  });

  it('goes back to full size under a pointer, and under a caret', async () => {
    pointerThatCan(true);
    await openCanvas();
    await enterFocus();

    // jsdom resolves no `:hover` and no `:focus-visible`, so what is asserted is that BOTH routes
    // back to full size are declared — the pointer one and the keyboard one. That they actually
    // fire is a browser question, and was measured in one.
    const className = overviewPanel().className;
    expect(className).toContain('hover:scale-100');
    expect(className).toContain('focus:scale-100');
    expect(className).toContain('focus-within:scale-100');
  });

  it('becomes a focus stop while it is shrunk, so a keyboard can enlarge it too', async () => {
    pointerThatCan(true);
    await openCanvas();
    await enterFocus();

    const panel = overviewPanel();
    expect(panel.getAttribute('tabindex')).toBe('0');
    expect(panel.getAttribute('role')).toBe('group');
    // Named for what it is and what to do with it, because a focus stop that announces nothing is
    // a place the caret lands for no stated reason.
    expect(panel.getAttribute('aria-label')).toMatch(/overview/i);
    expect(panel.getAttribute('aria-label')).toMatch(/full size/i);
  });

  it('is not a focus stop at all outside focus mode, so the tab order is the one that was settled', async () => {
    pointerThatCan(true);
    await openCanvas();

    const panel = overviewPanel();
    expect(panel.getAttribute('tabindex')).toBeNull();
    expect(panel.getAttribute('role')).toBeNull();
  });

  it('does not shrink for a pointer that cannot hover, because a tap there is a pan', async () => {
    pointerThatCan(false);
    await openCanvas();
    await enterFocus();

    const panel = overviewPanel();
    // The whole treatment is off: no scale, and no focus stop invented to undo a scale that never
    // happened. A finger gets the map exactly as it is outside focus mode.
    expect(panel.className).not.toContain('scale-[0.48]');
    expect(panel.getAttribute('tabindex')).toBeNull();
  });

  it('resizes on a transform, and not at all when motion is unwelcome', async () => {
    pointerThatCan(true);
    await openCanvas();
    await enterFocus();

    const className = overviewPanel().className;
    // A transform rather than a width: it is the property that does not touch layout, and — see
    // `FocusMiniMap` — the only one that leaves React Flow's pan gain alone.
    expect(className).toContain('transition-transform');
    expect(className).toContain('origin-bottom-left');
    expect(className).toContain('motion-reduce:transition-none');
  });

  it('never unmounts the overview, in either state', async () => {
    pointerThatCan(true);
    await openCanvas();
    expect(document.querySelector('[data-testid="rf__minimap"]')).not.toBeNull();

    await enterFocus();

    // The lesson from the card body, applied before it could be repeated: this is an animation of
    // the same shape, and the version of it that resolves against `height: auto` never settled
    // under jsdom, so `AnimatePresence` never unmounted and the collapsed content stayed in the
    // document forever. Nothing here is ever unmounted or conditionally rendered, so there is no
    // presence to settle and no way for this to lie the way that did.
    expect(document.querySelector('[data-testid="rf__minimap"]')).not.toBeNull();
  });

  it('keeps the geometry React Flow pans by identical in both states', async () => {
    pointerThatCan(true);
    await openCanvas();

    // React Flow derives `viewScale` — the number its pan handler multiplies raw pointer deltas by
    // — from the minimap's own width and height. This assertion IS the panning argument: because
    // the shrink is a transform and never touches these, the pan gain is the same small, large,
    // and on every frame in between, so a drag cannot accelerate under the finger mid-animation.
    expect(overviewSvg().getAttribute('width')).toBe('200');
    expect(overviewSvg().getAttribute('height')).toBe('150');

    await enterFocus();

    expect(overviewSvg().getAttribute('width')).toBe('200');
    expect(overviewSvg().getAttribute('height')).toBe('150');
  });
});
