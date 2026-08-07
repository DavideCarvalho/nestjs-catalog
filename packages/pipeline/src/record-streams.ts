import { StringDecoder } from 'node:string_decoder';

/**
 * Turning bytes into records without ever holding all of them.
 *
 * The line-oriented half of reading a file. CSV and NDJSON both have a row
 * boundary that can be found while the bytes are still arriving, which is the
 * whole reason a `file` or `s3` connector can now hand rows over incrementally
 * instead of parsing a finished string.
 *
 * **There is exactly one reader per format, and it is the streaming one.** The
 * whole-text versions in `sources.ts` were deleted rather than kept alongside,
 * because two implementations of "where does a row end" is two answers to what
 * a quoted newline means, and the symptom of them disagreeing is a row count
 * that differs by how the file happened to be *delivered* — which nobody would
 * look for. Reading a whole file is this reader handed one chunk; reading a
 * stream is the same reader handed many. That is also what makes the
 * chunk-boundary property testable: the same function, the same input, split in
 * every possible place, has to produce the same records.
 */

/**
 * A CSV reader that survives a chunk boundary anywhere.
 *
 * The state that has to cross a boundary is exactly the state the whole-text
 * scanner kept in local variables — the field so far, the row so far, and
 * whether the reader is inside a quoted run — so this is that scanner with
 * those four things lifted into a closure and a `push`/`end` pair around it.
 * Nothing about what a row *is* changed, and that is deliberate: a chunk that
 * lands mid-quoted-field is where a streaming reader silently loses or splits a
 * record, and the only defence that holds is that there is one scanner.
 *
 * The quirks below are the original reader's and are preserved rather than
 * tidied, because a transform written against them is in production:
 *
 * - A `"` anywhere opens a quoted run, even mid-field. `ab"c,d"ef` is one field.
 * - `""` inside a quoted run is one literal quote.
 * - An unterminated quote takes the rest of the payload rather than throwing. A
 *   truncated export is far more common than a deliberately malformed one, and
 *   the row count is what makes it noticed.
 * - `\r` is stripped only from the end of the last field of a row, so a CRLF
 *   file reads the same as an LF one.
 */
export interface CsvScanner {
  /** Every row this chunk completed. A row split across chunks is held back. */
  push(text: string): string[][];
  /** The last row, if the payload did not end with a newline. */
  end(): string[][];
}

/** Where the scanner is, between two characters. */
type CsvState =
  /** Ordinary text. A quote here opens a run; a delimiter or newline ends something. */
  | 'field'
  /** Inside a quoted run. A delimiter and a newline are ordinary characters. */
  | 'quoted'
  /** Just saw a quote inside a run; the next character says whether it was an escape. */
  | 'quote-maybe';

export function csvScanner(delimiter: string): CsvScanner {
  let state: CsvState = 'field';
  let field = '';
  let row: string[] = [];

  /**
   * One character in whichever state the scanner is in.
   *
   * `quote-maybe` re-reads the character in `field` state rather than handling
   * it twice, which is what makes `ab"c,d"ef` one field: the whole-text reader
   * returns from its quoted run *at* the closing quote and lets the outer loop
   * carry on appending to the same field, and this is that same handover.
   */
  const consume = (char: string, rows: string[][]): void => {
    if (state === 'quoted') {
      if (char === '"') state = 'quote-maybe';
      else field += char;
      return;
    }
    if (state === 'quote-maybe') {
      state = 'field';
      // A doubled quote is one literal quote and the run continues.
      if (char === '"') {
        field += '"';
        state = 'quoted';
        return;
      }
      // Otherwise the run closed and this character belongs to the field.
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
      // Indexed rather than `for (const char of text)`, which iterates by code
      // *point* and hands back a surrogate pair as one two-unit string. The
      // whole-text reader this has to agree with indexed with `text[i]`, and
      // "agrees with" is the only property here worth having.
      for (let index = 0; index < text.length; index += 1) consume(text[index] ?? '', rows);
      return rows;
    },
    end(): string[][] {
      // A payload ending on `quote-maybe` ended on a closing quote, which is a
      // closed run rather than an unterminated one — the whole-text reader
      // reaches the same conclusion by running out of characters to look at.
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

/**
 * Whether a row is worth keeping at all.
 *
 * The whole-text reader spelled this as `rows.filter(r => r.some(c => c.length
 * > 0))` *before* taking the header off the front, so a blank line anywhere —
 * including above the header — is skipped rather than read as a record of
 * nulls. Applied per row here so the streaming reader makes the same judgement
 * at the same moment.
 *
 * Asked of the **raw** cells, and deliberately before {@link emptyAsNull} runs:
 * this asks whether the *line* had any content, which is a question about the
 * file. A row of empty cells and a row of `null`s are the same thing once the
 * mapping is done, and by then the distinction this counts is gone.
 */
function isBlankRow(cells: readonly string[]): boolean {
  return !cells.some((cell) => cell.length > 0);
}

/**
 * The running count of lines a read has thrown away.
 *
 * A mutable tally rather than a return value, because a streamed read has no
 * moment at which it could return one: the rows go out as they are found, and
 * the total is not known until the last chunk. The caller holds this, hands it
 * in, and reads it after the stream is drained — the same timing
 * `StreamedFetchResult.state` has, and for the same reason.
 *
 * It exists at all because the skip used to be invisible. A `.filter` with no
 * counter removed 568 rows from a real 103,087-row drop and reported 102,519
 * with nothing anywhere saying where the rest went. Streaming must not
 * reintroduce that, which is why every reader here takes one.
 */
export interface BlankRowLedger {
  blankRows: number;
  /** The first source that had one, which is what somebody opens to look. */
  firstSource?: string;
  /** How many sources contributed, for a prefix read over many objects. */
  sources: number;
}

export function blankRowLedger(): BlankRowLedger {
  return { blankRows: 0, sources: 0 };
}

/**
 * An empty field, as `null` rather than as `""`.
 *
 * This was `cells[index] ?? null`, which made a **missing** cell `null` and a
 * **blank** one `""` — two spellings of "this row has no value here", only one
 * of which the `present` predicate recognises, because it tests `null` and
 * `undefined` and an empty string is neither. A graph filtering on `isNotNull`
 * therefore kept every blank in the file: measured against one real drop, it
 * committed 102,519 rows where the right answer was 89,458.
 *
 * `null` is now the single answer, and the reason to prefer it over teaching
 * `present` about `""` is that the workbook reader has the same question and
 * cannot answer it the other way: a blank spreadsheet cell is an *absent* cell,
 * there is no empty string anywhere in the file to report. Aligning CSV on
 * `null` makes one predicate mean one thing whichever format the source read;
 * aligning the other way would have meant inventing a value for the 3,468 empty
 * cells in the MVR sample.
 *
 * Nothing is trimmed on the way past. A field of spaces is a value somebody
 * typed, and deciding what it means is the transform's job — as it always was.
 */
export function emptyAsNull(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

/**
 * Cells under the header's names.
 *
 * One function for both readers, because this is where the blank-versus-missing
 * question is answered and two copies of that answer is exactly the thing a
 * predicate like `isNotNull` would then disagree with itself about.
 */
export function shapeCsvRecord(header: readonly string[], cells: readonly string[]): unknown {
  return Object.fromEntries(header.map((name, index) => [name, emptyAsNull(cells[index])]));
}

/**
 * A CSV payload as records, a chunk at a time.
 *
 * The header is whatever the first non-blank row turns out to be, exactly as in
 * the whole-text reader — which means the first chunk has to produce at least
 * one row before any record can be yielded. That is the only buffering here: a
 * header, a partial row, and nothing else.
 *
 * `ledger` is counted into as the blank lines go past rather than returned,
 * which is what keeps the skip visible on a read that has no return value. See
 * {@link BlankRowLedger}.
 */
export async function* csvRecords(
  chunks: AsyncIterable<string>,
  delimiter: string,
  source: string,
  ledger: BlankRowLedger,
): AsyncGenerator<unknown> {
  const scanner = csvScanner(delimiter);
  let header: string[] | undefined;
  let blanksHere = 0;

  const emit = function* (rows: string[][]): Generator<unknown> {
    for (const cells of rows) {
      if (isBlankRow(cells)) {
        blanksHere += 1;
        ledger.blankRows += 1;
        continue;
      }
      if (!header) {
        header = cells;
        continue;
      }
      yield shapeCsvRecord(header, cells);
    }
  };

  try {
    for await (const chunk of chunks) yield* emit(scanner.push(chunk));
    yield* emit(scanner.end());
  } finally {
    // In a `finally` so that a read abandoned partway still reports what it did
    // skip. A partial ledger is a true statement about a partial read; silence
    // is not.
    if (blanksHere > 0) {
      ledger.sources += 1;
      if (ledger.firstSource === undefined) ledger.firstSource = source;
    }
  }
}

/**
 * An NDJSON payload as records, a chunk at a time.
 *
 * The same three rules the whole-text reader applied — split on `\n`, trim,
 * drop what is left empty — with the last line held back until the next chunk
 * arrives, since a chunk boundary lands mid-line far more often than not.
 *
 * The line number is carried into the failure. `JSON.parse` reports a position
 * within the *line* it was given, which in a whole-payload read was at least a
 * position within the file; a streamed read would otherwise report "position 12"
 * for a hundred-thousandth line and leave nothing to look at.
 */
export async function* ndjsonRecords(
  chunks: AsyncIterable<string>,
  source: string,
): AsyncGenerator<unknown> {
  let pending = '';
  let line = 0;

  const parse = (raw: string): unknown => {
    line += 1;
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `${source} line ${line} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  for await (const chunk of chunks) {
    pending += chunk;
    const lines = pending.split('\n');
    // The last piece is either a partial line or the empty string after a
    // trailing newline. Either way it is not known to be complete yet.
    pending = lines.pop() ?? '';
    for (const raw of lines) {
      const trimmed = raw.trim();
      if (trimmed) yield parse(trimmed);
    }
  }

  const last = pending.trim();
  if (last) yield parse(last);
}

/**
 * Bytes as text, without splitting a character in half.
 *
 * `StringDecoder` holds an incomplete multi-byte sequence back until the rest
 * of it arrives, which is the difference between this and calling
 * `Buffer.toString('utf8')` per chunk — the latter turns every UTF-8 character
 * unlucky enough to straddle a 64 KiB boundary into two replacement characters,
 * and in a 7.6 MB export that is a handful of silently corrupted cells rather
 * than an error.
 *
 * It also leaves a byte-order mark alone, which `readFile(path, 'utf8')` does
 * and `TextDecoder` does not. A CSV whose first header silently lost its BOM is
 * a different column name than the transform was written against.
 */
export async function* decodeChunks(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  for await (const chunk of chunks) {
    const text = decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    if (text) yield text;
  }
  const rest = decoder.end();
  if (rest) yield rest;
}
