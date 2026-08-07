import { describe, expect, it } from 'vitest';
import {
  type BlankRowLedger,
  blankRowLedger,
  csvRecords,
  decodeChunks,
  ndjsonRecords,
} from './record-streams';

/**
 * The chunk boundary, hunted deliberately.
 *
 * A streaming reader that loses or duplicates a row at a chunk boundary is the
 * defect this whole change could plausibly introduce, and the place it hides is
 * a boundary landing inside a quoted field — where a `,` and a `\n` are
 * ordinary characters, so a reader that resynchronised on either would split
 * one record into two and never say so.
 *
 * These cases are therefore not "does it parse a CSV". They are: **the same
 * text, split in every possible place, produces the same records** — and then
 * the same again against a hand-written expectation, because a reader that is
 * consistently wrong would pass the first property on its own.
 */

/** Feed a text to the reader as one chunk. */
async function whole(text: string, delimiter = ','): Promise<Read> {
  return read([text], delimiter);
}

interface Read {
  records: unknown[];
  ledger: BlankRowLedger;
}

async function read(chunks: string[], delimiter = ','): Promise<Read> {
  const ledger = blankRowLedger();
  const records: unknown[] = [];
  for await (const record of csvRecords(iterate(chunks), delimiter, 'drop.csv', ledger)) {
    records.push(record);
  }
  return { records, ledger };
}

async function* iterate<T>(values: readonly T[]): AsyncGenerator<T> {
  for (const value of values) yield value;
}

/** Every way of cutting a text into two, and every way of cutting it into ones. */
function splits(text: string): string[][] {
  const all: string[][] = [];
  for (let at = 0; at <= text.length; at += 1) {
    all.push([text.slice(0, at), text.slice(at)]);
  }
  // One character per chunk, which is every boundary at once and is the case
  // that catches state a `push` forgot to carry.
  all.push([...text]);
  return all;
}

/** The corpus. Each entry is a text whose reading must not depend on chunking. */
const AWKWARD: Array<{ what: string; text: string }> = [
  { what: 'a plain file', text: 'a,b\n1,2\n3,4\n' },
  { what: 'no trailing newline', text: 'a,b\n1,2\n3,4' },
  { what: 'CRLF endings', text: 'a,b\r\n1,2\r\n3,4\r\n' },
  { what: 'a quoted comma', text: 'a,b\n"Smith, John",2\n' },
  { what: 'a quoted newline', text: 'a,b\n"line one\nline two",2\n' },
  { what: 'a quoted CRLF', text: 'a,b\r\n"line one\r\nline two",2\r\n' },
  { what: 'a doubled quote', text: 'a,b\n"say ""hi""",2\n' },
  { what: 'a quote in the middle of a field', text: 'a,b\nab"c,d"ef,2\n' },
  { what: 'an unterminated quote', text: 'a,b\n"never closed,2\n' },
  { what: 'empty fields', text: 'a,b,c\n1,,3\n,,\n' },
  { what: 'a short row', text: 'a,b,c\n1,2\n' },
  { what: 'blank lines throughout', text: '\na,b\n1,2\n\n3,4\n\n' },
  { what: 'a quoted empty field', text: 'a,b\n"",2\n' },
  { what: 'a field that is only a quote', text: 'a,b\n"",2\n"""",3\n' },
  { what: 'a lone CR inside a quoted field', text: 'a,b\n"one\rtwo",2\n' },
];

describe('a chunk boundary anywhere reads the same', () => {
  for (const { what, record } of AWKWARD.map((entry) => ({ what: entry.what, record: entry }))) {
    it(`is unaffected by where the chunks fall: ${what}`, async () => {
      const reference = await whole(record.text);

      for (const chunks of splits(record.text)) {
        const split = await read(chunks);
        expect(split.records, `split at ${JSON.stringify(chunks)}`).toEqual(reference.records);
        expect(split.ledger.blankRows, `split at ${JSON.stringify(chunks)}`).toBe(
          reference.ledger.blankRows,
        );
      }
    });
  }
});

describe('what the reader actually produces', () => {
  it('keeps a quoted comma in one field', async () => {
    const { records } = await whole('a,b\n"Smith, John",2\n');
    expect(records).toEqual([{ a: 'Smith, John', b: '2' }]);
  });

  it('keeps a quoted newline in one field, across a chunk boundary', async () => {
    const text = 'a,b\n"line one\nline two",2\n';
    // Split exactly on the newline inside the quotes, which is the boundary a
    // line-splitting reader would get wrong and this one must not.
    const at = text.indexOf('line one\n') + 'line one\n'.length;
    const { records } = await read([text.slice(0, at), text.slice(at)]);
    expect(records).toEqual([{ a: 'line one\nline two', b: '2' }]);
  });

  it('reads a doubled quote as one literal quote', async () => {
    const { records } = await whole('a,b\n"say ""hi""",2\n');
    expect(records).toEqual([{ a: 'say "hi"', b: '2' }]);
  });

  it('treats a quote mid-field as opening a run, as the old reader did', async () => {
    const { records } = await whole('a,b\nab"c,d"ef,2\n');
    expect(records).toEqual([{ a: 'abc,def', b: '2' }]);
  });

  it('gives a missing cell and a blank cell the same null', async () => {
    const { records } = await whole('a,b,c\n1,,3\n4,5\n');
    expect(records).toEqual([
      { a: '1', b: null, c: '3' },
      { a: '4', b: '5', c: null },
    ]);
  });

  it('does not trim a field of spaces', async () => {
    const { records } = await whole('a\n" "\n');
    expect(records).toEqual([{ a: ' ' }]);
  });

  it('strips the CR of a CRLF file without touching one inside a quoted field', async () => {
    const { records } = await whole('a,b\r\n"one\rtwo",2\r\n');
    expect(records).toEqual([{ a: 'one\rtwo', b: '2' }]);
  });

  it('takes the rest of the payload for an unterminated quote rather than throwing', async () => {
    const { records } = await whole('a,b\n"never closed,2\n');
    expect(records).toEqual([{ a: 'never closed,2\n', b: null }]);
  });

  it('honours a configured delimiter', async () => {
    const { records } = await whole('a;b\n1;2\n', ';');
    expect(records).toEqual([{ a: '1', b: '2' }]);
  });
});

describe('the blank-line ledger survives streaming', () => {
  it('counts a blank line in the middle, whichever way it is chunked', async () => {
    const text = 'a,b\n1,2\n\n3,4\n';
    for (const chunks of splits(text)) {
      const { records, ledger } = await read(chunks);
      expect(records).toHaveLength(2);
      expect(ledger.blankRows).toBe(1);
    }
  });

  it('counts a blank line before the header, which is what shifts it', async () => {
    const { records, ledger } = await whole('\na,b\n1,2\n');
    expect(records).toEqual([{ a: '1', b: '2' }]);
    expect(ledger.blankRows).toBe(1);
  });

  it('counts a row that is nothing but delimiters', async () => {
    const { ledger } = await whole('a,b,c\n1,2,3\n,,\n');
    expect(ledger.blankRows).toBe(1);
  });

  it('says nothing about a file ending in a single newline', async () => {
    const { ledger } = await whole('a,b\n1,2\n');
    expect(ledger.blankRows).toBe(0);
  });

  it('says nothing about CRLF endings', async () => {
    const { ledger } = await whole('a,b\r\n1,2\r\n');
    expect(ledger.blankRows).toBe(0);
  });

  it('names the source that had them, for a reader deciding what to open', async () => {
    const { ledger } = await whole('a,b\n1,2\n\n');
    expect(ledger.firstSource).toBe('drop.csv');
    expect(ledger.sources).toBe(1);
  });

  it('reports what it skipped even when the read is abandoned partway', async () => {
    // The blank is before the row the consumer stops on, so a ledger settled
    // only at exhaustion would report nothing at all.
    const ledger = blankRowLedger();
    const stream = csvRecords(iterate(['a,b\n\n1,2\n3,4\n']), ',', 'drop.csv', ledger);
    for await (const _ of stream) break;
    expect(ledger.blankRows).toBe(1);
  });
});

describe('the reader pulls rather than being pushed', () => {
  it('does not ask for the next chunk until the consumer takes a record', async () => {
    const asked: number[] = [];
    const chunks = async function* (): AsyncGenerator<string> {
      for (let index = 0; index < 4; index += 1) {
        asked.push(index);
        yield `${index},${index}\n`;
      }
    };

    const ledger = blankRowLedger();
    const stream = csvRecords(chunks(), ',', 'drop.csv', ledger);
    const iterator = stream[Symbol.asyncIterator]();

    // The header costs one chunk. Everything after it is one chunk per record,
    // and the count of chunks asked for is what proves nothing ran ahead.
    await iterator.next();
    expect(asked).toEqual([0, 1]);
    await iterator.next();
    expect(asked).toEqual([0, 1, 2]);
    await iterator.return?.();
  });
});

describe('ndjson', () => {
  it('reads one value per line, whichever way it is chunked', async () => {
    const text = '{"a":1}\n{"a":2}\n{"a":3}\n';
    for (const chunks of splits(text)) {
      const records: unknown[] = [];
      for await (const record of ndjsonRecords(iterate(chunks), 'drop.ndjson')) {
        records.push(record);
      }
      expect(records).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
    }
  });

  it('reads a last line with no trailing newline', async () => {
    const records: unknown[] = [];
    for await (const record of ndjsonRecords(iterate(['{"a":1}\n{"a":2}']), 'x')) {
      records.push(record);
    }
    expect(records).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('skips blank lines, which in ndjson are separators rather than records', async () => {
    const records: unknown[] = [];
    for await (const record of ndjsonRecords(iterate(['{"a":1}\n\n\n{"a":2}\n']), 'x')) {
      records.push(record);
    }
    expect(records).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('names the line a parse failed on, which a per-line JSON error cannot', async () => {
    const run = async (): Promise<void> => {
      for await (const _ of ndjsonRecords(iterate(['{"a":1}\n', 'not json\n']), 'drop.ndjson')) {
        // drained for the throw
      }
    };
    await expect(run()).rejects.toThrow(/drop\.ndjson line 2 is not JSON/);
  });
});

describe('decoding bytes to text', () => {
  const encoder = new TextEncoder();

  it('does not split a multi-byte character across a chunk boundary', async () => {
    const bytes = encoder.encode('café,naïve\n');
    for (let at = 0; at <= bytes.length; at += 1) {
      const chunks = [bytes.subarray(0, at), bytes.subarray(at)];
      let text = '';
      for await (const piece of decodeChunks(iterate(chunks))) text += piece;
      expect(text, `split at ${at}`).toBe('café,naïve\n');
    }
  });

  it('leaves a byte-order mark alone, as readFile with utf8 does', async () => {
    const bytes = encoder.encode('﻿a,b\n1,2\n');
    let text = '';
    for await (const piece of decodeChunks(iterate([bytes]))) text += piece;
    expect(text.charCodeAt(0)).toBe(0xfeff);
  });

  it('reads a CSV whose header carries a BOM without renaming the column', async () => {
    const bytes = encoder.encode('﻿a,b\n1,2\n');
    const records: unknown[] = [];
    const ledger = blankRowLedger();
    for await (const record of csvRecords(decodeChunks(iterate([bytes])), ',', 'x', ledger)) {
      records.push(record);
    }
    // The BOM is still on the first header name, which is what the whole-text
    // reader did too. Changing that is a different decision than this one.
    expect(Object.keys(records[0] as object)).toEqual(['﻿a', 'b']);
  });
});
