import type { ClickHouseClient } from '@clickhouse/client';
import type { CatalogObjectTypeDef, CatalogPropertyDef } from '@dudousxd/nestjs-catalog';
import { describe, expect, it, vi } from 'vitest';
import { refreshView, relationsFor } from './query';

/**
 * What this adapter's committed view calls its columns.
 *
 * The behaviour itself is pinned end to end by the shared store contract, which
 * runs against a real ClickHouse: a property named `Asset Id`, written from a
 * record keyed `Asset Id`, read back with its value. That is the case that
 * matters, because the failure it guards against was invisible in the SQL —
 * every statement was well-formed and every load committed.
 *
 * These cases exist for the two things that suite cannot see. The first is the
 * *shape* of the alias: a view built for a type whose property names are
 * ordinary identifiers is byte-identical to the one this adapter has always
 * built, and "byte-identical" is a claim about the statement rather than about a
 * cell. The second is `relationsFor`, which the container suite never reaches:
 * `queryRelations` only calls it when the store is mounted WITH a registry, and
 * this adapter is normally mounted without one — the fallback that reads
 * `system.columns` is what runs there. So the schema panel a registry-backed
 * deployment gets is unexercised by any engine, and it is the panel that tells
 * somebody what to type.
 */

function property(name: string, order: number): CatalogPropertyDef {
  return {
    name,
    displayName: name,
    type: 'string',
    columnName: name,
    nullable: true,
    primary: false,
    hidden: false,
    order,
    enriched: false,
  };
}

/**
 * A type carrying one name of each kind.
 *
 * `Kept__Name` is the interesting one and is not decoration. It is a legal SQL
 * identifier, so it is a name a deployment can be holding today; its doubled
 * underscore collapses when cleaned, so it is one of exactly two shapes whose
 * view column would MOVE if the alias were cleaned unconditionally. It sits in
 * the same statement as `Asset Id` so both halves of the rule are read off one
 * assertion.
 */
const TYPE: CatalogObjectTypeDef = {
  name: 'Mvr',
  displayName: 'Vehicle',
  pluralDisplayName: 'Vehicles',
  group: 'Fleet',
  tableName: 'obj_mvr',
  enriched: true,
  primaryKey: ['id'],
  properties: [property('id', 0), property('Asset Id', 1), property('Kept__Name', 2)],
  relations: [],
};

/** A client that records the DDL rather than sending it. */
function clientRecording(viewExists: boolean) {
  // The parameter is declared rather than inferred: `vi.fn(async () => …)` types
  // its calls as a zero-length tuple, so `call[0]` is a compile error the spec
  // typechecker catches and `statements()` below could not be written at all.
  const command = vi.fn(async (_request: { query: string }) => undefined);
  const client: ClickHouseClient = Object.create(null);
  return {
    client: Object.assign(client, {
      command,
      query: async () => ({ json: async () => [{ n: viewExists ? 1 : 0 }] }),
    }),
    statements: () => command.mock.calls.map((call) => call[0].query),
  };
}

describe('the committed view’s output columns', () => {
  it('aliases a name SQL cannot take to the column it was cleaned into', async () => {
    const recorder = clientRecording(false);

    await refreshView(recorder.client, TYPE, 'snap-1');

    const create = recorder.statements().find((sql) => /CREATE OR REPLACE VIEW/.test(sql)) ?? '';
    // The fix. `AS \`Asset Id\`` went through `ident`, which refuses rather than
    // escapes, so this statement could not be built at all — and it is that
    // impossibility, not anything about ClickHouse, that forced publishers to
    // rename the property and load NULL into every row of it.
    expect(create).toContain('`Asset_Id` AS `Asset_Id`');
  });

  it('leaves a name SQL can take exactly where it was, doubled underscore and all', async () => {
    const recorder = clientRecording(false);

    await refreshView(recorder.client, TYPE, 'snap-1');

    const create = recorder.statements().find((sql) => /CREATE OR REPLACE VIEW/.test(sql)) ?? '';
    // **The compatibility promise, in the statement.** `Kept__Name` cleans to
    // the column `Kept_Name`, and this view has always exposed it as
    // `Kept__Name`. Somebody is selecting that column by name. Cleaning the
    // alias unconditionally would tidy it to `Kept_Name` and break that query
    // silently, so the alias is only cleaned when it has to be.
    expect(create).toContain('`Kept_Name` AS `Kept__Name`');
    expect(create).toContain('`id` AS `id`');
  });

  it('is built under the shadow name and exchanged, as it always was', async () => {
    // Pinned alongside, because the alias change touches the same statement as
    // this adapter's whole atomicity story: `CREATE OR REPLACE VIEW` drops the
    // name on ClickHouse, so the definition is built where nobody reads and the
    // commit is the exchange.
    const recorder = clientRecording(true);

    await refreshView(recorder.client, TYPE, 'snap-1');

    const statements = recorder.statements();
    expect(statements.some((sql) => /CREATE OR REPLACE VIEW `mvr__next`/.test(sql))).toBe(true);
    expect(statements.some((sql) => /EXCHANGE TABLES `mvr` AND `mvr__next`/.test(sql))).toBe(true);
  });
});

describe('what the schema panel offers for that view', () => {
  it('names the columns the view actually has, not what the type calls them', () => {
    const [current] = relationsFor([TYPE]);

    expect(current.kind).toBe('current');
    expect(current.name).toBe('mvr');
    // `Asset Id` here would be an autocompletion that cannot be typed into a
    // statement: the view has no such column, and the person the panel is for is
    // the person least able to work out why.
    expect(current.columns.map((column) => column.name)).toEqual([
      'id',
      'Asset_Id',
      'Kept__Name',
      '_snapshot',
    ]);
  });

  it('names the physical columns for the history table, which is a different list', () => {
    const [, history] = relationsFor([TYPE]);

    expect(history.kind).toBe('history');
    expect(history.name).toBe('obj_mvr');
    // The two lists genuinely differ, and only for `Kept__Name`: the table holds
    // the cleaned column, the view exposes the property's own name. A reader
    // joining the view to the table has to spell that field two ways, which is
    // an oddity worth stating rather than one worth "fixing" by renaming a
    // column somebody is already selecting.
    expect(history.columns.map((column) => column.name)).toContain('Kept_Name');
    expect(history.columns.map((column) => column.name)).toContain('Asset_Id');
  });
});
