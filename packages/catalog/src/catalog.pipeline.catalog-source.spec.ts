import { describe, expect, it } from 'vitest';
import {
  CATALOG_SOURCE_TYPE_KEY,
  CONNECTOR_KINDS,
  type WorkflowColumnKnowledge,
  type WorkflowGraph,
  type WorkflowNode,
  isConnectorKind,
  validateWorkflow,
  workflowGraphHash,
  workflowKnownColumns,
  workflowSourceObjectType,
} from './catalog.pipeline';

/**
 * The source kind that names a **type**, as far as the model can see it.
 *
 * The run-time half — that it reads one snapshot and not four — is
 * `sources.catalog.db.spec.ts` in the pipeline package, against a real MySQL,
 * because that half is what a `WHERE` clause does. What is left here is
 * everything the pure model owes about the kind:
 *
 * - that a node which names no type is refused rather than run,
 * - that the columns below it are known, which no other source can offer,
 * - and that adding the kind renumbered no stored graph.
 *
 * That last one is not a formality. `workflowGraphHash` is what a release is
 * identified by, so a change to this file that moved an existing graph's
 * fingerprint would present every graph in every deployment as edited.
 */

// The same shapes the other pipeline specs use, byte for byte, because the
// pinned hash below is a value recorded off a build that predates this kind — a
// fixture that differed by one character would pin nothing.
function source(id: string): WorkflowNode {
  return { id, name: id, kind: 'source', sourceKind: 'inline', config: {} };
}

function catalogSource(id: string, objectType?: string): WorkflowNode {
  return {
    id,
    name: id,
    kind: 'source',
    sourceKind: 'catalog',
    config: objectType === undefined ? {} : { [CATALOG_SOURCE_TYPE_KEY]: objectType },
  };
}

function transform(id: string): WorkflowNode {
  return { id, name: id, kind: 'transform', transformId: 'tx-1' };
}

function sink(id: string): WorkflowNode {
  return { id, name: id, kind: 'sink', targetType: 'Mvr' };
}

function graph(nodes: WorkflowNode[], edges: Array<[string, string]>): WorkflowGraph {
  return { nodes, edges: edges.map(([from, to]) => ({ from, to })) };
}

/** A console that can see one published type. */
const knows: WorkflowColumnKnowledge = {
  columnsOfType: (name) =>
    name === 'SubwoReplica' ? ['workOrderId', 'actualLaborCost', 'baseCode'] : undefined,
};

describe('the kind itself', () => {
  it('is in the vocabulary, so nothing narrows it against a stale copy', () => {
    expect(CONNECTOR_KINDS).toContain('catalog');
    expect(isConnectorKind('catalog')).toBe(true);
  });

  it('refuses a kind it has never heard of, which is what a stored row can be', () => {
    // `isConnectorKind` is the boundary every stored `kind` is narrowed at, and
    // it is the reason a kind written by a newer deployment cannot arrive here
    // as "whichever kind happened to be first".
    expect(isConnectorKind('a-kind-from-the-future')).toBe(false);
    expect(isConnectorKind('Catalog')).toBe(false);
  });
});

describe('workflowSourceObjectType', () => {
  it('reads the type off a catalog source', () => {
    expect(workflowSourceObjectType(catalogSource('src', 'SubwoReplica'))).toBe('SubwoReplica');
  });

  it('trims, because a name that differs only by a space resolves nothing at run time', () => {
    expect(workflowSourceObjectType(catalogSource('src', '  SubwoReplica '))).toBe('SubwoReplica');
  });

  it('answers nothing for a blank name and nothing for another kind', () => {
    expect(workflowSourceObjectType(catalogSource('src', '   '))).toBeUndefined();
    expect(workflowSourceObjectType(catalogSource('src'))).toBeUndefined();
    expect(workflowSourceObjectType(source('src'))).toBeUndefined();
  });
});

describe('validateWorkflow, over a catalog source', () => {
  it('accepts one that names a type', () => {
    expect(
      validateWorkflow(
        graph([catalogSource('src', 'SubwoReplica'), sink('out')], [['src', 'out']]),
      ),
    ).toEqual([]);
  });

  it('refuses one that does not, rather than letting it fail inside a durable step', () => {
    const issues = validateWorkflow(graph([catalogSource('src'), sink('out')], [['src', 'out']]));
    expect(issues.map((issue) => issue.code)).toEqual(['source-type-not-named']);
    expect(issues[0].message).toMatch(/does not say which object type/);
  });

  it('says nothing about a blank config on any other kind, which may borrow an address', () => {
    // A source that carries no url is not evidence of anything: a named
    // connection supplies one. `catalog` is decidable precisely because it has
    // no connection to borrow from.
    expect(validateWorkflow(graph([source('src'), sink('out')], [['src', 'out']]))).toEqual([]);
  });
});

describe('the columns below a catalog source', () => {
  const withFilter = (column: string): WorkflowGraph =>
    graph(
      [
        catalogSource('src', 'SubwoReplica'),
        {
          id: 'keep',
          name: 'keep',
          kind: 'filter',
          predicate: { kind: 'compare', column, operator: 'equals', value: 'x' },
          // Acknowledged, so the only issue a valid graph can report here is the
          // column one. See `catalog.pipeline.filter.spec.ts` for what this is.
          narrows: ['Mvr'],
        },
        sink('out'),
      ],
      [
        ['src', 'keep'],
        ['keep', 'out'],
      ],
    );

  it('are the published type’s, when a caller supplied the lookup', () => {
    const known = workflowKnownColumns(withFilter('baseCode'), 'keep', knows);
    expect(known && [...known].sort()).toEqual(['actualLaborCost', 'baseCode', 'workOrderId']);
  });

  it('are unknown without one, which is the honest answer rather than an empty set', () => {
    // The point of the distinction: with no lookup the walk must not conclude
    // "no columns", or every filter under a catalog source would be refused on a
    // console that had simply not loaded its types.
    expect(workflowKnownColumns(withFilter('baseCode'), 'keep')).toBeUndefined();
  });

  it('are unknown for a type this caller cannot see', () => {
    const graphOfOther = graph(
      [catalogSource('src', 'SomethingElse'), sink('out')],
      [['src', 'out']],
    );
    expect(workflowKnownColumns(graphOfOther, 'out', knows)).toBeUndefined();
  });

  it('are unknown for every other source kind, whose shape lives in the live system', () => {
    const plain = graph([source('src'), sink('out')], [['src', 'out']]);
    expect(workflowKnownColumns(plain, 'out', knows)).toBeUndefined();
  });

  it('lets a filter be refused for naming a column the type does not have', () => {
    // The claim worth making: this reaches further into a graph than anything
    // else can, because it starts at the *root* rather than at a rename halfway
    // down. A filter on a column that is not there matches no row, so the load
    // comes out empty and every node reports success.
    const issues = validateWorkflow(withFilter('actual_labor_cost'), knows);
    expect(issues.map((issue) => issue.code)).toEqual(['column-not-produced']);
    expect(issues[0].message).toMatch(/"actual_labor_cost"/);
    expect(issues[0].message).toMatch(/source reading a published object type/);
  });

  it('adds no refusal when the lookup is not supplied', () => {
    expect(validateWorkflow(withFilter('actual_labor_cost'))).toEqual([]);
  });

  it('is silenced by a transform, whose output is a function body', () => {
    const throughCode = graph(
      [
        catalogSource('src', 'SubwoReplica'),
        transform('tx'),
        {
          id: 'keep',
          name: 'keep',
          kind: 'filter',
          predicate: { kind: 'compare', column: 'invented', operator: 'equals', value: 'x' },
          narrows: ['Mvr'],
        },
        sink('out'),
      ],
      [
        ['src', 'tx'],
        ['tx', 'keep'],
        ['keep', 'out'],
      ],
    );
    expect(workflowKnownColumns(throughCode, 'keep', knows)).toBeUndefined();
    expect(validateWorkflow(throughCode, knows)).toEqual([]);
  });
});

describe('workflowGraphHash, once a source kind has been added', () => {
  it('renumbers no graph that was stored before this kind existed', () => {
    // Recorded off a build that predates `catalog`. A source's canonical form
    // already carried its kind and its sorted config, so nothing was appended
    // and nothing moved — and this is the assertion that says so rather than the
    // reasoning that claims it. A graph's fingerprint is what a release is
    // identified by; moving one would present every stored graph as edited.
    expect(
      workflowGraphHash(
        graph(
          [source('src'), transform('tx'), sink('out')],
          [
            ['src', 'tx'],
            ['tx', 'out'],
          ],
        ),
      ),
    ).toBe('45d5af32d8af3680');
    expect(
      workflowGraphHash({
        nodes: [
          {
            id: 'src',
            name: 'src',
            kind: 'source',
            sourceKind: 'http',
            config: { url: 'https://x' },
          },
          sink('out'),
        ],
        edges: [{ from: 'src', to: 'out' }],
      }),
    ).toBe('1e44ef358427af9f');
  });

  it('moves when the type a catalog source reads moves', () => {
    // The type name lives in `config`, which the canonical form already sorts
    // and hashes — so repointing a graph at another dataset is a new version of
    // it, exactly as repointing a SQL source at another query is.
    const before = graph([catalogSource('src', 'SubwoReplica'), sink('out')], [['src', 'out']]);
    const after = graph([catalogSource('src', 'WoReplica')], []);
    expect(workflowGraphHash(before)).not.toBe(
      workflowGraphHash(graph([after.nodes[0], sink('out')], [['src', 'out']])),
    );
  });
});
