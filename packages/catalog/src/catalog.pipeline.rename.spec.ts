import { describe, expect, it } from 'vitest';
import {
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
  isWorkflowNode,
  renameColumnRefusals,
  validateWorkflow,
  workflowGraphHash,
  workflowKnownColumns,
  workflowRenameUnnamed,
} from './catalog.pipeline';

/**
 * The rename node as a piece of *data* — which is the whole argument for it.
 *
 * A transform is a function body, so the catalog can say nothing about it until
 * it has run. A rename is a map, so three things become answerable at the moment
 * a graph is saved: whether the names it produces can be columns, whether two of
 * them collide, and — in one exact arrangement — which columns reach the node
 * after it. Each of those is a failure that otherwise reports success and is
 * found in a committed snapshot, so each of them is a test here.
 *
 * The run-time half is `workflow-runner.rename.spec.ts`; the encoding half,
 * where the "no value moves" claim is actually proved, is
 * `catalog.stage-encoding.rename.spec.ts`.
 */

// The same three shapes `catalog.pipeline.filter.spec.ts` uses, byte for byte,
// because the pinned hash below is a value recorded off a build that predates
// both node kinds — a fixture that differed by one character would pin nothing.
function source(id: string): WorkflowNode {
  return { id, name: id, kind: 'source', sourceKind: 'inline', config: {} };
}

function rename(
  id: string,
  columns: Record<string, string>,
  unnamed?: 'keep' | 'drop',
): WorkflowNode {
  return { id, name: id, kind: 'rename', columns, unnamed };
}

function sink(id: string): WorkflowNode {
  return { id, name: id, kind: 'sink', targetType: id };
}

function graph(nodes: WorkflowNode[], wires: Array<[string, string]>): WorkflowGraph {
  const edges: WorkflowEdge[] = wires.map(([from, to]) => ({ from, to }));
  return { nodes, edges };
}

describe('what a rename map is allowed to say', () => {
  it('accepts the map a real file drop needs, spaces and all', () => {
    // The names on the left are what an Air Force fleet export actually calls
    // its columns. Being able to name those is the entire point of the node —
    // a filter cannot, because its columns have to be identifiers.
    expect(
      renameColumnRefusals({
        'Mgmt Cd': 'mgmtCd',
        'Reg Number': 'regNumber',
        'Asset Id': 'assetId',
        'VEH Type Name': 'vehTypeName',
      }),
    ).toEqual([]);
  });

  it('refuses a target that no store could turn into a column', () => {
    // The failure this refusal exists for is not a crash. A load looks every
    // field up as `row[name]`, so a column nothing downstream can name is one
    // that arrives as NULL in every row with the run reporting success — which
    // is what `property-names.ts` is the record of.
    const [refusal] = renameColumnRefusals({ 'Mgmt Cd': 'mgmt cd' });
    expect(refusal).toContain('"mgmt cd"');
    expect(refusal).toContain('NULL into every row');
  });

  it('refuses two columns renamed onto one name, naming both', () => {
    const [refusal] = renameColumnRefusals({ 'Mgmt Cd': 'code', 'Mgmt Code': 'code' });
    expect(refusal).toContain('"Mgmt Cd"');
    expect(refusal).toContain('"Mgmt Code"');
    expect(refusal).toContain('cannot share one name');
  });

  it('refuses an empty map, because both of its meanings are silent', () => {
    // With unnamed columns kept it is a node that draws as configured and does
    // nothing; with them dropped it deletes every column of every row. Two
    // opposite catastrophes reached by removing the last row of a form.
    expect(renameColumnRefusals({})).toHaveLength(1);
    expect(renameColumnRefusals({})[0]).toContain('renames nothing');
  });

  it('allows a column renamed to itself, which is how `drop` selects one', () => {
    expect(renameColumnRefusals({ mgmtCd: 'mgmtCd' })).toEqual([]);
  });
});

describe('reading a rename back out of a JSON column', () => {
  const stored = {
    id: 'r1',
    name: 'Headers',
    kind: 'rename',
    columns: { 'Mgmt Cd': 'mgmtCd' },
  };

  it('accepts a node with no disposition, and reads it as keeping the rest', () => {
    // Absent is what every rename written before the field existed carries, and
    // it has to keep meaning exactly what it has always meant.
    expect(isWorkflowNode(stored)).toBe(true);
    expect(workflowRenameUnnamed({ ...stored, kind: 'rename', columns: stored.columns })).toBe(
      'keep',
    );
  });

  it('refuses a disposition it does not recognise rather than defaulting it', () => {
    // Reading an unrecognised value as `keep` would turn a projection into a
    // pass-through silently, and the sink would commit every column the author
    // meant to remove.
    expect(isWorkflowNode({ ...stored, unnamed: 'discard' })).toBe(false);
    expect(isWorkflowNode({ ...stored, unnamed: 'drop' })).toBe(true);
  });

  it('refuses a map this build cannot run rather than repairing it', () => {
    expect(isWorkflowNode({ ...stored, columns: { a: 'not a column' } })).toBe(false);
    expect(isWorkflowNode({ ...stored, columns: {} })).toBe(false);
    expect(isWorkflowNode({ ...stored, columns: [['a', 'b']] })).toBe(false);
    expect(isWorkflowNode({ ...stored, columns: { a: 1 } })).toBe(false);
  });
});

describe('the graph fingerprint', () => {
  it('does not care what order the map was written in', () => {
    const forwards = workflowGraphHash(
      graph(
        [
          source('src'),
          rename('r', { 'Mgmt Cd': 'mgmtCd', 'Reg Number': 'regNumber' }),
          sink('Out'),
        ],
        [
          ['src', 'r'],
          ['r', 'Out'],
        ],
      ),
    );
    const backwards = workflowGraphHash(
      graph(
        [
          source('src'),
          rename('r', { 'Reg Number': 'regNumber', 'Mgmt Cd': 'mgmtCd' }),
          sink('Out'),
        ],
        [
          ['src', 'r'],
          ['r', 'Out'],
        ],
      ),
    );
    // The map is applied simultaneously, so its order changes nothing about the
    // result — and a canvas that rewrote the object must not look like an edit.
    expect(backwards).toBe(forwards);
  });

  it('tells "keep the rest" apart from "drop the rest"', () => {
    const wires: Array<[string, string]> = [
      ['src', 'r'],
      ['r', 'Out'],
    ];
    const kept = workflowGraphHash(
      graph([source('src'), rename('r', { 'Mgmt Cd': 'mgmtCd' }), sink('Out')], wires),
    );
    const dropped = workflowGraphHash(
      graph([source('src'), rename('r', { 'Mgmt Cd': 'mgmtCd' }, 'drop'), sink('Out')], wires),
    );
    // It decides which columns reach the sink, so it is a different pipeline.
    expect(dropped).not.toBe(kept);
    // …and saying `keep` out loud is the same graph as saying nothing, so
    // normalising the field on a canvas cannot bump a version.
    expect(
      workflowGraphHash(
        graph([source('src'), rename('r', { 'Mgmt Cd': 'mgmtCd' }, 'keep'), sink('Out')], wires),
      ),
    ).toBe(kept);
  });

  it('leaves graphs with no rename in them exactly where they were', () => {
    // A literal rather than a comparison, for the reason the filter node's
    // equivalent gives: only a value recorded from a build *before* this change
    // can say that adding a node kind renumbered nothing. This is the same
    // graph and the same string that spec pins.
    const untouched: WorkflowGraph = {
      nodes: [
        source('src'),
        { id: 'shape', name: 'shape', kind: 'transform', transformId: 'tx-1' },
        sink('Out'),
      ],
      edges: [
        { from: 'src', to: 'shape' },
        { from: 'shape', to: 'Out' },
      ],
    };
    expect(workflowGraphHash(untouched)).toBe('790a8afa64fc4bb4');
  });
});

describe('what the graph can prove about the columns reaching a node', () => {
  it('knows exactly what a rename that drops the rest produces', () => {
    const drawn = graph(
      [
        source('src'),
        rename('r', { 'Mgmt Cd': 'mgmtCd', 'Reg Number': 'regNumber' }, 'drop'),
        sink('Out'),
      ],
      [
        ['src', 'r'],
        ['r', 'Out'],
      ],
    );
    // Whatever the source turns out to hold, nothing outside these two can be
    // on the far side of the node. That is the closed set the check below is
    // built on, and it is the one thing a JS transform can never offer.
    expect([...(workflowKnownColumns(drawn, 'Out') ?? [])]).toEqual(['mgmtCd', 'regNumber']);
  });

  it('knows nothing downstream of a rename that keeps the rest', () => {
    const drawn = graph(
      [source('src'), rename('r', { 'Mgmt Cd': 'mgmtCd' }), sink('Out')],
      [
        ['src', 'r'],
        ['r', 'Out'],
      ],
    );
    // Its output is its input with one key re-labelled, and its input is a
    // source's shape — discovered against a live system, not declared here. So
    // the honest answer is that there is no answer.
    expect(workflowKnownColumns(drawn, 'Out')).toBeUndefined();
  });

  it('carries a closed set through a filter, which touches no column', () => {
    const drawn = graph(
      [
        source('src'),
        rename('r', { 'Mgmt Cd': 'mgmtCd' }, 'drop'),
        {
          id: 'f',
          name: 'f',
          kind: 'filter',
          predicate: { kind: 'present', column: 'mgmtCd', operator: 'isNotNull' },
        },
        sink('Out'),
      ],
      [
        ['src', 'r'],
        ['r', 'f'],
        ['f', 'Out'],
      ],
    );
    expect([...(workflowKnownColumns(drawn, 'Out') ?? [])]).toEqual(['mgmtCd']);
  });

  it('refuses a filter on a column a rename above it provably removed', () => {
    // The failure being caught: a comparison against an absent column is false
    // under SQL's three-valued logic, *including the inverses*, so this filter
    // drops every row — the load comes out empty and every node reports
    // success. Today that is discovered by looking at a published type.
    const drawn = graph(
      [
        source('src'),
        rename('r', { 'Mgmt Cd': 'mgmtCd' }, 'drop'),
        {
          id: 'f',
          name: 'Only the assigned',
          kind: 'filter',
          predicate: { kind: 'present', column: 'regNumber', operator: 'isNotNull' },
        },
        sink('Out'),
      ],
      [
        ['src', 'r'],
        ['r', 'f'],
        ['f', 'Out'],
      ],
    );
    const issue = validateWorkflow(drawn).find((each) => each.code === 'column-not-produced');
    expect(issue?.nodeIds).toEqual(['f']);
    expect(issue?.message).toContain('"regNumber"');
    expect(issue?.message).toContain('"mgmtCd"');
  });

  it('refuses a second rename whose source column cannot be there', () => {
    const drawn = graph(
      [
        source('src'),
        rename('first', { 'Mgmt Cd': 'mgmtCd' }, 'drop'),
        rename('second', { regNumber: 'reg' }),
        sink('Out'),
      ],
      [
        ['src', 'first'],
        ['first', 'second'],
        ['second', 'Out'],
      ],
    );
    const issue = validateWorkflow(drawn).find((each) => each.code === 'column-not-produced');
    expect(issue?.nodeIds).toEqual(['second']);
  });

  it('says nothing at all where the graph has no opinion', () => {
    // The restraint is the point. Refusing a column the graph merely cannot see
    // would make every filter downstream of a transform unsaveable, which is
    // most of them.
    const drawn = graph(
      [
        source('src'),
        { id: 'shape', name: 'shape', kind: 'transform', transformId: 'tx' },
        {
          id: 'f',
          name: 'f',
          kind: 'filter',
          predicate: { kind: 'present', column: 'anything', operator: 'isNotNull' },
        },
        sink('Out'),
      ],
      [
        ['src', 'shape'],
        ['shape', 'f'],
        ['f', 'Out'],
      ],
    );
    expect(validateWorkflow(drawn).filter((each) => each.code === 'column-not-produced')).toEqual(
      [],
    );
  });
});

describe('a rename the validator will not save', () => {
  it('names the node and every reason at once', () => {
    const drawn = graph(
      [source('src'), rename('r', { a: 'x', b: 'x', c: 'not a column' }), sink('Out')],
      [
        ['src', 'r'],
        ['r', 'Out'],
      ],
    );
    const issue = validateWorkflow(drawn).find((each) => each.code === 'rename-invalid');
    expect(issue?.nodeIds).toEqual(['r']);
    // Both refusals in one message: a map of forty columns typed in one sitting
    // is usually wrong about several in the same way, and one refusal per round
    // trip would make fixing it a morning.
    expect(issue?.message).toContain('"not a column"');
    expect(issue?.message).toContain('cannot share one name');
  });
});
