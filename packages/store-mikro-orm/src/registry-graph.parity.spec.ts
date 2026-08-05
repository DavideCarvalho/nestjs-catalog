import {
  type CatalogModuleOptions,
  InMemoryCatalogOverlayStore,
  MikroOrmCatalogRegistry,
} from '@dudousxd/nestjs-catalog';
import type { EntityProperty, MikroORM } from '@mikro-orm/core';
import {
  EntityMetadata,
  MetadataStorage,
  MikroORM as MikroORMClass,
  ReferenceKind,
} from '@mikro-orm/core';
import { describe, expect, it } from 'vitest';
import { SnapshotRow } from './entities/governance';
import { ObjectTypeRow, PropertyRow, type StoredRelation } from './entities/model';
import { StoredCatalogRegistry } from './stored-registry.service';

/**
 * That the two registries draw the SAME ontology the same way.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `MikroOrmCatalogRegistry` derives the model from ORM metadata in the
 * application that owns the tables. `StoredCatalogRegistry` reads it out of our
 * own tables, because the types arrived over the wire from applications whose
 * entity classes are not here. Until this release each of them built the graph
 * itself: two copies of `linkKey`, two copies of the edge loop, in two packages,
 * each under a comment asking whoever changed one to change both.
 *
 * A comment is not a mechanism, and this particular divergence would have been
 * invisible. The rule is that a link declared at both ends produces one edge,
 * paired by a key that survives the ends being spelled differently, drawn from
 * the end holding the foreign key. A copy that regressed to keying on property
 * name alone draws two edges for every ordinary foreign key — and the only place
 * that shows up is a picture, which nobody diffs.
 *
 * So this file builds ONE ontology twice — once as ORM metadata, once as stored
 * rows — and asserts the two graphs are identical. It also asserts each graph
 * against a literal, and that is not belt-and-braces: two registries sharing one
 * implementation agree with each other under any mutation of it, so equality
 * alone would prove nothing about the rule. The literal is what goes red.
 */
function entity(className: string, props: Array<Partial<EntityProperty>>): EntityMetadata {
  const meta = new EntityMetadata({
    className,
    tableName: className.toLowerCase(),
    primaryKeys: ['id'],
  });
  for (const prop of props) meta.addProperty(prop);
  return meta;
}

function scalar(name: string): Partial<EntityProperty> {
  return { name, kind: ReferenceKind.SCALAR, type: 'string' };
}

function ormOver(metas: EntityMetadata[]): MikroORM {
  const storage = new MetadataStorage(
    Object.fromEntries(metas.map((meta) => [meta.className, meta])),
  );
  const orm = Object.create(MikroORMClass.prototype);
  orm.getMetadata = () => storage;
  return orm;
}

/**
 * The ontology, as MikroORM would hand it over.
 *
 * `Mvr` holds two foreign keys into `Base` — the second is what keeps "one edge
 * per link" from degenerating into "one edge per pair of types" — plus one into
 * a `Depot` nobody published. `Base` declares the inverse end of the first,
 * under a name spelled nothing like it.
 */
function derivedTypes(): EntityMetadata[] {
  const base = entity('Base', [scalar('id'), scalar('name')]);
  const mvr = entity('Mvr', [
    scalar('id'),
    scalar('name'),
    {
      name: 'base',
      kind: ReferenceKind.MANY_TO_ONE,
      type: 'Base',
      targetMeta: base,
      fieldNames: ['base_id'],
      nullable: true,
      inversedBy: 'mvrs',
    },
    {
      name: 'homeBase',
      kind: ReferenceKind.MANY_TO_ONE,
      type: 'Base',
      targetMeta: base,
      fieldNames: ['home_base_id'],
      nullable: true,
    },
    {
      name: 'depot',
      kind: ReferenceKind.MANY_TO_ONE,
      type: 'Depot',
      fieldNames: ['depot_id'],
      nullable: true,
    },
  ]);
  base.addProperty({
    name: 'mvrs',
    kind: ReferenceKind.ONE_TO_MANY,
    type: 'Mvr',
    targetMeta: mvr,
    mappedBy: 'base',
  });
  return [base, mvr];
}

function derivedRegistry(): MikroOrmCatalogRegistry {
  // `defaultGroup` and nothing else. The two registries have to agree on the
  // node payload as well as the edges, and a group is the one node field the
  // derived side invents rather than reads.
  const options: CatalogModuleOptions = { defaultGroup: 'Fleet' };
  return new MikroOrmCatalogRegistry(
    ormOver(derivedTypes()),
    options,
    new InMemoryCatalogOverlayStore(),
  );
}

function storedRelation(
  fields: Partial<StoredRelation> & Pick<StoredRelation, 'name' | 'displayName'>,
): StoredRelation {
  return {
    kind: 'm:1',
    targetType: 'Base',
    nullable: true,
    hidden: false,
    position: 0,
    owner: true,
    ...fields,
  };
}

function propertyRow(name: string) {
  const row = Object.create(PropertyRow.prototype);
  return Object.assign(row, {
    name,
    displayName: name,
    type: 'string',
    sourceColumn: name,
    nullable: true,
    primary: false,
    hidden: false,
    position: 0,
  });
}

function typeRow(name: string, properties: string[], relations: StoredRelation[]): ObjectTypeRow {
  const row = Object.create(ObjectTypeRow.prototype);
  return Object.assign(row, {
    name,
    // Spelled out to match what `humanize` derives on the other side. The
    // publisher sends a label; the library derives one; parity is only
    // meaningful when both describe the same ontology, labels included.
    displayName: name,
    pluralDisplayName: `${name}s`,
    physicalTable: name.toLowerCase(),
    group: 'Fleet',
    primaryKey: ['id'],
    properties: { getItems: () => properties.map(propertyRow) },
    relations,
  });
}

/** The same ontology, as rows a publisher wrote. Same names, same positions. */
function storedTypes(): ObjectTypeRow[] {
  return [
    typeRow(
      'Base',
      ['id', 'name'],
      [
        storedRelation({
          name: 'mvrs',
          displayName: 'Mvrs',
          kind: '1:m',
          targetType: 'Mvr',
          owner: false,
          inverseName: 'base',
          position: 2,
        }),
      ],
    ),
    typeRow(
      'Mvr',
      ['id', 'name'],
      [
        storedRelation({
          name: 'base',
          displayName: 'Base',
          localKey: 'base_id',
          inverseName: 'mvrs',
          position: 2,
        }),
        storedRelation({
          name: 'homeBase',
          // What `humanize('homeBase')` produces on the derived side.
          displayName: 'Home Base',
          localKey: 'home_base_id',
          position: 3,
        }),
        storedRelation({
          name: 'depot',
          displayName: 'Depot',
          targetType: 'Depot',
          localKey: 'depot_id',
          position: 4,
        }),
      ],
    ),
  ];
}

async function storedRegistry(): Promise<StoredCatalogRegistry> {
  const rows = storedTypes();
  const fork = () => ({
    find: async (target: unknown) => {
      if (target === ObjectTypeRow) return rows;
      if (target === SnapshotRow) return [];
      throw new Error('unexpected entity in reload');
    },
    // `reload` asks the database which snapshots are the serving ones before
    // hydrating any. No fixture here has committed a load, so the honest answer
    // is none — and on that answer the registry skips the snapshot read
    // entirely. Nothing in this file is about freshness; the graph is.
    getConnection: () => ({
      execute: async (sql: string) => (sql.includes('catalog_snapshot') ? [] : WATERMARK_ANSWER),
    }),
  });
  const registry = Object.create(StoredCatalogRegistry.prototype);
  Object.assign(registry, {
    em: { fork },
    orm: {},
    // The background staleness check off: these fixtures are about what
    // `reload` builds, not about a sibling process noticing a write.
    options: { staleAfterMs: 0 },
    snapshot: { version: 0, generatedAt: '', stats: {}, types: [] },
  });
  const built: StoredCatalogRegistry = registry;
  await built.reload();
  return built;
}

/**
 * What both of them must draw.
 *
 * `Mvr.base` and `Base.mvrs` are one link and collapse to one edge, pointed from
 * `Mvr` because that is the end holding the column — and note `Base` is read
 * first on both sides, so a build that kept whichever row it saw first would
 * point it backwards. `Mvr.homeBase` is a second, separate link between the same
 * pair and survives as its own edge. `Mvr.depot` points at a type this catalog
 * does not hold and produces no edge, while remaining one of `Mvr`'s three
 * declared relations.
 */
const EXPECTED = {
  nodes: [
    {
      id: 'Base',
      label: 'Base',
      group: 'Fleet',
      icon: undefined,
      propertyCount: 2,
      relationCount: 1,
    },
    {
      id: 'Mvr',
      label: 'Mvr',
      group: 'Fleet',
      icon: undefined,
      propertyCount: 2,
      relationCount: 3,
    },
  ],
  edges: [
    { id: 'Mvr.base', source: 'Mvr', target: 'Base', label: 'Base', kind: 'm:1' },
    { id: 'Mvr.homeBase', source: 'Mvr', target: 'Base', label: 'Home Base', kind: 'm:1' },
  ],
};

/**
 * `reload` reads a staleness watermark over the model tables before anything
 * else, so the fakes below have to answer it or the rebuild stops there. Its
 * contents do not matter here — the check that would consult it is turned off,
 * with `staleAfterMs: 0` — and what it does is
 * `stored-registry.staleness.spec.ts`'s subject.
 */
const WATERMARK_ANSWER = [
  { type_rows: 0, type_at: null, property_rows: 0, property_at: null, db_now: new Date(0) },
];

describe('the two registries draw one ontology the same way', () => {
  it('agrees edge for edge and node for node', async () => {
    // The parity assertion. On its own it proves only that they share code —
    // which is the point, but it cannot fail while they share it. The two tests
    // below are the ones a broken rule trips.
    const derived = derivedRegistry().getGraph();
    const stored = (await storedRegistry()).getGraph();

    expect(stored).toEqual(derived);
  });

  it('draws the ontology the derived way', () => {
    expect(derivedRegistry().getGraph()).toEqual(EXPECTED);
  });

  it('draws the ontology the stored way', async () => {
    expect((await storedRegistry()).getGraph()).toEqual(EXPECTED);
  });

  it('leaves neither class its own copy of the drawing', async () => {
    // The structural half. Both used to declare `getGraph` and both had to be
    // changed in step; inheriting it is what makes a single edit reach both
    // screens. A subclass that re-declares it has re-opened the seam this file
    // exists to close, whatever its body happens to say today.
    expect(Object.getOwnPropertyNames(MikroOrmCatalogRegistry.prototype)).not.toContain('getGraph');
    expect(Object.getOwnPropertyNames(StoredCatalogRegistry.prototype)).not.toContain('getGraph');
  });
});
