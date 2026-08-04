import type {
  CatalogAuditEvent,
  CatalogObjectTypeDef,
  CatalogPipelineStore,
  CatalogPromotableSet,
  PromotableObjectType,
} from '@dudousxd/nestjs-catalog';
import { planPromotion } from '@dudousxd/nestjs-catalog';
import { describe, expect, it, vi } from 'vitest';
import { ObjectTypeRow, type StoredRelation, relationsOf } from './entities/model';
import type { CatalogEnvironmentBundle } from './environment.bundle';
import { type PromotionTarget, applyPromotion, readPromotable } from './environment.promotion';

/**
 * That a type promoted between environments arrives with its links.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `toPromotableType` read the row's properties and not its relations, and the
 * apply path had nothing to assign, so a type released into production arrived
 * complete in every visible way — right properties, right table, right owner —
 * and sat in that environment's graph as an island. Nothing errored and nothing
 * was reported, because the plan could not see the difference either.
 *
 * Against stubs, not MySQL, and deliberately: see `PromotionTarget`'s docblock.
 * The rows here are built on the real `ObjectTypeRow` prototype, so the entity's
 * own `relations` column and `relationsOf` are what is under test rather than a
 * copy of them — and, since `Object.create` never runs a field initialiser, the
 * rows arrive exactly as MikroORM hands back a row written before the column
 * existed.
 */

function relation(fields: Partial<StoredRelation> & Pick<StoredRelation, 'name'>): StoredRelation {
  return {
    kind: 'm:1',
    targetType: 'Base',
    displayName: fields.name,
    localKey: `${fields.name}_id`,
    nullable: true,
    hidden: false,
    position: 0,
    owner: true,
    ...fields,
  };
}

function typeRow(name: string, relations?: StoredRelation[]): ObjectTypeRow {
  const row = Object.create(ObjectTypeRow.prototype);
  return Object.assign(row, {
    name,
    ownerPrincipalId: 'fleet-app',
    displayName: name,
    pluralDisplayName: `${name}s`,
    group: 'Fleet',
    primaryKey: ['id'],
    physicalTable: `obj_${name.toLowerCase()}`,
    properties: { getItems: () => [] },
    relations,
  });
}

/**
 * A bundle that answers the four reads `readPromotable` makes and nothing else.
 *
 * No `listWorkflows`/`getWorkflow`/`saveWorkflow`, so `supportsWorkflows` narrows
 * to false and the workflow read is skipped — which is what keeps this stub to
 * four methods instead of the whole pipeline interface.
 */
function bundleOver(rows: ObjectTypeRow[]): CatalogEnvironmentBundle {
  const bundle = Object.create(null);
  return Object.assign(bundle, {
    em: {
      fork: () => ({
        find: (entity: unknown) => {
          if (entity !== ObjectTypeRow) {
            throw new Error('readPromotable is not expected to read anything else here.');
          }
          return Promise.resolve(rows);
        },
      }),
    },
    pipeline: {
      listTransforms: () => Promise.resolve([]),
      listConnectors: () => Promise.resolve([]),
      listConnections: () => Promise.resolve([]),
    },
  });
}

describe('reading one environment', () => {
  it('carries the links off the row', async () => {
    // `relations` was absent from the promotable shape, so every link stopped
    // here — at the first of the three places this had to be carried.
    const set = await readPromotable(bundleOver([typeRow('Mvr', [relation({ name: 'base' })])]));

    expect(set.objectTypes[0]?.relations).toEqual([
      expect.objectContaining({ name: 'base', kind: 'm:1', targetType: 'Base', owner: true }),
    ]);
  });

  it('orders them by the stored position rather than by however they were written', async () => {
    // Two environments holding the same links in a different stored order must
    // not read as a difference, because the diff compares the lists.
    const set = await readPromotable(
      bundleOver([
        typeRow('Mvr', [
          relation({ name: 'assignedBase', position: 2 }),
          relation({ name: 'homeBase', position: 1 }),
        ]),
      ]),
    );

    expect(set.objectTypes[0]?.relations?.map((r) => r.name)).toEqual(['homeBase', 'assignedBase']);
  });

  it('sorts a copy, leaving the row’s own array untouched', async () => {
    // The array is the entity's JSON value and MikroORM is tracking it. Sorting
    // in place would reorder what it compares against at flush time, in a
    // function whose whole contract is that it reads and writes nothing.
    const row = typeRow('Mvr', [
      relation({ name: 'assignedBase', position: 2 }),
      relation({ name: 'homeBase', position: 1 }),
    ]);
    const before = relationsOf(row).map((r) => r.name);

    await readPromotable(bundleOver([row]));

    expect(relationsOf(row).map((r) => r.name)).toEqual(before);
  });

  it('hands out copies, so the two environments never share a link object', async () => {
    const row = typeRow('Mvr', [relation({ name: 'base' })]);

    const set = await readPromotable(bundleOver([row]));

    expect(set.objectTypes[0]?.relations?.[0]).not.toBe(relationsOf(row)[0]);
  });

  it('reads a row written before the column existed as holding no links', async () => {
    // Hydrated from a database that predates the column, `relations` is NULL and
    // every `.map` over it throws — taking down the promotion preview for every
    // type in the environment, not just this one.
    const set = await readPromotable(bundleOver([typeRow('Mvr', undefined)]));

    expect(set.objectTypes[0]?.relations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The apply half.
// ---------------------------------------------------------------------------

const DEF: CatalogObjectTypeDef = {
  name: 'Mvr',
  displayName: 'Mvr',
  pluralDisplayName: 'Mvrs',
  group: 'Fleet',
  tableName: 'obj_mvr',
  primaryKey: ['id'],
  enriched: false,
  properties: [],
  relations: [],
};

function promotable(relations?: PromotableObjectType['relations']): PromotableObjectType {
  return {
    name: 'Mvr',
    ownerPrincipalId: 'fleet-app',
    displayName: 'Mvr',
    pluralDisplayName: 'Mvrs',
    group: 'Fleet',
    primaryKey: ['id'],
    properties: [],
    ...(relations === undefined ? {} : { relations }),
  };
}

function set(type: PromotableObjectType): CatalogPromotableSet {
  return {
    objectTypes: [type],
    transforms: [],
    workflows: [],
    connectors: [],
    connections: [],
  };
}

interface Rig {
  target: PromotionTarget;
  recorded: Array<Omit<CatalogAuditEvent, 'id'>>;
  /** Rows the apply built from scratch, in creation order. */
  created: ObjectTypeRow[];
  flushed: () => number;
}

/**
 * A target whose EntityManager is one stub over one row.
 *
 * `fork()` is declared to return an `EntityManager`, and this returns an object
 * with the four members `promoteType` touches — built through `Object.assign`
 * onto a bare object rather than asserted into place, so the day a fifth member
 * is called this fails on the missing method instead of compiling around it.
 */
function rig(existing: ObjectTypeRow | undefined): Rig {
  const recorded: Array<Omit<CatalogAuditEvent, 'id'>> = [];
  const created: ObjectTypeRow[] = [];
  let flushes = 0;
  const em = Object.assign(Object.create(null), {
    findOne: (entity: unknown, where: { name?: string }) => {
      if (entity !== ObjectTypeRow) {
        throw new Error('promoteType is not expected to read anything else here.');
      }
      return Promise.resolve(existing?.name === where.name ? existing : null);
    },
    create: (entity: { prototype: object }, data: Record<string, unknown>) => {
      const row = Object.assign(Object.create(entity.prototype), data);
      if (entity === ObjectTypeRow) created.push(row);
      return row;
    },
    persist: () => undefined,
    flush: () => {
      flushes += 1;
      return Promise.resolve();
    },
  });

  // Reached only if a phase after the model starts doing something. The plans
  // below carry object types alone, so any call here is a bug.
  const pipeline: CatalogPipelineStore = Object.assign(Object.create(null), {
    listTransforms: () => Promise.reject(new Error('unexpected pipeline read')),
  });

  return {
    recorded,
    created,
    flushed: () => flushes,
    target: {
      environment: { id: 'production' },
      em: { fork: () => em },
      registry: { reload: vi.fn(() => Promise.resolve()), getType: () => DEF },
      store: { ensureType: vi.fn(() => Promise.resolve()) },
      pipeline,
      workspace: {
        recordEvent: (event: Omit<CatalogAuditEvent, 'id'>) => {
          recorded.push(event);
          return Promise.resolve();
        },
      },
    },
  };
}

/** The plan, computed from the two sets the way a real promotion computes it. */
function planFor(source: PromotableObjectType, target: PromotableObjectType) {
  return planPromotion({
    from: 'dev',
    to: 'production',
    source: set(source),
    target: set(target),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
}

describe('applying into the other environment', () => {
  it('writes the source’s links onto a type that arrives for the first time', async () => {
    // The create path, which is the one a first release into an empty
    // environment takes — and the one where `em.create` names every field, so a
    // column nobody thought to pass is silently absent rather than wrong.
    const source = promotable([relation({ name: 'base', displayName: 'Home base' })]);
    const { target, created } = rig(undefined);

    await applyPromotion({
      source: set(source),
      target,
      plan: planFor(source, promotable([])),
      promotedBy: 'ana@example.com',
    });

    const [row] = created;
    if (!row) throw new Error('The apply created no object type row.');
    expect(relationsOf(row)).toEqual([
      expect.objectContaining({ name: 'base', displayName: 'Home base', localKey: 'base_id' }),
    ]);
  });

  it('carries the curation on a link, the way it carries every other label', async () => {
    // The difference between this path and a publish. A publish fills a label in
    // only when there is not one already, because the publishing application
    // redeploys constantly; a promotion is somebody deliberately releasing the
    // curation they did in dev, and the preview showed them the before and after.
    const row = typeRow('Mvr', [relation({ name: 'base', displayName: 'base' })]);
    const source = promotable([relation({ name: 'base', displayName: 'Home base' })]);
    const { target, flushed } = rig(row);

    await applyPromotion({
      source: set(source),
      target,
      plan: planFor(source, promotable([relation({ name: 'base', displayName: 'base' })])),
      promotedBy: 'ana@example.com',
    });

    expect(relationsOf(row)[0]?.displayName).toBe('Home base');
    expect(flushed()).toBe(1);
  });

  it('drops a link the source no longer has, rather than merging it forward', async () => {
    // ASSIGN, not merge. A link the source deliberately dropped surviving in the
    // target would mean the plan says `relations.removed` and the apply does not
    // remove it — the target asserting a join the schema no longer has, with an
    // approved plan on record saying otherwise. Safe in a way dropping a column
    // is not: a column may still hold rows, a link holds nothing.
    const row = typeRow('Mvr', [
      relation({ name: 'base' }),
      relation({ name: 'retired', targetType: 'Gone' }),
    ]);
    const source = promotable([relation({ name: 'base' })]);
    const { target } = rig(row);

    await applyPromotion({
      source: set(source),
      target,
      plan: planFor(
        source,
        promotable([relation({ name: 'base' }), relation({ name: 'retired', targetType: 'Gone' })]),
      ),
      promotedBy: 'ana@example.com',
    });

    expect(relationsOf(row).map((r) => r.name)).toEqual(['base']);
  });

  it('replaces the array rather than editing the one the row already holds', async () => {
    // MikroORM diffs a JSON property against the snapshot it took at load.
    // Editing the array in place can leave the flush with nothing to write, and
    // the promotion then reports success having changed nothing.
    const row = typeRow('Mvr', [relation({ name: 'base' })]);
    const before = relationsOf(row);
    const source = promotable([relation({ name: 'base', displayName: 'Home base' })]);
    const { target } = rig(row);

    await applyPromotion({
      source: set(source),
      target,
      plan: planFor(source, promotable([relation({ name: 'base' })])),
      promotedBy: 'ana@example.com',
    });

    expect(relationsOf(row)).not.toBe(before);
  });

  it('never lets the two environments share a link object', async () => {
    // The objects come out of the source environment's rows. Writing them
    // straight into the target's row would leave one JSON array aliased into two
    // databases' entities, where an edit to either shows up in both.
    const row = typeRow('Mvr', []);
    const source = promotable([relation({ name: 'base' })]);
    const { target } = rig(row);

    await applyPromotion({
      source: set(source),
      target,
      plan: planFor(source, promotable([])),
      promotedBy: 'ana@example.com',
    });

    expect(relationsOf(row)[0]).toEqual(expect.objectContaining({ name: 'base' }));
    expect(relationsOf(row)[0]).not.toBe(source.relations?.[0]);
  });

  it('leaves no key behind for a field the source never set', async () => {
    // These land in a JSON column, where `"localKey": null` reads as a decision
    // somebody made.
    const row = typeRow('Mvr', []);
    const source = promotable([
      {
        name: 'base',
        displayName: 'Base',
        kind: 'm:1',
        targetType: 'Base',
        nullable: true,
        hidden: false,
        position: 0,
        owner: true,
      },
    ]);
    const { target } = rig(row);

    await applyPromotion({
      source: set(source),
      target,
      plan: planFor(source, promotable([])),
      promotedBy: 'ana@example.com',
    });

    // Asserted first, so that "no key for localKey" cannot pass by there being
    // no link at all — which is exactly how this reads when the write is gone.
    expect(relationsOf(row)).toHaveLength(1);
    expect('localKey' in (relationsOf(row)[0] ?? {})).toBe(false);
    expect('inverseName' in (relationsOf(row)[0] ?? {})).toBe(false);
  });
});
