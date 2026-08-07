/**
 * What the canvas offers when you right-click something.
 *
 * WHY THESE ARE MODEL TESTS AND NOT DOM TESTS
 * -------------------------------------------
 * `buildCanvasMenu` returns data, and the questions worth pinning are questions about that data:
 * *is a sink ever offered something downstream*, *is a wire out of a gate the only wire offered a
 * branch*, *is the delete item always last and always separated*. Asked through a portalled popup
 * in jsdom, each of those becomes a query against a DOM with no layout, and a failure reads as a
 * selector problem rather than as a rule problem. Placement — which is the half jsdom genuinely
 * cannot answer — is checked in a real browser instead.
 *
 * THE ONE RULE EVERYTHING HERE EXISTS TO PROTECT
 * ----------------------------------------------
 * The menu must never offer an edge the graph would refuse. It does not know the rules: every
 * option that makes a connection is filtered by `canConnect`, the same function the drag, the
 * click gesture and the inspector's picker are refused by. So the tests below are written as
 * *nothing is offered that would be refused*, and a future change that restates a rule here so a
 * menu can be "smart" turns them red.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  type CanvasMenuActions,
  type CanvasMenuContext,
  type CanvasMenuSection,
  buildCanvasMenu,
} from './canvas-menu';
import { WORKFLOW_NODE_KINDS, type WorkflowEdge, type WorkflowNode } from './model';

function node(id: string, kind: WorkflowNode['kind'], name = id): WorkflowNode {
  if (kind === 'source') {
    return { id, name, kind: 'source', sourceKind: 'http', config: {}, position: { x: 0, y: 0 } };
  }
  if (kind === 'sink') {
    return { id, name, kind: 'sink', targetType: 'Mvr', position: { x: 640, y: 0 } };
  }
  if (kind === 'if') {
    return {
      id,
      name,
      kind: 'if',
      predicate: { kind: 'env', envVar: 'STAGE' },
      position: { x: 320, y: 0 },
    };
  }
  if (kind === 'filter') {
    return {
      id,
      name,
      kind: 'filter',
      predicate: { kind: 'compare', column: 'a', operator: 'equals', value: 1 },
      position: { x: 320, y: 0 },
    };
  }
  if (kind === 'call') {
    return {
      id,
      name,
      kind: 'call',
      callName: 'x',
      callVersion: '1',
      config: {},
      position: { x: 320, y: 0 },
    };
  }
  return { id, name, kind: 'transform', transformId: 'tr1', position: { x: 320, y: 0 } };
}

/** Every action, spied, so a test can assert what an item actually asked the canvas to do. */
function actions(): CanvasMenuActions & {
  [K in keyof CanvasMenuActions]: ReturnType<typeof vi.fn>;
} {
  return {
    inspect: vi.fn(),
    editCode: vi.fn(),
    connect: vi.fn(),
    connectToNew: vi.fn(),
    insertBetween: vi.fn(),
    setBranch: vi.fn(),
    disconnect: vi.fn(),
    removeNodes: vi.fn(),
    addAt: vi.fn(),
    tidy: vi.fn(),
    fitAll: vi.fn(),
    fitNodes: vi.fn(),
  };
}

function context(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  over: Partial<CanvasMenuContext> = {},
): CanvasMenuContext {
  return {
    nodes,
    edges,
    kinds: WORKFLOW_NODE_KINDS,
    canEdit: true,
    published: false,
    actions: actions(),
    ...over,
  };
}

/** Every item label on the menu, flattened, which is what most assertions are about. */
function labels(sections: CanvasMenuSection[]): string[] {
  return sections.flatMap((section) => section.items.map((item) => item.label));
}

function section(sections: CanvasMenuSection[], key: string): CanvasMenuSection {
  const found = sections.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`No "${key}" section. Got: ${sections.map((s) => s.key).join(', ')}`);
  return found;
}

describe('right-clicking a node', () => {
  const graph = () => ({
    nodes: [node('src', 'source', 'Feed'), node('out', 'sink', 'Out')],
    edges: [{ from: 'src', to: 'out' }] satisfies WorkflowEdge[],
  });

  it('offers a sink nothing downstream, and says why rather than showing a gap', () => {
    // "Nothing here" and "nothing is possible" look identical and mean different things, and for a
    // sink the answer is permanent — so the section is present, empty, and speaks.
    const { nodes, edges } = graph();
    const sections = buildCanvasMenu({ kind: 'node', nodeId: 'out' }, context(nodes, edges));

    expect(section(sections, 'targets').items).toEqual([]);
    expect(section(sections, 'targets').note).toMatch(/Nothing runs after one/);
    expect(labels(sections)).not.toContain('New transform');
    // …and the wire it already has is removable from here, which is otherwise a hunt for a line.
    expect(labels(sections)).toContain('Disconnect Feed');
  });

  it('offers a source every kind that can legally take its output, and no others', () => {
    const { nodes, edges } = graph();
    const sections = buildCanvasMenu({ kind: 'node', nodeId: 'src' }, context(nodes, edges));
    const made = section(sections, 'new').items.map((item) => item.label);

    expect(made).toContain('New transform');
    expect(made).toContain('New filter');
    expect(made).toContain('New if');
    // Nothing feeds a source. The probe is refused by the rule that refuses the drag.
    expect(made).not.toContain('New source');
  });

  it('derives the kinds it can make from the model, never from a written-out list', () => {
    // `filter` shipped complete — model, validator, executor, inspector, its own colour — and
    // could not be added from this screen at all, because the palette was six hand-typed JSX
    // elements and only five of them had been typed. A source can legally feed everything except
    // another source, so this menu has to name every other kind there is.
    const { nodes, edges } = graph();
    const sections = buildCanvasMenu({ kind: 'node', nodeId: 'src' }, context(nodes, edges));
    const made = new Set(section(sections, 'new').items.map((item) => item.label));

    for (const kind of WORKFLOW_NODE_KINDS) {
      if (kind === 'source') continue;
      expect(made).toContain(`New ${kind}`);
    }
  });

  it('puts delete last, on its own, in the destructive tone', () => {
    const { nodes, edges } = graph();
    const sections = buildCanvasMenu({ kind: 'node', nodeId: 'src' }, context(nodes, edges));
    const last = sections[sections.length - 1];

    expect(last.key).toBe('delete');
    expect(last.separated).toBe(true);
    expect(last.items).toHaveLength(1);
    expect(last.items[0].destructive).toBe(true);
  });

  it('says the wires go too, because nothing else on the screen would', () => {
    // A node removal that quietly unwires two OTHER nodes, and says only "node removed", is how
    // somebody finds out half an hour later that their graph no longer reaches its sink.
    const { nodes, edges } = graph();
    const sections = buildCanvasMenu({ kind: 'node', nodeId: 'src' }, context(nodes, edges));

    expect(section(sections, 'delete').items[0].detail).toMatch(/1 connection/);
  });

  it('warns that a published graph has to stay runnable, and only when it is one', () => {
    // The server refuses a save that would leave a published graph unable to run, in those words.
    // The edit is accepted here and turned away at the save, which is the one case where a warning
    // in advance is worth more than a confirmation after.
    const { nodes, edges } = graph();
    const draft = buildCanvasMenu({ kind: 'node', nodeId: 'src' }, context(nodes, edges));
    const live = buildCanvasMenu(
      { kind: 'node', nodeId: 'src' },
      context(nodes, edges, { published: true }),
    );

    expect(section(draft, 'delete').items[0].detail).not.toMatch(/published/);
    expect(section(live, 'delete').items[0].detail).toMatch(/has to stay runnable/);
  });

  it('offers the code of a transform only once it names one', () => {
    // The code sheet on a transform with no transform chosen renders a paragraph explaining there
    // is nothing to open. That is right for a sheet somebody navigated to and wrong for a menu
    // item, which exists to promise an outcome.
    const named = node('tx', 'transform');
    // Rebuilt rather than spread: `WorkflowNode` is a union of six shapes, and spreading one of
    // them widens the result to "any of the six", which is not assignable back to the union.
    const blank: WorkflowNode = {
      id: 'tx',
      name: 'tx',
      kind: 'transform',
      transformId: '',
      position: { x: 320, y: 0 },
    };

    expect(labels(buildCanvasMenu({ kind: 'node', nodeId: 'tx' }, context([named], [])))).toContain(
      'Edit its code',
    );
    expect(
      labels(buildCanvasMenu({ kind: 'node', nodeId: 'tx' }, context([blank], []))),
    ).not.toContain('Edit its code');
  });

  it('offers a read-only viewer everything that reads and nothing that writes', () => {
    const { nodes, edges } = graph();
    const sections = buildCanvasMenu(
      { kind: 'node', nodeId: 'src' },
      context(nodes, edges, { canEdit: false }),
    );

    expect(labels(sections)).toEqual(['Open Feed']);
    expect(sections.some((entry) => entry.items.some((item) => item.destructive))).toBe(false);
  });
});

describe('right-clicking a wire', () => {
  const gate = () => ({
    nodes: [
      node('src', 'source', 'Feed'),
      node('gate', 'if', 'Stage?'),
      node('out', 'sink', 'Out'),
    ],
    edges: [
      { from: 'src', to: 'gate' },
      { from: 'gate', to: 'out', branch: 'then' },
    ] satisfies WorkflowEdge[],
  });

  it('offers the branch swap on a gate’s wire, and on no other wire', () => {
    // `validateWorkflow` refuses a branch label on any wire that does not leave an `if`, so
    // offering the control anywhere else would be offering a change the server will not take.
    const { nodes, edges } = gate();
    const branched = buildCanvasMenu({ kind: 'edge', edge: edges[1] }, context(nodes, edges));
    const plain = buildCanvasMenu({ kind: 'edge', edge: edges[0] }, context(nodes, edges));

    expect(labels(branched)).toContain('Move it to "else"');
    expect(labels(plain).some((label) => label.startsWith('Move it to'))).toBe(false);
  });

  it('offers only kinds that can take one end AND feed the other', () => {
    // Splicing is two connections, not one. A menu that checked only the upstream half would
    // happily offer to insert a sink into the middle of a graph.
    const { nodes, edges } = gate();
    const sections = buildCanvasMenu({ kind: 'edge', edge: edges[0] }, context(nodes, edges));
    const made = section(sections, 'insert').items.map((item) => item.label);

    expect(made).toContain('New transform');
    // A sink commits and nothing runs after it, so it cannot feed the gate below.
    expect(made).not.toContain('New sink');
    // A source takes no input, so the node above cannot feed it.
    expect(made).not.toContain('New source');
  });

  it('says why nothing can go in the middle rather than showing an empty list', () => {
    // Straight into a sink there is still room for a transform; the case with no room at all is a
    // gate feeding a gate, where the inserted node would have to accept a second inbound stream.
    const nodes = [node('a', 'if', 'One'), node('b', 'if', 'Two')];
    const edges: WorkflowEdge[] = [{ from: 'a', to: 'b', branch: 'then' }];
    const sections = buildCanvasMenu({ kind: 'edge', edge: edges[0] }, context(nodes, edges));

    // Whatever the answer is, the section never renders as a silent gap: it either has items or it
    // has a sentence.
    const insert = section(sections, 'insert');
    expect(insert.items.length > 0 || Boolean(insert.note)).toBe(true);
  });

  it('puts disconnect last and separated, and names what stays', () => {
    const { nodes, edges } = gate();
    const sections = buildCanvasMenu({ kind: 'edge', edge: edges[0] }, context(nodes, edges));
    const last = sections[sections.length - 1];

    expect(last.key).toBe('disconnect');
    expect(last.separated).toBe(true);
    expect(last.items[0].destructive).toBe(true);
    expect(last.items[0].detail).toMatch(/Both nodes stay/);
  });
});

describe('right-clicking empty canvas', () => {
  it('adds at the point that was clicked, and says so', () => {
    const spies = actions();
    const sections = buildCanvasMenu(
      { kind: 'pane', at: { x: 42, y: 7 } },
      context([node('src', 'source')], [], { actions: spies }),
    );
    const add = section(sections, 'add');

    expect(add.items.map((item) => item.label)).toEqual(
      WORKFLOW_NODE_KINDS.map((kind) => `New ${kind}`),
    );
    add.items[0].run();
    expect(spies.addAt).toHaveBeenCalledWith(WORKFLOW_NODE_KINDS[0], { x: 42, y: 7 });
  });

  it('does not offer to arrange a graph that has nothing in it', () => {
    // Two controls that do nothing are worse than a sentence saying why there is nothing to do.
    const empty = buildCanvasMenu({ kind: 'pane', at: { x: 0, y: 0 } }, context([], []));

    expect(section(empty, 'view').items).toEqual([]);
    expect(section(empty, 'view').note).toMatch(/Nothing is drawn yet/);
  });

  it('offers a read-only viewer the view controls and no way to change the graph', () => {
    const sections = buildCanvasMenu(
      { kind: 'pane', at: { x: 0, y: 0 } },
      context([node('src', 'source')], [], { canEdit: false }),
    );

    expect(labels(sections)).toEqual(['Fit it on screen']);
  });
});

describe('right-clicking several selected nodes', () => {
  it('offers what is plural and leaves out what is not', () => {
    // "Send its output to" against five boxes would be offering an action whose "its" has no
    // referent, so the selection menu deliberately carries only what is true of a set.
    const nodes = [node('a', 'transform', 'One'), node('b', 'transform', 'Two')];
    const sections = buildCanvasMenu(
      { kind: 'selection', nodeIds: ['a', 'b'] },
      context(nodes, []),
    );

    expect(labels(sections)).toEqual(['Bring these into view', 'Delete these 2 nodes']);
    expect(sections[sections.length - 1].separated).toBe(true);
  });

  it('counts the wires the whole selection would take with it', () => {
    const nodes = [node('a', 'source', 'One'), node('b', 'transform', 'Two'), node('c', 'sink')];
    const edges: WorkflowEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ];
    const sections = buildCanvasMenu(
      { kind: 'selection', nodeIds: ['a', 'b'] },
      context(nodes, edges),
    );

    expect(section(sections, 'delete').items[0].detail).toMatch(/2 connections/);
  });
});
