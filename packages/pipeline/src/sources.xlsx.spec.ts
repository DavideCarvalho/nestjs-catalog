import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogConnector } from '@dudousxd/nestjs-catalog';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { fetchFile } from './sources';

/**
 * The workbook reader, against workbooks built here and against a real one.
 *
 * `xlsx` is a devDependency of this package and NOT a dependency of the
 * published one — the reader loads it optionally at run time, so these tests
 * install the same library a deployment would and prove the optional import
 * finds it. The alias in package.json points the name `xlsx` at `@e965/xlsx`,
 * the maintained npm mirror, because the vendor's own npm releases stop at
 * 0.18.5 and that version carries two unfixed advisories.
 */

let directory: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'catalog-xlsx-'));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** A workbook on disk, from sheets given as arrays of rows. */
function writeWorkbook(name: string, sheets: Record<string, unknown[][]>): string {
  const workbook = XLSX.utils.book_new();
  for (const [sheetName, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName);
  }
  const path = join(directory, name);
  // Serialised here and written with node's own fs, rather than XLSX.writeFile:
  // the library's ESM build has no filesystem bound unless `set_fs` is called,
  // and the bytes are what this needs anyway.
  writeFileSync(path, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  return path;
}

/**
 * A workbook holding one date cell, built as the file format really stores one:
 * a serial number with a date display format, not a `Date` object.
 */
function writeSerialDateWorkbook(name: string, serial: number, format: string): string {
  const sheet = {
    '!ref': 'A1:A2',
    A1: { t: 's', v: 'when' },
    A2: { t: 'n', v: serial, z: format },
  };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  const path = join(directory, name);
  writeFileSync(path, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  return path;
}

function connector(config: Record<string, unknown>): CatalogConnector {
  // Only the two fields a file fetch reads. The rest of the shape belongs to the
  // store and would be noise here.
  const value: unknown = { kind: 'file', config };
  if (!isConnector(value)) throw new Error('unreachable');
  return value;
}

function isConnector(value: unknown): value is CatalogConnector {
  return typeof value === 'object' && value !== null;
}

/**
 * The records out of a file fetch, whichever of its shapes it used.
 *
 * It used to assert the bare-array shape. `fetchFile` now always returns a
 * {@link FetchResult}, because it has somewhere to put the blank-line count a
 * CSV parse reports — a shape that varied with whether the file happened to
 * have blank lines in it would be worse than either. Both are inside
 * `SourceFetcher`'s declared return type and every caller in the repository
 * reads it through `toRecordStream` or `toBufferedFetchResult`, so this helper
 * was pinning an implementation detail rather than a contract. A workbook read
 * carries no notes, which the case below asserts rather than assumes.
 */
async function read(config: Record<string, unknown>): Promise<unknown[]> {
  const result = await fetchFile({ connector: connector(config), state: {}, mode: 'full' });
  if (Array.isArray(result)) return result;
  if (!Array.isArray(result.records)) {
    throw new Error('the file fetcher returned a shape it never returns');
  }
  return result.records;
}

describe('reading a workbook', () => {
  it('reads a two-cell sheet, keyed by the header row', async () => {
    const path = writeWorkbook('simple.xlsx', {
      Sheet1: [
        ['name', 'count'],
        ['widget', 3],
      ],
    });

    await expect(read({ path })).resolves.toEqual([{ name: 'widget', count: 3 }]);
  });

  // A workbook has no blank *line* to skip — a row of empty cells is a row of
  // `null`s the reader hands over like any other — so it has nothing to report
  // and must stay silent. The CSV parser's ledger reaches the run through the
  // same `FetchResult.notes` this fetch now returns, and a workbook read that
  // started saying something there would be a note on a file with no defect.
  it('says nothing about skipped rows, because a workbook skips none', async () => {
    const path = writeWorkbook('quiet.xlsx', {
      Sheet1: [
        ['name', 'count'],
        ['widget', 3],
      ],
    });

    // On the whole result rather than on `result.notes`: `notes` is declared on
    // `FetchResult` and not on `StreamedFetchResult`, so reaching for the field
    // would need a narrowing that says more about the union than about this
    // fetch. Asserting the object entire says the stronger thing anyway — the
    // key is absent, not merely undefined.
    await expect(
      fetchFile({ connector: connector({ path }), state: {}, mode: 'full' }),
    ).resolves.toEqual({ records: [{ name: 'widget', count: 3 }] });
  });

  it('takes the format from the extension, with no format configured', async () => {
    // The whole point of the change: a `.xlsx` used to reach `JSON.parse`.
    const path = writeWorkbook('guessed.xlsx', { Sheet1: [['a'], ['b']] });

    await expect(read({ path })).resolves.toEqual([{ a: 'b' }]);
  });

  it('keeps a number a number and a boolean a boolean', async () => {
    const path = writeWorkbook('types.xlsx', {
      Sheet1: [
        ['n', 'b', 's'],
        [42.5, true, 'text'],
      ],
    });

    await expect(read({ path })).resolves.toEqual([{ n: 42.5, b: true, s: 'text' }]);
  });

  it('turns a date into an ISO-8601 string rather than a serial number', async () => {
    // Written as a serial number carrying a date format, which is what a real
    // `.xlsx` holds — a date cell is a number plus a display format, and 46183
    // is how 2026-06-10 is actually stored. Going through the serial rather than
    // handing the library a `Date` is deliberate: it exercises the same path a
    // file from somebody else's software takes, and it is the path where the
    // serial would leak through as `46183` if `cellDates` were ever dropped.
    const path = writeSerialDateWorkbook('dates.xlsx', 46183, 'yyyy-mm-dd');

    const records = await read({ path });
    expect(readProperty(records[0], 'when')).toBe('2026-06-10T00:00:00.000Z');
  });

  it("keeps the time of day, and does not shift it by the reader's timezone", async () => {
    // 2026-06-10 14:30:15 as a serial. The assertion is a real one on any
    // machine that is not on UTC — this suite runs on America/Sao_Paulo, where
    // calling `toISOString()` on the Date the library hands back would return
    // 17:30 rather than 14:30.
    const path = writeSerialDateWorkbook(
      'datetimes.xlsx',
      46183.60434027778,
      'yyyy-mm-dd hh:mm:ss',
    );

    const records = await read({ path });
    expect(readProperty(records[0], 'when')).toBe('2026-06-10T14:30:15.000Z');
  });

  it('gives a blank cell null, the way a short CSV row gets null', async () => {
    const path = writeWorkbook('blanks.xlsx', {
      Sheet1: [
        ['a', 'b'],
        ['filled', null],
      ],
    });

    await expect(read({ path })).resolves.toEqual([{ a: 'filled', b: null }]);
  });

  it('drops a row that is blank all the way across', async () => {
    const path = writeWorkbook('spacer.xlsx', {
      Sheet1: [['a'], ['one'], [null], ['two']],
    });

    await expect(read({ path })).resolves.toEqual([{ a: 'one' }, { a: 'two' }]);
  });
});

/**
 * The two readers, asked the same question.
 *
 * These belong together in one block rather than one assertion each, because the
 * property under test is not what either reader returns — it is that they return
 * the *same* thing. A `present` filter downstream tests `null`, so a format that
 * spelled "no value here" as `""` would quietly pass a predicate the other
 * format fails, and the graph would commit a different number of rows depending
 * on which file it happened to read.
 */
describe('a blank cell means the same thing in either format', () => {
  it('gives null for a blank and for a missing cell, from CSV', async () => {
    const path = join(directory, 'blanks.csv');
    // `b` is blank on the first row and absent from the second.
    writeFileSync(path, 'a,b,c\n1,,3\n4,5\n');

    await expect(read({ path })).resolves.toEqual([
      { a: '1', b: null, c: '3' },
      { a: '4', b: '5', c: null },
    ]);
  });

  it('gives null for the same shape from a workbook', async () => {
    const path = writeWorkbook('blanks-agree.xlsx', {
      Sheet1: [
        ['a', 'b', 'c'],
        ['1', null, '3'],
        ['4', '5', null],
      ],
    });

    await expect(read({ path })).resolves.toEqual([
      { a: '1', b: null, c: '3' },
      { a: '4', b: '5', c: null },
    ]);
  });

  it('does not trim a field that holds whitespace, in either format', async () => {
    // A blank is absent; a space is a value somebody typed. The distinction is
    // the transform's to interpret, and neither reader may collapse it.
    const csv = join(directory, 'spaces.csv');
    writeFileSync(csv, 'a\n" "\n');
    await expect(read({ path: csv })).resolves.toEqual([{ a: ' ' }]);

    const workbook = writeWorkbook('spaces.xlsx', { Sheet1: [['a'], [' ']] });
    await expect(read({ path: workbook })).resolves.toEqual([{ a: ' ' }]);
  });
});

describe('choosing a sheet', () => {
  it('reads the only sheet without being told to', async () => {
    const path = writeWorkbook('one-sheet.xlsx', { Only: [['a'], ['1']] });

    await expect(read({ path })).resolves.toEqual([{ a: '1' }]);
  });

  it('refuses a multi-sheet workbook rather than picking the first', async () => {
    const path = writeWorkbook('two-sheets.xlsx', {
      First: [['a'], ['1']],
      Second: [['b'], ['2']],
    });

    await expect(read({ path })).rejects.toThrow(/has 2 sheets and no "sheet" configured/);
    // And it says which, because whoever configured the connector cannot open it.
    await expect(read({ path })).rejects.toThrow(/"First", "Second"/);
  });

  it('reads the named sheet out of a multi-sheet workbook', async () => {
    const path = writeWorkbook('named.xlsx', {
      First: [['a'], ['1']],
      Second: [['b'], ['2']],
    });

    await expect(read({ path, sheet: 'Second' })).resolves.toEqual([{ b: '2' }]);
  });

  it('lists the sheets when the named one is not there', async () => {
    const path = writeWorkbook('missing-sheet.xlsx', { First: [['a'], ['1']] });

    await expect(read({ path, sheet: 'Nope' })).rejects.toThrow(
      /has no sheet named "Nope". It has: "First"/,
    );
  });
});

describe('refusing what would load wrong', () => {
  it('refuses two columns with the same heading', async () => {
    const path = writeWorkbook('duplicate-headers.xlsx', {
      Sheet1: [
        ['id', 'id'],
        ['1', '2'],
      ],
    });

    await expect(read({ path })).rejects.toThrow(/two columns headed "id" \(A1 and B1\)/);
  });

  it('names a blank heading by its column letter instead of dropping it', async () => {
    const path = writeWorkbook('blank-header.xlsx', {
      Sheet1: [
        ['a', null],
        ['1', '2'],
      ],
    });

    // The data under an unlabelled column survives, under a name that points at
    // where it came from.
    await expect(read({ path })).resolves.toEqual([{ a: '1', B: '2' }]);
  });

  it('refuses a workbook over the byte cap rather than stalling on it', async () => {
    const path = writeWorkbook('big.xlsx', { Sheet1: [['a'], ['1']] });

    await expect(read({ path, maxBytes: 8 })).rejects.toThrow(
      /over the 8-byte workbook limit.*blocks this worker's event loop/s,
    );
  });

  it('refuses a format it does not know instead of reading it as JSON', async () => {
    const path = writeWorkbook('parquet.xlsx', { Sheet1: [['a'], ['1']] });

    await expect(read({ path, format: 'parquet' })).rejects.toThrow(
      /"parquet" is not a format this can read\. Use one of: csv, ndjson, json, xlsx/,
    );
  });
});

/**
 * The real thing.
 *
 * A synthetic two-cell workbook proves the mapping; it does not prove the
 * reader survives a file somebody's software actually wrote. This one is a real
 * MVR drop — 974 rows, 20 columns, and 1,732 merged ranges.
 */
describe('a real MVR drop', () => {
  const fixture = join(
    process.env.FLIP_PYTHON_DB_DIR ?? '/home/dudousxd/documents/flip/flip-python-db',
    'sampleFiles/21st/june-2026/DOD SAFE-PocAncIqXAAUjMA0/to-upload/mvr.xlsx',
  );

  it.skipIf(!existsSync(fixture))(
    'reads every row and carries no value across a merge',
    async () => {
      const records = await read({ path: fixture });

      // 974 rows in the used range: one header, 973 data rows, none blank across.
      expect(records).toHaveLength(973);

      const first = records[0];
      expect(readProperty(first, 'Host Command')).toBe('AFRC');
      expect(readProperty(first, 'Base Name')).toBe('PETERSON (AFRC)');
      // A column whose cell is empty on this row, not the string "undefined".
      expect(readProperty(first, 'UNIT_TYP_CD')).toBeNull();

      // The second row sits inside merged ranges that start on the first. Only the
      // anchor holds the value, so these are null — the fill-forward that a real
      // MVR transform needs is transform-level work and deliberately not done here.
      const second = records[1];
      expect(readProperty(second, 'Use_CD')).toBeNull();
      expect(readProperty(second, 'Asset_ID')).toBeNull();
      // Its own cells are still its own.
      expect(readProperty(second, 'ASC')).toBe('Total Auth / Assigned');
    },
  );
});

function readProperty(record: unknown, name: string): unknown {
  if (typeof record !== 'object' || record === null) {
    throw new Error(`expected a record, got ${typeof record}`);
  }
  return Reflect.get(record, name);
}
