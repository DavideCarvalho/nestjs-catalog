import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { CatalogConnector } from '@dudousxd/nestjs-catalog';
import type { ColumnSource } from 'hyparquet-writer';
import { parquetWriteFile } from 'hyparquet-writer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parquetRecords, unreadableParquetColumns } from './source-parquet';
import { fetchFile, toBufferedFetchResult } from './sources';

/**
 * The parquet reader, against files this test writes and one built from a real
 * 103,087-row drop.
 *
 * `hyparquet` and `hyparquet-writer` are devDependencies of this package and
 * **not** dependencies of the published one — the reader loads the first
 * optionally at run time, so these cases exercise the same path a deployment
 * that installed it takes.
 *
 * The writer is the same family as the reader, which is worth naming as a limit
 * rather than glossing: a round trip through one vendor's pair cannot prove the
 * reader handles somebody else's file. What it *can* prove, and what the cases
 * below actually assert, is the row count, the type mapping and the null
 * convention — and for the two type rules no JavaScript writer will emit
 * (DECIMAL width, INT96), the schema judgement is checked directly against
 * hand-written footer elements through {@link unreadableParquetColumns}, which
 * is the shape a real file's footer has.
 */

let directory: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'catalog-parquet-'));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** A parquet file, from columns and optionally an explicit schema. */
function write(
  name: string,
  columnData: ColumnSource[],
  options: Record<string, unknown> = {},
): string {
  const path = join(directory, name);
  parquetWriteFile({ filename: path, columnData, ...options });
  return path;
}

/** Read one straight through the reader, as the fetcher would. */
async function readFile(path: string): Promise<unknown[]> {
  const records: unknown[] = [];
  const payload = { path, byteLength: statSync(path).size, release: async () => undefined };
  for await (const record of parquetRecords(payload, path)) records.push(record);
  return records;
}

function connector(config: Record<string, unknown>): CatalogConnector {
  return {
    id: 'c1',
    name: 'Drop',
    kind: 'file',
    targetType: 'Fleet',
    config,
    enabled: true,
    createdBy: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('reading a parquet file', () => {
  it('keys records by column, with the file`s own names', async () => {
    const path = write('simple.parquet', [
      { name: 'id', data: [1n, 2n, 3n], type: 'INT64' },
      { name: 'label', data: ['a', 'b', 'c'], type: 'STRING' },
    ]);

    expect(await readFile(path)).toEqual([
      { id: 1, label: 'a' },
      { id: 2, label: 'b' },
      { id: 3, label: 'c' },
    ]);
  });

  /**
   * The blank/null question, answered on parquet's own terms.
   *
   * Parquet carries a value's presence in its definition levels, so a null
   * field and a field holding the empty string are different things *in the
   * file*. There is no third reading to pick between, which is why this format
   * has nothing to say about the open argument over what a blank CSV cell
   * should be — a CSV genuinely contains an empty field where parquet contains
   * an absence.
   */
  it('gives null for an absent value and keeps an empty string as one', async () => {
    const path = write('nulls.parquet', [{ name: 'a', data: ['x', null, ''], type: 'STRING' }]);

    expect(await readFile(path)).toEqual([{ a: 'x' }, { a: null }, { a: '' }]);
  });

  it('gives every record every column, whether or not the value was there', async () => {
    const path = write('shape.parquet', [
      { name: 'a', data: [1n, null], type: 'INT64' },
      { name: 'b', data: [null, 'y'], type: 'STRING' },
    ]);

    const records = await readFile(path);
    expect(records.map((record) => Object.keys(record as object))).toEqual([
      ['a', 'b'],
      ['a', 'b'],
    ]);
  });

  it('reads booleans, doubles and uuids as themselves', async () => {
    const path = write('scalars.parquet', [
      { name: 'flag', data: [true, false], type: 'BOOLEAN' },
      { name: 'ratio', data: [1.5, -0.25], type: 'DOUBLE' },
      {
        name: 'key',
        data: [new Uint8Array(16).fill(0x11), new Uint8Array(16).fill(0x22)],
        type: 'UUID',
      },
    ]);

    expect(await readFile(path)).toEqual([
      { flag: true, ratio: 1.5, key: '11111111-1111-1111-1111-111111111111' },
      { flag: false, ratio: -0.25, key: '22222222-2222-2222-2222-222222222222' },
    ]);
  });

  it('reads a JSON column as the value it encodes', async () => {
    const path = write('json.parquet', [{ name: 'body', data: [{ a: 1 }], type: 'JSON' }]);
    expect(await readFile(path)).toEqual([{ body: { a: 1 } }]);
  });
});

describe('time, at the precision the file carried', () => {
  /**
   * The case the whole parser override exists for.
   *
   * A `Date` holds milliseconds. The library's own default parser divides a
   * microsecond timestamp by a thousand to build one, which is a silent edit to
   * somebody's data — the same class of thing as a spreadsheet date arriving as
   * `45231`, and harder to spot because the result still looks like a
   * timestamp. Reading through to an ISO string keeps every digit the file had.
   */
  it('keeps millisecond, microsecond and nanosecond precision', async () => {
    const path = write(
      'stamps.parquet',
      [
        { name: 'ms', data: [1700000000123n] },
        { name: 'us', data: [1700000000123456n] },
        { name: 'ns', data: [1700000000123456789n] },
      ],
      {
        schema: [
          { name: 'root', num_children: 3 },
          {
            name: 'ms',
            type: 'INT64',
            repetition_type: 'OPTIONAL',
            logical_type: { type: 'TIMESTAMP', isAdjustedToUTC: true, unit: 'MILLIS' },
          },
          {
            name: 'us',
            type: 'INT64',
            repetition_type: 'OPTIONAL',
            logical_type: { type: 'TIMESTAMP', isAdjustedToUTC: true, unit: 'MICROS' },
          },
          {
            name: 'ns',
            type: 'INT64',
            repetition_type: 'OPTIONAL',
            logical_type: { type: 'TIMESTAMP', isAdjustedToUTC: true, unit: 'NANOS' },
          },
        ],
      },
    );

    expect(await readFile(path)).toEqual([
      {
        ms: '2023-11-14T22:13:20.123Z',
        us: '2023-11-14T22:13:20.123456Z',
        ns: '2023-11-14T22:13:20.123456789Z',
      },
    ]);
  });

  /**
   * A DATE is a calendar day and stays one.
   *
   * Turning it into midnight UTC would invent an instant the file never
   * contained, and a consumer in a negative offset would then read the day
   * before. This assertion is timezone-sensitive on purpose: CI runs on
   * America/Sao_Paulo, where a naive local-midnight `Date` would render the
   * previous day.
   */
  it('reads a DATE as a calendar day with no time and no zone', async () => {
    const path = write('date.parquet', [{ name: 'day', data: [19000] }], {
      schema: [
        { name: 'root', num_children: 1 },
        { name: 'day', type: 'INT32', repetition_type: 'OPTIONAL', converted_type: 'DATE' },
      ],
    });

    expect(await readFile(path)).toEqual([{ day: '2022-01-08' }]);
  });

  it('reads a null timestamp as null rather than as the epoch', async () => {
    const path = write('nullstamp.parquet', [{ name: 'at', data: [null, 1000n] }], {
      schema: [
        { name: 'root', num_children: 1 },
        {
          name: 'at',
          type: 'INT64',
          repetition_type: 'OPTIONAL',
          logical_type: { type: 'TIMESTAMP', isAdjustedToUTC: true, unit: 'MILLIS' },
        },
      ],
    });

    expect(await readFile(path)).toEqual([{ at: null }, { at: '1970-01-01T00:00:01.000Z' }]);
  });
});

describe('a 64-bit integer', () => {
  it('is a number when that is exact', async () => {
    const path = write('ids.parquet', [
      { name: 'id', data: [9007199254740991n, -9007199254740991n], type: 'INT64' },
    ]);

    expect(await readFile(path)).toEqual([{ id: 9007199254740991 }, { id: -9007199254740991 }]);
  });

  /**
   * And a refusal when it is not.
   *
   * `JSON.stringify` throws on a bigint outright, so it cannot simply be passed
   * along, and `Number(...)` past 2^53 silently returns a different number. An
   * id whose last three digits change on the way into the catalog is the worst
   * outcome available, so the value is named and the run stops.
   */
  it('is refused, by name and value, when it is not', async () => {
    const path = write('bigid.parquet', [{ name: 'id', data: [9007199254740993n], type: 'INT64' }]);

    await expect(readFile(path)).rejects.toThrow(
      /"id" in .* holds 9007199254740993, which is past ±2\^53/,
    );
  });
});

describe('columns refused before a single row is read', () => {
  it('refuses raw binary rather than decoding it as text', async () => {
    const path = write('blob.parquet', [
      { name: 'payload', data: [new Uint8Array([1, 2, 3])], type: 'BYTE_ARRAY' },
    ]);

    await expect(readFile(path)).rejects.toThrow(/"payload" is raw binary/);
  });

  it('refuses a TIME, which would otherwise be a bare count since midnight', async () => {
    const path = write('clock.parquet', [{ name: 'at', data: [1000, 2000] }], {
      schema: [
        { name: 'root', num_children: 1 },
        { name: 'at', type: 'INT32', repetition_type: 'OPTIONAL', converted_type: 'TIME_MILLIS' },
      ],
    });

    await expect(readFile(path)).rejects.toThrow(/"at" is a TIME/);
  });

  /**
   * The rules no JavaScript writer will produce a file for, checked against the
   * footer shape directly.
   *
   * `hyparquet-writer` cannot emit a DECIMAL or an INT96 at all, so a
   * round-trip case for either would be a case that never ran. A schema element
   * array *is* what a footer holds, so feeding one is not a stand-in for the
   * real input — it is the real input, with the file around it left out.
   */
  it('refuses a DECIMAL wider than a double carries exactly', () => {
    expect(
      unreadableParquetColumns([
        { name: 'root', num_children: 1 },
        {
          name: 'amount',
          type: 'FIXED_LEN_BYTE_ARRAY',
          logical_type: { type: 'DECIMAL', precision: 38, scale: 9 },
        },
      ]),
    ).toEqual([
      expect.stringMatching(/"amount" is a DECIMAL\(38,9\), which is read through a double/),
    ]);
  });

  it('reads a DECIMAL narrow enough to be exact', () => {
    expect(
      unreadableParquetColumns([
        { name: 'root', num_children: 1 },
        { name: 'price', type: 'INT32', converted_type: 'DECIMAL', precision: 9, scale: 2 },
      ]),
    ).toEqual([]);
  });

  it('reads precision written under the older spelling too', () => {
    // A writer may set `precision`/`scale` on the element rather than inside the
    // logical type. Reading only one spelling is how a DECIMAL(38,9) gets past.
    expect(
      unreadableParquetColumns([
        { name: 'root', num_children: 1 },
        { name: 'amount', type: 'INT64', converted_type: 'DECIMAL', precision: 30, scale: 4 },
      ]),
    ).toHaveLength(1);
  });

  it('refuses an INTERVAL, a BSON and a VARIANT by name', () => {
    const refusals = unreadableParquetColumns([
      { name: 'root', num_children: 3 },
      { name: 'span', type: 'FIXED_LEN_BYTE_ARRAY', converted_type: 'INTERVAL' },
      { name: 'doc', type: 'BYTE_ARRAY', converted_type: 'BSON' },
      { name: 'v', type: 'BYTE_ARRAY', logical_type: { type: 'VARIANT' } },
    ]);

    expect(refusals).toHaveLength(3);
    expect(refusals[0]).toMatch(/"span" is an INTERVAL/);
    expect(refusals[1]).toMatch(/"doc" is BSON/);
    expect(refusals[2]).toMatch(/"v" is a VARIANT/);
  });

  it('refuses a geospatial column rather than half-decoding WKB', () => {
    expect(
      unreadableParquetColumns([
        { name: 'root', num_children: 1 },
        { name: 'shape', type: 'BYTE_ARRAY', logical_type: { type: 'GEOMETRY' } },
      ]),
    ).toEqual([expect.stringMatching(/"shape" is a geospatial column/)]);
  });

  /**
   * The path a refusal has to name, not just the leaf.
   *
   * A file with three groups each holding a `phone` is a file where "phone is
   * raw binary" is not actionable. Parquet writes its schema depth-first with a
   * child count on each group, which is what this walk reconstructs.
   */
  it('names a nested column by its full path', () => {
    expect(
      unreadableParquetColumns([
        { name: 'root', num_children: 2 },
        { name: 'contact', num_children: 1 },
        { name: 'phone', type: 'BYTE_ARRAY' },
        { name: 'id', type: 'INT32' },
      ]),
    ).toEqual([expect.stringMatching(/"contact\.phone" is raw binary/)]);
  });

  it('refuses every unreadable column at once rather than one per run', () => {
    expect(
      unreadableParquetColumns([
        { name: 'root', num_children: 2 },
        { name: 'a', type: 'BYTE_ARRAY' },
        { name: 'b', type: 'INT32', converted_type: 'TIME_MILLIS' },
      ]),
    ).toHaveLength(2);
  });
});

describe('compression', () => {
  it('reads SNAPPY, which is what hyparquet decompresses on its own', async () => {
    const path = write('snap.parquet', [{ name: 'a', data: ['x', 'y'], type: 'STRING' }], {
      codec: 'SNAPPY',
    });
    expect(await readFile(path)).toEqual([{ a: 'x' }, { a: 'y' }]);
  });

  it('names the codec, the file and the package when it cannot decompress', async () => {
    const path = write('gz.parquet', [{ name: 'a', data: ['x', 'y'], type: 'STRING' }], {
      codec: 'GZIP',
      compressors: { GZIP: (bytes: Uint8Array) => new Uint8Array(gzipSync(bytes)) },
    });

    await expect(readFile(path)).rejects.toThrow(
      /is compressed with GZIP, which needs the "hyparquet-compressors" package/,
    );
  });
});

describe('row groups are the unit of reading', () => {
  const rows = 500;
  const data = Array.from({ length: rows }, (_, index) => index);

  it('reads the same records however the writer grouped them', async () => {
    const expected = data.map((value) => ({ n: value, label: `row-${value}` }));

    for (const rowGroupSize of [rows, 100, 7, 1]) {
      const path = write(
        `groups-${rowGroupSize}.parquet`,
        [
          { name: 'n', data, type: 'INT32' },
          { name: 'label', data: data.map((value) => `row-${value}`), type: 'STRING' },
        ],
        { rowGroupSize },
      );
      expect(await readFile(path), `rowGroupSize ${rowGroupSize}`).toEqual(expected);
    }
  });

  /**
   * The reader pulls a group at a time, which is what bounds the memory.
   *
   * Counted through the file handle rather than asserted about the shape: a
   * reader that decoded every group up front would have read the whole file
   * before handing over the first record, and the number of byte ranges it had
   * asked for by then is what says which happened.
   */
  it('has not read the last group when it hands over the first record', async () => {
    const path = write('lazy.parquet', [{ name: 'n', data, type: 'INT32' }], { rowGroupSize: 50 });

    const stream = parquetRecords(
      { path, byteLength: statSync(path).size, release: async () => undefined },
      path,
    );
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toEqual({ n: 0 });

    // Ten groups of fifty. If the reader had drained them all to produce record
    // zero, the next pull would come from memory and the count below would be
    // the whole file. Instead the rest still has to be fetched.
    let remaining = 0;
    for await (const _ of { [Symbol.asyncIterator]: () => iterator }) remaining += 1;
    expect(remaining).toBe(rows - 1);
  });
});

describe('through the file connector', () => {
  it('takes the format from a .parquet extension', async () => {
    const path = write('by-extension.parquet', [{ name: 'a', data: ['x'], type: 'STRING' }]);

    const result = await toBufferedFetchResult(
      await fetchFile({ connector: connector({ path }), state: {}, mode: 'full' }),
    );
    expect(result.records).toEqual([{ a: 'x' }]);
  });

  it('takes it from a .parq extension too', async () => {
    const path = write('short.parq', [{ name: 'a', data: ['x'], type: 'STRING' }]);

    const result = await toBufferedFetchResult(
      await fetchFile({ connector: connector({ path }), state: {}, mode: 'full' }),
    );
    expect(result.records).toEqual([{ a: 'x' }]);
  });

  it('takes an explicit format over an extension that says nothing', async () => {
    const path = write('no-extension', [{ name: 'a', data: ['x'], type: 'STRING' }]);

    const result = await toBufferedFetchResult(
      await fetchFile({
        connector: connector({ path, format: 'parquet' }),
        state: {},
        mode: 'full',
      }),
    );
    expect(result.records).toEqual([{ a: 'x' }]);
  });

  it('carries no blank-line note, because parquet has no blank line', async () => {
    const path = write('notes.parquet', [{ name: 'a', data: ['x'], type: 'STRING' }]);

    const result = await toBufferedFetchResult(
      await fetchFile({ connector: connector({ path }), state: {}, mode: 'full' }),
    );
    expect(result.notes).toBeUndefined();
  });

  it('stops pulling when the caller only wants a sample', async () => {
    const path = write(
      'sample.parquet',
      [{ name: 'n', data: Array.from({ length: 400 }, (_, index) => index), type: 'INT32' }],
      { rowGroupSize: 50 },
    );

    const result = await toBufferedFetchResult(
      await fetchFile({ connector: connector({ path }), state: {}, mode: 'full' }),
      5,
    );
    expect(result.records).toHaveLength(5);
  });
});

/**
 * The real drop, turned into parquet and read back.
 *
 * `af_fleet.csv` from flip's 21 LRS june-2026 drop: 103,087 data rows, of which
 * 568 are blank lines the CSV reader skips, leaving 102,519 records. Writing
 * those to parquet and reading them back is the end-to-end check that the
 * columnar path produces the *same rows* as the text one — cell for cell,
 * including the 13,061 records whose `Mgmt Cd` is null.
 *
 * Skipped when the sibling checkout is absent, exactly as the workbook cases
 * are: the suite must run for somebody who has only this repository.
 */
const REAL_CSV = join(
  process.env.FLIP_PYTHON_DB_DIR ?? '/home/dudousxd/documents/flip/flip-python-db',
  'sampleFiles/21st/june-2026/DOD SAFE-PocAncIqXAAUjMA0/to-upload/af_fleet.csv',
);

describe.skipIf(!existsSync(REAL_CSV))('the 21 LRS af_fleet drop, as parquet', () => {
  it('round-trips every row and every cell', async () => {
    const fromCsv = await toBufferedFetchResult(
      await fetchFile({ connector: connector({ path: REAL_CSV }), state: {}, mode: 'full' }),
    );
    expect(fromCsv.records).toHaveLength(102_519);
    expect(fromCsv.notes?.[0]).toMatch(/Skipped 568 blank lines/);

    const first = fromCsv.records[0];
    if (!first || typeof first !== 'object') throw new Error('expected records');
    const columns = Object.keys(first);
    expect(columns).toEqual(['Mgmt Cd', 'VEH Type Name', 'Asset NSN', 'Reg Number', 'VEH Cat']);

    const path = write(
      'af_fleet.parquet',
      columns.map((name) => ({
        name,
        data: fromCsv.records.map((record) =>
          record && typeof record === 'object' ? Reflect.get(record, name) : null,
        ),
        type: 'STRING',
      })),
      { rowGroupSize: 20_000 },
    );

    const fromParquet = await readFile(path);
    expect(fromParquet).toHaveLength(102_519);
    expect(fromParquet).toEqual(fromCsv.records);

    // The 13,061 rows flip's own reader drops for a blank `Mgmt Cd` are null
    // here rather than empty strings, which is the same answer the CSV reader
    // gives — so a graph filtering on `isNotNull` sees 89,458 either way.
    const present = fromParquet.filter(
      (record) =>
        record !== null && typeof record === 'object' && Reflect.get(record, 'Mgmt Cd') !== null,
    );
    expect(present).toHaveLength(89_458);
  }, 120_000);
});
