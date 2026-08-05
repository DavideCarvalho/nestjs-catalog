import type { CatalogConnector } from '@dudousxd/nestjs-catalog';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type FetchContext, fetchSql, toBufferedFetchResult, toRecordStream } from './sources';

/**
 * A stand-in for `mysql2/promise` that hands rows over one at a time.
 *
 * The whole file exists because the alternative — asserting that `fetchSql`
 * returns the right rows — passes identically whether the driver buffered or
 * streamed. What is under test is *when* the driver is asked for the next row,
 * so the fake records exactly that, and the assertions are about the ordering
 * between a pull and a read.
 *
 * Shaped like the real thing rather than like the code under test: a promise
 * wrapper holding a `connection`, whose `query`/`execute` return a command with
 * a `.stream()`. That is the shape mysql2 v3 actually has — `promise.js`
 * constructs `PromiseConnection(coreConnection)`, and `Execute.prototype.stream`
 * is literally assigned from `Query.prototype.stream` — and getting it wrong
 * here would mean testing a driver nobody has.
 */
interface DriverLog {
  /** Every statement the connection was given, in order. */
  statements: string[];
  /** Params bound on the streamed statement, if it was prepared. */
  params: unknown[];
  /** How many rows the fake had handed over each time the consumer took one. */
  pulls: number[];
  ended: boolean;
}

/** As much of `mysql2/promise` as a case here stands in for. */
interface MysqlModuleLike {
  createConnection(url: string): Promise<unknown>;
}

function fakeMysql(rows: unknown[]): { module: MysqlModuleLike; log: DriverLog } {
  const log: DriverLog = { statements: [], params: [], pulls: [], ended: false };

  const command = (params: unknown[]) => {
    log.params = params;
    return {
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          for (let index = 0; index < rows.length; index += 1) {
            log.pulls.push(index + 1);
            yield rows[index];
          }
        },
      }),
    };
  };

  const module = {
    createConnection: () =>
      Promise.resolve({
        query: (sql: string) => {
          log.statements.push(sql);
          return Promise.resolve([[], []]);
        },
        execute: () => Promise.resolve([[], []]),
        end: () => {
          log.ended = true;
          return Promise.resolve();
        },
        connection: {
          query: (sql: string) => {
            log.statements.push(sql);
            return command([]);
          },
          execute: (sql: string, params: unknown[]) => {
            log.statements.push(sql);
            return command(params);
          },
        },
      }),
  };

  return { module, log };
}

/**
 * mysql2 is a real dependency here, so the mock is registered against the
 * specifier the fetcher imports at run time — `importOptional` does a dynamic
 * `import('mysql2/promise')`, which vitest resolves through the same registry as
 * a static one.
 *
 * The mocked module is one stable object that *delegates* rather than a new one
 * per case, because the factory is evaluated once for the whole file: a mock
 * built from whatever `driver` held at that instant would serve the first case's
 * rows to every case after it, which is a suite that passes on stale data.
 */
const driver = vi.hoisted(() => ({
  module: undefined as MysqlModuleLike | undefined,
}));
vi.mock('mysql2/promise', () => ({
  createConnection: (url: string) => {
    if (!driver.module) throw new Error('No driver was installed for this case.');
    return driver.module.createConnection(url);
  },
}));

function connector(config: Record<string, unknown>): CatalogConnector {
  return {
    id: 'c1',
    name: 'Nightly pull',
    kind: 'sql',
    targetType: 'Mvr',
    config: { url: 'mysql://warehouse/db', ...config },
    enabled: true,
    createdBy: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const FULL: Pick<FetchContext, 'state' | 'mode'> = { state: {}, mode: 'full' };

beforeEach(() => {
  driver.module = undefined;
});

describe('toRecordStream', () => {
  it('reads a bare array as a stream with nothing to remember', async () => {
    const stream = toRecordStream([{ a: 1 }, { a: 2 }]);

    expect(stream.streamed).toBe(false);
    expect(await drain(stream.records)).toEqual([{ a: 1 }, { a: 2 }]);
    expect(stream.state()).toBeUndefined();
  });

  it('carries the state a result-shaped fetch reported', async () => {
    const stream = toRecordStream({ records: [{ a: 1 }], state: { watermark: 7 } });

    expect(stream.streamed).toBe(false);
    expect(await drain(stream.records)).toEqual([{ a: 1 }]);
    expect(stream.state()).toEqual({ watermark: 7 });
  });

  it('reports a streamed fetch as streamed and defers its state to a call', async () => {
    // The distinguishing property: a streamed fetch's state is a function,
    // because the value does not exist until the rows have run out.
    let asked = 0;
    const stream = toRecordStream({
      records: fromArray([{ a: 1 }]),
      state: () => {
        asked += 1;
        return { watermark: 9 };
      },
    });

    expect(stream.streamed).toBe(true);
    expect(asked).toBe(0);
    expect(await drain(stream.records)).toEqual([{ a: 1 }]);
    expect(stream.state()).toEqual({ watermark: 9 });
    expect(asked).toBe(1);
  });

  it('never copies an array it was handed', async () => {
    // The array shapes are wrapped rather than buffered, so normalising a fetch
    // that was already whole does not double its memory on the way past.
    const records = [{ a: 1 }, { a: 2 }];
    const stream = toRecordStream(records);
    const seen = await drain(stream.records);

    expect(seen[0]).toBe(records[0]);
    expect(seen[1]).toBe(records[1]);
  });
});

describe('toBufferedFetchResult', () => {
  it('drains a stream into the array shape, state and all', async () => {
    const result = await toBufferedFetchResult({
      records: fromArray([{ a: 1 }, { a: 2 }]),
      state: () => ({ watermark: 3 }),
    });

    expect(result).toEqual({ records: [{ a: 1 }, { a: 2 }], state: { watermark: 3 } });
  });

  it('stops pulling at the limit rather than reading and slicing', async () => {
    // What makes a discovery cheap on a source that streams: it asks for the
    // sample and then stops, instead of reading a table to describe twenty rows
    // of it.
    let pulled = 0;
    async function* many(): AsyncGenerator<unknown> {
      for (let index = 0; index < 10_000; index += 1) {
        pulled += 1;
        yield { index };
      }
    }

    const result = await toBufferedFetchResult({ records: many() }, 3);

    expect(result.records).toHaveLength(3);
    expect(pulled).toBeLessThanOrEqual(4);
  });

  it('reports no state for a stream it cut short', async () => {
    // A watermark from a truncated read names a row the caller never saw, and
    // storing it would skip everything after it on every run after this one.
    const result = await toBufferedFetchResult(
      { records: fromArray([{ a: 1 }, { a: 2 }]), state: () => ({ watermark: 2 }) },
      1,
    );

    expect(result.state).toBeUndefined();
  });

  it('keeps the state of an array shape it merely sliced', async () => {
    // Nothing was cut short: the fetcher read the whole thing and reported where
    // it got to before this saw any of it.
    const result = await toBufferedFetchResult(
      { records: [{ a: 1 }, { a: 2 }], state: { watermark: 2 } },
      1,
    );

    expect(result).toEqual({ records: [{ a: 1 }], state: { watermark: 2 } });
  });
});

describe('a MySQL connector reading its result set', () => {
  it('hands rows over as they are pulled rather than in one go', async () => {
    // The claim the whole change rests on. The consumer takes two rows and
    // stops; a buffered driver would have produced all five before `fetchSql`
    // even returned.
    const { module, log } = fakeMysql([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]);
    driver.module = module;

    const fetched = toRecordStream(
      await fetchSql({ connector: connector({ query: 'select * from big' }), ...FULL }),
    );

    expect(log.pulls).toEqual([]);

    const taken: unknown[] = [];
    for await (const row of fetched.records) {
      taken.push(row);
      if (taken.length === 2) break;
    }

    expect(taken).toEqual([{ id: 1 }, { id: 2 }]);
    expect(log.pulls).toEqual([1, 2]);
  });

  it('reads inside a read-only transaction and closes the connection after', async () => {
    // Unchanged from the buffered read and it has to be: a streamed read is
    // still a read of somebody else's database, and the transaction is what
    // refuses a write whatever the author's query parses as.
    const { module, log } = fakeMysql([{ id: 1 }]);
    driver.module = module;

    const fetched = toRecordStream(
      await fetchSql({ connector: connector({ query: 'select 1' }), ...FULL }),
    );
    await drain(fetched.records);

    expect(log.statements[0]).toBe('START TRANSACTION READ ONLY');
    expect(log.statements).toContain('ROLLBACK');
    expect(log.ended).toBe(true);
  });

  it('closes the connection when the consumer stops early', async () => {
    // The one obligation a streamed read puts on its caller that a buffered one
    // did not. `for await` calls the generator's `return` on a break, which is
    // what unwinds the ROLLBACK and the close.
    const { module, log } = fakeMysql([{ id: 1 }, { id: 2 }, { id: 3 }]);
    driver.module = module;

    const fetched = toRecordStream(
      await fetchSql({ connector: connector({ query: 'select 1' }), ...FULL }),
    );
    for await (const _row of fetched.records) break;

    expect(log.ended).toBe(true);
    expect(log.statements).toContain('ROLLBACK');
  });

  it('prepares the statement when there is a watermark to bind', async () => {
    // `execute` rather than `query`, for the reason the fetcher's comment gives:
    // mysql2's client-side interpolation cannot tell a `?` inside a string
    // literal from a placeholder.
    const { module, log } = fakeMysql([{ id: 4, at: '2026-02-02T00:00:00.000Z' }]);
    driver.module = module;

    const fetched = toRecordStream(
      await fetchSql({
        connector: connector({ query: 'select * from t', watermarkColumn: 'at' }),
        state: { watermark: '2026-02-01T00:00:00.000Z' },
        mode: 'incremental',
      }),
    );
    await drain(fetched.records);

    expect(log.params).toEqual([new Date('2026-02-01T00:00:00.000Z')]);
    expect(log.statements.some((sql) => sql.includes('catalog_incremental'))).toBe(true);
  });

  it('advances the watermark to the largest value it saw, not the last one', async () => {
    // A running maximum has to be a maximum. Rows out of order are ordinary — a
    // query with no ORDER BY makes no promise — and taking the last row would
    // park the watermark below rows this run already loaded.
    const { module } = fakeMysql([
      { id: 1, n: 5 },
      { id: 2, n: 40 },
      { id: 3, n: 9 },
    ]);
    driver.module = module;

    const fetched = toRecordStream(
      await fetchSql({
        connector: connector({ query: 'select * from t', watermarkColumn: 'n' }),
        state: { watermark: 1 },
        mode: 'incremental',
      }),
    );
    await drain(fetched.records);

    expect(fetched.state()).toEqual({ watermark: 40 });
  });

  it('compares numerically when the driver hands numbers back as strings', async () => {
    // MySQL returns BIGINT and DECIMAL as strings to keep the precision, and
    // `"9" > "10"` is true lexicographically — which would park the watermark on
    // the ninth row of an autoincrementing id and never move it again.
    const { module } = fakeMysql([{ id: '9' }, { id: '10' }]);
    driver.module = module;

    const fetched = toRecordStream(
      await fetchSql({
        connector: connector({ query: 'select * from t', watermarkColumn: 'id' }),
        state: { watermark: '1' },
        mode: 'incremental',
      }),
    );
    await drain(fetched.records);

    expect(fetched.state()).toEqual({ watermark: '10' });
  });

  it('reports nothing to save when the watermark did not move', async () => {
    const { module } = fakeMysql([{ id: 1, n: 1 }]);
    driver.module = module;

    const fetched = toRecordStream(
      await fetchSql({
        connector: connector({ query: 'select * from t', watermarkColumn: 'n' }),
        state: { watermark: 4 },
        mode: 'incremental',
      }),
    );
    await drain(fetched.records);

    expect(fetched.state()).toBeUndefined();
  });

  it('refuses, after the last row, when no row carried the watermark column', async () => {
    // Loud rather than silent, exactly as the buffered read was. A run that
    // cannot advance would read the same rows again for ever, and the only
    // symptom would be a load that keeps writing the same numbers.
    const { module } = fakeMysql([{ id: 1 }, { id: 2 }]);
    driver.module = module;

    const fetched = toRecordStream(
      await fetchSql({
        connector: connector({ query: 'select * from t', watermarkColumn: 'updated_at' }),
        state: {},
        mode: 'incremental',
      }),
    );
    await drain(fetched.records);

    expect(() => fetched.state()).toThrow(/none of them carried "updated_at"/);
  });

  it('says nothing about a watermark when the run is a full one', async () => {
    const { module } = fakeMysql([{ id: 1 }]);
    driver.module = module;

    const fetched = toRecordStream(
      await fetchSql({
        connector: connector({ query: 'select * from t', watermarkColumn: 'id' }),
        ...FULL,
      }),
    );
    await drain(fetched.records);

    expect(fetched.state()).toBeUndefined();
  });

  it('falls back to the buffered read when the driver has no core connection', async () => {
    // A shape mismatch in somebody's mysql2 alias must not turn a working
    // connector into a failed load. The fallback is what every SQL connector did
    // before streaming existed, so it is a return to the old behaviour rather
    // than a degradation — and the fetcher warns, because a silent one would
    // leave an operator believing a load is bounded when it is not.
    driver.module = {
      createConnection: () =>
        Promise.resolve({
          query: (sql: string) =>
            Promise.resolve(sql.startsWith('select') ? [[{ id: 1 }, { id: 2 }], []] : [[], []]),
          execute: () => Promise.resolve([[], []]),
          end: () => Promise.resolve(),
        }),
    };

    const fetched = toRecordStream(
      await fetchSql({ connector: connector({ query: 'select * from t' }), ...FULL }),
    );

    expect(await drain(fetched.records)).toEqual([{ id: 1 }, { id: 2 }]);
  });
});

async function* fromArray(values: unknown[]): AsyncGenerator<unknown> {
  for (const value of values) yield value;
}

async function drain(records: AsyncIterable<unknown>): Promise<unknown[]> {
  const collected: unknown[] = [];
  for await (const record of records) collected.push(record);
  return collected;
}
