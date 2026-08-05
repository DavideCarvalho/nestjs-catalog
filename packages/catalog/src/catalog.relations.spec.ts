import type { EntityProperty } from '@mikro-orm/core';
import { EntityMetadata, MetadataStorage, MikroORM, ReferenceKind } from '@mikro-orm/core';
import { describe, expect, it } from 'vitest';
import { CatalogProperty } from './catalog.decorators';
import type { CatalogModuleOptions } from './catalog.options';
import { InMemoryCatalogOverlayStore } from './catalog.overlay-store';
import { MikroOrmCatalogRegistry } from './catalog.registry';

/**
 * That the links are read off the ORM, and that one link draws one line.
 *
 * WHAT THIS FILE IS ABOUT
 * -----------------------
 * A relation needs nothing hand-written: `@ManyToOne(() => Base)` already names
 * its target, its kind and its join column, and MikroORM's metadata carries all
 * three plus which end owns the key. The tests below pin that, because it is the
 * argument for there being no `@CatalogRelation` decorator — everything such a
 * decorator would restate is already here, and a restatement is something that
 * can disagree with the schema.
 *
 * The half that was wrong is the picture. Both ends of a link may be declared,
 * and the graph de-duplicated them by property NAME — which only catches the
 * accident of both ends being spelled alike. `Mvr.base` with `Base.mvrs` is the
 * ordinary shape of a foreign key in any schema, and it drew two lines between
 * the same pair of nodes. A graph that cannot be trusted to draw one line per
 * link is not a graph, it is a decoration.
 *
 * The metadata is built by hand rather than by booting an ORM, exactly as
 * `catalog.registry.spec.ts` does: every derivation here is a reading of
 * metadata, so metadata is the right input.
 */

/** The acting principal the one curation call here is made as. */
const CURATOR = 'catalog-console#ana@example.com';

function entity(
  className: string,
  props: Array<Partial<EntityProperty>>,
  overrides: Partial<EntityMetadata> = {},
): EntityMetadata {
  const meta = new EntityMetadata({
    className,
    tableName: className.toLowerCase(),
    primaryKeys: ['id'],
    ...overrides,
  });
  for (const prop of props) meta.addProperty(prop);
  return meta;
}

function scalar(name: string, prop: Partial<EntityProperty> = {}): Partial<EntityProperty> {
  return { name, kind: ReferenceKind.SCALAR, type: 'string', ...prop };
}

function ormOver(metas: EntityMetadata[]): MikroORM {
  const storage = new MetadataStorage(
    Object.fromEntries(metas.map((meta) => [meta.className, meta])),
  );
  const orm = Object.create(MikroORM.prototype);
  orm.getMetadata = () => storage;
  return orm;
}

function registryOver(
  metas: EntityMetadata[],
  options: CatalogModuleOptions = {},
): MikroOrmCatalogRegistry {
  return new MikroOrmCatalogRegistry(ormOver(metas), options, new InMemoryCatalogOverlayStore());
}

/**
 * `Mvr` with a `@ManyToOne` to `Base`, and `Base` with the matching
 * `@OneToMany` — the shape MikroORM produces for one foreign key declared at
 * both ends, `mappedBy` and all.
 *
 * `linked` picks whether the inverse end exists at all, because the two are
 * genuinely different catalogs: with only the owning end declared, `Base` has an
 * empty relations list and is nonetheless one of the most linked-to types in the
 * schema.
 */
function fleet(options: { linked?: boolean } = {}): EntityMetadata[] {
  const base = entity('Base', [scalar('id'), scalar('name')]);
  const mvr = entity('Mvr', [
    scalar('id'),
    {
      name: 'base',
      kind: ReferenceKind.MANY_TO_ONE,
      type: 'Base',
      targetMeta: base,
      fieldNames: ['base_id'],
      nullable: true,
      inversedBy: options.linked ? 'mvrs' : undefined,
    },
  ]);
  if (options.linked) {
    base.addProperty({
      name: 'mvrs',
      kind: ReferenceKind.ONE_TO_MANY,
      type: 'Mvr',
      targetMeta: mvr,
      mappedBy: 'base',
    });
  }
  return [base, mvr];
}

describe('what the ORM already knows about a link', () => {
  it('reads the target, the kind and the join column with nothing declared by hand', () => {
    // The whole case for there being no relation decorator. Every field a
    // hand-written declaration would carry is already in the metadata.
    const [relation] = registryOver(fleet()).getType('Mvr')?.relations ?? [];

    expect(relation).toMatchObject({
      name: 'base',
      kind: 'm:1',
      targetType: 'Base',
      localKey: 'base_id',
      nullable: true,
    });
    // Derived, so nobody has said anything about it yet.
    expect(relation?.enriched).toBe(false);
  });

  it('knows which end holds the key', () => {
    // Not decoration. The owning end is the one a join is written from and the
    // one whose column can be indexed, and it is what lets the graph point an
    // arrow the right way round.
    const registry = registryOver(fleet({ linked: true }));

    expect(registry.getType('Mvr')?.relations[0]?.owner).toBe(true);
    expect(registry.getType('Base')?.relations[0]?.owner).toBe(false);
  });

  it('carries the property at the other end, from whichever side named it', () => {
    // `inversedBy` on the owning end, `mappedBy` on the inverse one — the same
    // fact under two spellings, and the thing that lets two rows be recognised
    // as one link.
    const registry = registryOver(fleet({ linked: true }));

    expect(registry.getType('Mvr')?.relations[0]?.inverseName).toBe('mvrs');
    expect(registry.getType('Base')?.relations[0]?.inverseName).toBe('base');
  });

  it('treats a one-to-many as the inverse end even when nothing says so', () => {
    // Metadata assembled by hand — an `EntitySchema`, or a fixture — often has
    // no `owner` flag at all. The key on a 1:m is on the many side by
    // definition, so the kind answers this without the flag.
    const base = entity('Base', [scalar('id')]);
    const mvr = entity('Mvr', [scalar('id')]);
    base.addProperty({
      name: 'mvrs',
      kind: ReferenceKind.ONE_TO_MANY,
      type: 'Mvr',
      targetMeta: mvr,
    });

    expect(registryOver([base, mvr]).getType('Base')?.relations[0]?.owner).toBe(false);
  });

  it('lists a link on the end that declares it and nowhere else', () => {
    // One row per DECLARATION. Synthesising a mirror row on `Base` would double
    // every count and hand a curator a label no publisher owns — the inbound
    // view is derived by the screen instead.
    const registry = registryOver(fleet());

    expect(registry.getType('Mvr')?.relations.map((r) => r.name)).toEqual(['base']);
    expect(registry.getType('Base')?.relations).toEqual([]);
  });
});

describe('a link whose other end is missing', () => {
  it('keeps the relation on the type and says the target is not published', () => {
    // Dropping it would leave `Mvr` looking less connected than it is: the
    // foreign key exists, and that its target is out of reach is the single most
    // useful thing to know about it.
    const registry = registryOver(fleet(), { exclude: ['Base'] });
    const [relation] = registry.getType('Mvr')?.relations ?? [];

    expect(relation?.targetType).toBe('Base');
    expect(relation?.targetPublished).toBe(false);
  });

  it('draws no edge for it', () => {
    // The other half of the answer, and the reason the two are not the same
    // decision: an edge promises a node the reader can open.
    const registry = registryOver(fleet(), { exclude: ['Base'] });

    expect(registry.getGraph().nodes.map((n) => n.id)).toEqual(['Mvr']);
    expect(registry.getGraph().edges).toEqual([]);
  });

  it('marks a published target as published', () => {
    // The other side of the flag, so a change that hardcoded `false` — or that
    // computed it before the catalog was assembled — fails here.
    expect(registryOver(fleet()).getType('Mvr')?.relations[0]?.targetPublished).toBe(true);
  });
});

describe('the graph', () => {
  it('draws one edge for a link declared at both ends under different names', () => {
    // THE case this file exists for. `Mvr.base` and `Base.mvrs` are one foreign
    // key; keying the de-duplication on the property name saw two links, so
    // every ordinary relation in a real schema was drawn twice.
    const edges = registryOver(fleet({ linked: true })).getGraph().edges;

    expect(edges).toHaveLength(1);
  });

  it('points the edge from the end that holds the key', () => {
    // So the arrow reads the way a join is written. `Base` sorts before `Mvr`
    // and is discovered first, so a build that kept whichever row it saw first
    // would point this backwards.
    const [edge] = registryOver(fleet({ linked: true })).getGraph().edges;

    expect(edge).toMatchObject({ id: 'Mvr.base', source: 'Mvr', target: 'Base', kind: 'm:1' });
  });

  it('still collapses a symmetric pair that names neither end', () => {
    // The fallback. Two `m:n` sides spelled alike and mapped by nothing is what
    // hand-built metadata produces, and it has to keep collapsing to one line.
    const left = entity('Left', [scalar('id')]);
    const right = entity('Right', [scalar('id')]);
    left.addProperty({
      name: 'link',
      kind: ReferenceKind.MANY_TO_MANY,
      type: 'Right',
      targetMeta: right,
    });
    right.addProperty({
      name: 'link',
      kind: ReferenceKind.MANY_TO_MANY,
      type: 'Left',
      targetMeta: left,
    });

    expect(registryOver([left, right]).getGraph().edges).toHaveLength(1);
  });

  it('draws two edges for two different links between the same pair', () => {
    // The boundary of the rule above, and the error that pairing links by their
    // endpoints alone would make: a vehicle assigned to one base and stationed
    // at another has two foreign keys, and collapsing them would hide one.
    const base = entity('Base', [scalar('id')]);
    const mvr = entity('Mvr', [
      scalar('id'),
      {
        name: 'homeBase',
        kind: ReferenceKind.MANY_TO_ONE,
        type: 'Base',
        targetMeta: base,
        fieldNames: ['home_base_id'],
      },
      {
        name: 'assignedBase',
        kind: ReferenceKind.MANY_TO_ONE,
        type: 'Base',
        targetMeta: base,
        fieldNames: ['assigned_base_id'],
      },
    ]);

    expect(
      registryOver([base, mvr])
        .getGraph()
        .edges.map((e) => e.id),
    ).toEqual(['Mvr.homeBase', 'Mvr.assignedBase']);
  });

  it('labels the edge with the curated name, not the property name', () => {
    // A graph is read at a glance; `base` is what the code calls it and "Home
    // base" is what the business does.
    class Mvr {
      @CatalogProperty({ displayName: 'Home base' })
      base?: unknown;
    }
    const base = entity('Base', [scalar('id')]);
    const mvr = entity(
      'Mvr',
      [
        scalar('id'),
        { name: 'base', kind: ReferenceKind.MANY_TO_ONE, type: 'Base', targetMeta: base },
      ],
      { class: Mvr },
    );

    expect(registryOver([base, mvr]).getGraph().edges[0]?.label).toBe('Home base');
  });

  it('reports how many links each node has', () => {
    const nodes = registryOver(fleet({ linked: true })).getGraph().nodes;
    const byId = new Map(nodes.map((node) => [node.id, node]));

    expect(byId.get('Mvr')?.relationCount).toBe(1);
    expect(byId.get('Base')?.relationCount).toBe(1);
  });
});

describe('naming a link', () => {
  it('takes its label from @CatalogProperty, which needs no relation decorator', () => {
    // The metadata is keyed by property name and a `@ManyToOne` is a property,
    // so the decorator that labels a column labels a link. A second decorator
    // would be a synonym for this one.
    class Mvr {
      @CatalogProperty({ displayName: 'Home base', description: 'Where it lives.' })
      base?: unknown;
    }
    const base = entity('Base', [scalar('id')]);
    const mvr = entity(
      'Mvr',
      [
        scalar('id'),
        { name: 'base', kind: ReferenceKind.MANY_TO_ONE, type: 'Base', targetMeta: base },
      ],
      { class: Mvr },
    );

    const [relation] = registryOver([base, mvr]).getType('Mvr')?.relations ?? [];
    expect(relation?.displayName).toBe('Home base');
    expect(relation?.description).toBe('Where it lives.');
    expect(relation?.enriched).toBe(true);
  });

  it('counts a named link as enrichment of the type', () => {
    // Otherwise a type whose only human input is "this link is called Home
    // base" stays on the "nobody has named this" list a curator works from, and
    // gets done twice.
    class Mvr {
      @CatalogProperty({ displayName: 'Home base' })
      base?: unknown;
    }
    const base = entity('Base', [scalar('id')]);
    const mvr = entity(
      'Mvr',
      [
        scalar('id'),
        { name: 'base', kind: ReferenceKind.MANY_TO_ONE, type: 'Base', targetMeta: base },
      ],
      { class: Mvr },
    );

    const registry = registryOver([base, mvr]);
    expect(registry.getType('Mvr')?.enriched).toBe(true);
    expect(registry.getSnapshot().stats.enrichedTypes).toBe(1);
  });

  it('survives the next deploy, through the same overlay a column uses', () => {
    // No new route and no new patch shape: the overlay is keyed by property
    // name, a relation's name is in that namespace, and `patchProperty` already
    // accepts one. Rebuilding from the ORM afterwards is what proves the edit
    // outlives the metadata it was made against.
    const registry = registryOver(fleet());

    return registry.patchProperty('Mvr', 'base', { displayName: 'Home base' }, CURATOR).then(() => {
      expect(registry.getType('Mvr')?.relations[0]?.displayName).toBe('Home base');
      expect(registry.getType('Mvr')?.relations[0]?.enriched).toBe(true);
      expect(registry.getGraph().edges[0]?.label).toBe('Home base');
    });
  });
});

describe('the counts', () => {
  it('counts declared relations rather than links', () => {
    // Two rows for one link, and deliberately so: this number is the sum of
    // what the type pages show, and quietly halving it would make the header
    // disagree with the rows underneath it. The graph is where links are
    // counted.
    const registry = registryOver(fleet({ linked: true }));

    expect(registry.getSnapshot().stats.relations).toBe(2);
    expect(registry.getGraph().edges).toHaveLength(1);
  });
});
