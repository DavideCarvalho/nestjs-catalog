import { describe, expect, it } from 'vitest';
import { type CsvRow, csvCell, csvLines, guardFormula, toCsv } from './catalog.csv';

/**
 * What the export writes, and what a spreadsheet does with it.
 *
 * The interesting half is not "does a CSV come out". It is that a CSV is a
 * program a spreadsheet will run: a cell beginning `=`, `+`, `-` or `@` is
 * evaluated on open, and the cells here came from whatever the queried source
 * contained — operational data loaded by connectors from systems this catalog
 * does not control. So the guard is checked against the forms that actually get
 * past a naive one (leading blank, a leading tab, the leader inside a quoted
 * field) and against the thing a guard usually breaks in exchange, which is that
 * the file still parses back to the values that went in.
 */

// ---------------------------------------------------------------------------
// An independent reader, so the round trip proves something.
// ---------------------------------------------------------------------------

/**
 * RFC 4180, minus the parts an export cannot produce.
 *
 * Written here rather than reusing anything from the writer under test, which is
 * the whole point: a round trip through `toCsv`'s own inverse would agree with
 * whatever `toCsv` did, including agreeing that a doubled apostrophe was fine.
 * This one only knows the format — a field is quoted or it is not, a `""` inside
 * quotes is one literal quote, and a record ends at a newline outside quotes.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let index = 0;

  while (index < text.length) {
    const field = readField(text, index);
    row.push(field.value);
    index = field.end;
    if (field.endsRecord) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

/** One field, and whether the thing that ended it also ended the record. */
function readField(
  text: string,
  start: number,
): { value: string; end: number; endsRecord: boolean } {
  let value = '';
  let index = start;
  let quoted = false;

  while (index < text.length) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        value += '"';
        index += 2;
      } else if (char === '"') {
        quoted = false;
        index += 1;
      } else {
        value += char;
        index += 1;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ',') return { value, end: index + 1, endsRecord: false };
    if (char === '\r' && text[index + 1] === '\n') {
      return { value, end: index + 2, endsRecord: true };
    }
    value += char;
    index += 1;
  }
  return { value, end: index, endsRecord: true };
}

async function* rowsOf(...rows: CsvRow[]): AsyncGenerator<CsvRow> {
  for (const row of rows) yield row;
}

async function collect(lines: AsyncIterable<string>): Promise<string> {
  let text = '';
  for await (const line of lines) text += line;
  return text;
}

// ---------------------------------------------------------------------------
// 1. The guard.
// ---------------------------------------------------------------------------

describe('a cell a spreadsheet would execute', () => {
  it.each([
    ['=1+1', "'=1+1"],
    ['@SUM(A1:A9)', "'@SUM(A1:A9)"],
    ["=cmd|' /C calc'!A0", "'=cmd|' /C calc'!A0"],
    // The one people quote as proof that `-` matters: a working command
    // execution whose first character is a minus sign.
    ["-2+3+cmd|' /C calc'!A0", "'-2+3+cmd|' /C calc'!A0"],
    ['+SUM(1)', "'+SUM(1)"],
  ])('is prefixed so it reads as text: %j', (value, expected) => {
    expect(guardFormula(value)).toBe(expected);
  });

  it.each([
    [' =1+1', "' =1+1"],
    ['   =1+1', "'   =1+1"],
    ['\t=1+1', "'\t=1+1"],
    ['\r=1+1', "'\r=1+1"],
    [' =1+1', "' =1+1"],
  ])('is still caught when blank hides the leader: %j', (value, expected) => {
    // Importers do not agree on whether leading blank belongs to the value.
    // Several strip it and then decide, so a guard that looked only at position
    // zero would pass this straight through to the formula engine.
    expect(guardFormula(value)).toBe(expected);
  });

  it.each([
    ['\thello', "'\thello"],
    ['\rhello', "'\rhello"],
  ])('treats a leading tab or carriage return as a leader itself: %j', (value, expected) => {
    expect(guardFormula(value)).toBe(expected);
  });
});

describe('a cell that only looks like one', () => {
  it.each(['-42', '+42', '-42.5', '+0.5', '-1.2e-3', '1e5', '.5', '-.5'])(
    'is left exactly as it was, because it is a number: %j',
    (value) => {
      // The exemption that keeps the guard from corrupting data. A spreadsheet
      // evaluates `-42` to the number -42, which is what it already was, so
      // there is nothing to defend against and an apostrophe here would be pure
      // loss to every machine that reads the file back.
      expect(guardFormula(value)).toBe(value);
    },
  );

  it.each(['-42abc', '- 42', '+1+1', '-1-cmd', '@42', '=42'])(
    'is guarded when it is not actually a number: %j',
    (value) => {
      expect(guardFormula(value)).toBe(`'${value}`);
    },
  );

  it.each(['hello', 'a=b', '2026-08-04', '', '0', '42'])('is untouched: %j', (value) => {
    expect(guardFormula(value)).toBe(value);
  });
});

// ---------------------------------------------------------------------------
// 2. The guard and the CSV quoting, together.
// ---------------------------------------------------------------------------

describe('a cell that needs both the guard and the quoting', () => {
  it('puts the apostrophe inside the quotes, and puts it there once', () => {
    // The other order produces a field no reader can parse, and applying the
    // guard twice — once before quoting and once after — produces a cell with
    // two apostrophes in it.
    expect(csvCell('=1+1,x')).toBe(`"'=1+1,x"`);
    expect(parseCsv(`${csvCell('=1+1,x')}\r\n`)[0][0]).toBe("'=1+1,x");
  });

  it('doubles a literal quote and does not double the apostrophe', () => {
    expect(csvCell('="a"')).toBe(`"'=""a"""`);
    expect(parseCsv(`${csvCell('="a"')}\r\n`)[0][0]).toBe('\'="a"');
  });

  it('does not quote a value that only needed the guard', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
  });

  it('leaves a value that only needed the quoting alone otherwise', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('line\r\nbreak')).toBe('"line\r\nbreak"');
  });

  it('writes nothing for null and undefined, and JSON for an object', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
});

// ---------------------------------------------------------------------------
// 3. The file, read back.
// ---------------------------------------------------------------------------

describe('the file a machine reads back', () => {
  it('still parses -42 as -42', async () => {
    const text = await collect(csvLines(rowsOf({ delta: -42, note: 'ok' })));
    const parsed = parseCsv(text);

    expect(parsed[0]).toEqual(['delta', 'note']);
    expect(parsed[1][0]).toBe('-42');
    expect(Number(parsed[1][0])).toBe(-42);
  });

  it('round-trips a row of awkward values without changing any of them', async () => {
    const row: CsvRow = {
      plain: 'hello',
      negative: -42,
      comma: 'a,b',
      quote: 'say "hi"',
      newline: 'one\r\ntwo',
      empty: null,
    };
    const parsed = parseCsv(await collect(csvLines(rowsOf(row))));

    expect(parsed[0]).toEqual(Object.keys(row));
    expect(parsed[1]).toEqual(['hello', '-42', 'a,b', 'say "hi"', 'one\r\ntwo', '']);
  });

  it('carries the apostrophe, and only the apostrophe, on a guarded cell', async () => {
    const parsed = parseCsv(await collect(csvLines(rowsOf({ payload: '=1+1' }))));
    // The cost, stated: a reader that is not a spreadsheet sees a character the
    // database did not have. It sees exactly one.
    expect(parsed[1][0]).toBe("'=1+1");
  });

  it('guards a column name too, because those come from the query as well', async () => {
    // `SELECT 1 AS "=cmd|..."` is a column name the author chose, and the header
    // row is a row.
    const parsed = parseCsv(await collect(csvLines(rowsOf({ '=cmd|calc': 1 }))));
    expect(parsed[0]).toEqual(["'=cmd|calc"]);
  });
});

// ---------------------------------------------------------------------------
// 4. Framing.
// ---------------------------------------------------------------------------

describe('how the lines are framed', () => {
  it('terminates every line with CRLF, including the last', async () => {
    const text = await collect(csvLines(rowsOf({ a: 1 }, { a: 2 })));
    expect(text).toBe('a\r\n1\r\n2\r\n');
  });

  it('takes the header from the first row when no columns were declared', async () => {
    const text = await collect(csvLines(rowsOf({ b: 2, a: 1 })));
    expect(text.split('\r\n')[0]).toBe('b,a');
  });

  it('writes a declared header before asking the source for anything', async () => {
    let pulled = false;
    async function* watched(): AsyncGenerator<CsvRow> {
      pulled = true;
      yield { a: 1 };
    }

    const lines = csvLines(watched(), ['a']);
    const first = await lines.next();

    expect(first.value).toBe('a\r\n');
    expect(pulled).toBe(false);
  });

  it('writes a declared header even when there are no rows at all', async () => {
    expect(await collect(csvLines(rowsOf(), ['a', 'b']))).toBe('a,b\r\n');
  });

  it('writes nothing at all when there are no rows and no declared columns', async () => {
    // There is nothing honest to put in a header: an empty stream never said
    // what its columns were.
    expect(await collect(csvLines(rowsOf()))).toBe('');
  });

  it('fills a column a row does not have rather than shifting the row', async () => {
    const text = await collect(csvLines(rowsOf({ a: 1 }, { b: 2 }), ['a', 'b']));
    expect(parseCsv(text)).toEqual([
      ['a', 'b'],
      ['1', ''],
      ['', '2'],
    ]);
  });
});

describe('the buffered writer', () => {
  it('produces byte-for-byte what the streaming one does', async () => {
    const columns = ['a', 'b'];
    const rows = [
      { a: '=1+1', b: -42 },
      { a: 'x,y', b: null },
    ];

    expect(toCsv({ columns, rows })).toBe(await collect(csvLines(rowsOf(...rows), columns)));
  });

  it('still writes a header line for an empty result, as it always did', () => {
    expect(toCsv({ columns: [], rows: [] })).toBe('\r\n');
  });
});
