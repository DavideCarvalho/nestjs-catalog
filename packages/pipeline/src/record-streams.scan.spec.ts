import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CsvScanner, csvScanner, ndjsonRecords } from './record-streams';

/**
 * The CSV scanner against a character-at-a-time reference, and the cost of
 * reading a long line.
 *
 * `referenceScanner` below is the reader every rule in `csvScanner`'s docblock
 * was first written against: one state transition per UTF-16 code unit. It is
 * kept here as the oracle because "reads the same as the obvious reader" is the
 * property worth having, and the obvious reader is too slow to ship — a 25 MB
 * export is a function call and a string append per character.
 */
function referenceScanner(delimiter: string): CsvScanner {
  let state: 'field' | 'quoted' | 'quote-maybe' = 'field';
  let field = '';
  let row: string[] = [];

  const consume = (char: string, rows: string[][]): void => {
    if (state === 'quoted') {
      if (char === '"') state = 'quote-maybe';
      else field += char;
      return;
    }
    if (state === 'quote-maybe') {
      state = 'field';
      if (char === '"') {
        field += '"';
        state = 'quoted';
        return;
      }
    }
    if (char === '"') {
      state = 'quoted';
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  };

  return {
    push(text: string): string[][] {
      const rows: string[][] = [];
      for (let index = 0; index < text.length; index += 1) consume(text[index] ?? '', rows);
      return rows;
    },
    end(): string[][] {
      if (state === 'quote-maybe') state = 'field';
      if (field.length > 0 || row.length > 0) {
        row.push(field.replace(/\r$/, ''));
        const last = row;
        row = [];
        field = '';
        return [last];
      }
      return [];
    },
  };
}

/** What each `push` returned, then what `end` returned, in order. */
function scan(make: (delimiter: string) => CsvScanner, delimiter: string, chunks: string[]) {
  const scanner = make(delimiter);
  return [...chunks.map((chunk) => scanner.push(chunk)), scanner.end()];
}

function expectSameAsReference(delimiter: string, chunks: string[]): void {
  expect(scan(csvScanner, delimiter, chunks), JSON.stringify({ delimiter, chunks })).toEqual(
    scan(referenceScanner, delimiter, chunks),
  );
}

const EDGE_CASES = [
  '',
  'a',
  'a,b\n1,2\n3,4\n',
  'a,b\n1,2\n3,4',
  'a,b\r\n1,2\r\n3,4\r\n',
  'a,b\n"Smith, John",2\n',
  'a,b\n"line one\nline two",2\n',
  'a,b\r\n"line one\r\nline two",2\r\n',
  'a,b\n"say ""hi""",2\n',
  'a,b\nab"c,d"ef,2\n',
  'a,b\n"never closed,2\n',
  'a,b,c\n1,,3\n,,\n',
  '\na,b\n1,2\n\n3,4\n\n',
  'a,b\n"",2\n"""",3\n',
  'a,b\n"one\rtwo",2\n',
  '"a\r"\n',
  'a\r\r\n',
  '\r\n\r\n',
  '\r',
  '"',
  '""',
  '"""',
  '"a"b"c"\n',
  '"a""',
  ',,,\n',
  'x,"y"\r\n',
  '"x"\n"y"',
  'é,😀\n"ü\n😀",ß\n',
  '\uD83D,\uDE00\n',
  'a\tb\n1\t"2\t3"\n',
  'a;b\n1;"2;3";4\n',
];

const DELIMITERS = [',', ';', '\t', '|', '\r', '\n', '"', '', 'ab', '😀'];

describe('csvScanner reads exactly what the character-at-a-time reference reads', () => {
  it('on every edge case, delimiter and two-way split', () => {
    for (const text of EDGE_CASES) {
      for (const delimiter of DELIMITERS) {
        expectSameAsReference(delimiter, [text]);
        expectSameAsReference(delimiter, [...text]);
        for (let at = 0; at <= text.length; at += 1) {
          expectSameAsReference(delimiter, [text.slice(0, at), text.slice(at)]);
        }
      }
    }
  });

  it('on random CSVs cut into random chunks', () => {
    // Seeded, so a failure reproduces.
    let seed = 0x2545f491;
    const random = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x1_0000_0000;
    };
    const alphabet = ['a', 'b', ' ', ',', ';', '\t', '"', '"', '\n', '\r', 'é', '😀', '\uD83D'];

    for (let round = 0; round < 3_000; round += 1) {
      const size = Math.floor(random() * 60);
      let text = '';
      for (let index = 0; index < size; index += 1) {
        text += alphabet[Math.floor(random() * alphabet.length)];
      }
      const chunks: string[] = [];
      let at = 0;
      while (at < text.length) {
        const width = Math.floor(random() * 8);
        chunks.push(text.slice(at, at + width));
        at += width;
      }
      const delimiter = DELIMITERS[Math.floor(random() * DELIMITERS.length)] ?? ',';
      expectSameAsReference(delimiter, chunks);
      expectSameAsReference(delimiter, [text]);
    }
  });
});

/**
 * A string that counts how often one of its characters is read by index.
 *
 * Methods are bound to the wrapped `String` object, so `indexOf` and `slice`
 * still run natively and are not counted — which is the point: the cost being
 * measured is visiting characters one by one from JavaScript.
 */
function countingText(text: string): { text: string; indexedReads: () => number } {
  let reads = 0;
  const boxed = new String(text);
  const proxy = new Proxy(boxed, {
    get(target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { text: proxy as unknown as string, indexedReads: () => reads };
}

describe('csvScanner does not visit characters one at a time', () => {
  it('reads an unquoted file without indexing into it per character', () => {
    const line = `${Array.from({ length: 12 }, (_, i) => `value${i}_abcdef`).join(',')}\r\n`;
    const plain = line.repeat(2_000);
    const { text, indexedReads } = countingText(plain);

    const rows = csvScanner(',').push(text);

    expect(rows).toHaveLength(2_000);
    expect(rows[0]).toEqual(Array.from({ length: 12 }, (_, i) => `value${i}_abcdef`));
    // The reference indexes every one of the ~370,000 characters.
    expect(indexedReads()).toBe(0);
  });

  it('reads a quoted field in one slice per quote, not per character', () => {
    const body = 'x'.repeat(100_000);
    const { text, indexedReads } = countingText(`a,b\n"${body}",2\n`);

    const rows = csvScanner(',').push(text);

    expect(rows).toEqual([
      ['a', 'b'],
      [body, '2'],
    ]);
    expect(indexedReads()).toBe(0);
  });
});

/**
 * How many characters `split` and `indexOf` were asked to look at for a
 * newline, while `run` was running.
 *
 * Only calls about `\n` on strings of at least `atLeast` characters count, so
 * whatever else the test runner does with short strings in the meantime does
 * not land in the total.
 */
async function newlineScanCost(run: () => Promise<void>, atLeast = 1_000): Promise<number> {
  let scanned = 0;
  const { split, indexOf } = String.prototype;
  const count = (self: unknown, separator: unknown, from = 0): void => {
    const length = String(self).length;
    if (separator === '\n' && length >= atLeast) scanned += length - from;
  };
  vi.spyOn(String.prototype, 'split').mockImplementation(function (
    this: string,
    ...args: unknown[]
  ) {
    count(this, args[0]);
    return Reflect.apply(split, this, args);
  });
  vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (
    this: string,
    ...args: unknown[]
  ) {
    count(this, args[0], Number(args[1] ?? 0));
    return Reflect.apply(indexOf, this, args);
  });
  try {
    await run();
  } finally {
    vi.restoreAllMocks();
  }
  return scanned;
}

describe('ndjson over a line much longer than a chunk', () => {
  afterEach(() => vi.restoreAllMocks());

  it('looks at each character a bounded number of times', async () => {
    const value = 'x'.repeat(4 * 1024 * 1024);
    const text = `${JSON.stringify({ value })}\n{"a":2}\n`;
    const chunks: string[] = [];
    for (let at = 0; at < text.length; at += 64 * 1024) chunks.push(text.slice(at, at + 64 * 1024));

    const records: unknown[] = [];
    const scanned = await newlineScanCost(async () => {
      async function* iterate(): AsyncGenerator<string> {
        yield* chunks;
      }
      for await (const record of ndjsonRecords(iterate(), 'drop.ndjson')) records.push(record);
    });

    expect(records).toEqual([{ value }, { a: 2 }]);
    // Re-splitting the growing line on every chunk looks at it once per chunk:
    // ~64 passes over up to 4 MB, about 140 million characters.
    expect(scanned).toBeLessThan(3 * text.length);
  });
});
