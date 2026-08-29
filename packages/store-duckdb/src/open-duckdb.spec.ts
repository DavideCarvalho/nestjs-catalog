import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DuckDbConnection } from './duckdb';
import { openDuckDb } from './duckdb';

// DuckDB is in-process — no container, no `.db.spec.ts` suffix, runs in the default suite.

let root: string;
const opened: DuckDbConnection[] = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'catalog-duckdb-open-'));
});

afterAll(async () => {
  await Promise.all(opened.map((connection) => connection.close()));
  rmSync(root, { recursive: true, force: true });
});

describe('openDuckDb', () => {
  it('opens a connection that can run a query', async () => {
    const connection = await openDuckDb({ root });
    opened.push(connection);
    expect(await connection.rows('SELECT 1 AS n')).toEqual([{ n: 1 }]);
  });

  it('applies memoryLimit and threads rather than leaving them at DuckDB defaults', async () => {
    const connection = await openDuckDb({ root, memoryLimit: '256MB', threads: 3 });
    opened.push(connection);

    // DuckDB normalises the decimal-megabyte input to a binary-mebibyte display value —
    // 256,000,000 bytes / 1,048,576 rounds to 244.1 MiB — so the setting is confirmed applied
    // by asserting DuckDB's own normalised report, not the string this test passed in.
    expect(await connection.rows("SELECT current_setting('memory_limit') AS value")).toEqual([
      { value: '244.1 MiB' },
    ]);

    // `current_setting` reports an integer column, which this driver surfaces as a bigint
    // (unlike a plain `SELECT ... AS n`, which comes back as `number`) — so the comparison
    // value must be a bigint literal too.
    expect(await connection.rows("SELECT current_setting('threads') AS value")).toEqual([
      { value: 3n },
    ]);
  });
});
