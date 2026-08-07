import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_FILTER_MAX_DEPTH,
  WORKFLOW_FILTER_MAX_VALUES,
  type WorkflowFilterNode,
  type WorkflowFilterPredicate,
  type WorkflowGraph,
  type WorkflowIssueCode,
  type WorkflowNode,
  type WorkflowSinkNode,
  type WorkflowSourceNode,
  type WorkflowTransformNode,
  isWorkflowFilterPredicate,
  isWorkflowNode,
  validateWorkflow,
  workflowFilterMatches,
  workflowGraphHash,
  workflowNarrowedTypes,
} from './catalog.pipeline';

/**
 * The filter node: what it keeps, and what it must never quietly delete.
 *
 * WHAT THIS FILE IS ACTUALLY GUARDING
 * -----------------------------------
 * Two failures, and neither of them looks like a failure at the time.
 *
 * The first is **a predicate that answers differently from a `WHERE`.** The
 * whole reason the predicate is a closed structure rather than code is that it
 * can one day be pushed into the source query — and the moment it is, the
 * database answers instead of `workflowFilterMatches`. If the two disagree about
 * a null, or about `"5"` against `5`, then a change made for speed silently
 * changes which rows a published type contains. So the comparison cases below
 * are weighted towards nulls and towards mismatched types, which are exactly the
 * two places SQL and JavaScript disagree, and they assert SQL's answer.
 *
 * The second is **filtering into the type that was already there.** A filter
 * dropped onto a working `source → sink` wire replaces the published snapshot
 * with a subset, and every part of the run reports success. The graph cannot
 * tell that apart from filtering to derive something new — the two are the same
 * shape — so the defence is that the author has to *name the type*, and the
 * cases here are about the validator demanding it in exactly the situations
 * where it is lost and refusing it in the ones where it is not.
 */

function source(id: string, overrides: Partial<WorkflowSourceNode> = {}): WorkflowSourceNode {
  return { id, name: id, kind: 'source', sourceKind: 'inline', config: {}, ...overrides };
}

function transform(
  id: string,
  overrides: Partial<WorkflowTransformNode> = {},
): WorkflowTransformNode {
  return { id, name: id, kind: 'transform', transformId: 'tx-1', ...overrides };
}

function sink(id: string, overrides: Partial<WorkflowSinkNode> = {}): WorkflowSinkNode {
  return { id, name: id, kind: 'sink', targetType: id, ...overrides };
}

function filter(id: string, overrides: Partial<WorkflowFilterNode> = {}): WorkflowFilterNode {
  return {
    id,
    name: id,
    kind: 'filter',
    predicate: { kind: 'compare', column: 'status', operator: 'equals', value: 'OPEN' },
    ...overrides,
  };
}

function graph(nodes: WorkflowNode[], wires: Array<[string, string]>): WorkflowGraph {
  return { nodes, edges: wires.map(([from, to]) => ({ from, to })) };
}

function codes(underTest: WorkflowGraph): WorkflowIssueCode[] {
  return validateWorkflow(underTest).map((issue) => issue.code);
}

/** Whether one row survives one predicate, with nothing else in the way. */
function keeps(predicate: WorkflowFilterPredicate, row: Record<string, unknown>): boolean {
  return workflowFilterMatches(predicate, row);
}

describe('what a comparison does to a value that is there', () => {
  it('keeps a row whose column equals the value and drops one that does not', () => {
    const open: WorkflowFilterPredicate = {
      kind: 'compare',
      column: 'status',
      operator: 'equals',
      value: 'OPEN',
    };

    expect(keeps(open, { status: 'OPEN' })).toBe(true);
    expect(keeps(open, { status: 'CLOSED' })).toBe(false);
  });

  it('orders numbers numerically and strings lexicographically', () => {
    const big: WorkflowFilterPredicate = {
      kind: 'compare',
      column: 'qty',
      operator: 'greaterThan',
      value: 9,
    };
    // The one that a string comparison would get wrong: "10" < "9" as text.
    expect(keeps(big, { qty: 10 })).toBe(true);
    expect(keeps(big, { qty: 9 })).toBe(false);

    const after: WorkflowFilterPredicate = {
      kind: 'compare',
      column: 'day',
      operator: 'greaterThanOrEqual',
      // ISO-8601, which is why dates are text here: it sorts correctly under
      // `<` and under every SQL collation.
      value: '2026-01-01',
    };
    expect(keeps(after, { day: '2026-06-01' })).toBe(true);
    expect(keeps(after, { day: '2025-12-31' })).toBe(false);
  });

  it('does not reach up the prototype chain for a column', () => {
    // A source's rows are somebody else's records and a column may be called
    // anything. Indexing rather than `Object.hasOwn` would compare `constructor`
    // against a function and answer for a column the row does not have.
    const present: WorkflowFilterPredicate = {
      kind: 'present',
      column: 'constructor',
      operator: 'isNotNull',
    };

    expect(keeps(present, { id: 1 })).toBe(false);
  });
});

describe('a column with no value, which is where SQL and JavaScript part company', () => {
  const rows = [{ status: null }, { status: undefined }, {}];

  it('fails an equality test, which is unsurprising', () => {
    const open: WorkflowFilterPredicate = {
      kind: 'compare',
      column: 'status',
      operator: 'equals',
      value: 'OPEN',
    };

    for (const row of rows) expect(keeps(open, row)).toBe(false);
  });

  it('fails the INVERSE test too, which is the whole point', () => {
    // THE ONE THAT MATTERS. `status <> 'CLOSED'` does not return a row whose
    // status is NULL in any SQL database, and JavaScript's `null !== 'CLOSED'`
    // says it should. If this file ever asserts `true` here, then pushing this
    // predicate into the source query would change which rows a type holds —
    // and that change would be made for performance, by somebody who had no
    // reason to think they were touching the data.
    const notClosed: WorkflowFilterPredicate = {
      kind: 'compare',
      column: 'status',
      operator: 'notEquals',
      value: 'CLOSED',
    };
    const notInList: WorkflowFilterPredicate = {
      kind: 'oneOf',
      column: 'status',
      operator: 'notIn',
      values: ['CLOSED'],
    };

    for (const row of rows) {
      expect(keeps(notClosed, row)).toBe(false);
      expect(keeps(notInList, row)).toBe(false);
    }
  });

  it('is only visible to a presence test', () => {
    const empty: WorkflowFilterPredicate = {
      kind: 'present',
      column: 'status',
      operator: 'isNull',
    };
    const filled: WorkflowFilterPredicate = {
      kind: 'present',
      column: 'status',
      operator: 'isNotNull',
    };

    for (const row of rows) {
      expect(keeps(empty, row)).toBe(true);
      expect(keeps(filled, row)).toBe(false);
    }
    expect(keeps(filled, { status: 'OPEN' })).toBe(true);
    // An empty string is a value. It is not absence, and conflating the two is
    // how "the ones with no delivery date" quietly starts including the ones
    // whose date is blank.
    expect(keeps(filled, { status: '' })).toBe(true);
  });
});

describe('a value the test cannot compare against', () => {
  const numeric: WorkflowFilterPredicate = {
    kind: 'compare',
    column: 'qty',
    operator: 'greaterThan',
    value: 10,
  };

  it('fails the test and reports the column rather than inventing an ordering', () => {
    const seen: string[] = [];

    expect(workflowFilterMatches(numeric, { qty: 'n/a' }, (column) => seen.push(column))).toBe(
      false,
    );
    expect(seen).toEqual(['qty']);
  });

  it('fails a test and its inverse alike', () => {
    // Deliberately asymmetric with De Morgan, and stated so: a row nothing can
    // judge is dropped rather than kept, because dropping has a backstop (the
    // sink's row-count bound, and a full sink refusing to commit nothing) while
    // keeping publishes unjudged rows into the type with nothing to notice.
    const has: WorkflowFilterPredicate = {
      kind: 'compare',
      column: 'note',
      operator: 'contains',
      value: 'urgent',
    };
    const hasNot: WorkflowFilterPredicate = { ...has, operator: 'notContains' };

    expect(keeps(has, { note: 42 })).toBe(false);
    expect(keeps(hasNot, { note: 42 })).toBe(false);
  });

  it('treats text and a number as incomparable rather than coercing either way', () => {
    // `'5' = 5` is TRUE in MySQL and false in JavaScript, so this is the other
    // comparison whose answer would change under a pushdown. Reported instead of
    // picked, so the run says which column it was.
    const five: WorkflowFilterPredicate = {
      kind: 'compare',
      column: 'code',
      operator: 'equals',
      value: 5,
    };
    const seen: string[] = [];

    expect(workflowFilterMatches(five, { code: '5' }, (column) => seen.push(column))).toBe(false);
    expect(seen).toEqual(['code']);
  });
});

describe('groups', () => {
  const open: WorkflowFilterPredicate = {
    kind: 'compare',
    column: 'status',
    operator: 'equals',
    value: 'OPEN',
  };
  const stocked: WorkflowFilterPredicate = {
    kind: 'compare',
    column: 'qty',
    operator: 'greaterThan',
    value: 0,
  };

  it('requires every child of an all and any child of an any', () => {
    const every: WorkflowFilterPredicate = { kind: 'all', children: [open, stocked] };
    const some: WorkflowFilterPredicate = { kind: 'any', children: [open, stocked] };

    expect(keeps(every, { status: 'OPEN', qty: 3 })).toBe(true);
    expect(keeps(every, { status: 'OPEN', qty: 0 })).toBe(false);
    expect(keeps(some, { status: 'CLOSED', qty: 3 })).toBe(true);
    expect(keeps(some, { status: 'CLOSED', qty: 0 })).toBe(false);
  });

  it('nests, so "A and (B or C)" is expressible without a not', () => {
    const nested: WorkflowFilterPredicate = {
      kind: 'all',
      children: [open, { kind: 'any', children: [stocked, { ...stocked, column: 'backorder' }] }],
    };

    expect(keeps(nested, { status: 'OPEN', qty: 0, backorder: 2 })).toBe(true);
    expect(keeps(nested, { status: 'OPEN', qty: 0, backorder: 0 })).toBe(false);
  });
});

describe('what a stored predicate is allowed to be', () => {
  it('refuses an empty group, in both directions', () => {
    // Opposite catastrophes, both silent, both one deletion away in a form: an
    // empty `all` is vacuously true and keeps every row, so the filter does
    // nothing; an empty `any` is vacuously false and drops every row, so the
    // load comes out empty. Neither is storable.
    expect(isWorkflowFilterPredicate({ kind: 'all', children: [] })).toBe(false);
    expect(isWorkflowFilterPredicate({ kind: 'any', children: [] })).toBe(false);
  });

  it('refuses a column that could not be quoted into a query', () => {
    const bad = ['Part Number', 'orders.status', 'status"', '', '1st'];
    for (const column of bad) {
      expect(
        isWorkflowFilterPredicate({ kind: 'compare', column, operator: 'equals', value: 'x' }),
      ).toBe(false);
    }
    expect(
      isWorkflowFilterPredicate({
        kind: 'compare',
        column: 'part_number',
        operator: 'equals',
        value: 'x',
      }),
    ).toBe(true);
  });

  it('refuses a value that is not a finite scalar', () => {
    // `NaN` compares false against everything, so a predicate holding one is a
    // filter that drops the whole dataset while looking perfectly configured —
    // and `Infinity` does not survive a JSON round trip at all.
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, null, {}, ['a']]) {
      expect(
        isWorkflowFilterPredicate({ kind: 'compare', column: 'qty', operator: 'equals', value }),
      ).toBe(false);
    }
  });

  it('refuses a list that is empty or longer than the bound', () => {
    const list = (length: number) => ({
      kind: 'oneOf',
      column: 'status',
      operator: 'in',
      values: Array.from({ length }, (_, index) => index),
    });

    expect(isWorkflowFilterPredicate(list(0))).toBe(false);
    expect(isWorkflowFilterPredicate(list(WORKFLOW_FILTER_MAX_VALUES))).toBe(true);
    expect(isWorkflowFilterPredicate(list(WORKFLOW_FILTER_MAX_VALUES + 1))).toBe(false);
  });

  it('refuses a tree deeper than the bound rather than overflowing a stack in a step', () => {
    const nest = (depth: number): unknown => {
      let built: unknown = { kind: 'compare', column: 'a', operator: 'equals', value: 1 };
      for (let level = 0; level < depth; level += 1) built = { kind: 'all', children: [built] };
      return built;
    };

    expect(isWorkflowFilterPredicate(nest(WORKFLOW_FILTER_MAX_DEPTH))).toBe(true);
    expect(isWorkflowFilterPredicate(nest(WORKFLOW_FILTER_MAX_DEPTH + 1))).toBe(false);
  });

  it('refuses a filter node whose acknowledgement is not a list of type names', () => {
    // Refused rather than dropped: dropping it turns a graph somebody
    // acknowledged into one that never was, and the refusal that followed would
    // name a field they did fill in.
    expect(isWorkflowNode({ ...filter('f'), narrows: 'Mvr' })).toBe(false);
    expect(isWorkflowNode({ ...filter('f'), narrows: [1] })).toBe(false);
    expect(isWorkflowNode({ ...filter('f'), narrows: ['Mvr'] })).toBe(true);
    expect(isWorkflowNode(filter('f'))).toBe(true);
  });
});

describe('which published types a filter stands in front of', () => {
  it('names a full sink it is the only path to', () => {
    // `src → keep → PriBuy`. The trap, drawn: everything `keep` drops
    // disappears from PriBuy the next time this runs.
    const trap = graph(
      [source('src'), filter('keep'), sink('PriBuy')],
      [
        ['src', 'keep'],
        ['keep', 'PriBuy'],
      ],
    );

    expect(workflowNarrowedTypes(trap, 'keep')).toEqual(['PriBuy']);
  });

  it('names nothing when rows reach the sink another way', () => {
    // `src → keep → Out` and `src → straight → Out`. The filter removes rows
    // from one arm of a union; the sink still receives everything the other arm
    // delivers, so nothing is lost from what Out publishes because of this node.
    const union = graph(
      [source('src'), filter('keep'), transform('straight'), sink('Out')],
      [
        ['src', 'keep'],
        ['keep', 'Out'],
        ['src', 'straight'],
        ['straight', 'Out'],
      ],
    );

    expect(workflowNarrowedTypes(union, 'keep')).toEqual([]);
  });

  it('names nothing in front of an incremental sink, which merges rather than replaces', () => {
    const merging = graph(
      [source('src'), filter('keep'), sink('Out', { mode: 'incremental' })],
      [
        ['src', 'keep'],
        ['keep', 'Out'],
      ],
    );

    expect(workflowNarrowedTypes(merging, 'keep')).toEqual([]);
  });

  it('treats a sink with no mode as a full sink', () => {
    // The same default `runSink` applies. A graph that validated under one
    // reading of the absent field and ran under the other is precisely the
    // failure this check exists to prevent.
    const unset = graph(
      [source('src'), filter('keep'), { id: 'Out', name: 'Out', kind: 'sink', targetType: 'Out' }],
      [
        ['src', 'keep'],
        ['keep', 'Out'],
      ],
    );

    expect(workflowNarrowedTypes(unset, 'keep')).toEqual(['Out']);
  });

  it('names every full sink behind it when a graph commits several types', () => {
    const fanned = graph(
      [source('src'), filter('keep'), sink('Mvr'), sink('Subwo')],
      [
        ['src', 'keep'],
        ['keep', 'Mvr'],
        ['keep', 'Subwo'],
      ],
    );

    expect(workflowNarrowedTypes(fanned, 'keep').sort()).toEqual(['Mvr', 'Subwo']);
  });
});

describe('the acknowledgement the validator demands', () => {
  const trap = (narrows?: string[]) =>
    graph(
      [source('src'), filter('keep', { narrows }), sink('PriBuy')],
      [
        ['src', 'keep'],
        ['keep', 'PriBuy'],
      ],
    );

  it('refuses a filter that shrinks a published type without saying so', () => {
    // THE ONE THAT MATTERS. This is dragging a filter onto a working
    // `source → sink` wire: the graph is well-formed, the run would succeed, and
    // what PriBuy publishes would quietly become a subset. The refusal is what
    // makes somebody write the type name down.
    expect(codes(trap())).toContain('filter-narrows-unacknowledged');
  });

  it('accepts it once the type is named', () => {
    expect(codes(trap(['PriBuy']))).toEqual([]);
  });

  it('refuses an acknowledgement the graph does not back up', () => {
    // The reverse, and refused for the reason a branch label on a plain wire is:
    // an acknowledgement nothing reads is worse than none, because the canvas
    // draws it and the next reader believes it. Reached by rewiring around a
    // filter and leaving the switch on.
    const merging = graph(
      [source('src'), filter('keep', { narrows: ['Out'] }), sink('Out', { mode: 'incremental' })],
      [
        ['src', 'keep'],
        ['keep', 'Out'],
      ],
    );

    expect(codes(merging)).toEqual(['filter-narrows-nothing']);
  });

  it('demands nothing of a filter that derives a type of its own', () => {
    // The safe intention, and the reason the rule cannot be structural: this
    // graph is the same *shape* as the trap above. What differs is the name on
    // the sink, which is why the author is asked to type it.
    const derived = graph(
      [source('src'), filter('keep', { narrows: ['OpenOrders'] }), sink('OpenOrders')],
      [
        ['src', 'keep'],
        ['keep', 'OpenOrders'],
      ],
    );

    expect(codes(derived)).toEqual([]);
  });

  it('refuses a filter whose test cannot decide anything', () => {
    const unset = graph(
      [
        source('src'),
        filter('keep', {
          predicate: { kind: 'compare', column: '', operator: 'equals', value: '' },
          narrows: ['Out'],
        }),
        sink('Out'),
      ],
      [
        ['src', 'keep'],
        ['keep', 'Out'],
      ],
    );

    expect(codes(unset)).toContain('filter-predicate-invalid');
  });
});

describe('the graph fingerprint', () => {
  const based = (node: WorkflowFilterNode) =>
    workflowGraphHash(
      graph(
        [source('src'), node, sink('Out')],
        [
          ['src', 'keep'],
          ['keep', 'Out'],
        ],
      ),
    );

  it('changes when the predicate changes', () => {
    const before = based(filter('keep', { narrows: ['Out'] }));
    const after = based(
      filter('keep', {
        predicate: { kind: 'compare', column: 'status', operator: 'equals', value: 'CLOSED' },
        narrows: ['Out'],
      }),
    );

    expect(after).not.toBe(before);
  });

  it('changes when somebody acknowledges what it shrinks', () => {
    // Deliberately in the fingerprint even though it changes nothing the node
    // computes: it is the record that a published type was allowed to become a
    // subset, and a run from before anybody acknowledged that has to stay
    // distinguishable from one after.
    expect(based(filter('keep', { narrows: ['Out'] }))).not.toBe(based(filter('keep')));
  });

  it('does not change when a canvas rewrites a group in another order', () => {
    const open: WorkflowFilterPredicate = {
      kind: 'compare',
      column: 'status',
      operator: 'equals',
      value: 'OPEN',
    };
    const stocked: WorkflowFilterPredicate = {
      kind: 'compare',
      column: 'qty',
      operator: 'greaterThan',
      value: 0,
    };

    const forwards = based(
      filter('keep', { predicate: { kind: 'all', children: [open, stocked] }, narrows: ['Out'] }),
    );
    const backwards = based(
      filter('keep', { predicate: { kind: 'all', children: [stocked, open] }, narrows: ['Out'] }),
    );

    expect(backwards).toBe(forwards);
  });

  it('leaves graphs with no filter in them exactly where they were', () => {
    // A literal rather than a comparison, because the property is about a build
    // that no longer exists: adding a node kind must not renumber the version of
    // every graph that does not use it, and only a value recorded from *before*
    // the change can say so. This one was read off the pre-filter build of
    // `workflowGraphHash` over exactly this graph.
    const untouched = graph(
      [source('src'), transform('shape'), sink('Out')],
      [
        ['src', 'shape'],
        ['shape', 'Out'],
      ],
    );

    expect(workflowGraphHash(untouched)).toBe('790a8afa64fc4bb4');
  });
});
