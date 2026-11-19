import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogDrizzleRunner } from './connection';
import { catalogDrizzleSql } from './ddl';
import { MAX_CATALOG_TABLE_PREFIX_LENGTH, catalogDrizzleTables } from './schema';

describe('catalogDrizzleSql', () => {
  it('matches the SQL file the package ships', () => {
    // The file is what a host copies into its migrations; the function is what
    // the tests apply. They are the same text, or one of them is lying.
    const shipped = readFileSync(join(__dirname, '..', 'sql', 'catalog.sql'), 'utf8');
    expect(catalogDrizzleSql()).toBe(shipped);
  });

  it('puts the prefix on every table and index name', () => {
    const ddl = catalogDrizzleSql({ prefix: 'oracle_catalog_' });
    const names = [...ddl.matchAll(/(?:TABLE|INDEX) IF NOT EXISTS "([^"]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) expect(name?.startsWith('oracle_catalog_')).toBe(true);
  });

  it('qualifies tables with a schema when one is named', () => {
    const ddl = catalogDrizzleSql({ schema: 'catalog' });
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "catalog"."catalog_saved_query"');
    expect(ddl).toContain('ON "catalog"."catalog_saved_query" ("folder")');
  });

  it('grants, owns and creates nothing beyond tables and indexes', () => {
    const ddl = catalogDrizzleSql();
    expect(ddl).not.toMatch(/\b(GRANT|OWNER|EXTENSION|ROLE|SCHEMA|SECURITY DEFINER)\b/i);
  });

  it('knows its longest derived name', () => {
    const names = [
      ...catalogDrizzleSql({ prefix: '' }).matchAll(/(?:TABLE|INDEX) IF NOT EXISTS "([^"]+)"/g),
    ];
    const longest = Math.max(...names.map((m) => Buffer.byteLength(m[1] ?? '')));
    expect(longest + MAX_CATALOG_TABLE_PREFIX_LENGTH).toBe(63);
  });

  it('treats the public schema as no schema', () => {
    expect(catalogDrizzleSql({ schema: 'public' })).toBe(catalogDrizzleSql());
  });

  it('keeps every name within 63 bytes at the longest prefix it accepts', () => {
    const prefix = 'p'.repeat(MAX_CATALOG_TABLE_PREFIX_LENGTH);
    const ddl = catalogDrizzleSql({ prefix });
    const names = [...ddl.matchAll(/(?:TABLE|INDEX) IF NOT EXISTS "([^"]+)"/g)].map((m) => m[1]);
    expect(Math.max(...names.map((name) => Buffer.byteLength(name ?? '')))).toBe(63);
    expect(() => catalogDrizzleTables({ prefix: `${prefix}p` })).toThrow(/at most 17/);
  });

  it('refuses a prefix that would need quoting', () => {
    expect(() => catalogDrizzleTables({ prefix: 'Catalog-' })).toThrow(/table prefix/);
    expect(() => catalogDrizzleTables({ prefix: '' })).not.toThrow();
  });
});

describe('catalogDrizzleRunner', () => {
  it('uses the host runner as given', async () => {
    const run = async <T>(work: (db: never) => Promise<T>) => work(undefined as never);
    expect(catalogDrizzleRunner({ run })).toBe(run);
  });

  it('refuses a connection with neither form', () => {
    expect(() => catalogDrizzleRunner({} as never)).toThrow(/pass either `db`/);
  });
});
