import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  describeOverlayStoreContract,
  describeWorkspaceStoreContract,
} from '../../../test/workspace-store-contract';
import type { CatalogDrizzleRun } from './connection';
import { catalogDrizzleSql } from './ddl';
import { DrizzleCatalogOverlayStore } from './overlay.store';
import { catalogDrizzleTables } from './schema';
import { DrizzleWorkspaceStore } from './workspace.store';

/**
 * The Drizzle stores on a real Postgres, as roles a production host would use:
 *
 * - `catalog_owner` creates the tables. It is not a superuser and has no
 *   privilege beyond CREATE on the database's `public` schema.
 * - `catalog_app` runs the stores. It holds only SELECT, INSERT, UPDATE and
 *   DELETE on the tables it is granted.
 *
 * The contract runs twice: once handed a bare Drizzle database, and once through
 * a host transaction wrapper on tables with FORCE row security, where the
 * policy admits a row only while the wrapper's setting is on. The second is the
 * shape a host like one that sets tenant context per transaction needs, and the
 * last case proves the stores issue nothing outside the wrapper.
 */
let container: StartedPostgreSqlContainer;
let ownerPool: Pool;
let appPool: Pool;

const RLS_PREFIX = 'rls_catalog_';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('catalog')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();

  const admin = new Pool({ connectionString: container.getConnectionUri() });
  await admin.query(`
    CREATE ROLE catalog_owner LOGIN PASSWORD 'owner' NOSUPERUSER NOCREATEDB NOCREATEROLE;
    CREATE ROLE catalog_app LOGIN PASSWORD 'app' NOSUPERUSER NOCREATEDB NOCREATEROLE;
    GRANT USAGE, CREATE ON SCHEMA public TO catalog_owner;
    GRANT USAGE ON SCHEMA public TO catalog_app;
  `);
  await admin.end();

  const uri = (user: string, password: string) =>
    `postgres://${user}:${password}@${container.getHost()}:${container.getPort()}/catalog`;
  ownerPool = new Pool({ connectionString: uri('catalog_owner', 'owner') });
  appPool = new Pool({ connectionString: uri('catalog_app', 'app') });

  // As the owner, with nothing but the shipped SQL.
  await ownerPool.query(catalogDrizzleSql());
  await ownerPool.query(catalogDrizzleSql({ prefix: RLS_PREFIX }));

  const grants: string[] = [];
  for (const prefix of ['catalog_', RLS_PREFIX]) {
    for (const table of Object.values(catalogDrizzleTables({ prefix }))) {
      const name = getTableConfig(table).name;
      grants.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${name}" TO catalog_app;`);
      if (prefix === RLS_PREFIX) {
        grants.push(
          `ALTER TABLE "${name}" ENABLE ROW LEVEL SECURITY;`,
          `ALTER TABLE "${name}" FORCE ROW LEVEL SECURITY;`,
          `CREATE POLICY "${name}_gate" ON "${name}" FOR ALL TO catalog_app
             USING (current_setting('app.catalog_gate', true) = 'open')
             WITH CHECK (current_setting('app.catalog_gate', true) = 'open');`,
        );
      }
    }
  }
  await ownerPool.query(grants.join('\n'));
}, 300_000);

afterAll(async () => {
  await ownerPool?.end();
  await appPool?.end();
  await container?.stop();
});

/** The host's wrapper: one transaction, the gate opened inside it, counted. */
const wrapped = { calls: 0 };
const gatedRun: CatalogDrizzleRun = (work) => {
  wrapped.calls += 1;
  return drizzle(appPool).transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.catalog_gate', 'open', true)`);
    return work(tx);
  });
};

describe('Drizzle stores, given a database', () => {
  describeWorkspaceStoreContract(() => ({
    name: 'drizzle (db)',
    store: new DrizzleWorkspaceStore({ db: drizzle(appPool) }),
  }));
  describeOverlayStoreContract(
    () => new DrizzleCatalogOverlayStore({ db: drizzle(appPool), key: 'db-contract' }),
  );
});

describe('Drizzle stores, through a host transaction wrapper under row security', () => {
  describeWorkspaceStoreContract(() => ({
    name: 'drizzle (run)',
    store: new DrizzleWorkspaceStore({ run: gatedRun, prefix: RLS_PREFIX }),
  }));
  describeOverlayStoreContract(
    () => new DrizzleCatalogOverlayStore({ run: gatedRun, prefix: RLS_PREFIX, key: 'run' }),
  );

  it('goes through the wrapper for every call, and sees nothing without it', async () => {
    const store = new DrizzleWorkspaceStore({ run: gatedRun, prefix: RLS_PREFIX });
    const before = wrapped.calls;
    const saved = await store.saveQuery({ name: 'gated', sql: 'SELECT 1' }, 'a');
    await store.getSavedQuery(saved.id);
    expect(wrapped.calls - before).toBe(2);

    // The same tables, the same role, no wrapper: row security hides them.
    const bare = new DrizzleWorkspaceStore({ db: drizzle(appPool), prefix: RLS_PREFIX });
    expect(await bare.getSavedQuery(saved.id)).toBeUndefined();
    await expect(bare.saveQuery({ name: 'ungated', sql: 'SELECT 1' }, 'a')).rejects.toThrow();
  });

  it('commits a save and its first revision together, or neither', async () => {
    let failNext = false;
    const failing: CatalogDrizzleRun = (work) =>
      gatedRun(async (db) => {
        const result = await work(db);
        if (failNext) throw new Error('host refused the commit');
        return result;
      });
    const store = new DrizzleWorkspaceStore({ run: failing, prefix: RLS_PREFIX });
    const marker = `SELECT 'rolled-back-${Date.now()}'`;
    failNext = true;
    await expect(store.saveQuery({ name: 'rolled-back', sql: marker }, 'a')).rejects.toThrow(
      'host refused the commit',
    );
    failNext = false;
    const remaining = await gatedRun(
      (db) =>
        db.execute(
          sql`SELECT (SELECT count(*) FROM ${sql.identifier(`${RLS_PREFIX}saved_query`)} WHERE sql = ${marker}) AS q,
                   (SELECT count(*) FROM ${sql.identifier(`${RLS_PREFIX}revision`)} WHERE body = ${marker}) AS r`,
        ) as Promise<{ rows: Array<Record<string, string>> }>,
    );
    expect(remaining.rows[0]).toEqual({ q: '0', r: '0' });
  });
});

describe('the shipped SQL', () => {
  it('creates exactly the columns the Drizzle tables define', async () => {
    for (const table of Object.values(catalogDrizzleTables())) {
      const config = getTableConfig(table);
      const result = await ownerPool.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
        [config.name],
      );
      expect(result.rows.map((row) => [row.column_name, row.is_nullable === 'NO'])).toEqual(
        config.columns.map((column) => [column.name, column.notNull]),
      );
    }
  });

  it('can be applied twice', async () => {
    await expect(ownerPool.query(catalogDrizzleSql())).resolves.toBeDefined();
  });
});
