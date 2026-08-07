/**
 * Making nodes and wires, and splicing one into a wire that already exists.
 *
 * WHY THE SPLICE IS TESTED HERE AND NOT ON THE CANVAS
 * ---------------------------------------------------
 * It is reached by right-clicking an edge, and React Flow draws no edges under jsdom — it places
 * them from measurements jsdom never takes, so `.react-flow__edge` simply does not exist there. A
 * DOM test would have to fake the geometry to assert arithmetic, which is a test of the fake.
 *
 * The two things worth pinning are both invisible on screen, which is exactly why they need a
 * test:
 *
 *   - **the branch label travels with the first half.** A wire leaving an `if` is on a side, and
 *     the side decides which half of the pipeline runs. Dropping the label while splicing would
 *     move a whole downstream branch onto the gate's default and pass validation doing it.
 *   - **the two new wires go in at the index the old one held.** A node with several inbound edges
 *     receives its inputs in that order and the order is part of what the graph produces, so an
 *     append would silently reorder a join's feeds and draw an identical picture.
 */
import { describe, expect, it } from 'vitest';
import {
  graphWithNodeBetween,
  kindsBetween,
  newEdge,
  newKindsFrom,
  nodeBetween,
  uniqueName,
} from './create';
import { WORKFLOW_NODE_KINDS, type WorkflowEdge, type WorkflowNode } from './model';

const SOURCE: WorkflowNode = {
  id: 'src',
  name: 'Feed',
  kind: 'source',
  sourceKind: 'http',
  config: {},
  position: { x: 0, y: 0 },
};
const GATE: WorkflowNode = {
  id: 'gate',
  name: 'Stage?',
  kind: 'if',
  predicate: { kind: 'env', envVar: 'STAGE' },
  position: { x: 320, y: 0 },
};
const SINK: WorkflowNode = {
  id: 'out',
  name: 'Out',
  kind: 'sink',
  targetType: 'Mvr',
  position: { x: 640, y: 0 },
};

describe('what can follow what', () => {
  it('asks the graph rather than restating the rules', () => {
    // Every kind except another source can be fed by a source. Nothing here says so; `newKindsFrom`
    // drops a throwaway node of each kind into a copy of the graph and asks `canConnect`.
    const kinds = newKindsFrom(SOURCE, [SOURCE], []);

    expect(kinds).toEqual(WORKFLOW_NODE_KINDS.filter((kind) => kind !== 'source'));
  });

  it('offers nothing after a sink, ever', () => {
    expect(newKindsFrom(SINK, [SOURCE, SINK], [])).toEqual([]);
  });
});

describe('putting a node in the middle of a wire', () => {
  const nodes = [SOURCE, SINK];
  const edge: WorkflowEdge = { from: 'src', to: 'out' };

  it('only offers kinds that can take one end and feed the other', () => {
    const kinds = kindsBetween(edge, nodes, [edge]);

    expect(kinds).toContain('transform');
    expect(kinds).toContain('filter');
    // A source takes no input; a sink lets nothing follow it.
    expect(kinds).not.toContain('source');
    expect(kinds).not.toContain('sink');
  });

  it('takes the wire out before asking, or every candidate would close a loop', () => {
    // Left in, the second question — can the new node feed the downstream one — is asked against a
    // graph where the two ends are still directly connected, and is refused for a cycle that is
    // about to stop existing.
    expect(kindsBetween(edge, nodes, [edge]).length).toBeGreaterThan(0);
  });

  it('rewires A → B into A → new → B', () => {
    const made = nodeBetween(edge, 'transform', nodes);
    const next = graphWithNodeBetween(edge, made, nodes, [edge]);

    expect(next.edges).toEqual([
      { from: 'src', to: made.id },
      { from: made.id, to: 'out' },
    ]);
    expect(next.nodes.map((node) => node.id)).toEqual(['src', 'out', made.id]);
  });

  it('keeps the branch on the first half, so the same side still runs', () => {
    const branched: WorkflowEdge = { from: 'gate', to: 'out', branch: 'else' };
    const graph = [SOURCE, GATE, SINK];
    const edges: WorkflowEdge[] = [{ from: 'src', to: 'gate' }, branched];
    const made = nodeBetween(branched, 'transform', graph);
    const next = graphWithNodeBetween(branched, made, graph, edges);

    expect(next.edges[1]).toEqual({ from: 'gate', to: made.id, branch: 'else' });
    // …and the second half carries none, because the inserted node is not itself a gate.
    expect(next.edges[2]).toEqual({ from: made.id, to: 'out' });
  });

  it('puts both halves where the old wire was, so a join keeps its input order', () => {
    // `join` is fed by A first and B second. Splicing the FIRST of those must leave the spliced
    // pair ahead of B's wire, or the join silently sees its inputs the other way round.
    const a: WorkflowNode = { ...SOURCE, id: 'a', name: 'A' };
    const b: WorkflowNode = { ...SOURCE, id: 'b', name: 'B' };
    const join: WorkflowNode = {
      id: 'join',
      name: 'Join',
      kind: 'transform',
      transformId: 't',
      position: { x: 320, y: 0 },
    };
    const graph = [a, b, join];
    const edges: WorkflowEdge[] = [
      { from: 'a', to: 'join' },
      { from: 'b', to: 'join' },
    ];
    const made = nodeBetween(edges[0], 'filter', graph);
    const next = graphWithNodeBetween(edges[0], made, graph, edges);

    expect(next.edges.filter((entry) => entry.to === 'join').map((entry) => entry.from)).toEqual([
      made.id,
      'b',
    ]);
  });

  it('drops the new node between its two ends rather than beside the upstream one', () => {
    // Left-to-right is run order on this canvas. A node inserted into `A → B` runs after A and
    // before B, and placing it in A's next column — frequently B's own column — would draw it level
    // with the node it now feeds.
    const made = nodeBetween(edge, 'transform', nodes);

    expect(made.position).toEqual({ x: 320, y: 0 });
  });
});

describe('naming and branching', () => {
  it('does not call the second transform "Transform" as well', () => {
    const first: WorkflowNode = {
      id: 'a',
      name: 'Transform',
      kind: 'transform',
      transformId: '',
      position: { x: 0, y: 0 },
    };

    expect(uniqueName([first], 'transform')).toBe('Transform 2');
  });

  it('gives a gate’s first two wires the two branches, in that order', () => {
    const graph = [GATE, SINK];

    expect(newEdge(graph, [], 'gate', 'out').branch).toBe('then');
    expect(newEdge(graph, [{ from: 'gate', to: 'x', branch: 'then' }], 'gate', 'out').branch).toBe(
      'else',
    );
  });

  it('leaves every other wire unbranded, because only an if node branches', () => {
    expect(newEdge([SOURCE, SINK], [], 'src', 'out')).toEqual({ from: 'src', to: 'out' });
  });
});
