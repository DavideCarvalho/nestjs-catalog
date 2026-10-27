import 'reflect-metadata';
import type { CatalogObjectTypeDef } from '@dudousxd/nestjs-catalog';
import type { EntityManager } from '@mikro-orm/sql';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MYSQL_DIALECT, POSTGRES_DIALECT } from './dialect';
import { MySqlWarehouseStore, PostgresWarehouseStore } from './warehouse.store';

/**
 * What the store tells an operator when it could not add an object-table index.
 *
 * The advice is to run the statement by hand, and what that costs differs by
 * engine: MySQL's `ADD INDEX` is online, Postgres's plain `CREATE INDEX` blocks
 * writes to the table while it builds. Telling a Postgres operator the
 * statement "does not block writes" sends them to stall a busy table.
 */

const TYPE: CatalogObjectTypeDef = {
  name: 'Mvr',
  displayName: 'Vehicle',
  pluralDisplayName: 'Vehicles',
  group: 'Fleet',
  tableName: 'obj_mvr',
  enriched: false,
  primaryKey: [],
  properties: [],
  relations: [],
};

/** A table that exists with every reserved column and no indexes, on which adding one fails. */
function storeWhereIndexesFail(make: (em: EntityManager) => MySqlWarehouseStore, nameKey: string) {
  const execute = vi.fn(async (sql: string) => {
    if (/information_schema\.COLUMNS|information_schema\.columns/.test(sql)) {
      return ['_row', '_snapshot_id', '_principal_id', '_loaded_at', '_batch'].map((name) => ({
        [nameKey]: name,
      }));
    }
    if (/STATISTICS|pg_indexes/.test(sql)) return [];
    if (/INDEX/.test(sql)) throw new Error('permission denied');
    return [];
  });
  const em: EntityManager = Object.create(null);
  Object.assign(em, { fork: () => em, getConnection: () => ({ execute }) });
  return make(em);
}

afterEach(() => vi.restoreAllMocks());

async function warnings(store: MySqlWarehouseStore): Promise<string[]> {
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  await store.ensureType(TYPE);
  return warn.mock.calls.map((call) => String(call[0]));
}

describe('the advice when an index cannot be added', () => {
  it('on MySQL, hands over the ADD INDEX it tried, which is online', async () => {
    const messages = await warnings(
      storeWhereIndexesFail(
        (em) => new MySqlWarehouseStore(em),
        MYSQL_DIALECT.existingColumnsQuery().nameKey,
      ),
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain(
      'ALTER TABLE `obj_mvr` ADD INDEX `ix_snapshot_batch` (`_snapshot_id`, `_batch`)',
    );
    expect(messages[1]).toContain(
      'ALTER TABLE `obj_mvr` ADD INDEX `ix_snapshot_row` (`_snapshot_id`, `_row`)',
    );
    for (const message of messages) expect(message).toContain('does not block writes');
  });

  it('on Postgres, hands over CREATE INDEX CONCURRENTLY and does not call the plain one online', async () => {
    const messages = await warnings(
      storeWhereIndexesFail(
        (em) => new PostgresWarehouseStore(em),
        POSTGRES_DIALECT.existingColumnsQuery().nameKey,
      ),
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "obj_mvr_ix_snapshot_batch" ON "obj_mvr" ("_snapshot_id", "_batch")',
    );
    expect(messages[1]).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "obj_mvr_ix_snapshot_row" ON "obj_mvr" ("_snapshot_id", "_row")',
    );
    for (const message of messages) {
      expect(message).not.toContain('it is online and does not block writes');
      expect(message).toContain('README');
    }
  });
});
