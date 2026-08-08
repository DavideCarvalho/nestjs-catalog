import type { CatalogObjectTypeDef, CatalogPrincipal } from '@dudousxd/nestjs-catalog';
import { ObjectTypeRow, relationsOf } from '@dudousxd/nestjs-catalog-store-mikro-orm';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { PublishService } from './publish.service';
import { refuseUnusableRelations } from './relation-shape';

/**
 * That a link which cannot mean anything is refused where it is typed.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every field of a relation was accepted verbatim. A relation drives no DDL and
 * is never joined on, so nothing downstream ever failed over one — which sounds
 * harmless until you notice what each wrong shape *renders* as. Measured against
 * a running catalog before the refusal existed, all eight of these were stored
 * and answered 200: a `targetType` of `"NoSuchType"`, a `localKey` naming
 * nothing, a `1:m` claiming `owner: true`, `"kind": "sometimes"`, a duplicate
 * name, an empty name, and `{ "name": "sparse" }` with no kind and no target at
 * all. The kind came back out of the read as `m:1`, so the graph drew a
 * many-to-one arrow for a relation whose kind was a word.
 *
 * These go through `upsertType` rather than `refuseUnusableRelations` directly,
 * for the reason `publish.relations.spec.ts` states about the wire: the rule has
 * its own unit tests at the bottom of this file, but a refusal is only worth
 * anything from the end somebody actually calls, and *when* it fires — before
 * anything is created — is half of what is being asserted.
 */

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

const PRINCIPAL: CatalogPrincipal = {
  id: 'fleet-app',
  scopes: ['catalog:write'],
  writeTypes: ['*'],
};

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

const ID_COLUMN = { name: 'id', type: 'string', primary: true };

interface Rig {
  service: PublishService;
  created: () => ObjectTypeRow[];
  /** The row this publish wrote through, or a failure saying it wrote none. */
  row: () => ObjectTypeRow;
  flushed: () => number;
  ensured: () => number;
}

/** The same shape `publish.relations.spec.ts` builds, plus a count of the writes. */
function rig(existing?: ObjectTypeRow): Rig {
  const created: ObjectTypeRow[] = [];
  let flushes = 0;
  let ensures = 0;

  const em = Object.assign(Object.create(null), {
    findOne: () => Promise.resolve(existing ?? null),
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

  const service = new PublishService(
    () => Object.assign(Object.create(null), { fork: () => em }),
    { reload: () => Promise.resolve(), getType: () => DEF },
    Object.assign(Object.create(null), {
      ensureType: () => {
        ensures += 1;
        return Promise.resolve();
      },
    }),
  );

  return {
    service,
    created: () => created,
    row: () => {
      const row = created[0];
      if (!row) throw new Error('The publish created no object type row.');
      return row;
    },
    flushed: () => flushes,
    ensured: () => ensures,
  };
}

/** A publish of `Mvr` carrying exactly these links. */
function publish(service: PublishService, relations: unknown) {
  return service.upsertType(PRINCIPAL, {
    name: 'Mvr',
    properties: [ID_COLUMN],
    // The payload is an HTTP body; the wire type describes what a caller should
    // send, which is the thing under test.
    relations: Object.assign([], relations),
  });
}

/** The refusal's own words, so a test can assert on what the publisher is told. */
async function refusalOf(service: PublishService, relations: unknown): Promise<string> {
  try {
    await publish(service, relations);
  } catch (error) {
    if (error instanceof BadRequestException) return error.message;
    throw error;
  }
  throw new Error('The publish was accepted.');
}

describe('a link that cannot mean anything', () => {
  it('is refused for a kind that is not one of the four, because the read would guess `m:1`', async () => {
    // The sharpest of the set. An unrecognised kind is narrowed to `m:1` on the
    // way back out, so this used to publish cleanly and then be drawn with an
    // arrowhead nobody chose — a wrong picture with nothing anywhere reporting
    // that anything went wrong.
    const { service } = rig();

    const message = await refusalOf(service, [
      { name: 'base', kind: 'sometimes', targetType: 'Base' },
    ]);

    expect(message).toContain('"sometimes"');
    expect(message).toContain('`m:1`');
  });

  it('is refused for a `1:m` that claims to own the key', async () => {
    // `owner` is what the graph reads to decide which end an edge is drawn
    // from, and the one end of a one-to-many never holds the column. Both ends
    // claiming it points the arrow at whichever type was loaded first.
    const { service } = rig();

    const message = await refusalOf(service, [
      { name: 'subWorkOrders', kind: '1:m', targetType: 'Subwo', owner: true },
    ]);

    expect(message).toContain('`1:m`');
    expect(message).toContain('owner');
  });

  it('is refused for a second link under a name the type already used', async () => {
    // Every consumer keys on the name — the merge, the edge id, the React list —
    // so two rows under one name are one link with the loser silently dropped.
    const { service } = rig();

    const message = await refusalOf(service, [
      { name: 'base', kind: 'm:1', targetType: 'Base' },
      { name: 'base', kind: '1:1', targetType: 'Depot' },
    ]);

    expect(message).toContain('second link called `base`');
  });

  it('is refused for a link with no name, and says which position it was', async () => {
    // The name cannot be the handle in a message about a missing name, which is
    // why the refusal is positional as well.
    const { service } = rig();

    const message = await refusalOf(service, [
      { name: 'base', kind: 'm:1', targetType: 'Base' },
      { name: '', kind: 'm:1', targetType: 'Depot' },
    ]);

    expect(message).toContain('relations[1]');
  });

  it('is refused for a link that never says what it points at', async () => {
    const { service } = rig();

    const message = await refusalOf(service, [{ name: 'sparse' }]);

    expect(message).toContain('`targetType`');
  });

  it('names every problem at once, not the first', async () => {
    // A publisher that has misunderstood the model has misunderstood it for
    // every link in the payload, and one refusal per round trip turns a
    // five-minute fix into an afternoon.
    const { service } = rig();

    const message = await refusalOf(service, [
      { name: 'a', kind: 'sometimes', targetType: 'Base' },
      { name: 'b', kind: '1:m', targetType: 'Depot', owner: true },
      { name: '', kind: 'm:1', targetType: 'Wing' },
    ]);

    expect(message).toContain('relations[0]');
    expect(message).toContain('relations[1]');
    expect(message).toContain('relations[2]');
  });

  it('refuses before anything is created, flushed or given a table', async () => {
    // The ordering is the point, and it is the same one
    // `publish.property-names.spec.ts` makes: the properties in the payload go
    // down in the same call, so a refusal that landed after the flush would
    // leave a type half-published over a link.
    const { service, created, flushed, ensured } = rig();

    await expect(publish(service, [{ name: 'base', kind: 'sometimes' }])).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(created()).toEqual([]);
    expect(flushed()).toBe(0);
    expect(ensured()).toBe(0);
  });
});

describe('what the refusal deliberately lets through', () => {
  it('accepts a target this catalog does not hold, because that is a reported state', async () => {
    // `targetPublished: false` exists to carry exactly this, the graph already
    // omits the edge rather than promising a node nobody can open, and FlowView's
    // cross-publisher lane treats it as its sharpest signal. Refusing it would
    // also make publishing order load-bearing: of two types that point at each
    // other, whichever went first would be refused for naming a type that does
    // not exist yet.
    const { service, row } = rig();

    await publish(service, [{ name: 'base', kind: 'm:1', targetType: 'NotPublishedAnywhere' }]);

    expect(relationsOf(row())).toEqual([
      expect.objectContaining({ targetType: 'NotPublishedAnywhere' }),
    ]);
  });

  it('accepts a `localKey` that is not a property, because the ORM puts a column there', async () => {
    // The rule that looks most obviously checkable and would have broken the
    // most. `CatalogRelationDef.localKey` is documented as a property name, but
    // `MikroOrmCatalogRegistry` fills it from `prop.fieldNames[0]` — so a
    // `@ManyToOne` called `base` reports `base_id`, which is not a property of
    // that type and never will be. Publishing a derived `CatalogRelationDef[]`
    // verbatim is a documented case; refusing this would refuse it.
    const { service, row } = rig();

    await publish(service, [
      { name: 'base', kind: 'm:1', targetType: 'Base', localKey: 'base_id', owner: true },
    ]);

    expect(relationsOf(row())).toEqual([
      expect.objectContaining({ localKey: 'base_id', owner: true }),
    ]);
  });

  it('accepts a link with no `localKey` at all', async () => {
    // An `m:n` through a join table legitimately has none, and a derived
    // relation may simply not expose one.
    const { service, row } = rig();

    await publish(service, [{ name: 'tags', kind: 'm:n', targetType: 'Tag' }]);

    expect(relationsOf(row())).toHaveLength(1);
  });

  it('says nothing about a publisher that sends no links', async () => {
    const { service, row } = rig();

    await service.upsertType(PRINCIPAL, { name: 'Mvr', properties: [ID_COLUMN] });

    expect(relationsOf(row())).toEqual([]);
  });
});

describe('the rule on its own', () => {
  it('is quiet about an empty list, which is a publisher saying there are none', () => {
    expect(refuseUnusableRelations('Mvr', [])).toBeUndefined();
  });

  it('accepts all four kinds, read off the one list rather than a copy of it', () => {
    const relations = (['1:1', '1:m', 'm:1', 'm:n'] as const).map((kind, index) => ({
      name: `link${index}`,
      kind,
      targetType: 'Base',
    }));

    expect(refuseUnusableRelations('Mvr', relations)).toBeUndefined();
  });

  it('names the type it refused, since a publisher sends several', () => {
    const refusal = refuseUnusableRelations('Subwo', [
      { name: 'wo', kind: 'nonsense', targetType: 'Wo' },
    ]);

    expect(refusal).toContain('Subwo was not published');
  });
});
