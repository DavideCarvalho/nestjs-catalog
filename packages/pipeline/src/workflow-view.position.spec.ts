import type { WorkflowNodeKind } from '@dudousxd/nestjs-catalog';
import { describe, expect, it } from 'vitest';
import { toGraph } from './workflow-view';

/**
 * That a node keeps the position it was saved at — every kind of node.
 *
 * WHY THIS EXISTS
 * ---------------
 * `readNode` reads `position` once, at the top, for every node. Then each kind
 * builds its own return object, and the `sink` branch was the one that did not
 * hand it back. The read was right there, four lines above.
 *
 * The consequence was total rather than cosmetic: **a sink could not be placed
 * at all, by any route.** Drag one on the canvas, save, reload, and it returns
 * to wherever the automatic layout puts it. `POST pipeline/workflows` carrying
 * explicit coordinates answers **201** and silently drops them — which is how
 * this was found, by rewriting thirteen adopted graphs' positions and reading
 * one back to check.
 *
 * WHY IT IS WRITTEN OVER THE KINDS RATHER THAN ABOUT THE SINK
 * -----------------------------------------------------------
 * A test named "a sink keeps its position" would have closed this bug and left
 * the shape that produced it: four independent branches, each responsible for
 * remembering a field that was read for all of them. The fifth kind will be
 * written by somebody who never saw this file.
 *
 * So the case is driven by a `Record<WorkflowNodeKind, …>`. Adding a kind to
 * the union without adding a fixture here is a **compile error**, not a test
 * that quietly covers three of four.
 */

/** The smallest body of each kind that `toGraph` accepts, minus the position. */
const MINIMAL: Record<WorkflowNodeKind, Record<string, unknown>> = {
  source: { kind: 'source', sourceKind: 'inline', config: { records: [] } },
  transform: { kind: 'transform', transformId: 't1' },
  sink: { kind: 'sink', targetType: 'Widget' },
  call: { kind: 'call', callName: 'billing.reconcile', callVersion: '1' },
  // The fifth kind, added by somebody who had indeed never seen this file, and
  // sent here by the compile error the docblock above promised.
  if: { kind: 'if', predicate: { kind: 'env', envVar: 'CLICKHOUSE_URL' } },
  // And the sixth, sent here the same way. The mechanism has now worked twice,
  // which is the only evidence a claim like the one above ever gets.
  filter: {
    kind: 'filter',
    predicate: { kind: 'compare', column: 'status', operator: 'equals', value: 'OPEN' },
  },
  // And the seventh. Three for three, which is as close to proof as a claim
  // about the next person ever gets.
  rename: { kind: 'rename', columns: { 'Mgmt Cd': 'mgmtCd' } },
  // And the eighth. Four for four — the claim about the next person has now
  // survived two node kinds nobody had in mind when it was written down.
  aggregate: {
    kind: 'aggregate',
    groupBy: ['workOrderId'],
    aggregates: [{ as: 'lines', fn: 'count' }],
  },
};

const KINDS = Object.keys(MINIMAL) as WorkflowNodeKind[];

/** A graph of one node, which is all that is needed to ask what came back. */
function graphOf(node: Record<string, unknown>) {
  return toGraph({ name: 'Fleet', nodes: [{ id: 'n1', name: 'N', ...node }], edges: [] });
}

describe('a node keeps the position it was given', () => {
  it.each(KINDS)('%s', (kind) => {
    const graph = graphOf({ ...MINIMAL[kind], position: { x: 320, y: 96 } });

    expect(graph.nodes[0]?.position).toEqual({ x: 320, y: 96 });
  });

  it.each(KINDS)('%s survives a round trip through toGraph twice', (kind) => {
    // The canvas reads a graph, moves one box and posts the whole thing back, so
    // what a save receives is what a read produced. A field lost on the way out
    // and defaulted on the way in would pass the case above and still lose the
    // position on the second hop.
    const once = graphOf({ ...MINIMAL[kind], position: { x: 640, y: 0 } });
    const twice = toGraph({ name: 'Fleet', nodes: [once.nodes[0] as never], edges: [] });

    expect(twice.nodes[0]?.position).toEqual({ x: 640, y: 0 });
  });

  it.each(KINDS)('%s accepts having no position at all', (kind) => {
    // Absent is a real state, not a missing value: a graph built by the API
    // rather than the canvas has never been arranged, and the console lays those
    // out on load. Defaulting to `{x: 0, y: 0}` here would make an unarranged
    // graph indistinguishable from one somebody deliberately stacked at the
    // origin, and the canvas would stop laying it out.
    const graph = graphOf(MINIMAL[kind]);

    expect(graph.nodes[0]?.position).toBeUndefined();
  });
});
