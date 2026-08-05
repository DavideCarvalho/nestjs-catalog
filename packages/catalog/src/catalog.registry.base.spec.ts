import { describe, expect, it } from 'vitest';
import { buildCatalogGraph } from './catalog.registry.base';
import type { CatalogObjectTypeDef, CatalogRelationDef } from './catalog.types';

/**
 * The edge rule, tested where it now lives rather than through a registry.
 *
 * WHAT THIS FILE IS ABOUT
 * -----------------------
 * There used to be two of these. `MikroOrmCatalogRegistry` derived the ontology
 * from ORM metadata and `StoredCatalogRegistry`, in another package, read it out
 * of the database — and each carried its own `linkKey` and its own edge loop
 * under a comment asking whoever changed one to change both. The rule they
 * implement is subtle enough that a divergence would have been invisible: a link
 * declared at both ends must produce ONE edge, paired by a key that survives the
 * two ends having different property names, and the surviving edge must be the
 * one whose end holds the foreign key. The previous implementation keyed on
 * property name alone and drew two edges for every ordinary foreign key, which
 * is exactly what one copy silently reverting would have looked like.
 *
 * So the input here is a snapshot's `types` and nothing else — no ORM, no
 * database, no registry. That is the honest shape of the function: the graph is
 * a pure reading of the snapshot, which is why it stopped being something a
 * subclass gets to decide. The proof that both registries reach this code is in
 * `registry-graph.parity.spec.ts` over in the store package; the proof that the
 * code is right is here.
 */
function relation(fields: Partial<CatalogRelationDef> & Pick<CatalogRelationDef, 'name'>) {
  const built: CatalogRelationDef = {
    displayName: fields.name,
    kind: 'm:1',
    targetType: 'Base',
    nullable: true,
    hidden: false,
    order: 0,
    owner: true,
    targetPublished: true,
    enriched: false,
    ...fields,
  };
  return built;
}

function objectType(
  name: string,
  relations: CatalogRelationDef[] = [],
  fields: Partial<CatalogObjectTypeDef> = {},
): CatalogObjectTypeDef {
  return {
    name,
    displayName: name,
    pluralDisplayName: `${name}s`,
    tableName: name.toLowerCase(),
    group: 'Fleet',
    primaryKey: ['id'],
    enriched: false,
    properties: [],
    relations,
    ...fields,
  };
}

/**
 * One foreign key, declared from both ends under the names a real schema uses.
 * `Base` sorts first and is therefore read first, so anything that kept the row
 * it saw first points this backwards.
 */
function fleet(): CatalogObjectTypeDef[] {
  return [
    objectType('Base', [
      relation({
        name: 'mvrs',
        displayName: 'Mvrs',
        kind: '1:m',
        targetType: 'Mvr',
        owner: false,
        inverseName: 'base',
      }),
    ]),
    objectType('Mvr', [
      relation({ name: 'base', displayName: 'Base', localKey: 'base_id', inverseName: 'mvrs' }),
    ]),
  ];
}

describe('one edge per link', () => {
  it('collapses a link declared at both ends under different names', () => {
    // THE case. `Mvr.base` and `Base.mvrs` are one foreign key, and the pairing
    // has to survive the two ends being spelled nothing alike — which is the
    // ordinary shape, not the exotic one.
    expect(buildCatalogGraph(fleet()).edges).toHaveLength(1);
  });

  it('draws it from the end that holds the key, whichever end was read first', () => {
    // So the arrow reads the way a join is written. The inverse end is read
    // first here, so keeping the first row seen would produce `Base -> Mvr`.
    expect(buildCatalogGraph(fleet()).edges[0]).toEqual({
      id: 'Mvr.base',
      source: 'Mvr',
      target: 'Base',
      label: 'Base',
      kind: 'm:1',
    });
  });

  it('collapses a symmetric pair that names neither end', () => {
    // The fallback in the key. Two `m:n` sides spelled alike and mapped by
    // nothing is what hand-built metadata produces, and there is still one link
    // underneath it.
    const graph = buildCatalogGraph([
      objectType('Left', [
        relation({ name: 'link', kind: 'm:n', targetType: 'Right', owner: false }),
      ]),
      objectType('Right', [
        relation({ name: 'link', kind: 'm:n', targetType: 'Left', owner: false }),
      ]),
    ]);

    expect(graph.edges).toHaveLength(1);
  });

  it('keeps two different links between the same pair apart', () => {
    // The boundary of the rule, and the error that pairing by endpoints alone
    // would make: a vehicle with a home base and an assigned base has two
    // foreign keys, and collapsing them hides one.
    const graph = buildCatalogGraph([
      objectType('Base'),
      objectType('Mvr', [
        relation({ name: 'homeBase', order: 0 }),
        relation({ name: 'assignedBase', order: 1 }),
      ]),
    ]);

    expect(graph.edges.map((edge) => edge.id)).toEqual(['Mvr.homeBase', 'Mvr.assignedBase']);
  });

  it('draws no edge to a type the catalog does not hold', () => {
    // An edge promises a node the reader can open. `targetPublished` is computed
    // against the whole catalog for exactly this.
    const graph = buildCatalogGraph([
      objectType('Mvr', [relation({ name: 'depot', targetType: 'Depot', targetPublished: false })]),
    ]);

    expect(graph.edges).toEqual([]);
    expect(graph.nodes.map((node) => node.id)).toEqual(['Mvr']);
  });

  it('still draws a hidden link', () => {
    // Hiding is a statement about a table cell. A graph that quietly dropped
    // edges would be a picture nobody could read as complete, which is the only
    // thing a graph is for.
    const graph = buildCatalogGraph([
      objectType('Base'),
      objectType('Mvr', [relation({ name: 'base', hidden: true })]),
    ]);

    expect(graph.edges.map((edge) => edge.id)).toEqual(['Mvr.base']);
  });

  it('labels the edge with the curated name rather than the property name', () => {
    // A graph is read at a glance; `base` is what the code calls it and "Home
    // base" is what the business does.
    const graph = buildCatalogGraph([
      objectType('Base'),
      objectType('Mvr', [relation({ name: 'base', displayName: 'Home base' })]),
    ]);

    expect(graph.edges[0]?.label).toBe('Home base');
  });
});

describe('the nodes', () => {
  it('carries the label, the group and both counts', () => {
    // Shared for the same reason the edges are: a node that reported the wrong
    // link count would make the picture disagree with the type page beside it,
    // and there is nothing about counting that either registry does its own way.
    const graph = buildCatalogGraph([
      objectType('Mvr', [relation({ name: 'base' }), relation({ name: 'homeBase' })], {
        displayName: 'Vehicle',
        group: 'Fleet',
        icon: 'truck',
        properties: [
          {
            name: 'id',
            displayName: 'ID',
            type: 'uuid',
            columnName: 'id',
            nullable: false,
            primary: true,
            hidden: false,
            order: 0,
            enriched: false,
          },
        ],
      }),
    ]);

    expect(graph.nodes).toEqual([
      {
        id: 'Mvr',
        label: 'Vehicle',
        group: 'Fleet',
        icon: 'truck',
        propertyCount: 1,
        relationCount: 2,
      },
    ]);
  });

  it('keeps a type that has no links at all', () => {
    // The node list is the catalog, not the subgraph that happens to be
    // connected. A loose type is a real answer and a common one.
    expect(buildCatalogGraph([objectType('Loose')]).nodes.map((node) => node.id)).toEqual([
      'Loose',
    ]);
  });

  it('counts declarations rather than links', () => {
    // Two rows for one link, deliberately: this is the number the type pages
    // sum to, and halving it would make the header disagree with the rows under
    // it. The edges are where links are counted.
    const graph = buildCatalogGraph(fleet());
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));

    expect(byId.get('Mvr')?.relationCount).toBe(1);
    expect(byId.get('Base')?.relationCount).toBe(1);
    expect(graph.edges).toHaveLength(1);
  });
});
