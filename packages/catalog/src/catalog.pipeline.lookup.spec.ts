import { describe, expect, it } from 'vitest';
import {
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowLookupNode,
  type WorkflowNode,
  isWorkflowNode,
  lookupConfigRefusals,
  nodeKindIsReusable,
  validateWorkflow,
  workflowGraphHash,
  workflowKnownColumns,
  workflowLookupColumns,
  workflowLookupKey,
  workflowLookupUnmatched,
} from './catalog.pipeline';

/**
 * The lookup node as a piece of *data* — which is the argument for it being a
 * kind, exactly as it is for a rename.
 *
 * Four things become answerable at the moment a graph is saved rather than at
 * the moment a load comes out with a column of nulls in it:
 *
 * 1. Whether the names it produces can be columns, and whether two of them
 *    collide with each other or with the key.
 * 2. Whether the node it names as its reference is actually wired into it, and
 *    whether anything else is — the two wiring mistakes that both produce a run
 *    that finishes.
 * 3. Which columns are on **which side**, which no other multi-input node has to
 *    distinguish, because for every other kind the inputs are interchangeable.
 * 4. What leaves the node, exactly, when what arrives is known.
 *
 * The run-time half — the counts, the streaming, the duplicate-key rule — is
 * `workflow-runner.lookup.spec.ts`.
 */

// The same three shapes `catalog.pipeline.filter.spec.ts` and
// `catalog.pipeline.rename.spec.ts` use, byte for byte, because the pinned hash
// below is a value recorded off a build that predates all three node kinds — a
// fixture that differed by one character would pin nothing.
function source(id: string): WorkflowNode {
  return { id, name: id, kind: 'source', sourceKind: 'inline', config: {} };
}

function sink(id: string): WorkflowNode {
  return { id, name: id, kind: 'sink', targetType: id };
}

function rename(id: string, columns: Record<string, string>): WorkflowNode {
  return { id, name: id, kind: 'rename', columns, unnamed: 'drop' };
}

function lookup(id: string, over: Partial<WorkflowLookupNode> = {}): WorkflowLookupNode {
  return {
    id,
    name: id,
    kind: 'lookup',
    reference: 'plans',
    key: 'planId',
    referenceKey: 'Plan ID',
    fields: { 'Plan Name': 'planName' },
    ...over,
  };
}

function graph(nodes: WorkflowNode[], wires: Array<[string, string]>): WorkflowGraph {
  const edges: WorkflowEdge[] = wires.map(([from, to]) => ({ from, to }));
  return { nodes, edges };
}

/** `subwo → look → Out`, with `plans` wired in as the reference. */
function joined(node: WorkflowLookupNode = lookup('look')): WorkflowGraph {
  return graph(
    [source('subwo'), source('plans'), node, sink('Out')],
    [
      ['subwo', 'look'],
      ['plans', 'look'],
      ['look', 'Out'],
    ],
  );
}

function codesOf(graph: WorkflowGraph): string[] {
  return validateWorkflow(graph).map((issue) => issue.code);
}

describe('what a lookup is allowed to say', () => {
  it('accepts the join a real reference table needs, spaces and all', () => {
    // `Plan ID` and `Plan Name` are what flip's `vscos_work_plan` actually calls
    // its columns. Being able to name those on the reference side is the point;
    // what lands on the row has to be an identifier, because a load looks every
    // field up as `row[name]`.
    expect(
      lookupConfigRefusals({
        key: 'planId',
        referenceKey: 'Plan ID',
        fields: { 'Plan Name': 'planName', 'Plan Desc': 'planDescription' },
      }),
    ).toEqual([]);
  });

  it('refuses a name a column cannot have, and says what happens if it were let through', () => {
    const [refusal] = lookupConfigRefusals({
      key: 'planId',
      referenceKey: 'Plan ID',
      fields: { 'Plan Name': 'plan name' },
    });

    expect(refusal).toContain('not a name a column can have');
    // The whole reason for the rule: the symptom is a green run, not an error.
    expect(refusal).toContain('reports success');
  });

  it('refuses two reference columns landing on one name', () => {
    // The mirror of the mistake the `Record` makes unrepresentable, and the
    // sentence is the one `renameColumnRefusals` says about it.
    const [refusal] = lookupConfigRefusals({
      key: 'planId',
      referenceKey: 'Plan ID',
      fields: { 'Plan Name': 'planName', 'Plan Desc': 'planName' },
    });

    expect(refusal).toContain('which of somebody');
  });

  it('refuses a field landing on the key column', () => {
    // It would overwrite the key with the reference's copy on every row that
    // matched and leave it alone on every row that did not, so afterwards the
    // column would no longer say which rows were enriched.
    const [refusal] = lookupConfigRefusals({
      key: 'planId',
      referenceKey: 'Plan ID',
      fields: { 'Plan ID': 'planId' },
    });

    expect(refusal).toContain('the column this node matches on');
  });

  it('refuses an empty field map rather than treating it as a no-op', () => {
    // Two silent opposites reached by deleting the last row of a form: with
    // unmatched rows kept it does nothing at all, and with them dropped it is a
    // filter nobody drew.
    const [refusal] = lookupConfigRefusals({ key: 'planId', referenceKey: 'Plan ID', fields: {} });

    expect(refusal).toContain('brings no fields across');
  });

  it('says all of them at once rather than the first', () => {
    // A form filled in one sitting is usually wrong about several things in the
    // same way, and being told one at a time is four saves.
    expect(
      lookupConfigRefusals({ key: '', referenceKey: '', fields: { '': 'a b' } }).length,
    ).toBeGreaterThan(2);
  });
});

describe('when two keys are the same key', () => {
  it('compares as text, so a number and its string are one key', () => {
    // The two sides routinely come from different engines: a plan code out of a
    // VARCHAR and the same code out of a spreadsheet parser are the same key to
    // everyone except `===`.
    expect(workflowLookupKey(43)).toBe(workflowLookupKey('43'));
  });

  it('does not trim, fold case, or normalise in any other way', () => {
    // Every one of those is a rule about which of somebody's values are the same
    // value. flip's reader normalises the driving unit and compares it against a
    // column normalised at write time by a different screen; the two agree only
    // for as long as nobody edits either.
    expect(workflowLookupKey(' 43AA')).not.toBe(workflowLookupKey('43AA'));
    expect(workflowLookupKey('43aa')).not.toBe(workflowLookupKey('43AA'));
  });

  it('treats null, undefined and the empty string as no key at all', () => {
    // A reference table writes the empty string where a code was missing — flip's
    // `planId: row.planId ?? ""` — so treating it as a value would make one
    // keyless reference row the answer for every keyless driving row.
    expect(workflowLookupKey(null)).toBeUndefined();
    expect(workflowLookupKey(undefined)).toBeUndefined();
    expect(workflowLookupKey('')).toBeUndefined();
  });

  it('refuses an object rather than stringifying it', () => {
    // `String({})` is `"[object Object]"`, which every JSON column in a row would
    // share — so a join on a mis-chosen column would match everything to
    // everything and report a very large number of matches.
    expect(workflowLookupKey({ a: 1 })).toBeUndefined();
    expect(workflowLookupKey([1, 2])).toBeUndefined();
  });
});

describe('reading a stored lookup back out of a column', () => {
  it('accepts one this build can run', () => {
    expect(isWorkflowNode(lookup('look'))).toBe(true);
  });

  it('refuses one whose reference names nothing', () => {
    expect(isWorkflowNode({ ...lookup('look'), reference: '' })).toBe(false);
  });

  it('refuses a disposition this build does not recognise', () => {
    // Reading an unknown word back as `null` would turn a `fail` — chosen because
    // the reference is a prerequisite — into a load that commits nulls and
    // reports success.
    expect(isWorkflowNode({ ...lookup('look'), unmatched: 'outer' })).toBe(false);
  });

  it('accepts an absent disposition, which is what "null" is stored as', () => {
    expect(isWorkflowNode({ ...lookup('look'), unmatched: undefined })).toBe(true);
    expect(workflowLookupUnmatched(lookup('look'))).toBe('null');
  });

  it('refuses one whose field map it cannot run, rather than dropping the entry', () => {
    // A map read back with one entry silently dropped is a graph that commits a
    // column of NULLs under a name nobody can now explain.
    expect(isWorkflowNode({ ...lookup('look'), fields: { 'Plan Name': 'plan name' } })).toBe(false);
  });
});

describe('the wiring a lookup needs', () => {
  it('accepts the shape it was designed for', () => {
    expect(codesOf(joined())).toEqual([]);
  });

  it('refuses a reference that is not wired into it, pointing at both boxes', () => {
    // The one lookup mistake that otherwise produces a green run: with no
    // reference rows to hold, every row comes out enriched with nulls.
    const drawn = joined(lookup('look', { reference: 'somewhere' }));
    const [issue] = validateWorkflow(drawn);

    expect(issue?.code).toBe('lookup-reference-not-wired');
    expect(issue?.message).toContain('every row would come out enriched with nulls');
  });

  it('refuses a lookup with only its reference wired in', () => {
    const drawn = graph(
      [source('plans'), lookup('look'), sink('Out')],
      [
        ['plans', 'look'],
        ['look', 'Out'],
      ],
    );

    expect(codesOf(drawn)).toContain('lookup-nothing-to-enrich');
  });

  it('does not decide which input is the reference from edge order', () => {
    // Drawing the reference edge first must be the same graph as drawing it
    // second: the node names it. If order decided, one of these would validate
    // and the other would not.
    const wires: Array<[string, string]> = [
      ['plans', 'look'],
      ['subwo', 'look'],
      ['look', 'Out'],
    ];
    const drawn = graph([source('subwo'), source('plans'), lookup('look'), sink('Out')], wires);

    expect(codesOf(drawn)).toEqual([]);
  });
});

describe('the fingerprint of a graph with a lookup in it', () => {
  it('leaves graphs with no lookup in them exactly where they were', () => {
    // A literal rather than a comparison, for the reason the filter and rename
    // specs give: only a value recorded from a build *before* this change can say
    // that adding a node kind renumbered nothing. This is the same graph and the
    // same string both of those pin.
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

  it('changes when the reference edge is repointed', () => {
    // The field somebody would be tempted to leave out, because it names a node
    // rather than describing an operation. Repointing it changes what the load
    // produces on every row and leaves the canvas looking identical.
    const one = workflowGraphHash(joined());
    const other = workflowGraphHash(joined(lookup('look', { reference: 'subwo' })));

    expect(other).not.toBe(one);
  });

  it('changes when the disposition changes, and folds the default with saying nothing', () => {
    const silent = workflowGraphHash(joined());
    const spelled = workflowGraphHash(joined(lookup('look', { unmatched: 'null' })));
    const dropping = workflowGraphHash(joined(lookup('look', { unmatched: 'drop' })));

    // Normalising the field on a canvas must not renumber a stored graph.
    expect(spelled).toBe(silent);
    // …and `drop` decides which rows reach the sink, so it is a different load.
    expect(dropping).not.toBe(silent);
  });

  it('is not moved by the order the field map was written in', () => {
    // The whole map is applied to one row at once, so its order changes nothing
    // about the result — and a canvas that rewrote the object must not look like
    // an edit.
    const forwards = workflowGraphHash(
      joined(lookup('look', { fields: { 'Plan Name': 'planName', 'Plan Desc': 'planDesc' } })),
    );
    const backwards = workflowGraphHash(
      joined(lookup('look', { fields: { 'Plan Desc': 'planDesc', 'Plan Name': 'planName' } })),
    );

    expect(backwards).toBe(forwards);
  });
});

describe('what the graph can prove about a lookup’s two sides', () => {
  /** `subwo` and `plans` each behind a rename that drops what it does not name. */
  function knownBothSides(node: WorkflowLookupNode = lookup('look')): WorkflowGraph {
    return graph(
      [
        source('subwo'),
        rename('drive', { 'Sub Work Order Id': 'subWorkOrderId', 'Plan Id': 'planId' }),
        source('plans'),
        rename('ref', { 'Plan ID': 'Plan ID', 'Plan Name': 'Plan Name' }),
        node,
        sink('Out'),
      ],
      [
        ['subwo', 'drive'],
        ['drive', 'look'],
        ['plans', 'ref'],
        ['ref', 'look'],
        ['look', 'Out'],
      ],
    );
  }

  it('tells the driving columns from the reference columns', () => {
    // THE ONE THAT MATTERS, and the reason `workflowKnownColumns` grew a filter.
    // Every other multi-input node sees its inputs pooled, because the rows
    // arrive concatenated. A lookup's reference is held as a map and never
    // passed on, so pooling would offer a key column that exists only over there.
    const { driving, reference } = workflowLookupColumns(
      knownBothSides(),
      lookup('look', { reference: 'ref' }),
    );

    expect([...(driving ?? [])].sort()).toEqual(['planId', 'subWorkOrderId']);
    expect([...(reference ?? [])].sort()).toEqual(['Plan ID', 'Plan Name']);
  });

  it('refuses a key column that is only on the reference side', () => {
    // Pooled, this would validate — and then match nothing on every row, and
    // commit. It is the exact failure `checkColumnsProduced` exists to catch,
    // produced by the check itself.
    const drawn = knownBothSides(lookup('look', { reference: 'ref', key: 'Plan ID' }));

    expect(codesOf(drawn)).toContain('column-not-produced');
  });

  it('refuses a reference column that is only on the driving side', () => {
    const drawn = knownBothSides(lookup('look', { reference: 'ref', referenceKey: 'planId' }));

    expect(codesOf(drawn)).toContain('column-not-produced');
  });

  it('refuses a field landing on a name the driving rows already carry', () => {
    const drawn = knownBothSides(
      lookup('look', { reference: 'ref', fields: { 'Plan Name': 'subWorkOrderId' } }),
    );

    expect(codesOf(drawn)).toContain('lookup-column-collides');
  });

  it('says exactly what leaves the node when what arrives is known', () => {
    // What a lookup passes on is what arrived plus the names it was told to add,
    // and nothing else — so the set stays closed for whatever is below it.
    const drawn = knownBothSides(lookup('look', { reference: 'ref' }));

    expect([...(workflowKnownColumns(drawn, 'Out') ?? [])].sort()).toEqual([
      'planId',
      'planName',
      'subWorkOrderId',
    ]);
  });

  it('does not leak the reference’s columns downstream', () => {
    // The half of the claim above that would go unnoticed: `Plan Name` is on the
    // reference and lands as `planName`, so the reference's own spelling must not
    // be offerable to a filter below this node.
    const drawn = knownBothSides(lookup('look', { reference: 'ref' }));

    expect(workflowKnownColumns(drawn, 'Out')?.has('Plan Name')).toBe(false);
  });

  it('says nothing at all when the sides are not known, rather than saying empty', () => {
    // Refusing a column the graph merely has no opinion about would make every
    // lookup below a transform unsaveable.
    const { driving, reference } = workflowLookupColumns(joined(), lookup('look'));

    expect(driving).toBeUndefined();
    expect(reference).toBeUndefined();
    expect(codesOf(joined())).toEqual([]);
  });
});

describe('what a lookup cannot be saved as', () => {
  it('is not a reusable node', () => {
    // The rename argument, plus one that is not an argument at all: `reference`
    // is a node id in *this* graph, so a shared body would name a node the
    // adopting graph has never had — and it is the field that decides which side
    // is held in memory.
    expect(nodeKindIsReusable('lookup')).toBe(false);
  });
});
