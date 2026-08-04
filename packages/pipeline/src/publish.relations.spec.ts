import type { CatalogObjectTypeDef, CatalogPrincipal } from '@dudousxd/nestjs-catalog';
import { InMemoryCatalogOverlayStore, MikroOrmCatalogRegistry } from '@dudousxd/nestjs-catalog';
import { ObjectTypeRow, relationsOf } from '@dudousxd/nestjs-catalog-store-mikro-orm';
import type { EntityProperty } from '@mikro-orm/core';
import { EntityMetadata, MetadataStorage, MikroORM, ReferenceKind } from '@mikro-orm/core';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { PublishService } from './publish.service';

/**
 * That a link a publisher describes actually lands in the catalog.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Relations shipped end to end — discovered from ORM metadata, stored as a
 * column on `ObjectTypeRow`, merged by a rule that knows what a publisher owns
 * and what a curator owns, served on the type and drawn in the graph — with
 * nothing writing the column. `PublishedType` had no `relations`, so the one
 * route an application publishes its shape through dropped every link on
 * arrival, silently, and the whole feature was inert in any deployment that had
 * not hand-edited the database.
 *
 * These go through `upsertType` rather than `mergeRelations`, deliberately. The
 * merge rule has its own tests next door; what was missing was the wire, and a
 * wire is only testable from the end somebody actually calls.
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

/** The one property every payload below carries; `upsertType` refuses a type with none. */
const ID_COLUMN = { name: 'id', type: 'string', primary: true };

/**
 * A row as MikroORM hands one back, on the real prototype so that
 * `mergeRelations` and `relationsOf` are the ones under test.
 *
 * `Object.create` runs no field initialiser, which is exactly how a row written
 * before the relations column existed arrives: `relations` undefined, not `[]`.
 */
function typeRow(relations?: unknown): ObjectTypeRow {
  const row = Object.create(ObjectTypeRow.prototype);
  return Object.assign(row, {
    name: 'Mvr',
    ownerPrincipalId: 'fleet-app',
    displayName: 'Mvr',
    pluralDisplayName: 'Mvrs',
    group: 'Fleet',
    primaryKey: ['id'],
    physicalTable: 'obj_mvr',
    properties: { getItems: () => [] },
    relations,
  });
}

interface Rig {
  service: PublishService;
  /** Whichever row the publish wrote through — the existing one, or the created one. */
  row: () => ObjectTypeRow;
  flushed: () => number;
}

/**
 * A publisher over one EntityManager stub and one row.
 *
 * The store arrives through `CATALOG_STORE`, whose declared type is the whole
 * write-store interface; this implements the one member the schema path touches
 * and nothing else, so a call this test is not expecting fails rather than being
 * quietly answered. Same for the EntityManager.
 */
function rig(existing?: ObjectTypeRow): Rig {
  const created: ObjectTypeRow[] = [];
  let flushes = 0;

  const em = Object.assign(Object.create(null), {
    findOne: (entity: unknown) => {
      if (entity !== ObjectTypeRow) {
        throw new Error('upsertType is not expected to read anything else here.');
      }
      return Promise.resolve(existing ?? null);
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

  const service = new PublishService(
    () => Object.assign(Object.create(null), { fork: () => em }),
    { reload: () => Promise.resolve(), getType: () => DEF },
    Object.assign(Object.create(null), { ensureType: () => Promise.resolve() }),
  );

  return {
    service,
    row: () => {
      const row = existing ?? created[0];
      if (!row) throw new Error('The publish neither read nor created an object type row.');
      return row;
    },
    flushed: () => flushes,
  };
}

describe('publishing a link', () => {
  it('writes it onto the type, which is what nothing did before', async () => {
    // `PublishedType` carried no `relations`, so a publisher could describe its
    // links perfectly and the catalog dropped every one of them at the door.
    const { service, row, flushed } = rig();

    await service.upsertType(PRINCIPAL, {
      name: 'Mvr',
      properties: [ID_COLUMN],
      relations: [{ name: 'base', kind: 'm:1', targetType: 'Base', localKey: 'base_id' }],
    });

    expect(relationsOf(row())).toEqual([
      expect.objectContaining({
        name: 'base',
        kind: 'm:1',
        targetType: 'Base',
        localKey: 'base_id',
      }),
    ]);
    expect(flushed()).toBe(1);
  });

  it('fills in what the publisher left off rather than storing a blank label', async () => {
    // A `CatalogRelationDef` off the ORM always carries a display name, but the
    // wire shape does not require one — and a link stored with an empty label
    // renders as a blank row on the type page.
    const { service, row } = rig();

    await service.upsertType(PRINCIPAL, {
      name: 'Mvr',
      properties: [ID_COLUMN],
      relations: [{ name: 'base', kind: 'm:1', targetType: 'Base' }],
    });

    expect(relationsOf(row())[0]).toMatchObject({
      displayName: 'base',
      nullable: true,
      hidden: false,
      owner: false,
      position: 0,
    });
  });

  it('goes through the row’s own merge rule, so a curated label survives a re-publish', async () => {
    // The publishing application redeploys constantly and re-sends its whole
    // shape each time. A wire that assigned what it was handed would reset every
    // name a human chose, which is the whole reason curating is worth doing —
    // and the rule that knows which fields are whose lives on the column, not
    // here.
    const { service, row } = rig(
      typeRow([
        {
          name: 'base',
          kind: 'm:1',
          targetType: 'Base',
          displayName: 'Home base',
          nullable: true,
          hidden: false,
          position: 0,
          owner: true,
        },
      ]),
    );

    await service.upsertType(PRINCIPAL, {
      name: 'Mvr',
      properties: [ID_COLUMN],
      relations: [
        {
          name: 'base',
          kind: '1:1',
          targetType: 'Base',
          displayName: 'Base',
          localKey: 'home_base_id',
        },
      ],
    });

    // The label stayed with the curator; the structure followed the publisher.
    expect(relationsOf(row())[0]).toMatchObject({
      displayName: 'Home base',
      kind: '1:1',
      localKey: 'home_base_id',
    });
  });

  it('merges onto a row written before the relations column existed', async () => {
    const { service, row } = rig(typeRow(undefined));

    await service.upsertType(PRINCIPAL, {
      name: 'Mvr',
      properties: [ID_COLUMN],
      relations: [{ name: 'base', kind: 'm:1', targetType: 'Base' }],
    });

    expect(relationsOf(row()).map((relation) => relation.name)).toEqual(['base']);
  });
});

/**
 * The whole path, from a decorator in somebody's application to a row in the
 * catalog's database.
 *
 * The claim being checked is that a host needs to write nothing: what
 * `MikroOrmCatalogRegistry` derives from a `@ManyToOne` is already a publishable
 * payload, so the wire is the only thing that had to exist. Worth pinning
 * because the two shapes are not identical — a derived relation orders itself
 * with `order` and a stored one with `position` — and the seam holds only
 * because the derived list arrives already sorted and the merge falls back to the
 * array index. A rename on either side that broke that would be invisible in
 * both packages' own tests.
 *
 * The metadata is built by hand rather than by booting an ORM, exactly as
 * `catalog.relations.spec.ts` does: the derivation is a reading of metadata, so
 * metadata is the right input.
 */
describe('a @ManyToOne in a host’s entity', () => {
  function ormOver(metas: EntityMetadata[]): MikroORM {
    const storage = new MetadataStorage(
      Object.fromEntries(metas.map((meta) => [meta.className, meta])),
    );
    const orm = Object.create(MikroORM.prototype);
    orm.getMetadata = () => storage;
    return orm;
  }

  /** `Mvr.base -> Base`, the ordinary shape of one foreign key. */
  function fleet(): EntityMetadata[] {
    const id: Partial<EntityProperty> = { name: 'id', kind: ReferenceKind.SCALAR, type: 'string' };
    const base = new EntityMetadata({
      className: 'Base',
      tableName: 'base',
      primaryKeys: ['id'],
    });
    base.addProperty(id);
    const mvr = new EntityMetadata({ className: 'Mvr', tableName: 'mvr', primaryKeys: ['id'] });
    mvr.addProperty(id);
    mvr.addProperty({
      name: 'base',
      kind: ReferenceKind.MANY_TO_ONE,
      type: 'Base',
      targetMeta: base,
      fieldNames: ['base_id'],
      nullable: true,
    });
    return [base, mvr];
  }

  it('reaches the stored catalog with nothing written by hand in between', async () => {
    const derived = new MikroOrmCatalogRegistry(
      ormOver(fleet()),
      {},
      new InMemoryCatalogOverlayStore(),
    ).getType('Mvr');
    if (!derived) throw new Error('The registry derived no Mvr.');
    const { service, row } = rig();

    // The derived type, published verbatim. A host doing this by hand is the
    // case this whole wire exists for.
    await service.upsertType(PRINCIPAL, {
      name: derived.name,
      properties: derived.properties,
      relations: derived.relations,
    });

    expect(relationsOf(row())).toEqual([
      expect.objectContaining({
        name: 'base',
        kind: 'm:1',
        targetType: 'Base',
        localKey: 'base_id',
        // The many end holds the column, so a join is written from here.
        owner: true,
        nullable: true,
      }),
    ]);
  });
});

describe('a publisher that says nothing about links', () => {
  it('leaves the stored ones exactly where they are', async () => {
    // Absence is not a statement. An application on a client that predates this
    // field re-publishes its columns on every deploy, and reading that as "no
    // links" would delete the whole ontology — and every label curated onto it —
    // the next time somebody shipped an unrelated change.
    const { service, row } = rig(
      typeRow([
        {
          name: 'base',
          kind: 'm:1',
          targetType: 'Base',
          displayName: 'Home base',
          nullable: true,
          hidden: false,
          position: 0,
          owner: true,
        },
      ]),
    );

    await service.upsertType(PRINCIPAL, { name: 'Mvr', properties: [ID_COLUMN] });

    expect(relationsOf(row())).toEqual([expect.objectContaining({ displayName: 'Home base' })]);
  });

  it('drops them when it says, in as many words, that there are none', async () => {
    // The other half of the same distinction: an empty array IS a statement, and
    // a link the schema no longer has is a join the ontology asserts and nothing
    // can satisfy.
    const { service, row } = rig(
      typeRow([
        {
          name: 'base',
          kind: 'm:1',
          targetType: 'Base',
          displayName: 'Home base',
          nullable: true,
          hidden: false,
          position: 0,
          owner: true,
        },
      ]),
    );

    await service.upsertType(PRINCIPAL, { name: 'Mvr', properties: [ID_COLUMN], relations: [] });

    expect(relationsOf(row())).toEqual([]);
  });

  it('refuses a body whose relations are not a list, rather than answering 500', async () => {
    // `PublishedType` is the shape of an HTTP body, not a promise about one. The
    // same guard `appendRows` puts on `rows`, for the same reason: the publisher
    // gets told what it sent wrong.
    const { service } = rig();

    await expect(
      service.upsertType(PRINCIPAL, {
        name: 'Mvr',
        properties: [ID_COLUMN],
        // What a publisher sends after refactoring its payload builder by hand.
        relations: Object.assign(Object.create(null), { base: { targetType: 'Base' } }),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
