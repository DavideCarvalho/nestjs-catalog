import type { EntityProperty } from '@mikro-orm/core';
import { EntityMetadata, MetadataStorage, MikroORM, ReferenceKind } from '@mikro-orm/core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CatalogModuleOptions } from './catalog.options';
import { InMemoryCatalogOverlayStore } from './catalog.overlay-store';
import { MikroOrmCatalogRegistry } from './catalog.registry';

/**
 * The registry reads a MikroORM metadata graph and nothing else, so these tests
 * hand it a real `EntityMetadata` built by hand rather than a database. That is
 * the point: every derivation below — the display name, the scalar type, the
 * relation direction — is a guess made from metadata, and the guesses are what
 * a UI switches on.
 */
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

/**
 * A MikroORM stand-in. The registry only ever calls `getMetadata()`, so this is
 * a real prototype with that one method rather than a cast over a bare object.
 */
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

describe('the derived display name', () => {
  it.each([
    ['PriBuyBuyListDetail', 'Pri Buy Buy List Detail'],
    ['Mvr', 'Mvr'],
    ['work_order', 'Work order'],
    ['work-order', 'Work order'],
    // An acronym run keeps its letters together and only breaks before the
    // word that follows it.
    ['HTTPServer', 'HTTP Server'],
    ['MELRecord', 'MEL Record'],
    ['subwo2Line', 'Subwo2 Line'],
  ])('humanises the type name %s into %s', (className, expected) => {
    const registry = registryOver([entity(className, [scalar('id')])]);
    expect(registry.getSnapshot().types[0]?.displayName).toBe(expected);
  });

  // The single most common column in any schema. `Id` is the first thing
  // anyone notices, which is why it is special-cased.
  it('renders an id column as ID rather than Id', () => {
    const registry = registryOver([entity('Widget', [scalar('id'), scalar('parentId')])]);
    const [id, parentId] = registry.getSnapshot().types[0]?.properties ?? [];
    expect(id?.displayName).toBe('ID');
    // Only a column called exactly `id` is special-cased; a suffix is left as
    // the humaniser found it. Pinned because it is the boundary of the rule,
    // and because the overlay is the intended fix rather than a wider regex.
    expect(parentId?.displayName).toBe('Parent Id');
  });

  it.each([
    ['Box', 'Boxes'],
    ['Batch', 'Batches'],
    ['Dish', 'Dishes'],
    ['Category', 'Categories'],
    // Vowel + y takes a plain s: "Days", not "Daies".
    ['Day', 'Days'],
    ['Mvr', 'Mvrs'],
  ])('pluralises %s as %s', (className, expected) => {
    const registry = registryOver([entity(className, [scalar('id')])]);
    expect(registry.getSnapshot().types[0]?.pluralDisplayName).toBe(expected);
  });

  it('pluralises the display name rather than the class name', () => {
    // Otherwise a type renamed through the overlay would keep a plural derived
    // from a name nobody sees.
    const registry = registryOver([entity('WorkOrder', [scalar('id')])]);
    expect(registry.getSnapshot().types[0]?.pluralDisplayName).toBe('Work Orders');
  });
});

describe('the derived scalar type', () => {
  it.each<[string, Partial<EntityProperty>, string]>([
    ['a uuid', { type: 'uuid' }, 'uuid'],
    ['a plain string', { type: 'string' }, 'string'],
    ['an enum', { type: 'enum' }, 'string'],
    ['a varchar column', { type: '', columnTypes: ['varchar(255)'] }, 'string'],
    ['an int', { type: 'int' }, 'number'],
    ['a decimal', { type: 'decimal' }, 'number'],
    ['a date', { type: 'Date' }, 'date'],
    ['a datetime column', { type: '', columnTypes: ['datetime'] }, 'date'],
    ['a boolean', { type: 'boolean' }, 'boolean'],
    ['json', { type: 'json' }, 'json'],
    ['something nobody has a rule for', { type: 'geometry' }, 'unknown'],
  ])('classifies %s as %s', (_label, prop, expected) => {
    const registry = registryOver([entity('Widget', [scalar('value', prop)])]);
    expect(registry.getSnapshot().types[0]?.properties[0]?.type).toBe(expected);
  });

  // tinyint(1) is how MySQL spells boolean, and it contains "int". Ordering the
  // tests the other way round right-aligns every boolean column in the UI.
  it('reads tinyint(1) as a boolean rather than a number', () => {
    const registry = registryOver([
      entity('Widget', [scalar('flag', { type: '', columnTypes: ['tinyint(1)'] })]),
    ]);
    expect(registry.getSnapshot().types[0]?.properties[0]?.type).toBe('boolean');
  });

  it('still reads a wider tinyint as a number', () => {
    const registry = registryOver([
      entity('Widget', [scalar('count', { type: '', columnTypes: ['tinyint(4)'] })]),
    ]);
    expect(registry.getSnapshot().types[0]?.properties[0]?.type).toBe('number');
  });

  // `Opt<string>` and every other branded type erase to `Object` through
  // emitDecoratorMetadata, which is roughly half the columns in a real schema.
  // Trusting the first candidate would call all of them json.
  it('looks past an Object runtime type to the column type underneath', () => {
    const registry = registryOver([
      entity('Widget', [
        scalar('note', { runtimeType: 'Object', type: 'Object', columnTypes: ['text'] }),
      ]),
    ]);
    expect(registry.getSnapshot().types[0]?.properties[0]?.type).toBe('string');
  });

  it('says unknown rather than guessing when nothing classifies', () => {
    const registry = registryOver([
      entity('Widget', [scalar('blob', { runtimeType: 'Object', type: 'Object' })]),
    ]);
    expect(registry.getSnapshot().types[0]?.properties[0]?.type).toBe('unknown');
  });
});

describe('which entities and properties are catalogued', () => {
  it.each<[string, Partial<EntityMetadata>]>([
    ['abstract', { abstract: true }],
    ['a pivot table', { pivotTable: true }],
    // MikroORM derives `virtual` from the expression, so this is how a virtual
    // entity actually reaches the registry.
    ['virtual', { expression: 'select 1' }],
  ])('leaves out an entity that is %s', (_label, overrides) => {
    const registry = registryOver([entity('Hidden', [scalar('id')], overrides)]);
    expect(registry.getSnapshot().types).toEqual([]);
  });

  it('honours an explicit include list', () => {
    const registry = registryOver(
      [entity('Kept', [scalar('id')]), entity('Dropped', [scalar('id')])],
      { include: ['Kept'] },
    );
    expect(registry.getSnapshot().types.map((type) => type.name)).toEqual(['Kept']);
  });

  it('honours an exclude list', () => {
    const registry = registryOver(
      [entity('Kept', [scalar('id')]), entity('Dropped', [scalar('id')])],
      { exclude: ['Dropped'] },
    );
    expect(registry.getSnapshot().types.map((type) => type.name)).toEqual(['Kept']);
  });

  it('treats an empty include list as "no opinion" rather than "nothing"', () => {
    const registry = registryOver([entity('Kept', [scalar('id')])], { include: [] });
    expect(registry.getSnapshot().types.map((type) => type.name)).toEqual(['Kept']);
  });

  // An excluded entity has no constructor here either, so it cannot be read
  // back through the generic object endpoint by guessing its name.
  it('hands out no entity class for a type it left out', () => {
    const registry = registryOver(
      [entity('Kept', [scalar('id')]), entity('Dropped', [scalar('id')])],
      {
        exclude: ['Dropped'],
      },
    );
    expect(registry.getEntityClass('Dropped')).toBeUndefined();
    expect(registry.getEntityClass('Kept')).toBeDefined();
  });

  it('leaves out a derived column that has nothing to read', () => {
    // `persist: false` marks a field with no column behind it.
    const registry = registryOver([
      entity('Widget', [scalar('id'), scalar('computed', { persist: false })]),
    ]);
    expect(registry.getSnapshot().types[0]?.properties.map((p) => p.name)).toEqual(['id']);
  });

  it('leaves out an embedded root, whose children are already listed', () => {
    const registry = registryOver([
      entity('Widget', [
        scalar('id'),
        { name: 'address', kind: ReferenceKind.EMBEDDED, type: 'Address' },
      ]),
    ]);
    expect(registry.getSnapshot().types[0]?.properties.map((p) => p.name)).toEqual(['id']);
  });
});

describe('relations', () => {
  const owner = entity('Owner', [scalar('id')]);
  const widget = entity('Widget', [
    scalar('id'),
    {
      name: 'owner',
      kind: ReferenceKind.MANY_TO_ONE,
      type: 'Owner',
      targetMeta: owner,
      fieldNames: ['owner_id'],
    },
  ]);

  it('files a relation apart from the scalar properties', () => {
    const registry = registryOver([owner, widget]);
    const type = registry.getType('Widget');
    expect(type?.properties.map((p) => p.name)).toEqual(['id']);
    expect(type?.relations.map((r) => r.name)).toEqual(['owner']);
  });

  it('names the target by its class and keeps the local key', () => {
    const registry = registryOver([owner, widget]);
    const [relation] = registry.getType('Widget')?.relations ?? [];
    expect(relation?.targetType).toBe('Owner');
    expect(relation?.kind).toBe('m:1');
    expect(relation?.localKey).toBe('owner_id');
  });

  it('drops a graph edge that points at a type the catalog does not hold', () => {
    // The target was excluded, so drawing the edge would put a node on the
    // graph that cannot be opened.
    const registry = registryOver([owner, widget], { exclude: ['Owner'] });
    expect(registry.getGraph().nodes.map((node) => node.id)).toEqual(['Widget']);
    expect(registry.getGraph().edges).toEqual([]);
  });

  // Both ends of a relation are declared, so a link named the same on both
  // sides would otherwise appear twice and the graph would double up.
  it('draws one edge for a relation declared at both ends under one name', () => {
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
    const edges = registryOver([left, right]).getGraph().edges;
    expect(edges).toHaveLength(1);
  });
});

describe('the snapshot as a whole', () => {
  it('counts what it holds', () => {
    const owner = entity('Owner', [scalar('id')]);
    const widget = entity('Widget', [
      scalar('id'),
      scalar('name'),
      { name: 'owner', kind: ReferenceKind.MANY_TO_ONE, type: 'Owner', targetMeta: owner },
    ]);
    const stats = registryOver([owner, widget]).getSnapshot().stats;
    expect(stats).toEqual({ types: 2, properties: 3, relations: 1, enrichedTypes: 0 });
  });

  it('sorts by group and then by display name', () => {
    const registry = registryOver(
      [
        entity('Zulu', [scalar('id')]),
        entity('Alpha', [scalar('id')]),
        entity('Mike', [scalar('id')]),
      ],
      { defaultGroup: 'Ops' },
    );
    expect(registry.getSnapshot().types.map((type) => type.name)).toEqual([
      'Alpha',
      'Mike',
      'Zulu',
    ]);
  });

  it('falls back to the configured default group', () => {
    const registry = registryOver([entity('Widget', [scalar('id')])], {
      defaultGroup: 'Logistics',
    });
    expect(registry.getSnapshot().types[0]?.group).toBe('Logistics');
  });

  it('finds a type however it is cased, because a URL segment is not a class name', () => {
    const registry = registryOver([entity('WorkOrder', [scalar('id')])]);
    expect(registry.getType('workorder')?.name).toBe('WorkOrder');
    expect(registry.getType('WORKORDER')?.name).toBe('WorkOrder');
    expect(registry.getType('nope')).toBeUndefined();
  });
});

describe('the overlay', () => {
  let registry: MikroOrmCatalogRegistry;

  beforeEach(() => {
    registry = registryOver([entity('WorkOrder', [scalar('id'), scalar('acftSn')])]);
  });

  it('renames a type without touching the database', async () => {
    const patched = await registry.patchType('WorkOrder', {
      displayName: 'Work Order',
      group: 'Maintenance',
    });
    expect(patched?.displayName).toBe('Work Order');
    expect(patched?.group).toBe('Maintenance');
    // Derived from the new display name, not the old one.
    expect(patched?.pluralDisplayName).toBe('Work Orders');
    expect(patched?.enriched).toBe(true);
  });

  // Property overlays are written through patchProperty. A type patch that
  // spread its whole payload would wipe every column label somebody had fixed.
  it('does not let a type patch clobber the property overlay', async () => {
    await registry.patchProperty('WorkOrder', 'acftSn', { displayName: 'Aircraft Serial' });
    await registry.patchType('WorkOrder', {
      displayName: 'Work Order',
      properties: { acftSn: { displayName: 'Wiped' } },
    });
    const property = registry.getType('WorkOrder')?.properties.find((p) => p.name === 'acftSn');
    expect(property?.displayName).toBe('Aircraft Serial');
  });

  it('merges successive patches rather than replacing them', async () => {
    await registry.patchProperty('WorkOrder', 'acftSn', { displayName: 'Aircraft Serial' });
    await registry.patchProperty('WorkOrder', 'acftSn', { unit: 'serial' });
    const property = registry.getType('WorkOrder')?.properties.find((p) => p.name === 'acftSn');
    expect(property?.displayName).toBe('Aircraft Serial');
    expect(property?.unit).toBe('serial');
  });

  // A patch against a column that does not exist would sit in the overlay
  // forever, invisible, and read as a rename that quietly did nothing.
  it('refuses a patch against a property nobody has', async () => {
    await expect(
      registry.patchProperty('WorkOrder', 'noSuchColumn', { hidden: true }),
    ).resolves.toBeUndefined();
  });

  it('refuses a patch against a type nobody has', async () => {
    await expect(registry.patchType('NoSuchType', { displayName: 'x' })).resolves.toBeUndefined();
    await expect(
      registry.patchProperty('NoSuchType', 'id', { hidden: true }),
    ).resolves.toBeUndefined();
  });

  it('accepts a patch against a relation, which is a property to whoever is looking', async () => {
    const owner = entity('Owner', [scalar('id')]);
    const widget = entity('Widget', [
      scalar('id'),
      { name: 'owner', kind: ReferenceKind.MANY_TO_ONE, type: 'Owner', targetMeta: owner },
    ]);
    const withRelations = registryOver([owner, widget]);
    const patched = await withRelations.patchProperty('Widget', 'owner', {
      displayName: 'Owned by',
    });
    expect(patched?.relations[0]?.displayName).toBe('Owned by');
  });

  it('reorders properties by the order the overlay gives them', async () => {
    await registry.patchProperty('WorkOrder', 'acftSn', { order: -1 });
    expect(registry.getType('WorkOrder')?.properties.map((p) => p.name)).toEqual(['acftSn', 'id']);
  });

  it('puts everything back where it started', async () => {
    await registry.patchType('WorkOrder', { displayName: 'Work Order' });
    await registry.resetOverlay();
    const type = registry.getType('WorkOrder');
    expect(type?.displayName).toBe('Work Order');
    // Derived again, not remembered: the humanised guess happens to match here,
    // so the honest assertion is that nothing is left marked as enriched.
    expect(type?.enriched).toBe(false);
  });

  it('persists through the store it was given, so a restart keeps the edits', async () => {
    const store = new InMemoryCatalogOverlayStore();
    const first = new MikroOrmCatalogRegistry(
      ormOver([entity('WorkOrder', [scalar('id')])]),
      {},
      store,
    );
    await first.patchType('WorkOrder', { displayName: 'Work Order' });

    const second = new MikroOrmCatalogRegistry(
      ormOver([entity('WorkOrder', [scalar('id')])]),
      {},
      store,
    );
    await second.onModuleInit();
    expect(second.getType('WorkOrder')?.displayName).toBe('Work Order');
  });

  it('bumps the snapshot version on every rebuild, so a cache can tell', async () => {
    const before = registry.getSnapshot().version;
    await registry.patchType('WorkOrder', { displayName: 'Work Order' });
    expect(registry.getSnapshot().version).toBeGreaterThan(before);
  });
});
