import {
  type CatalogObjectTypeDef,
  type CatalogPrincipal,
  UnsafeIdentifierError,
} from '@dudousxd/nestjs-catalog';
import {
  ObjectTypeRow,
  ident as mysqlIdent,
  physicalColumn as mysqlPhysicalColumn,
} from '@dudousxd/nestjs-catalog-store-mikro-orm';
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
 * publish, not at the load — and that a name which merely *looks* unusable is
 * not refused at all.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `upsertType` accepted a name that could never become a column and answered
 * 200. The refusal arrived at the first commit, which is after the connector has
 * read the whole source and written every row of it: an observed run reported
 * `fetched=6905, written=6905` and then failed on a schema that could never have
 * worked. Everything needed to answer the question was in the publish payload.
 *
 * The load-bearing assertions here are the ones about WHEN. A test that only
 * checked the 400 would pass just as happily if the refusal fired after the
 * flush, which is most of the bug — so every refusal below is also checked
 * against a rig that counts flushes and `ensureType` calls.
 *
 * WHY THE RULE IS NARROWER THAN IT WAS
 * ------------------------------------
 * The check used to be `assertSafeIdentifier(name)`, so `Asset Id` was refused.
 * That refusal was correct for the code as it stood — a store wrote the name
 * verbatim as the output alias of its view and of every read — and it was
 * expensive in a way nobody costed. Publishers did as the message told them and
 * sent `{ name: 'Asset_Id', columnName: 'Asset Id' }`, and a load matches a
 * record to a property by NAME (`row[property.name]`), never by `columnName`, so
 * every renamed column loaded NULL into every row while the run stayed green.
 * Thirteen types went in that way; six came out mostly empty, 313,833 rows on
 * the largest of them.
 *
 * Both aliases now go through `outputAlias`, so the name never becomes a raw
 * identifier and the check asks the question it actually needs to: does this
 * name CLEAN to something a store can create? `Asset Id` does. `2024 Total`
 * does not, because `2024_Total` starts with a digit. The cases below pin both
 * halves — what is now allowed matters as much as what is still refused, since
 * the allowed half is the bug fix.
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

describe('a property named the way the source spells it', () => {
  it('is published under that exact name, spaces and slashes and all', async () => {
    // The fix, at the layer that used to block it. `Asset Id` cleans to the
    // column `Asset_Id` and the view aliases to `Asset_Id`, so nothing anywhere
    // needs the name to be an identifier — and the publisher gets to keep the
    // one thing that has to match the records they will send.
    const { service, created, flushed, ensured } = rig();

    await service.upsertType(PRINCIPAL, {
      name: 'Mvr',
      properties: [
        ID_COLUMN,
        { name: 'Asset Id', type: 'string' },
        { name: 'Asset LIN/TAMCN', type: 'string' },
      ],
    });

    expect(flushed()).toBe(1);
    expect(ensured()).toBe(1);
    // Stored verbatim, not tidied. A stored `Asset_Id` here would be the old bug
    // arriving by a different route: the caller's next batch is keyed `Asset Id`
    // and a load reads `row[property.name]`.
    expect(created().map((data) => data.name)).toContain('Asset Id');
    expect(created().map((data) => data.name)).toContain('Asset LIN/TAMCN');
    expect(created().some((data) => data.name === 'Asset_Id')).toBe(false);
  });

  it('is not something the rule has anything to say about', () => {
    // The three names from the incident, by name. Each of them was refused by
    // this check until the alias changed, and each refusal is what produced a
    // renamed property and a column of NULLs.
    expect(identifierRefusal('Asset Id')).toBeUndefined();
    expect(identifierRefusal('Work Order Id')).toBeUndefined();
    expect(identifierRefusal('Asset LIN/TAMCN')).toBeUndefined();
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

describe('a property named something that cannot be a column', () => {
  it('is refused, and refused before a single row of it exists', async () => {
    const { service, created, flushed, ensured } = rig();

    await expect(
      service.upsertType(PRINCIPAL, {
        name: 'Mvr',
        properties: [ID_COLUMN, { name: '2024 Total', type: 'string' }],
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
        properties: [ID_COLUMN, { name: '2024 Total', type: 'string' }],
      }),
    ).rejects.toThrow(
      // Character for character what `ident` raises at DDL time, because both
      // come from `assertSafeIdentifier` in the core package — whichever store
      // is mounted. Two wordings for one rule is how they come to disagree. The
      // value named is the CLEANED one, because that is the string the store
      // would refuse: `2024 Total` never reaches `ident`, `2024_Total` does.
      new UnsafeIdentifierError('2024_Total').message,
    );
  });

  it('says what the name cleans to, so the rule is not a riddle', async () => {
    // The refusal names a string the caller did not send. Without the cleaned
    // form beside the original, "letters, digits and underscore only" reads as
    // nonsense against a name that already is only letters, digits and spaces.
    const { service } = rig();

    const error = await service
      .upsertType(PRINCIPAL, {
        name: 'Mvr',
        properties: [ID_COLUMN, { name: '2024 Total', type: 'string' }],
      })
      .catch((thrown: unknown) => thrown);

    expect(String(error)).toContain('"2024 Total" cleans to "2024_Total"');
  });

  it('offers the payload that would have worked instead of restating the rule', async () => {
    const { service } = rig();

    const error = await service
      .upsertType(PRINCIPAL, {
        name: 'Mvr',
        properties: [ID_COLUMN, { name: '2024 Total', type: 'string' }],
      })
      .catch((thrown: unknown) => thrown);

    expect(String(error)).toContain('{ "name": "c_2024_Total", "columnName": "2024 Total" }');
  });

  it('warns that taking the suggestion needs a transform behind it', async () => {
    // The one thing the old message did not say, and the whole reason the
    // incident happened: a renamed property is fed from `row[name]`, so a
    // publisher who renames and sends the source's records unchanged gets a
    // column of NULLs and a green run.
    const { service } = rig();

    const error = await service
      .upsertType(PRINCIPAL, {
        name: 'Mvr',
        properties: [ID_COLUMN, { name: '2024 Total', type: 'string' }],
      })
      .catch((thrown: unknown) => thrown);

    const message = String(error);
    expect(message).toContain('row[name]');
    expect(message).toContain('transform');
  });

  it('names every offender, so a forty-column payload takes one round trip', async () => {
    const { service } = rig();

    const error = await service
      .upsertType(PRINCIPAL, {
        name: 'Mvr',
        properties: [
          ID_COLUMN,
          { name: '2024 Total', type: 'string' },
          { name: '9 Lives', type: 'string' },
          { name: '', type: 'string' },
        ],
      })
      .catch((thrown: unknown) => thrown);

    const message = String(error);
    expect(message).toContain('"2024 Total"');
    expect(message).toContain('"9 Lives"');
    expect(message).toContain('""');
    expect(message).toContain('{ "name": "c_9_Lives", "columnName": "9 Lives" }');
  });

  it('keeps a columnName the caller already sent rather than overwriting it', async () => {
    // `sourceColumn` is `columnName ?? name`, so a caller who already mapped the
    // source must not be told to point it back at the broken name.
    const { service } = rig();

    const error = await service
      .upsertType(PRINCIPAL, {
        name: 'Mvr',
        properties: [ID_COLUMN, { name: '2024 Total', type: 'string', columnName: 'total_2024' }],
      })
      .catch((thrown: unknown) => thrown);

    expect(String(error)).toContain('{ "name": "c_2024_Total", "columnName": "total_2024" }');
  });

  it('does not sanitise it into the catalog behind the caller’s back', async () => {
    // The refusal exists instead of a rename. A stored `c_2024_Total` would
    // leave every batch the caller sends — keyed by `2024 Total` — writing
    // nothing into that column, which is a dataset that looks loaded.
    const { service, created } = rig();

    await expect(
      service.upsertType(PRINCIPAL, {
        name: 'Mvr',
        properties: [ID_COLUMN, { name: '2024 Total', type: 'string' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(created().some((data) => data.name === 'c_2024_Total')).toBe(false);
    expect(created().some((data) => data.name === '2024_Total')).toBe(false);
  });
});

describe('a type that already holds a name this check would refuse', () => {
  it('can still be republished, because nothing can remove the property', async () => {
    // `upsertType` only ever adds properties and no route deletes one, so
    // refusing the republish would leave a type permanently unpublishable —
    // including for the publisher trying to add the correctly-named property
    // beside it. That is worse than the bug this check is for.
    const { service, flushed, ensured } = rig(['id', '2024 Total']);

    await service.upsertType(PRINCIPAL, {
      name: 'Mvr',
      properties: [ID_COLUMN, { name: '2024 Total', type: 'string' }],
    });

    expect(flushed()).toBe(1);
    expect(ensured()).toBe(1);
  });

  it('is warned about by name, rather than left to be met at a commit', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service } = rig(['id', '2024 Total']);

    await service.upsertType(PRINCIPAL, {
      name: 'Mvr',
      properties: [ID_COLUMN, { name: '2024 Total', type: 'string' }],
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('"2024 Total"');
  });

  it('still refuses a NEW bad name on that same republish', async () => {
    // Tolerating the old one is not tolerating the class of mistake: the
    // republish that adds a second one is refused, and refused before the flush.
    const { service, flushed, ensured } = rig(['id', '2024 Total']);

    await expect(
      service.upsertType(PRINCIPAL, {
        name: 'Mvr',
        properties: [
          ID_COLUMN,
          { name: '2024 Total', type: 'string' },
          { name: '9 Lives', type: 'string' },
        ],
      }),
    ).rejects.toThrow(new UnsafeIdentifierError('9_Lives').message);

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

  it('has stopped complaining about a stored name that now simply works', async () => {
    // The set this warning describes shrank when the alias changed. A type that
    // picked up `Asset Id` before any of this existed used to fail at every
    // commit and be told so on every publish; it now cleans to a column like any
    // other, so there is nothing left to warn about. Warning anyway would send
    // an operator to fix a type that is fine.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service } = rig(['id', 'Asset Id']);

    await service.upsertType(PRINCIPAL, {
      name: 'Mvr',
      properties: [ID_COLUMN, { name: 'Asset Id', type: 'string' }],
    });

    expect(warn).not.toHaveBeenCalled();
    expect(describeStoredUnpublishableNames('Mvr', ['id', 'Asset Id'])).toBeUndefined();
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

  it('accepts anything that cleans to an identifier, however it is punctuated', () => {
    // Punctuation and length are no longer reasons on their own. Whatever the
    // characters, `physicalColumn` replaces them and cuts the result to 60 — and
    // 60 is inside the 63 the rule allows, so a long name can never be refused
    // for its length again. What is left is the first character.
    for (const fine of ['Asset Id', 'Asset-Id', 'Sub/Un Sub', 'a'.repeat(200), '///', ' ']) {
      expect(identifierRefusal(fine)).toBeUndefined();
    }
  });

  it('refuses the shapes `ident` refuses, and names the string ident would see', () => {
    // The refused value is the CLEANED one on both sides. Nothing sends
    // `2024 Total` to `ident`; a store sends `2024_Total`, and that is what a
    // publisher will find in the DDL-time error if this check is ever bypassed.
    for (const [sent, cleaned] of [
      ['2024 Total', '2024_Total'],
      ['9lives', '9lives'],
      ['', ''],
      ['42', '42'],
    ]) {
      expect(identifierRefusal(String(sent))).toBe(
        new UnsafeIdentifierError(String(cleaned)).message,
      );
    }
  });

  it('reaches the rule the mounted store reaches, not one adapter’s copy of it', () => {
    // The whole point of the move. This used to import `ident` and
    // `UnsafeIdentifierError` from the MySQL adapter, so a deployment running
    // only the ClickHouse store had a publish-time refusal and a DDL-time
    // refusal that were two files agreeing by hand. Both halves of the rule —
    // the cleaning and the character set — now live in the core package, and
    // both adapters re-export them rather than restating them.
    expect(mysqlPhysicalColumn('Asset Id')).toBe('Asset_Id');
    // What the check accepts, the mounted adapter can quote; what it refuses,
    // the mounted adapter refuses. Asserted through the adapter's own `ident` so
    // this is a statement about the store rather than about the core package
    // agreeing with itself.
    expect(mysqlIdent(mysqlPhysicalColumn('Asset Id'))).toBe('`Asset_Id`');
    expect(() => mysqlIdent(mysqlPhysicalColumn('2024 Total'))).toThrow(UnsafeIdentifierError);
    expect(identifierRefusal('2024 Total')).toBe(new UnsafeIdentifierError('2024_Total').message);
  });

  it('reports a repeated bad name once', () => {
    const message = refuseUnpublishablePropertyNames(
      'Mvr',
      [{ name: '2024 Total' }, { name: '2024 Total' }],
      new Set(),
    );
    expect(message?.match(/2024 Total/g)?.length).toBeGreaterThan(0);
    expect(message?.match(/Send it as/g)).toHaveLength(1);
  });

  it('always suggests a name it would itself accept', () => {
    // `toPhysicalName` prefixes a leading digit and names an empty result, so a
    // suggestion is never a second thing to be refused for.
    for (const bad of ['9lives', '', '42', '7 8 9']) {
      const message = refuseUnpublishablePropertyNames('Mvr', [{ name: bad }], new Set());
      const suggested = message?.match(/\{ "name": "([^"]*)"/)?.[1];
      expect(suggested).toBeDefined();
      expect(identifierRefusal(String(suggested))).toBeUndefined();
    }
  });

  it('has nothing to say about a payload whose names all clean to identifiers', () => {
    expect(
      refuseUnpublishablePropertyNames(
        'Mvr',
        [{ name: 'id' }, { name: 'asset_id' }, { name: 'Asset Id' }],
        new Set(),
      ),
    ).toBeUndefined();
    expect(describeStoredUnpublishableNames('Mvr', ['id', 'asset_id', 'Asset Id'])).toBeUndefined();
  });
});
