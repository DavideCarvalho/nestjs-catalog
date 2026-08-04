/**
 * The canvas's half of workflow validation.
 *
 * Core's rules are already covered in `packages/catalog/src/catalog.pipeline.spec.ts`, and this
 * module deliberately does not restate them — it calls core's `validateWorkflow` and adds only the
 * questions core cannot answer. So what is pinned here is the seam and the additions:
 *
 *   - core's issues are passed through with their codes INTACT, because a caller matching on a
 *     code has to match the same string the server would have sent back;
 *   - the three canvas-only checks, each of which was once a rule that had drifted from the
 *     executable model and flagged graphs that ran perfectly well;
 *   - `canConnect`, which is asked mid-drag, before the edge exists, and so cannot be core's.
 */
import type { WorkflowEdge, WorkflowNode } from '@dudousxd/nestjs-catalog/client';
import { describe, expect, it } from 'vitest';
import {
  type WorkflowProblem,
  canConnect,
  edgeId,
  hasBlockingProblem,
  problemsByNode,
  validateWorkflow,
  wouldCycle,
} from './validate';

function source(id: string): WorkflowNode {
  return { id, name: id, kind: 'source', sourceKind: 'inline', config: {} };
}
function transform(id: string, transformId = 'tx-1'): WorkflowNode {
  return { id, name: id, kind: 'transform', transformId };
}
function sink(id: string, targetType = 'Mvr'): WorkflowNode {
  return { id, name: id, kind: 'sink', targetType };
}
function wire(pairs: Array<[string, string]>): WorkflowEdge[] {
  return pairs.map(([from, to]) => ({ from, to }));
}
function codes(problems: WorkflowProblem[]): string[] {
  return problems.map((problem) => problem.code);
}

/** src → tx → out. The smallest graph that actually runs. */
const runnableNodes = [source('src'), transform('tx'), sink('out')];
const runnableEdges = wire([
  ['src', 'tx'],
  ['tx', 'out'],
]);
const allTransforms = { transformIds: new Set(['tx-1']) };

describe('validateWorkflow', () => {
  it('has nothing to say about a graph that runs', () => {
    expect(validateWorkflow({ nodes: runnableNodes, edges: runnableEdges }, allTransforms)).toEqual(
      [],
    );
  });

  it("passes core's issues through under core's own codes", () => {
    // The seam. This file used to carry a second copy of these rules and they drifted; the value
    // of delegating is lost the moment a code is renamed on the way out, because a canvas showing
    // one vocabulary and a server refusing in another is a save nobody can debug.
    const problems = validateWorkflow({ nodes: [], edges: [] }, allTransforms);

    expect(codes(problems)).toEqual(['empty']);
    expect(problems[0]?.level).toBe('error');
  });

  it('names the wires for a cycle, which core reports as nodes only', () => {
    // React Flow needs edge ids to draw the loop in red. Core has no concept of an edge id, so
    // this is derived here — and only for the codes that are actually about wires.
    const nodes = [source('src'), transform('a'), transform('b'), sink('out')];
    const edges = wire([
      ['src', 'a'],
      ['a', 'b'],
      ['b', 'a'],
      ['b', 'out'],
    ]);

    const cycle = validateWorkflow({ nodes, edges }, allTransforms).find(
      (problem) => problem.code === 'cycle',
    );

    expect(cycle).toBeDefined();
    expect(cycle?.edgeIds).toEqual(expect.arrayContaining(['a->b', 'b->a']));
  });

  it('leaves edgeIds empty for issues that are not about wires', () => {
    const problems = validateWorkflow({ nodes: [sink('out')], edges: [] }, allTransforms).filter(
      (problem) => problem.code !== 'cycle',
    );

    expect(problems.every((problem) => problem.edgeIds.length === 0)).toBe(true);
  });

  it('flags a transform pointing at something that was deleted', () => {
    // Invisible on the canvas — the node keeps its name and its wiring — and only fails when the
    // graph runs. Core cannot see it: it has no list of transforms.
    const problems = validateWorkflow(
      { nodes: runnableNodes, edges: runnableEdges },
      { transformIds: new Set(['some-other-transform']) },
    );

    expect(codes(problems)).toEqual(['missing-transform']);
    expect(problems[0]?.nodeIds).toEqual(['tx']);
    expect(problems[0]?.message).toContain('Transforms tab');
  });

  it('does not flag a transform node that names nothing yet', () => {
    // A node dropped from the palette has no transform chosen. That is unfinished, not broken,
    // and core already reports it; a second complaint on the same node while somebody is still
    // wiring teaches them to ignore the panel.
    const problems = validateWorkflow(
      { nodes: [source('src'), transform('tx', ''), sink('out')], edges: runnableEdges },
      allTransforms,
    );

    expect(codes(problems)).not.toContain('missing-transform');
  });

  it('flags a sink that does not say what it writes', () => {
    // Core's type requires `targetType` but its validator never checks the string is non-empty,
    // and the server refuses one that is. Additive, not contradictory.
    const problems = validateWorkflow(
      { nodes: [source('src'), transform('tx'), sink('out', '')], edges: runnableEdges },
      allTransforms,
    );

    expect(codes(problems)).toEqual(['sink-has-no-type']);
    expect(problems[0]?.nodeIds).toEqual(['out']);
  });

  it('treats whitespace as no type at all', () => {
    const problems = validateWorkflow(
      { nodes: [source('src'), transform('tx'), sink('out', '   ')], edges: runnableEdges },
      allTransforms,
    );

    expect(codes(problems)).toEqual(['sink-has-no-type']);
  });

  it('allows two sinks writing DIFFERENT types', () => {
    // The rule that was withdrawn, and the reason a workflow exists at all: one expensive read
    // feeding several outputs. A validator that forbids this makes people pull twice.
    const nodes = [
      source('src'),
      transform('tx'),
      sink('vehicles', 'Mvr'),
      sink('orders', 'Subwo'),
    ];
    const edges = wire([
      ['src', 'tx'],
      ['tx', 'vehicles'],
      ['tx', 'orders'],
    ]);

    expect(validateWorkflow({ nodes, edges }, allTransforms)).toEqual([]);
  });

  it('refuses two sinks writing the SAME type, exactly once', () => {
    // The half of that rule that survives: two snapshots of one type in one run, with nothing to
    // say which one won.
    //
    // ONCE is the assertion that matters. This file used to raise its own `duplicate-sink-type`
    // as well as passing core's through, so the canvas listed the same complaint twice in two
    // different wordings and ringed the same pair of nodes for both. Counting, rather than using
    // `find`, is what catches the copy coming back.
    const nodes = [source('src'), transform('tx'), sink('a', 'Mvr'), sink('b', 'Mvr')];
    const edges = wire([
      ['src', 'tx'],
      ['tx', 'a'],
      ['tx', 'b'],
    ]);

    const problems = validateWorkflow({ nodes, edges }, allTransforms);

    expect(codes(problems)).toEqual(['duplicate-sink-type']);
    // Both sinks are named, because "two sinks write Mvr" is not actionable on a canvas with six.
    expect(problems[0]?.nodeIds).toEqual(['a', 'b']);
    expect(problems[0]?.message).toContain('"a"');
    expect(problems[0]?.message).toContain('"b"');
  });

  it('leaves sinks whose types differ only by whitespace to core, which allows them', () => {
    // The one case the deleted local copy caught: it trimmed, core does not. Core treats them as
    // two types, so flagging them here would refuse a graph the server accepts — which is the
    // failure mode this module opens by describing.
    const nodes = [source('src'), transform('tx'), sink('a', 'Mvr'), sink('b', 'Mvr ')];
    const edges = wire([
      ['src', 'tx'],
      ['tx', 'a'],
      ['tx', 'b'],
    ]);

    expect(validateWorkflow({ nodes, edges }, allTransforms)).toEqual([]);
  });

  it('reports every problem at once rather than one at a time', () => {
    // The canvas-only checks run whatever core said. Gating them behind a structural error makes
    // somebody fix one problem only to be told about the next.
    const nodes = [source('src'), transform('tx', 'gone'), sink('out', '')];
    const problems = validateWorkflow({ nodes, edges: runnableEdges }, allTransforms);

    expect(codes(problems)).toEqual(
      expect.arrayContaining(['missing-transform', 'sink-has-no-type']),
    );
  });
});

describe('edgeId', () => {
  it('derives an identity from the only two fields there are', () => {
    // The executable model gives an edge no id; a stored second identity is something that can
    // drift from the pair that actually matters.
    expect(edgeId({ from: 'a', to: 'b' })).toBe('a->b');
    expect(edgeId({ from: 'a', to: 'b' })).not.toBe(edgeId({ from: 'b', to: 'a' }));
  });
});

describe('wouldCycle', () => {
  const edges = wire([
    ['a', 'b'],
    ['b', 'c'],
  ]);

  it('sees a loop through other nodes, not just a direct one', () => {
    expect(wouldCycle(edges, 'c', 'a')).toBe(true);
    expect(wouldCycle(edges, 'b', 'a')).toBe(true);
  });

  it('allows a second path that does not close a loop', () => {
    expect(wouldCycle(edges, 'a', 'c')).toBe(false);
  });

  it('counts a self-edge', () => {
    expect(wouldCycle([], 'a', 'a')).toBe(true);
  });

  it('terminates on a graph that already loops', () => {
    // The traversal marks nodes as seen; without that, asking about a graph that is already
    // cyclic hangs the browser mid-drag rather than refusing the drop.
    const looped = wire([
      ['a', 'b'],
      ['b', 'a'],
    ]);

    expect(wouldCycle(looped, 'x', 'a')).toBe(false);
  });
});

describe('canConnect', () => {
  const nodes = [source('src'), transform('tx'), sink('out')];

  it('allows a legal wire', () => {
    expect(canConnect(nodes, [], 'src', 'tx')).toEqual({ ok: true });
  });

  // Every refusal carries a sentence, because `isValidConnection` only wants a boolean but
  // `onConnectEnd` needs to say why — and a drag refused with no reason reads as a broken canvas.
  it.each([
    ['a node feeding itself', 'src', 'src', /cannot feed itself/],
    ['anything after a sink', 'out', 'tx', /Nothing runs after a sink/],
    ['anything into a source', 'tx', 'src', /reads from a system/],
    ['an end that is not a node', 'src', 'ghost', /not a node/],
  ])('refuses %s, with a reason', (_case, from, to, reason) => {
    const verdict = canConnect(nodes, [], from, to);

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(reason);
  });

  it('refuses a duplicate wire', () => {
    const verdict = canConnect(nodes, wire([['src', 'tx']]), 'src', 'tx');

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/same rows twice/);
  });

  it('refuses a wire that would close a loop, before the edge exists', () => {
    const cyclic = [source('src'), transform('a'), transform('b'), sink('out')];
    const verdict = canConnect(
      cyclic,
      wire([
        ['a', 'b'],
        ['b', 'out'],
      ]),
      'b',
      'a',
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/close a loop/);
  });
});

describe('hasBlockingProblem / problemsByNode', () => {
  it('blocks the save on an error', () => {
    const problems = validateWorkflow({ nodes: [], edges: [] }, allTransforms);

    expect(hasBlockingProblem(problems)).toBe(true);
    expect(hasBlockingProblem([])).toBe(false);
  });

  it('indexes a problem under every node it names, so both ends get ringed', () => {
    const nodes = [source('src'), transform('tx'), sink('a', 'Mvr'), sink('b', 'Mvr')];
    const edges = wire([
      ['src', 'tx'],
      ['tx', 'a'],
      ['tx', 'b'],
    ]);

    const byNode = problemsByNode(validateWorkflow({ nodes, edges }, allTransforms));

    expect(byNode.get('a')?.map((problem) => problem.code)).toEqual(['duplicate-sink-type']);
    expect(byNode.get('b')?.map((problem) => problem.code)).toEqual(['duplicate-sink-type']);
    expect(byNode.has('src')).toBe(false);
  });
});
