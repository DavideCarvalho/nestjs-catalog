import type { CatalogConnector, CatalogObjectTypeDef } from '@dudousxd/nestjs-catalog';
import { describe, expect, it } from 'vitest';
import {
  type ConnectorSchemaDiscovery,
  type DiscoveredColumn,
  columnsFromSqlDescription,
  discoverConnectorSchema,
  driftFrom,
  flagUnusableNames,
} from './schema-discovery';
import { readMysqlFields, readPostgresFields, zeroRowStatement } from './sources';

/**
 * Discovery, which is the one thing here that must never quietly be wrong.
 *
 * Every assertion below is about the same failure: a column typed on a guess
 * becomes a column in a lake, the load that fills it succeeds every night, and
 * nobody re-reads it until the number it produced is used for something. So the
 * cases that matter most are the ones where discovery is expected to REFUSE to
 * answer — an unmapped oid, a sample that disagrees with itself, a column that
 * was null in every record it saw.
 *
 * The two drivers are exercised through the pure readers rather than a database.
 * `pg` and `mysql2` are optional peers this repo does not install, and what
 * needs testing is not that a socket opens: it is the shape each driver hands
 * back, which is a fixture.
 */

function connector(overrides: Partial<CatalogConnector> = {}): CatalogConnector {
  return {
    id: 'c1',
    name: 'Nightly pull',
    kind: 'inline',
    targetType: 'Mvr',
    config: {},
    enabled: true,
    createdBy: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Discovery over an inline connector: real fetcher, records supplied by the test. */
function discoverRecords(
  records: unknown[],
  overrides: Partial<CatalogConnector> = {},
): Promise<ConnectorSchemaDiscovery> {
  return discoverConnectorSchema({
    connector: connector({ config: { records }, ...overrides }),
  });
}

function column(discovery: ConnectorSchemaDiscovery, name: string): DiscoveredColumn {
  const found = discovery.columns.find((entry) => entry.name === name);
  if (!found) throw new Error(`No column ${name} in ${discovery.columns.map((c) => c.name)}`);
  return found;
}

function objectType(properties: CatalogObjectTypeDef['properties']): CatalogObjectTypeDef {
  return {
    name: 'Mvr',
    displayName: 'Vehicle',
    pluralDisplayName: 'Vehicles',
    tableName: 'obj_mvr',
    group: 'Fleet',
    primaryKey: [],
    enriched: false,
    properties,
    relations: [],
  };
}

function property(
  name: string,
  type: CatalogObjectTypeDef['properties'][number]['type'],
): CatalogObjectTypeDef['properties'][number] {
  return {
    name,
    displayName: name,
    type,
    columnName: name,
    nullable: true,
    primary: false,
    hidden: false,
    order: 0,
    enriched: false,
  };
}

describe('zeroRowStatement', () => {
  it('asks for the columns and none of the rows', () => {
    expect(zeroRowStatement('SELECT * FROM vehicles')).toBe(
      'SELECT * FROM (SELECT * FROM vehicles) AS catalog_discovery LIMIT 0',
    );
  });

  // Legal on its own, a syntax error inside a derived table, and the single most
  // likely thing to have been pasted into the query box.
  it('drops a trailing semicolon that would break the wrapping', () => {
    expect(zeroRowStatement('SELECT 1;  ')).not.toContain(';');
    expect(zeroRowStatement('SELECT 1;;')).toBe(
      'SELECT * FROM (SELECT 1) AS catalog_discovery LIMIT 0',
    );
  });
});

describe('reading what the drivers hand back', () => {
  it('takes names and type oids off a pg result', () => {
    expect(
      readPostgresFields({
        rows: [],
        fields: [
          { name: 'id', dataTypeID: 23 },
          { name: 'plate', dataTypeID: 1043 },
        ],
      }),
    ).toEqual([
      { name: 'id', typeId: 23 },
      { name: 'plate', typeId: 1043 },
    ]);
  });

  it('reports no nullability for Postgres, because a plain query carries none', () => {
    const [field] = readPostgresFields({ fields: [{ name: 'id', dataTypeID: 23 }] });
    expect(field.nullable).toBeUndefined();
  });

  it('answers nothing for a result that carried no fields at all', () => {
    expect(readPostgresFields({ rows: [] })).toEqual([]);
    expect(readPostgresFields(undefined)).toEqual([]);
  });

  // mysql2 v3 says `columnType`; v1 and v2 say `type`. Both are installable
  // against this package's peer range, so both are read.
  it('reads a mysql field packet under either spelling of the type', () => {
    expect(readMysqlFields([{ name: 'a', columnType: 3, flags: 0 }])[0].typeId).toBe(3);
    expect(readMysqlFields([{ name: 'a', type: 3, flags: 0 }])[0].typeId).toBe(3);
  });

  it('reads NOT NULL off the flags, and says nothing when there are none', () => {
    expect(readMysqlFields([{ name: 'a', columnType: 3, flags: 1 }])[0].nullable).toBe(false);
    expect(readMysqlFields([{ name: 'a', columnType: 3, flags: 0 }])[0].nullable).toBe(true);
    expect(readMysqlFields([{ name: 'a', columnType: 3 }])[0].nullable).toBeUndefined();
  });

  it('carries the display width and the character set, which decide two types', () => {
    const [field] = readMysqlFields([
      { name: 'a', columnType: 1, columnLength: 1, characterSet: 63, flags: 0 },
    ]);
    expect(field).toMatchObject({ length: 1, charset: 63 });
  });

  it('skips an entry that does not describe a column', () => {
    expect(readMysqlFields([null, 'nonsense', { columnType: 3 }])).toEqual([]);
    expect(readMysqlFields('not an array')).toEqual([]);
  });
});

describe('a sampled source', () => {
  it('reports the columns the records actually carried', async () => {
    const discovery = await discoverRecords([
      { plate: 'AB-1', miles: 12 },
      { plate: 'AB-2', miles: 40 },
    ]);
    expect(discovery.columns.map((entry) => entry.name)).toEqual(['plate', 'miles']);
    expect(column(discovery, 'miles').type).toBe('number');
    expect(column(discovery, 'plate').type).toBe('string');
  });

  // The heart of it. A sample proves nothing beyond itself, and a screen that
  // showed a sampled string beside a driver-reported one as equally solid is
  // what makes somebody trust the wrong column.
  it('never claims a sampled type was reported', async () => {
    const discovery = await discoverRecords([{ plate: 'AB-1' }]);
    expect(discovery.basis).toBe('sample');
    expect(column(discovery, 'plate').confidence).toBe('inferred');
  });

  // A CSV column of numbers with one "n/a" in it looks exactly like this, and
  // typing it as a number would write null over every row that has the "n/a".
  it('refuses to type a column whose samples disagree', async () => {
    const discovery = await discoverRecords([{ miles: 12 }, { miles: 'n/a' }]);
    expect(column(discovery, 'miles').type).toBeNull();
    expect(column(discovery, 'miles').confidence).toBe('unknown');
    expect(column(discovery, 'miles').note).toMatch(/disagrees/);
  });

  it('refuses to type a column that was null in every record it saw', async () => {
    const discovery = await discoverRecords([{ vin: null }, { vin: null }]);
    expect(column(discovery, 'vin').type).toBeNull();
    expect(column(discovery, 'vin').note).toMatch(/nothing to infer/);
  });

  // JSON has no date. Promoting a string that looks like one is the guess that
  // costs the most: a value the store cannot parse is written as null, so the
  // rows that do not match the format vanish without an error.
  it('proposes an ISO-8601-looking string as text, and says why', async () => {
    const discovery = await discoverRecords([
      { seenAt: '2026-01-01T00:00:00.000Z' },
      { seenAt: '2026-02-01T00:00:00.000Z' },
    ]);
    expect(column(discovery, 'seenAt').type).toBe('string');
    expect(column(discovery, 'seenAt').note).toMatch(/ISO-8601/);
  });

  it('reads a missing key as nullable, and never claims a column cannot be null', async () => {
    const discovery = await discoverRecords([{ plate: 'AB-1', trailer: 'T1' }, { plate: 'AB-2' }]);
    expect(column(discovery, 'trailer').nullable).toBe(true);
    // Seen non-null forty times is not proof of NOT NULL, so it stays unstated.
    expect(column(discovery, 'plate').nullable).toBeNull();
  });

  it('counts shapes without ever echoing a value back', async () => {
    const discovery = await discoverRecords([{ plate: 'SECRET-1' }, { plate: null }]);
    expect(column(discovery, 'plate').sourceType).toBe('string ×1, null ×1 of 2 records');
    expect(JSON.stringify(discovery)).not.toContain('SECRET-1');
  });

  // The limit bounds what is INSPECTED, not what the source hands over. It is
  // the difference between a button that is cheap to press on a source with a
  // million rows behind it and one nobody presses twice.
  it('looks at no more records than it was told to', async () => {
    const discovery = await discoverConnectorSchema({
      connector: connector({ config: { records: [{ a: 1 }, { a: 2 }, { a: 3 }] } }),
      sampleLimit: 2,
    });
    expect(discovery.sampled).toBe(2);
    expect(discovery.columns[0].sourceType).toContain('of 2 records');
  });

  it('says a source that returned nothing returned nothing, rather than having no columns', async () => {
    const discovery = await discoverRecords([]);
    expect(discovery.columns).toEqual([]);
    expect(discovery.sampled).toBe(0);
    expect(discovery.caveat).toMatch(/no records/);
  });

  it('says the columns are the pre-transform shape when a transform is configured', async () => {
    const discovery = await discoverRecords([{ plate: 'AB-1' }], { transformId: 't1' });
    expect(discovery.caveat).toMatch(/before|BEFORE|SOURCE/);
    expect(discovery.caveat).toMatch(/transform emits/);
  });

  it('leaves the caveat alone when there is no transform in the way', async () => {
    const discovery = await discoverRecords([{ plate: 'AB-1' }]);
    expect(discovery.caveat).not.toMatch(/transform emits/);
  });
});

describe('what a Postgres driver reports', () => {
  const map = (oid: number): DiscoveredColumn =>
    columnsFromSqlDescription({ dialect: 'postgres', fields: [{ name: 'c', typeId: oid }] })[0];

  it.each([
    [23, 'number'], // int4
    [20, 'number'], // int8
    [1700, 'number'], // numeric
    [1043, 'string'], // varchar
    [25, 'string'], // text
    [16, 'boolean'],
    [1082, 'date'], // date
    [1184, 'date'], // timestamptz
    [2950, 'uuid'],
    [3802, 'json'], // jsonb
    [1009, 'json'], // text[], which arrives as a JS array
  ] as const)("reads oid %i as %s, on the database's own word", (oid, type) => {
    expect(map(oid)).toMatchObject({ type, confidence: 'reported' });
  });

  // `new Date("14:30:00")` is Invalid Date, and the store writes that as null.
  // A time-of-day column typed as a date is a column of nulls that nothing
  // reports as an error.
  it.each([1083, 1266])('proposes time oid %i as text rather than as a date', (oid) => {
    expect(map(oid).type).toBe('string');
    expect(map(oid).note).toMatch(/time of day/);
  });

  // An interval, a bytea, an enum, a domain, anything anybody defined. The oid
  // is handed back so a person can look it up; a guess would be a column.
  it('refuses an oid it does not know, and says which oid', () => {
    expect(map(1186)).toMatchObject({ type: null, confidence: 'unknown', sourceType: 'oid 1186' });
    expect(map(1186).note).toMatch(/1186/);
  });

  it('leaves nullability unstated, because the query never carried it', () => {
    expect(map(23).nullable).toBeNull();
  });
});

describe('what a MySQL driver reports', () => {
  const map = (field: { typeId?: number; length?: number; charset?: number; nullable?: boolean }) =>
    columnsFromSqlDescription({ dialect: 'mysql', fields: [{ name: 'c', ...field }] })[0];

  it.each([
    [3, 'number'], // long
    [8, 'number'], // longlong
    [246, 'number'], // newdecimal
    [15, 'string'], // varchar
    [253, 'string'], // var_string
    [247, 'string'], // enum
    [12, 'date'], // datetime
    [7, 'date'], // timestamp
    [245, 'json'],
  ] as const)('reads type %i as %s', (typeId, type) => {
    expect(map({ typeId })).toMatchObject({ type, confidence: 'reported' });
  });

  // TINYINT(1) is how MySQL spells a boolean and how it spells a one-digit
  // integer. Reported as a boolean and marked inferred, because the person
  // confirming is the only one who knows which it was meant to be.
  it('reads tinyint(1) as a boolean, and does not claim the database said so', () => {
    expect(map({ typeId: 1, length: 1 })).toMatchObject({
      type: 'boolean',
      confidence: 'inferred',
    });
    expect(map({ typeId: 1, length: 1 }).note).toMatch(/TINYINT\(1\)/);
  });

  it('reads a wider tinyint as the integer it is', () => {
    expect(map({ typeId: 1, length: 4 })).toMatchObject({ type: 'number', confidence: 'reported' });
  });

  // TEXT columns come back as blob type ids; the character set is the only thing
  // separating them from a real binary blob. Reading the id alone would report
  // most of the columns in most MySQL tables as untyped.
  it('reads a blob id with a text character set as text', () => {
    expect(map({ typeId: 252, charset: 33 }).type).toBe('string');
  });

  it('refuses a blob id on the binary character set', () => {
    expect(map({ typeId: 252, charset: 63 }).type).toBeNull();
    expect(map({ typeId: 252, charset: 63 }).note).toMatch(/binary/);
  });

  // BIT and GEOMETRY arrive as Buffers, and a Buffer down the store's text path
  // is its bytes read as UTF-8 — garbage that looks like data.
  it('refuses a type id it does not know', () => {
    expect(map({ typeId: 16 })).toMatchObject({ type: null, confidence: 'unknown' });
  });

  it('carries the NOT NULL the driver did report', () => {
    expect(map({ typeId: 3, nullable: false }).nullable).toBe(false);
    expect(map({ typeId: 3 }).nullable).toBeNull();
  });
});

describe('columns the catalog cannot accept as named', () => {
  // `SELECT a.id, b.id` is an ordinary query and both drivers describe two
  // fields called `id` — but a row is an object, so one has already overwritten
  // the other before anything here sees it.
  it('flags every column of a duplicated name, on both of them', () => {
    const flagged = flagUnusableNames(
      columnsFromSqlDescription({
        dialect: 'postgres',
        fields: [
          { name: 'id', typeId: 23 },
          { name: 'id', typeId: 1043 },
          { name: 'plate', typeId: 1043 },
        ],
      }),
    );
    expect(flagged[0].note).toMatch(/only the last one survives/);
    expect(flagged[1].note).toMatch(/only the last one survives/);
    expect(flagged[2].note).toBeUndefined();
  });

  it('refuses a source column that would land in the store bookkeeping', async () => {
    const discovery = await discoverRecords([{ _row: 1, plate: 'AB-1' }]);
    expect(column(discovery, '_row').note).toMatch(/bookkeeping/);
    expect(column(discovery, 'plate').note).toBeUndefined();
  });

  it('keeps the source spelling rather than tidying it into a property name', async () => {
    // The store reads `row[property.name]`, so a tidied `firstName` against a
    // source column `first_name` is a column that loads null forever.
    const discovery = await discoverRecords([{ first_name: 'Ana' }]);
    expect(discovery.columns[0].name).toBe('first_name');
  });
});

describe('drift', () => {
  const existing = objectType([property('plate', 'string'), property('miles', 'number')]);

  it('is not reported at all for a type that does not exist yet', async () => {
    const discovery = await discoverRecords([{ plate: 'AB-1' }]);
    expect(discovery.drift).toBeNull();
    expect(discovery.typeExists).toBe(false);
  });

  it('names a column the source gained, which every load silently drops today', () => {
    const drift = driftFrom(existing, [
      { name: 'plate', type: 'string', confidence: 'reported', sourceType: '', nullable: null },
      { name: 'miles', type: 'number', confidence: 'reported', sourceType: '', nullable: null },
      { name: 'trailer', type: 'string', confidence: 'reported', sourceType: '', nullable: null },
    ]);
    expect(drift.added).toEqual(['trailer']);
    expect(drift.removed).toEqual([]);
  });

  it('names a column the source lost, which every load writes as null today', () => {
    const drift = driftFrom(existing, [
      { name: 'plate', type: 'string', confidence: 'reported', sourceType: '', nullable: null },
    ]);
    expect(drift.removed).toEqual(['miles']);
  });

  it('names a column whose type moved, and both ends of the move', () => {
    const drift = driftFrom(existing, [
      { name: 'plate', type: 'string', confidence: 'reported', sourceType: '', nullable: null },
      { name: 'miles', type: 'string', confidence: 'reported', sourceType: '', nullable: null },
    ]);
    expect(drift.retyped).toEqual([{ property: 'miles', was: 'number', now: 'string' }]);
  });

  // An untyped column has not changed type — nothing is known about its type at
  // all. Reporting it as drift would make every re-discovery of a source with
  // one odd column read as an incident, and an alarm that cries wolf is worse
  // than no alarm.
  it('says nothing about a column discovery could not type', () => {
    const drift = driftFrom(existing, [
      { name: 'plate', type: 'string', confidence: 'reported', sourceType: '', nullable: null },
      { name: 'miles', type: null, confidence: 'unknown', sourceType: '', nullable: null },
    ]);
    expect(drift.retyped).toEqual([]);
    expect(drift.removed).toEqual([]);
  });

  it('reports a quiet source as quiet rather than as nothing', async () => {
    const discovery = await discoverConnectorSchema({
      connector: connector({ config: { records: [{ plate: 'AB-1', miles: 3 }] } }),
      existing,
    });
    expect(discovery.typeExists).toBe(true);
    expect(discovery.drift).toEqual({ added: [], removed: [], retyped: [] });
  });
});

describe('what discovery refuses to describe', () => {
  // A connector attached to a graph does not read its own config at all — the
  // workflow's source nodes do. Describing that config would describe a source
  // that never loads, and the person reading it has no way to tell.
  it('refuses a connector whose source is a workflow, naming the workflow', async () => {
    await expect(
      discoverConnectorSchema({ connector: connector({ workflowId: 'wf-9' }) }),
    ).rejects.toThrow(/wf-9/);
  });
});
