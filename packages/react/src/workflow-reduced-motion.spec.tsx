// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * That somebody who has asked their machine to stop moving things can still use this canvas.
 *
 * WHY THIS IS ITS OWN FILE
 * ------------------------
 * `useReducedMotion` reads `matchMedia('(prefers-reduced-motion)')` exactly once and caches the
 * answer in a module-level ref, so a single spec file cannot exercise both branches — the first
 * render decides for every test after it. Vitest gives each file its own module registry, so the
 * preference is set here, before anything renders, and the "no preference" branch lives in
 * `workflow-edge-delete.spec.tsx`.
 *
 * WHAT IS ACTUALLY BEING PROTECTED
 * --------------------------------
 * Not that the animation is absent — an absent animation is not something anybody needs. What
 * matters is that nothing is REVEALED by one. The × is mounted by the edge being selected;
 * `AnimatePresence` only decides how it arrives. If a later change made the control's existence
 * depend on a transition having run, this file is what notices, and it notices in the one
 * configuration where that transition does not run.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { installCodeSurfaceDom } from '../../../test/jsdom-code-surface';
import { WorkflowCanvas } from './WorkflowCanvas';
import { CatalogProvider, type CatalogTransport } from './context';
import { flowingEdgeIds } from './workflow/graph';
import type { WorkflowEdge, WorkflowRunNode } from './workflow/model';

installCodeSurfaceDom();

/**
 * The preference, said yes to — and said yes to AFTER the shim, which answers no to everything.
 *
 * Before any render, because the first `useReducedMotion` of the file is what sticks.
 */
Object.defineProperty(window, 'matchMedia', {
  value: (query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
  writable: true,
  configurable: true,
});

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class FlatDOMMatrix {
  m22 = 1;
}
Object.defineProperty(globalThis, 'DOMMatrixReadOnly', { value: FlatDOMMatrix, writable: true });
Object.defineProperty(globalThis, 'DOMMatrix', { value: FlatDOMMatrix, writable: true });
// Non-zero, or React Flow skips the nodes and draws no edge at all. See the sibling spec.
Object.defineProperties(globalThis.HTMLElement.prototype, {
  offsetHeight: { get: () => 80, configurable: true },
  offsetWidth: { get: () => 224, configurable: true },
});
Object.defineProperty(globalThis.SVGElement.prototype, 'getBBox', {
  value: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  configurable: true,
});

afterEach(cleanup);

const workflow = {
  id: 'wf1',
  name: 'Fleet',
  enabled: true,
  version: 1,
  status: 'ready' as const,
  graphHash: 'hash-1',
  targetType: 'Mvr',
  createdBy: 'someone',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  nodes: [
    {
      id: 'src_1',
      name: 'Feed',
      kind: 'source' as const,
      sourceKind: 'http' as const,
      config: {},
      position: { x: 0, y: 0 },
    },
    {
      id: 'snk_1',
      name: 'Out',
      kind: 'sink' as const,
      targetType: 'Mvr',
      position: { x: 320, y: 0 },
    },
  ],
  edges: [{ from: 'src_1', to: 'snk_1' }],
};

const answers: Record<string, unknown> = {
  '/pipeline/workflows': [workflow],
  '/pipeline/transforms': [],
  '/pipeline/connections': [],
  '/pipeline/capabilities': {
    languages: ['javascript'],
    pythonPackages: [],
    durable: { available: true },
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

function transportFor(): CatalogTransport {
  // biome-ignore lint/suspicious/noExplicitAny: the seam under test is generic over its response.
  const answer = (path: string): Promise<any> =>
    path in answers ? Promise.resolve(answers[path]) : Promise.reject(new Error(path));
  return {
    get: answer,
    post: answer,
    patch: answer,
    delete: answer,
  };
}

function withCatalog(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <CatalogProvider transport={transportFor()}>{children}</CatalogProvider>
    </QueryClientProvider>
  );
}

async function edgeElement(): Promise<Element> {
  let found: Element | null = null;
  await waitFor(() => {
    found = document.querySelector('.react-flow__edge[data-id="src_1->snk_1"]');
    expect(found, 'no edge on the canvas').not.toBeNull();
  });
  if (!found) throw new Error('No edge on the canvas');
  return found;
}

describe('with prefers-reduced-motion set', () => {
  it('still offers the × on a selected connection, and it still works', async () => {
    render(withCatalog(<WorkflowCanvas />));
    await screen.findAllByText('Feed');

    fireEvent.click(await edgeElement());

    await waitFor(() =>
      expect(screen.getAllByLabelText('Remove the connection from Feed to Out')).toHaveLength(1),
    );

    fireEvent.click(screen.getByLabelText('Remove the connection from Feed to Out'));
    await waitFor(() => expect(screen.getByText('Connection removed.')).toBeDefined());
  });

  it('marks no connection as animated, because there is no way to soften that one', async () => {
    // React Flow's `animated` is a keyframe in its own stylesheet — no prop reaches it and this
    // package ships no CSS to override it. So the only honest accommodation is not to set the
    // flag, and `flowingEdgeIds` is where that decision lives.
    render(withCatalog(<WorkflowCanvas />));
    await screen.findAllByText('Feed');

    expect((await edgeElement()).getAttribute('class')).not.toContain('animated');
  });
});

describe('flowingEdgeIds', () => {
  const edges: WorkflowEdge[] = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
  ];
  const running: WorkflowRunNode[] = [
    { nodeId: 'a', status: 'running' },
    { nodeId: 'b', status: 'pending' },
  ];

  it('flows the edges leaving whatever is running right now', () => {
    expect([...flowingEdgeIds(edges, running, { reducedMotion: false })]).toEqual(['a->b']);
  });

  it('flows nothing at all when motion is unwanted', () => {
    // The assertion that makes the accommodation real rather than aspirational: it is not "less
    // animation", it is none, and it holds even with a node actively running.
    expect([...flowingEdgeIds(edges, running, { reducedMotion: true })]).toEqual([]);
  });

  it('flows nothing when no node is running, which is almost always', () => {
    const finished: WorkflowRunNode[] = [
      { nodeId: 'a', status: 'succeeded' },
      { nodeId: 'b', status: 'succeeded' },
    ];
    expect([...flowingEdgeIds(edges, finished, { reducedMotion: false })]).toEqual([]);
  });
});
