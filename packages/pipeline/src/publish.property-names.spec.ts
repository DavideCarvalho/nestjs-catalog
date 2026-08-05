import {
  type CatalogObjectTypeDef,
  type CatalogPrincipal,
  UnsafeIdentifierError,
} from '@dudousxd/nestjs-catalog';
import { ObjectTypeRow, ident as mysqlIdent } from '@dudousxd/nestjs-catalog-store-mikro-orm';
import { BadRequestException, Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeStoredUnpublishableNames,
  identifierRefusal,
  refuseUnpublishablePropertyNames,
} from './property-names';
import { PublishService } from './publish.service';

/**
 * That a property name which can never become a column is refused at the
 * publish, not at the load.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `upsertType` accepted `{"name": "Asset Id"}` and answered 200. The refusal —
 * `Refusing to use "Asset Id" as a SQL identifier …` — arrived at the first
 * commit, which is after the connector has read the whole source and written
 * every row of it: an observed run reported `fetched=6905, written=6905` and
 * then failed on a schema that could never have worked. Everything needed to
 * answer the question was in the publish payload.
 *
 * The load-bearing assertions here are the ones about WHEN. A test that only
 * checked the 400 would pass just as happily if the refusal fired after the
 * flush, which is most of the bug — so every refusal below is also checked
 * against a rig that counts flushes and `ensureType` calls.
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

/** The one property every payload carries; `upsertType` refuses a type with none. */
const ID_COLUMN = { name: 'id', type: 'string', primary: true };

interface Rig {
  service: PublishService;
  /** Rows the publish handed to `em.create` — nothing is created before the check. */
  created: () => Array<Record<string, unknown>>;
  flushed: () => number;
  ensured: () => number;
}

/**
 * A publisher over one EntityManager stub, following `publish.relations.spec.ts`.
 *
 * The counters are the point of this file rather than a convenience: `flushed`
 * is the write, `ensured` is the DDL, and a refusal that fires after either of
 * them is the bug wearing a 400.
 */
function rig(storedPropertyNames: string[] = []): Rig {
  const created: Array<Record<string, unknown>> = [];
  let flushes = 0;
  let ensures = 0;

  const existing =
    storedPropertyNames.length > 0
      ? Object.assign(Object.create(ObjectTypeRow.prototype), {
          name: 'Mvr',
          ownerPrincipalId: 'fleet-app',
          displayName: 'Mvr',
          pluralDisplayName: 'Mvrs',
          group: 'Fleet',
          primaryKey: ['id'],
          physicalTable: 'obj_mvr',
          properties: {
            getItems: () =>
              storedPropertyNames.map((name) => ({
                name,
                displayName: name,
                type: 'string',
                sourceColumn: name,
              })),
          },
          relations: [],
        })
      : null;

  const em = Object.assign(Object.create(null), {
    findOne: () => Promise.resolve(existing),
    create: (entity: { prototype: object }, data: Record<string, unknown>) => {
      created.push(data);
      return Object.assign(Object.create(entity.prototype), data);
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
    flushed: () => flushes,
    ensured: () => ensures,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a property named something that cannot be a column', () => {
  it('is refused, and refused before a single row of it exists', async () => {
    const { service, created, flushed, ensured } = rig();

    await expect(
      service.upsertType(PRINCIPAL, {
        name: 'Mvr',
        properties: [ID_COLUMN, { name: 'Asset Id', type: 'string' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // The half that matters. A refusal thrown after the flush would satisfy the
    // assertion above and leave the type stored exactly as the bug did.
    expect(flushed()).toBe(0);
    expect(ensured()).toBe(0);
    expect(created()).toEqual([]);
  });

  it('says which property, in the catalog’s own words for the rule', async () => {
    const { service } = rig();

    await expect(
      service.upsertType(PRINCIPAL, {
        name: 'Mvr',
        properties: [ID_COLUMN, { name: 'Asset Id', type: 'string' }],
      }),
    ).rejects.toThrow(
      // Character for character what `ident` raises at DDL time, because both
      // come from `assertSafeIdentifier` in the core package — whichever store
      // is mounted. Two wordings for one rule is how they come to disagree.
      new UnsafeIdentifierError('Asset Id').message,
    );
  });

  it('offers the payload that would have worked instead of restating the rule', async () => {
    const { service } = rig();

    const error = await service
      .upsertType(PRINCIPAL, {
        name: 'Mvr',
        properties: [ID_COLUMN, { name: 'Asset Id', type: 'string' }],
      })
      .catch((thrown: unknown) => thrown);

    expect(String(error)).toContain('{ "name": "Asset_Id", "columnName": "Asset Id" }');
  });

  it('names every offender, so a forty-column payload takes one round trip', async () => {
    const { service } = rig();

    const error = await service
      .upsertType(PRINCIPAL, {
        name: 'Mvr',
        properties: [
          ID_COLUMN,
          { name: 'Asset Id', type: 'string' },
          { name: 'Work Order Id', type: 'string' },
          { name: 'Asset LIN/TAMCN', type: 'string' },
        ],
      })
      .catch((thrown: unknown) => thrown);

    const message = String(error);
    expect(message).toContain('"Asset Id"');
    expect(message).toContain('"Work Order Id"');
    expect(message).toContain('"Asset LIN/TAMCN"');
    expect(message).toContain('{ "name": "Asset_LIN_TAMCN", "columnName": "Asset LIN/TAMCN" }');
  });

  it('keeps a columnName the caller already sent rather than overwriting it', async () => {
    // `sourceColumn` is `columnName ?? name`, so a caller who already mapped the
    // source must not be told to point it back at the broken name.
    const { service } = rig();

    const error = await service
      .upsertType(PRINCIPAL, {
        name: 'Mvr',
        properties: [ID_COLUMN, { name: 'Asset Id', type: 'string', columnName: 'asset_id' }],
      })
      .catch((thrown: unknown) => thrown);

    expect(String(error)).toContain('{ "name": "Asset_Id", "columnName": "asset_id" }');
  });

  it('does not sanitise it into the catalog behind the caller’s back', async () => {
    // The refusal exists instead of a rename. A stored `Asset_Id` would leave
    // every batch the caller sends — keyed by `Asset Id` — writing nothing into
    // that column, which is a dataset that looks loaded.
    const { service, created } = rig();

    await expect(
      service.upsertType(PRINCIPAL, {
        name: 'Mvr',
        properties: [ID_COLUMN, { name: 'Asset Id', type: 'string' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(created().some((data) => data.name === 'Asset_Id')).toBe(false);
  });

  it('lets a name that is already an identifier through untouched', async () => {
    const { service, flushed, ensured } = rig();

    await service.upsertType(PRINCIPAL, {
      name: 'Mvr',
      properties: [ID_COLUMN, { name: 'Asset_Id', type: 'string', columnName: 'Asset Id' }],
    });

    expect(flushed()).toBe(1);
    expect(ensured()).toBe(1);
  });
});

describe('a type that already holds a name this check would refuse', () => {
  it('can still be republished, because nothing can remove the property', async () => {
    // `upsertType` only ever adds properties and no route deletes one, so
    // refusing the republish would leave a type permanently unpublishable —
    // including for the publisher trying to add the correctly-named property
    // beside it. That is worse than the bug this check is for.
    const { service, flushed, ensured } = rig(['id', 'Asset Id']);

    await service.upsertType(PRINCIPAL, {
      name: 'Mvr',
      properties: [ID_COLUMN, { name: 'Asset Id', type: 'string' }],
    });

    expect(flushed()).toBe(1);
    expect(ensured()).toBe(1);
  });

  it('is warned about by name, rather than left to be met at a commit', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service } = rig(['id', 'Asset Id']);

    await service.upsertType(PRINCIPAL, {
      name: 'Mvr',
      properties: [ID_COLUMN, { name: 'Asset Id', type: 'string' }],
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('"Asset Id"');
  });

  it('still refuses a NEW bad name on that same republish', async () => {
    // Tolerating the old one is not tolerating the class of mistake: the
    // republish that adds a second one is refused, and refused before the flush.
    const { service, flushed, ensured } = rig(['id', 'Asset Id']);

    await expect(
      service.upsertType(PRINCIPAL, {
        name: 'Mvr',
        properties: [
          ID_COLUMN,
          { name: 'Asset Id', type: 'string' },
          { name: 'Work Order Id', type: 'string' },
        ],
      }),
    ).rejects.toThrow(new UnsafeIdentifierError('Work Order Id').message);

    expect(flushed()).toBe(0);
    expect(ensured()).toBe(0);
  });

  it('says nothing about the old one when every stored name is fine', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service } = rig(['id', 'asset_id']);

    await service.upsertType(PRINCIPAL, {
      name: 'Mvr',
      properties: [ID_COLUMN],
    });

    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * The rules on their own, where the cases that are awkward to reach through a
 * service are cheap.
 */
describe('the rule itself', () => {
  it('hands back nothing for a name a store would accept', () => {
    expect(identifierRefusal('Asset_Id')).toBeUndefined();
    expect(identifierRefusal('_snapshot_id')).toBeUndefined();
  });

  it('refuses the shapes `ident` refuses, and says so in its words', () => {
    for (const bad of ['Asset Id', '9lives', 'a'.repeat(64), '', 'Asset-Id']) {
      expect(identifierRefusal(bad)).toBe(new UnsafeIdentifierError(bad).message);
    }
  });

  it('reaches the rule the mounted store reaches, not one adapter’s copy of it', () => {
    // The whole point of the move. This used to import `ident` and
    // `UnsafeIdentifierError` from the MySQL adapter, so a deployment running
    // only the ClickHouse store had a publish-time refusal and a DDL-time
    // refusal that were two files agreeing by hand. Asserting on the class the
    // core exports — which is the one both adapters now throw — is what makes
    // the assertion above true of every store rather than of one.
    expect(identifierRefusal('Asset Id')).toBe(new UnsafeIdentifierError('Asset Id').message);
    expect(mysqlIdent('Asset_Id')).toBe('`Asset_Id`');
    expect(() => mysqlIdent('Asset Id')).toThrow(UnsafeIdentifierError);
  });

  it('reports a repeated bad name once', () => {
    const message = refuseUnpublishablePropertyNames(
      'Mvr',
      [{ name: 'Asset Id' }, { name: 'Asset Id' }],
      new Set(),
    );
    expect(message?.match(/Asset Id/g)?.length).toBeGreaterThan(0);
    expect(message?.match(/Send it as/g)).toHaveLength(1);
  });

  it('always suggests a name it would itself accept', () => {
    // `toPhysicalName` prefixes a leading digit and names an empty result, so a
    // suggestion is never a second thing to be refused for.
    for (const bad of ['9lives', '///', ' ', 'a'.repeat(200)]) {
      const message = refuseUnpublishablePropertyNames('Mvr', [{ name: bad }], new Set());
      const suggested = message?.match(/\{ "name": "([^"]*)"/)?.[1];
      expect(suggested).toBeDefined();
      expect(identifierRefusal(String(suggested))).toBeUndefined();
    }
  });

  it('has nothing to say about a payload whose names are all identifiers', () => {
    expect(
      refuseUnpublishablePropertyNames('Mvr', [{ name: 'id' }, { name: 'asset_id' }], new Set()),
    ).toBeUndefined();
    expect(describeStoredUnpublishableNames('Mvr', ['id', 'asset_id'])).toBeUndefined();
  });
});
