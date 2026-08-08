import { describe, expect, it } from 'vitest';
import {
  type WorkflowAggregateNode,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
  aggregateRefusals,
  isWorkflowNode,
  validateWorkflow,
  workflowAggregateColumns,
  workflowAggregateJoinMaxLength,
  workflowAggregateMaxGroups,
  workflowAggregateOutputColumns,
  workflowAggregateSeparator,
  workflowGraphHash,
  workflowKnownColumns,
} from './catalog.pipeline';

/**
 * The aggregate node as a piece of *data*.
 *
 * The rename node made the argument first and this one extends it: a config that
 * is data can be checked at the moment a graph is saved, and a function body
 * cannot. What is new here is the direction of the proof — a rename's output set
 * is an *upper bound* and only when it drops what it does not name, while an
 * aggregate's is **exact** and always, because it writes every one of its
 * columns on every record it emits.
 *
 * Every refusal below is a failure that otherwise reports success and is found
 * in a committed snapshot. The two worst point in opposite directions: no
 * group-by columns commits exactly one row whatever the source held, and no
 * aggregates commits the distinct group keys with every other column gone.
 *
 * The arithmetic half — the summation error, the collation, the join bound — is
 * `catalog.aggregate.spec.ts`. The run-time half is
 * `workflow-runner.aggregate.spec.ts`.
 */

// The same three shapes `catalog.pipeline.rename.spec.ts` uses, byte for byte,
// because the pinned hash below is a value recorded off a build that predates
// this node kind — a fixture that differed by one character would pin nothing.
function source(id: string): WorkflowNode {
  return { id, name: id, kind: 'source', sourceKind: 'inline', config: {} };
}

function sink(id: string): WorkflowNode {
  return { id, name: id, kind: 'sink', targetType: id };
}

function graph(nodes: WorkflowNode[], wires: Array<[string, string]>): WorkflowGraph {
  const edges: WorkflowEdge[] = wires.map(([from, to]) => ({ from, to }));
  return { nodes, edges };
}

/** flip's own `wo` derivation, shrunk to the four functions it actually uses. */
function woAggregate(id = 'agg'): WorkflowAggregateNode {
  return {
    id,
    name: id,
    kind: 'aggregate',
    groupBy: ['workOrderId', 'assetId'],
    aggregates: [
      { as: 'itemDescription', fn: 'max', column: 'itemDescription' },
      { as: 'actualLaborCost', fn: 'sum', column: 'actualLaborCost' },
      { as: 'nmcStartDate', fn: 'min', column: 'nmcStartDate' },
      { as: 'requestedService', fn: 'join', column: 'requestedService', separator: '; ' },
      { as: 'subWorkOrders', fn: 'count' },
    ],
  };
}

describe('what an aggregate is allowed to say', () => {
  it('accepts the derivation it was written for', () => {
    expect(aggregateRefusals(woAggregate())).toEqual([]);
  });

  it('refuses grouping on nothing, because that commits one row whatever it read', () => {
    // The most dangerous empty state in the file, and the reason `groupBy` is
    // required rather than defaulted: with no grouping, a run over a source that
    // returned everything and a run over one that returned nothing both commit a
    // single row, and nothing distinguishes them.
    const [refusal] = aggregateRefusals({ groupBy: [], aggregates: [{ as: 'n', fn: 'count' }] });
    expect(refusal).toContain('exactly one row whether it read a billion records or none');
  });

  it('refuses computing nothing, because that is a projection wearing the wrong name', () => {
    const [refusal] = aggregateRefusals({ groupBy: ['workOrderId'], aggregates: [] });
    expect(refusal).toContain('drops every other column of every row');
  });

  it('refuses an output name no store could turn into a column', () => {
    // The same failure `property-names.ts` is the record of, one node upstream:
    // a load looks every field up as `row[name]`, so a column nothing downstream
    // can name arrives as NULL in every row with the run reporting success.
    const [refusal] = aggregateRefusals({
      groupBy: ['workOrderId'],
      aggregates: [{ as: 'total cost', fn: 'count' }],
    });
    expect(refusal).toContain('"total cost"');
    expect(refusal).toContain('NULL into every row');
  });

  it('refuses a group-by column spelled the way a real file drop spells it, and says what to do', () => {
    // The one place this node is deliberately less permissive than `rename`,
    // and the refusal has to carry the fix or it reads as an arbitrary rule.
    const [refusal] = aggregateRefusals({
      groupBy: ['Work Order Id'],
      aggregates: [{ as: 'n', fn: 'count' }],
    });
    expect(refusal).toContain('"Work Order Id"');
    expect(refusal).toContain('rename node above this one');
  });

  it('refuses two aggregates writing one name, naming both by counting them', () => {
    const refusals = aggregateRefusals({
      groupBy: ['workOrderId'],
      aggregates: [
        { as: 'cost', fn: 'sum', column: 'actualLaborCost' },
        { as: 'cost', fn: 'max', column: 'estimatedLaborCost' },
      ],
    });
    expect(refusals.join(' ')).toContain('2 aggregates are written out as "cost"');
  });

  it('refuses an aggregate that writes into a column it also groups on', () => {
    const [refusal] = aggregateRefusals({
      groupBy: ['workOrderId'],
      aggregates: [{ as: 'workOrderId', fn: 'count' }],
    });
    expect(refusal).toContain('cannot hold both the group key and a summary');
  });

  it('refuses the same group-by column twice', () => {
    const [refusal] = aggregateRefusals({
      groupBy: ['workOrderId', 'workOrderId'],
      aggregates: [{ as: 'n', fn: 'count' }],
    });
    expect(refusal).toContain('groups on "workOrderId" twice');
  });

  it('lets only count go without a column, and says so on the others', () => {
    expect(aggregateRefusals({ groupBy: ['a'], aggregates: [{ as: 'n', fn: 'count' }] })).toEqual(
      [],
    );
    const [refusal] = aggregateRefusals({ groupBy: ['a'], aggregates: [{ as: 'n', fn: 'sum' }] });
    expect(refusal).toContain('Only `count` may go without a column');
  });

  it('refuses a separator on something that has nothing to separate', () => {
    // A field only one function reads is a field somebody sets on the wrong one
    // and never finds out, which is why it is refused rather than ignored.
    const [refusal] = aggregateRefusals({
      groupBy: ['a'],
      aggregates: [{ as: 'n', fn: 'sum', column: 'b', separator: '; ' }],
    });
    expect(refusal).toContain('nothing to separate');
  });

  it('refuses a join bound that could not be stored in the column it is going into', () => {
    const [refusal] = aggregateRefusals({
      groupBy: ['a'],
      aggregates: [{ as: 'n', fn: 'join', column: 'b', maxLength: 900_000_000 }],
    });
    expect(refusal).toContain('cannot be stored in the column it is going into');
  });

  it('reports every refusal in one pass, because a node typed in one sitting is wrong the same way several times', () => {
    const refusals = aggregateRefusals({
      groupBy: ['Work Order Id', 'Asset Id'],
      aggregates: [
        { as: 'a b', fn: 'sum', column: 'x' },
        { as: 'c d', fn: 'sum', column: 'y' },
      ],
    });
    expect(refusals.length).toBe(4);
  });
});

describe('reading a stored aggregate back out of a column', () => {
  it('accepts one this build can run', () => {
    expect(isWorkflowNode(woAggregate())).toBe(true);
  });

  it('refuses one whose function this build does not have, rather than dropping it', () => {
    // Refused rather than repaired: an aggregate read back with one entry
    // silently dropped is a load that commits a column of nulls under a name
    // somebody put in an object type on purpose.
    expect(
      isWorkflowNode({
        id: 'agg',
        name: 'agg',
        kind: 'aggregate',
        groupBy: ['a'],
        aggregates: [{ as: 'p', fn: 'median', column: 'b' }],
      }),
    ).toBe(false);
  });

  it('refuses one whose group-by vanished, because that reads back as a single row', () => {
    expect(
      isWorkflowNode({
        id: 'agg',
        name: 'agg',
        kind: 'aggregate',
        groupBy: [],
        aggregates: [{ as: 'n', fn: 'count' }],
      }),
    ).toBe(false);
  });
});

describe('the defaults, each read in exactly one place', () => {
  it('caps a node that asked for nothing at the shipped ceiling', () => {
    expect(workflowAggregateMaxGroups(woAggregate())).toBe(1_000_000);
  });

  it('honours a lower cap and clamps one above the hard ceiling', () => {
    const node = woAggregate('a');
    expect(workflowAggregateMaxGroups({ ...node, maxGroups: 500 })).toBe(500);
    expect(workflowAggregateMaxGroups({ ...node, maxGroups: 999_000_000 })).toBe(20_000_000);
  });

  it('separates with ", " and bounds a join at one TEXT column when nobody said', () => {
    expect(workflowAggregateSeparator({ as: 'x', fn: 'join', column: 'y' })).toBe(', ');
    expect(workflowAggregateJoinMaxLength({ as: 'x', fn: 'join', column: 'y' })).toBe(65_535);
  });
});

describe('the fingerprint', () => {
  it('renumbers no graph that has no aggregate in it', () => {
    // A literal rather than a comparison, for the reason the rename node's
    // equivalent gives: only a value recorded from a build *before* this change
    // can say that adding a node kind renumbered nothing. This is the same graph
    // and the same string that spec pins.
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

  it('does not call reordering an edit, in either list', () => {
    const node = woAggregate();
    const forwards = workflowGraphHash(graph([source('s'), node, sink('Out')], [['s', 'agg']]));
    const backwards = workflowGraphHash(
      graph(
        [
          source('s'),
          {
            ...node,
            groupBy: [...node.groupBy].reverse(),
            aggregates: [...node.aggregates].reverse(),
          },
          sink('Out'),
        ],
        [['s', 'agg']],
      ),
    );
    // Neither order changes which groups exist or what is computed for them, and
    // a record's key order is not something anything downstream reads.
    expect(forwards).toBe(backwards);
  });

  it('calls a changed function an edit, because it changes what is committed', () => {
    const node = woAggregate();
    const asMax = workflowGraphHash(graph([source('s'), node, sink('Out')], [['s', 'agg']]));
    const asMin = workflowGraphHash(
      graph(
        [
          source('s'),
          {
            ...node,
            aggregates: node.aggregates.map((each) =>
              each.as === 'itemDescription' ? { ...each, fn: 'min' } : each,
            ),
          },
          sink('Out'),
        ],
        [['s', 'agg']],
      ),
    );
    expect(asMax).not.toBe(asMin);
  });

  it('gives one spelling to a cap nobody set, so normalising it on a canvas renumbers nothing', () => {
    const node = woAggregate();
    const absent = workflowGraphHash(graph([source('s'), node, sink('Out')], [['s', 'agg']]));
    const spelled = workflowGraphHash(
      graph([source('s'), { ...node, maxGroups: 1_000_000 }, sink('Out')], [['s', 'agg']]),
    );
    // Set explicitly to the default it already had, and that IS an edit — the
    // pin is recorded, exactly as a transform's version pin is, because moving
    // off "whatever this build ships" onto a number is a decision somebody made.
    expect(absent).not.toBe(spelled);
  });
});

describe('what the graph can prove about the columns leaving an aggregate', () => {
  it('knows them exactly, without looking upstream at all', () => {
    const drawn = graph(
      [source('src'), woAggregate(), sink('Out')],
      [
        ['src', 'agg'],
        ['agg', 'Out'],
      ],
    );
    // A source is unknown, so a rename in this position would answer undefined.
    // An aggregate answers, and it answers the closed set, because it writes
    // every one of these on every record whatever it was handed.
    expect([...(workflowKnownColumns(drawn, 'Out') ?? [])].sort()).toEqual(
      [
        'actualLaborCost',
        'assetId',
        'itemDescription',
        'nmcStartDate',
        'requestedService',
        'subWorkOrders',
        'workOrderId',
      ].sort(),
    );
  });

  it('names its inputs and its outputs as two different lists', () => {
    const node = woAggregate();
    // What it reads includes `count`'s absent column not at all, and what it
    // writes includes `subWorkOrders`, which it reads nothing for.
    expect(workflowAggregateColumns(node)).not.toContain('subWorkOrders');
    expect(workflowAggregateOutputColumns(node)).toContain('subWorkOrders');
  });

  it('refuses a filter below it that names a column the aggregate cannot produce', () => {
    const drawn = graph(
      [
        source('src'),
        woAggregate(),
        {
          id: 'keep',
          name: 'keep',
          kind: 'filter',
          narrows: ['Out'],
          predicate: { kind: 'compare', column: 'serialNumber', operator: 'equals', value: 'x' },
        },
        sink('Out'),
      ],
      [
        ['src', 'agg'],
        ['agg', 'keep'],
        ['keep', 'Out'],
      ],
    );
    const issue = validateWorkflow(drawn).find((each) => each.code === 'column-not-produced');
    expect(issue?.message).toContain('"serialNumber"');
    // Not a warning: a comparison against an absent column is false under
    // three-valued logic, including the inverses, so the load comes out empty
    // and every node reports success.
    expect(issue).toBeDefined();
  });

  it('refuses an aggregate that groups on a column the graph can prove is not there', () => {
    const drawn = graph(
      [
        source('src'),
        {
          id: 'r',
          name: 'r',
          kind: 'rename',
          columns: { 'Work Order Id': 'workOrderId' },
          unnamed: 'drop',
        },
        {
          id: 'agg',
          name: 'agg',
          kind: 'aggregate',
          groupBy: ['workOrderId', 'assetId'],
          aggregates: [{ as: 'n', fn: 'count' }],
        },
        sink('Out'),
      ],
      [
        ['src', 'r'],
        ['r', 'agg'],
        ['agg', 'Out'],
      ],
    );
    const issue = validateWorkflow(drawn).find((each) => each.code === 'column-not-produced');
    expect(issue?.message).toContain('"assetId"');
    // The sentence has to name the consequence, because "column not produced"
    // reads like a warning and this one turns sixteen thousand rows into one.
    expect(issue?.message).toContain('one null-keyed group');
  });

  it('refuses an aggregate the canvas would draw as finished, by code', () => {
    const drawn = graph(
      [
        source('src'),
        { id: 'agg', name: 'agg', kind: 'aggregate', groupBy: [''], aggregates: [] },
        sink('Out'),
      ],
      [
        ['src', 'agg'],
        ['agg', 'Out'],
      ],
    );
    expect(validateWorkflow(drawn).some((each) => each.code === 'aggregate-invalid')).toBe(true);
  });
});
