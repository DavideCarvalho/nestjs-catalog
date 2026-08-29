import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDuckDb, quoteLiteral } from './duckdb';

describe('quoteLiteral', () => {
  it('doubles an embedded quote, so a path with one cannot end the string', () => {
    expect(quoteLiteral("o'brien")).toBe("'o''brien'");
  });

  it('leaves an ordinary path alone but wraps it', () => {
    expect(quoteLiteral('s3://bucket/prefix/mvr/run-1/*.parquet')).toBe(
      "'s3://bucket/prefix/mvr/run-1/*.parquet'",
    );
  });
});

describe('DuckDbConnection.openStreamConnection', () => {
  it('keeps yielding every row while another query runs on the primary connection', async () => {
    // CRITICAL 1: a stream and any other query on the SAME connection corrupt each other --
    // an interleaved query silently truncates the stream (a chunk reporting 0 rows, not an
    // error), which a `for await` reads as the stream simply ending. A dedicated connection,
    // opened from the same engine, must not exhibit that: this is the regression test for the
    // fix `stream`'s own docblock in `duckdb.ts` cites.
    const root = mkdtempSync(join(tmpdir(), 'catalog-duckdb-streamconn-'));
    const connection = await openDuckDb({ root });
    try {
      await connection.run('CREATE TABLE t AS SELECT range AS n FROM range(10000)');
      const streamConnection = await connection.openStreamConnection();
      try {
        const iterator = streamConnection
          .stream('SELECT n FROM t ORDER BY n')
          [Symbol.asyncIterator]();
        const seen: number[] = [];
        // Pull past the first chunk (2,048 rows) so a truncation there would already show.
        for (let index = 0; index < 2049; index += 1) {
          const step = await iterator.next();
          if (step.done) break;
          seen.push(Number(step.value.n));
        }
        expect(seen.length).toBe(2049);

        // An unrelated query on the PRIMARY connection, while the stream above is still open
        // and mid-iteration on its own, dedicated connection.
        const other = await connection.rows('SELECT 1 AS x');
        expect(other).toEqual([{ x: 1 }]);

        let step = await iterator.next();
        while (!step.done) {
          seen.push(Number(step.value.n));
          step = await iterator.next();
        }
        expect(seen).toHaveLength(10000);
        expect(seen[0]).toBe(0);
        expect(seen[9999]).toBe(9999);
      } finally {
        await streamConnection.close();
      }
    } finally {
      await connection.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
