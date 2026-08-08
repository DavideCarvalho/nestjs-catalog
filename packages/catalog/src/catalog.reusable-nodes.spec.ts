import { describe, expect, it } from 'vitest';
import {
  NODE_KIND_IS_REUSABLE,
  REUSABLE_NODE_KINDS,
  type ReusableNodeBody,
  WORKFLOW_NODE_KINDS,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowSinkNode,
  type WorkflowSourceNode,
  type WorkflowTransformNode,
  applyReusableNode,
  describeVersionPin,
  isReusableNodeBody,
  isWorkflowNode,
  nodeKindIsReusable,
  reusableNodeBodyOf,
  validateWorkflow,
  workflowGraphHash,
} from './catalog.pipeline';

/**
 * Reusable nodes, and the version pins that had to land with them.
 *
 * The load-bearing assertion in this file is the one about the fingerprint of a
 * graph that has neither: **13 workflows exist in the deployment this ships to**,
 * and a release that renumbered their versions would rewrite the answer to "has
 * this graph changed since the run that produced these rows" for every one of
 * them. So the additions hash to nothing when they are absent, which is the same
 * rule `edge.branch` already follows and is asserted here rather than trusted.
 */

const SOURCE: WorkflowSourceNode = {
  id: 'src',
  name: 'Warehouse',
  kind: 'source',
  sourceKind: 'sql',
  config: { query: 'select 1' },
};

const SINK: WorkflowSinkNode = {
  id: 'sink',
  name: 'Mvr',
  kind: 'sink',
  targetType: 'Mvr',
};

const TRANSFORM: WorkflowTransformNode = {
  id: 'shape',
  name: 'Shape',
  kind: 'transform',
  transformId: 'tx-1',
};

function graph(...nodes: WorkflowNode[]): WorkflowGraph {
  return { nodes, edges: [] };
}

describe('what may be saved as a reusable node', () => {
  it('answers for every node kind there is, so a new one cannot slip through', () => {
    // The record is `satisfies Record<WorkflowNodeKind, boolean>`, so a kind
    // added without an entry fails the build. This is the run-time half: that
    // the list and the record agree, which the type system checks in one
    // direction and this checks in the other.
    for (const kind of WORKFLOW_NODE_KINDS) {
      expect(Object.hasOwn(NODE_KIND_IS_REUSABLE, kind)).toBe(true);
      expect(nodeKindIsReusable(kind)).toBe(REUSABLE_NODE_KINDS.some((one) => one === kind));
    }
  });

  it('is source and sink, and neither transform nor call nor a predicate', () => {
    expect([...REUSABLE_NODE_KINDS]).toEqual(['source', 'sink']);
    // A transform and a call already reference a stored object; a predicate is
    // about the rows in front of it. See REUSABLE_NODE_KINDS.
    expect(nodeKindIsReusable('transform')).toBe(false);
    expect(nodeKindIsReusable('call')).toBe(false);
    expect(nodeKindIsReusable('filter')).toBe(false);
    // A rename map names one source's own spelling of its own headers, so a
    // shared one renames nothing in a graph reading anything else.
    expect(nodeKindIsReusable('rename')).toBe(false);
    // An aggregate names one type's columns on both sides, so a shared one
    // groups a graph it was not written for on a column that is not there —
    // which collapses everything into one null-keyed group rather than failing.
    expect(nodeKindIsReusable('aggregate')).toBe(false);
    // A lookup's `reference` is a node id in the graph it lives in, so a shared
    // body would carry the id of a node the adopting graph has never had — and
    // it is the field that decides which side of the join is held in memory.
    expect(nodeKindIsReusable('lookup')).toBe(false);
  });
});

describe('lifting a node into a reusable body, and folding one back on', () => {
  it('lifts what a source reads and leaves behind what belongs to the graph', () => {
    const body = reusableNodeBodyOf({
      ...SOURCE,
      connectionId: 'conn-1',
      mode: 'incremental',
      position: { x: 10, y: 20 },
    });

    // No id, no position, no name: those are the graph's, and a body carrying
    // them would rename and move every node in every graph that adopted it.
    expect(body).toEqual({
      kind: 'source',
      sourceKind: 'sql',
      connectionId: 'conn-1',
      config: { query: 'select 1' },
      secretEnvVar: undefined,
      mode: 'incremental',
    });
  });

  it('answers nothing for a kind that cannot be reusable', () => {
    expect(reusableNodeBodyOf(TRANSFORM)).toBeUndefined();
  });

  it('folds a source body on without touching the node’s identity', () => {
    const body: ReusableNodeBody = {
      kind: 'source',
      sourceKind: 'http',
      config: { url: 'https://example.test/feed' },
      mode: 'full',
    };

    const folded = applyReusableNode({ ...SOURCE, useId: 'lib-1' }, body);

    expect(folded).toMatchObject({
      id: 'src',
      name: 'Warehouse',
      kind: 'source',
      sourceKind: 'http',
      config: { url: 'https://example.test/feed' },
      useId: 'lib-1',
    });
  });

  it('fills in a sink that has not chosen a type yet', () => {
    const folded = applyReusableNode(
      { ...SINK, targetType: '' },
      { kind: 'sink', targetType: 'Subwo', mode: 'full' },
    );

    expect(folded).toMatchObject({ kind: 'sink', targetType: 'Subwo', mode: 'full' });
  });

  it('refuses to move a sink’s type under a graph that already committed to one', () => {
    // The grant check runs over the type on the node, at save time. A shared
    // sink that could repoint it afterwards would write into a type nobody with
    // access to this graph was ever granted — on a schedule, with the graph's
    // own diff showing nothing.
    expect(() => applyReusableNode(SINK, { kind: 'sink', targetType: 'Subwo' })).toThrow(
      /commits Mvr, and the reusable node it uses now commits Subwo/,
    );
  });

  it('refuses a body of the wrong kind rather than folding half of it in', () => {
    expect(() => applyReusableNode(SOURCE, { kind: 'sink', targetType: 'Mvr' })).toThrow(
      /is a source node and the reusable node it names is a sink/,
    );
  });

  it('refuses a stored body it cannot read, and accepts the two it can', () => {
    expect(isReusableNodeBody({ kind: 'source', sourceKind: 'sql', config: {} })).toBe(true);
    expect(isReusableNodeBody({ kind: 'sink', targetType: 'Mvr' })).toBe(true);
    // A kind this build has no rule for. Folded on as nothing, the node would
    // run whatever was cached on it while claiming to be the library's.
    expect(isReusableNodeBody({ kind: 'filter', predicate: {} })).toBe(false);
    expect(isReusableNodeBody({ kind: 'sink', targetType: '' })).toBe(false);
    expect(isReusableNodeBody({ kind: 'source', sourceKind: 'carrier-pigeon', config: {} })).toBe(
      false,
    );
  });
});

describe('the graph fingerprint', () => {
  it('is unchanged for a graph that pins nothing and shares nothing', () => {
    // The whole additive claim, in one assertion. A node with the keys present
    // and undefined has to hash exactly as one without them, because that is
    // what `toGraph` produces for a payload that mentioned neither and what
    // every one of the 13 stored graphs is.
    const bare = workflowGraphHash(graph(SOURCE, TRANSFORM, SINK));
    const explicit = workflowGraphHash(
      graph(
        { ...SOURCE, useId: undefined, useVersion: undefined },
        { ...TRANSFORM, transformVersion: undefined },
        { ...SINK, useId: undefined, useVersion: undefined },
      ),
    );

    expect(explicit).toBe(bare);
  });

  it('moves when a transform node is pinned, and again when the pin moves', () => {
    const following = workflowGraphHash(graph(TRANSFORM));
    const pinnedToThree = workflowGraphHash(graph({ ...TRANSFORM, transformVersion: 3 }));
    const pinnedToFive = workflowGraphHash(graph({ ...TRANSFORM, transformVersion: 5 }));

    expect(pinnedToThree).not.toBe(following);
    expect(pinnedToFive).not.toBe(pinnedToThree);
  });

  it('tells "follows the latest" apart from "pinned to v1"', () => {
    // Not a nicety. Moving a shared sink off its pin changes what it will run
    // next month, and a fingerprint that could not see it would let somebody do
    // that with no version bump and nothing in the diff — which is the silence
    // this whole feature was built to end.
    const following = workflowGraphHash(graph({ ...SINK, useId: 'lib-1' }));
    const pinned = workflowGraphHash(graph({ ...SINK, useId: 'lib-1', useVersion: 1 }));

    expect(pinned).not.toBe(following);
    expect(following).not.toBe(workflowGraphHash(graph(SINK)));
  });

  it('does not move when the transform’s own code is edited', () => {
    // Unchanged behaviour, asserted because it is the thing the pin is easily
    // mistaken for. Editing a transform is a new transform version and NOT a
    // new graph version — folding it in would claim the wiring changed when it
    // did not. What the pin adds is a way to say which version, not a way to
    // make somebody else's edit show up here.
    expect(workflowGraphHash(graph(TRANSFORM))).toBe(
      workflowGraphHash(graph({ ...TRANSFORM, name: 'Shape it' })),
    );
  });
});

describe('reading a graph back out of a column', () => {
  it('accepts a node with no pin, which is every node stored today', () => {
    expect(isWorkflowNode({ ...TRANSFORM })).toBe(true);
    expect(isWorkflowNode({ ...SOURCE })).toBe(true);
  });

  it('refuses a pin that names no version a store could hold', () => {
    // `"3"` is what an unparsed form field sends and `0` is what a spinner
    // starts at. Either resolves to nothing, inside a durable step, in the
    // middle of a load.
    expect(isWorkflowNode({ ...TRANSFORM, transformVersion: '3' })).toBe(false);
    expect(isWorkflowNode({ ...TRANSFORM, transformVersion: 0 })).toBe(false);
    expect(isWorkflowNode({ ...TRANSFORM, transformVersion: 2.5 })).toBe(false);
    expect(isWorkflowNode({ ...SINK, useId: 'lib-1', useVersion: -1 })).toBe(false);
    expect(isWorkflowNode({ ...SINK, useId: 7 })).toBe(false);
  });
});

describe('the validator', () => {
  const wired: WorkflowGraph = {
    nodes: [SOURCE, SINK],
    edges: [{ from: 'src', to: 'sink' }],
  };

  it('passes a graph that pins nothing', () => {
    expect(validateWorkflow(wired)).toEqual([]);
  });

  it('reports a pin that is not a version, on the node that carries it', () => {
    const issues = validateWorkflow({
      ...wired,
      nodes: [{ ...SOURCE, useId: 'lib-1', useVersion: 0 }, SINK],
    });

    expect(issues.map((issue) => issue.code)).toEqual(['version-pin-invalid']);
    expect(issues[0]?.nodeIds).toEqual(['src']);
  });

  it('reports a version pinned against no reference at all', () => {
    const issues = validateWorkflow({
      ...wired,
      nodes: [{ ...SOURCE, useVersion: 2 }, SINK],
    });

    expect(issues.map((issue) => issue.code)).toEqual(['version-pin-invalid']);
    expect(issues[0]?.message).toContain('names no reusable node');
  });

  it('accepts a reference that follows the latest', () => {
    expect(validateWorkflow({ ...wired, nodes: [{ ...SOURCE, useId: 'lib-1' }, SINK] })).toEqual(
      [],
    );
  });
});

describe('describing a version pin', () => {
  it('says following is following, in words that cannot be read as pinning', () => {
    const copy = describeVersionPin(undefined, 'this transform');

    expect(copy.pinned).toBe(false);
    expect(copy.label).toBe('follows the latest');
    expect(copy.detail).toContain('on the next run');
  });

  it('names the version it is pinned to, and what a pin cannot survive', () => {
    const copy = describeVersionPin(3, 'this transform');

    expect(copy.pinned).toBe(true);
    expect(copy.label).toBe('pinned to v3');
    expect(copy.detail).toContain('fails saying so');
  });
});
