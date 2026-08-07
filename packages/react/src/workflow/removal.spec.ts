/**
 * Removing a node, and what the canvas says it cost.
 *
 * This file used to be about an undo window of its own. It is not any more — a real per-action
 * undo stack landed in `workflow/history.tsx` while this was being written, and shipping a second,
 * narrower one beside it would have given the canvas two things called undo. What is left is the
 * fact that undo makes recoverable but does not make visible: **a node takes its wires with it.**
 *
 * That sentence is the whole point. Four gestures now remove a node — the Delete key, the hover
 * toolbar, the context menu and the inspector — and none of them stops to ask. A canvas that
 * reports "node removed" leaves somebody to discover half an hour later that their graph no longer
 * reaches its sink.
 */
import { describe, expect, it } from 'vitest';
import type { WorkflowEdge, WorkflowNode } from './model';
import { removeNodes, wiresOn } from './removal';

const NODES: WorkflowNode[] = [
  { id: 'a', name: 'A', kind: 'source', sourceKind: 'http', config: {}, position: { x: 0, y: 0 } },
  { id: 'join', name: 'Join', kind: 'transform', transformId: 't', position: { x: 320, y: 0 } },
  { id: 'b', name: 'B', kind: 'source', sourceKind: 'http', config: {}, position: { x: 0, y: 90 } },
  { id: 'out', name: 'Out', kind: 'sink', targetType: 'Mvr', position: { x: 640, y: 0 } },
];

const EDGES: WorkflowEdge[] = [
  { from: 'a', to: 'join' },
  { from: 'b', to: 'join' },
  { from: 'join', to: 'out' },
];

describe('removing a node', () => {
  it('takes its wires with it, at both ends', () => {
    const after = removeNodes(NODES, EDGES, ['join']);

    expect(after.nodes.map((node) => node.id)).toEqual(['a', 'b', 'out']);
    expect(after.edges).toEqual([]);
  });

  it('names what went and counts what went with it', () => {
    const after = removeNodes(NODES, EDGES, ['join']);

    expect(after.said).toContain('"Join"');
    expect(after.said).toContain('3 connections');
  });

  it('does not claim wires went when none did', () => {
    // The opposite failure, and just as bad: a sentence that implies collateral damage on a node
    // that had none teaches people to stop reading it.
    const lonely = removeNodes([NODES[3]], [], ['out']);

    expect(lonely.said).toMatch(/Nothing was wired to it/);
  });

  it('counts rather than names once there are more nodes than a sentence can carry', () => {
    const after = removeNodes(NODES, EDGES, ['a', 'b', 'join', 'out']);

    expect(after.said).toContain('4 nodes');
  });

  it('ignores ids that are not in the graph', () => {
    // Called with whatever a menu was opened on, and a graph can be replaced under an open menu.
    const after = removeNodes(NODES, EDGES, ['ghost']);

    expect(after.nodes).toHaveLength(NODES.length);
    expect(after.said).toBe('Nothing was removed.');
  });
});

describe('counting the wires before the click', () => {
  it('is the same count the removal reports afterwards', () => {
    // The warning on the menu item and the sentence after it must agree, or one of them is
    // teaching somebody the wrong thing about what a delete does.
    expect(wiresOn(EDGES, ['join'])).toBe(3);
    expect(removeNodes(NODES, EDGES, ['join']).said).toContain('3 connections');
  });

  it('counts a wire once even when both its ends are going', () => {
    expect(wiresOn(EDGES, ['a', 'join'])).toBe(3);
  });
});
