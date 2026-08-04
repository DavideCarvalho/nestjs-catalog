import type { MikroORM } from '@mikro-orm/core';
/**
 * That the persisted catalog has links, which is the difference between an
 * ontology and a list of tables.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The library registry has read relations off the ORM since the beginning. The
 * stored registry — the one a real deployment runs, because it serves types that
 * arrived over the wire from applications whose entity classes are not here —
 * answered `relations: []`, `stats.relations: 0` and `edges: []`, hardcoded. So
 * `Mvr` and `Base` both existed in the catalog and nothing recorded that an MVR
 * belongs to a base. The graph drew nodes and no lines, and the type page said,
 * in as many words, that nothing linked to or from anything.
 *
 * Nothing here is derivable and nothing ever will be: there are no foreign keys
 * in the warehouse, every published type lands as a flat snapshot, and a
 * `base_id` column beside a type called `Base` is a strong hint and a bad edge.
 * So these tests are about a link arriving, surviving a re-publish, and being
 * drawn once.
 */
import type { EntityManager } from '@mikro-orm/mysql';
import { describe, expect, it, vi } from 'vitest';
import { SnapshotRow } from './entities/governance';
import {
  ObjectTypeRow,
  PropertyRow,
  type PublishedRelation,
  type StoredRelation,
  relationsOf,
} from './entities/model';
import { StoredCatalogRegistry } from './stored-registry.service';

function relation(fields: Partial<StoredRelation> & Pick<StoredRelation, 'name'>): StoredRelation {
  return {
    kind: 'm:1',
    targetType: 'Base',
    displayName: fields.name,
    nullable: true,
    hidden: false,
    position: 0,
    owner: true,
    ...fields,
  };
}

/**
 * An `ObjectTypeRow` as MikroORM would hand one back — a real prototype, so the
 * entity's own `mergeRelations` is under test rather than a copy of it.
 */
function typeRow(name: string, relations?: StoredRelation[]): ObjectTypeRow {
  const row = Object.create(ObjectTypeRow.prototype);
  return Object.assign(row, {
    name,
    displayName: name,
    pluralDisplayName: `${name}s`,
    physicalTable: name.toLowerCase(),
    group: 'default',
    primaryKey: ['id'],
    properties: { getItems: () => [] },
    relations,
  });
}

/**
 * An EntityManager over a fixed set of type rows.
 *
 * `findOne(PropertyRow)` always misses, because every property patch in this
 * file is aimed at a relation — which is exactly the path that used to 404.
 */
function emOver(types: ObjectTypeRow[]) {
  const flush = vi.fn(async () => undefined);
  const fork = () => ({
    find: async (entity: unknown) => {
      if (entity === ObjectTypeRow) return types;
      if (entity === SnapshotRow) return [];
      throw new Error('unexpected entity in reload');
    },
    findOne: async (entity: unknown, where: Record<string, unknown>) => {
      if (entity === PropertyRow) return null;
      if (entity === ObjectTypeRow) return types.find((row) => row.name === where.name) ?? null;
      throw new Error('unexpected entity in findOne');
    },
    flush,
  });
  return { em: { fork }, flush };
}

function registryOver(types: ObjectTypeRow[]) {
  const { em, flush } = emOver(types);
  const registry = Object.create(StoredCatalogRegistry.prototype);
  Object.assign(registry, {
    em,
    orm: {} as MikroORM,
    options: {},
    snapshot: { version: 0, generatedAt: '', stats: {}, types: [] },
  });
  return { registry: registry as StoredCatalogRegistry, flush };
}

/** `Mvr` pointing at `Base`, both published, as one foreign key from one app. */
function fleet(options: { linked?: boolean; base?: boolean } = {}) {
  const rows = [
    typeRow('Mvr', [
      relation({
        name: 'base',
        targetType: 'Base',
        localKey: 'base_id',
        ...(options.linked ? { inverseName: 'mvrs' } : {}),
      }),
    ]),
  ];
  if (options.base !== false) {
    rows.unshift(
      typeRow(
        'Base',
        options.linked
          ? [
              relation({
                name: 'mvrs',
                kind: '1:m',
                targetType: 'Mvr',
                owner: false,
                inverseName: 'base',
              }),
            ]
          : [],
      ),
    );
  }
  return rows;
}

describe('a published link reaches the type', () => {
  it('serves the relations stored on the row', async () => {
    // Hardcoded `relations: []` until this existed, so a link that had been
    // published, stored and read back still vanished on the way out.
    const { registry } = registryOver(fleet());
    await registry.reload();

    expect(registry.getType('Mvr')?.relations).toEqual([
      expect.objectContaining({
        name: 'base',
        kind: 'm:1',
        targetType: 'Base',
        localKey: 'base_id',
        owner: true,
        targetPublished: true,
      }),
    ]);
  });

  it('counts them in the snapshot stats', async () => {
    // The header on the catalog screen reads this, and the boot line prints it
    // — a wire that stops carrying links shows up as a zero here and nowhere
    // else until somebody opens the graph and finds it bare.
    const { registry } = registryOver(fleet({ linked: true }));
    await registry.reload();

    expect(registry.getSnapshot().stats.relations).toBe(2);
  });

  it('orders them by the stored position rather than by insertion', async () => {
    const { registry } = registryOver([
      typeRow('Mvr', [
        relation({ name: 'assignedBase', position: 2 }),
        relation({ name: 'homeBase', position: 1 }),
      ]),
    ]);
    await registry.reload();

    expect(registry.getType('Mvr')?.relations.map((r) => r.name)).toEqual([
      'homeBase',
      'assignedBase',
    ]);
  });

  it('narrows a kind it does not recognise instead of refusing to load', async () => {
    // What comes out of a JSON column is whatever some earlier version of some
    // publisher put in. The kind decides an arrowhead; refusing the whole
    // catalog over one bad row would take the other two hundred types down with
    // it.
    const { registry } = registryOver([typeRow('Mvr', [relation({ name: 'base', kind: 'wat' })])]);
    await registry.reload();

    expect(registry.getType('Mvr')?.relations[0]?.kind).toBe('m:1');
  });

  it('survives a row written before the column existed', async () => {
    // The field initialiser only runs for rows this process constructs; a row
    // hydrated from a database that predates the column holds NULL, and every
    // `.map` over it throws — taking down the first boot after this shipped,
    // which is the boot nobody is watching for a relations bug.
    const { registry } = registryOver([typeRow('Mvr', undefined)]);

    await expect(registry.reload()).resolves.toBeUndefined();
    expect(registry.getType('Mvr')?.relations).toEqual([]);
  });
});

describe('a link whose other end nobody published', () => {
  it('keeps the relation and marks the target unpublished', async () => {
    // Two publishers, one of them switched off. That `Mvr` points at something
    // called `Base` is still true, and it is the most useful thing to know.
    const { registry } = registryOver(fleet({ base: false }));
    await registry.reload();

    expect(registry.getType('Mvr')?.relations[0]).toMatchObject({
      targetType: 'Base',
      targetPublished: false,
    });
  });

  it('draws no edge for it', async () => {
    const { registry } = registryOver(fleet({ base: false }));
    await registry.reload();

    expect(registry.getGraph().edges).toEqual([]);
  });
});

describe('the graph', () => {
  it('draws an edge per link', async () => {
    // `edges: []` was hardcoded, so the graph screen showed every published type
    // floating unattached however many links had been published.
    const { registry } = registryOver(fleet());
    await registry.reload();

    expect(registry.getGraph().edges).toEqual([
      { id: 'Mvr.base', source: 'Mvr', target: 'Base', label: 'base', kind: 'm:1' },
    ]);
  });

  it('draws one edge for a link published from both ends', async () => {
    // Two rows, one foreign key. `Base` sorts first and is read first, so the
    // pairing cannot depend on which arrives first either.
    const { registry } = registryOver(fleet({ linked: true }));
    await registry.reload();

    const edges = registry.getGraph().edges;
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ id: 'Mvr.base', source: 'Mvr', target: 'Base' });
  });

  it('reports how many links a node has', async () => {
    // `relationCount: 0` was hardcoded beside the empty edge list, so even a
    // renderer that ignored edges could not tell a linked type from a loose one.
    const { registry } = registryOver(fleet());
    await registry.reload();

    const byId = new Map(registry.getGraph().nodes.map((node) => [node.id, node]));
    expect(byId.get('Mvr')?.relationCount).toBe(1);
    expect(byId.get('Base')?.relationCount).toBe(0);
  });
});

describe('naming a link', () => {
  it('renames it through the property route, with no new endpoint', async () => {
    // A relation is a property to whoever is looking. The console sends
    // `PATCH .../properties/base` without knowing whether `base` is a column or
    // a link, and this path used to answer 404 for every link.
    const rows = fleet();
    const { registry, flush } = registryOver(rows);
    await registry.reload();

    const patched = await registry.patchProperty('Mvr', 'base', { displayName: 'Home base' });

    expect(patched?.relations[0]?.displayName).toBe('Home base');
    expect(flush).toHaveBeenCalled();
  });

  it('marks a described link as enrichment of its type', async () => {
    const rows = fleet();
    const { registry } = registryOver(rows);
    await registry.reload();

    const patched = await registry.patchProperty('Mvr', 'base', {
      description: 'Where the vehicle lives.',
    });

    expect(patched?.relations[0]?.enriched).toBe(true);
    expect(patched?.enriched).toBe(true);
  });

  it('hides and reorders a link', async () => {
    const { registry } = registryOver(fleet());
    await registry.reload();

    const patched = await registry.patchProperty('Mvr', 'base', { hidden: true, order: 7 });

    expect(patched?.relations[0]).toMatchObject({ hidden: true, order: 7 });
  });

  it('still refuses a field that is neither a column nor a link', async () => {
    // The 404 has to survive: a patch against a name nobody has is a typo, and
    // answering 200 to it would make the console report a rename that never
    // happened.
    const { registry } = registryOver(fleet());
    await registry.reload();

    await expect(registry.patchProperty('Mvr', 'nope', { displayName: 'x' })).resolves.toBe(
      undefined,
    );
  });

  it('replaces the array rather than editing the object in it', async () => {
    // MikroORM diffs a JSON property against the snapshot taken at load. Editing
    // the object it already holds leaves the flush with nothing to write, and
    // the rename appears to work until the next reload.
    const rows = fleet();
    const before = relationsOf(rows[1] as ObjectTypeRow);
    const { registry } = registryOver(rows);
    await registry.reload();

    await registry.patchProperty('Mvr', 'base', { displayName: 'Home base' });

    expect(relationsOf(rows[1] as ObjectTypeRow)).not.toBe(before);
  });
});

describe('what a re-publish does to a curated link', () => {
  // Carries a `displayName`, because a real publisher always does: the library
  // registry derives one from the property name before it sends anything, so a
  // fixture that omitted it would make "curator wins" and "publisher wins"
  // behave identically and test neither. Found by mutation.
  const published = (fields: Partial<PublishedRelation> = {}): PublishedRelation => ({
    name: 'base',
    kind: 'm:1',
    targetType: 'Base',
    displayName: 'Base',
    localKey: 'base_id',
    ...fields,
  });

  it('keeps the label a curator wrote over the one the publisher sends', async () => {
    // The publishing application redeploys constantly and re-publishes its whole
    // shape each time, label and all. Following it unconditionally would reset
    // every name a human chose, which is the whole reason curating is worth
    // doing.
    const row = typeRow('Mvr', [relation({ name: 'base', displayName: 'Home base' })]);

    row.mergeRelations([published()]);

    expect(relationsOf(row)[0]?.displayName).toBe('Home base');
  });

  it('follows the publisher on the structure', async () => {
    // The other half, and the one that must not be curator-owned: a stale copy
    // of a join column is a link that no longer exists.
    const row = typeRow('Mvr', [
      relation({ name: 'base', displayName: 'Home base', localKey: 'base_id', kind: 'm:1' }),
    ]);

    row.mergeRelations([published({ localKey: 'home_base_id', kind: '1:1', owner: true })]);

    expect(relationsOf(row)[0]).toMatchObject({
      displayName: 'Home base',
      localKey: 'home_base_id',
      kind: '1:1',
    });
  });

  it('drops a link the publisher stopped sending', async () => {
    // Unlike a property, which may still hold data in the warehouse. A link
    // holds nothing, and keeping one the schema no longer has means the ontology
    // asserts a join that will fail.
    const row = typeRow('Mvr', [
      relation({ name: 'base' }),
      relation({ name: 'retiredLink', targetType: 'Gone' }),
    ]);

    row.mergeRelations([published()]);

    expect(relationsOf(row).map((r) => r.name)).toEqual(['base']);
  });

  it('names a link the publisher did not name', async () => {
    // The property name, which is at least true, rather than an empty label a
    // screen would render as a blank row.
    const row = typeRow('Mvr', []);

    row.mergeRelations([{ name: 'base', kind: 'm:1', targetType: 'Base' }]);

    expect(relationsOf(row)[0]?.displayName).toBe('base');
  });

  it('leaves no key behind for a field nobody set', async () => {
    // These rows are serialised into a JSON column, and `"localKey": null`
    // sitting in the database reads as a decision somebody made.
    const row = typeRow('Mvr', []);

    row.mergeRelations([{ name: 'base', kind: 'm:1', targetType: 'Base' }]);

    expect('localKey' in (relationsOf(row)[0] ?? {})).toBe(false);
    expect('description' in (relationsOf(row)[0] ?? {})).toBe(false);
  });

  it('merges into a row that predates the column', async () => {
    const row = typeRow('Mvr', undefined);

    row.mergeRelations([published()]);

    expect(relationsOf(row).map((r) => r.name)).toEqual(['base']);
  });
});
