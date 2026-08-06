/**
 * CSV, for the export button.
 *
 * Two things here are not the obvious implementation, and both are here because
 * the obvious one was wrong in production.
 *
 * **Rows are written as they arrive.** {@link csvLines} is a generator over an
 * async row source, so the caller can hand each line to a socket and never hold
 * the file. The buffered {@link toCsv} is still exported — it is public API and
 * a caller with a result already in memory has nothing to gain from a stream —
 * but it is now the special case rather than the only shape.
 *
 * **A cell that a spreadsheet would run is neutralised.** See
 * {@link guardFormula}.
 */

/** One row of a result, as every store hands it over. */
export type CsvRow = Record<string, unknown>;

/**
 * The characters a spreadsheet reads as "what follows is a formula".
 *
 * `=` is the obvious one. `+`, `-` and `@` are the ones people forget: Excel and
 * Sheets both accept a leading `+` or `-` as the start of an expression, and `@`
 * introduces a function reference. `-2+3+cmd|' /C calc'!A0` is a working command
 * execution in an unpatched Excel, and it starts with a minus sign.
 */
const FORMULA_LEADERS = new Set(['=', '+', '-', '@']);

/**
 * Blank a spreadsheet strips before it decides whether a cell is a formula.
 *
 * The reason this exists rather than a plain `text[0]` test: importers do not
 * agree on whether leading blank is part of the value. Several strip it and then
 * dispatch on what is left, so `  =1+1` is a formula to them and an innocent
 * string to a guard that only looked at position zero. Guarding the stripped
 * form costs nothing on values that were never formulas.
 */
const LEADING_BLANK = /^[\t\n\v\f\r  ]+/;

/**
 * A value a spreadsheet will read back as the number it already is.
 *
 * This is the exemption that keeps the guard from corrupting data — see
 * {@link guardFormula}. Deliberately narrow: an optional sign, digits with at
 * most one point, an optional exponent, and nothing else. `-42` matches.
 * `-42abc` does not, `- 42` does not, and `-2+3+cmd|' /C calc'!A0` does not.
 */
const PLAIN_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Stop a cell being executed when the file is opened.
 *
 * A CSV is not a document format, it is a program that a spreadsheet is willing
 * to run. A cell whose value begins with one of {@link FORMULA_LEADERS} is
 * evaluated on open, and the values in this file come from whatever the queried
 * source contained — which for this catalog is other people's operational data,
 * loaded by connectors, from systems nobody here controls. So the crafted cell
 * is not a thought experiment: it is one row in a table an operator exports and
 * opens.
 *
 * **The escape is a leading apostrophe, and it is not free.** Excel and Sheets
 * both read `'` as "the rest is literal text" and do not show it in the cell;
 * every other reader on earth — a parser, a `pandas.read_csv`, the next
 * pipeline that ingests this export — sees an apostrophe that was not in the
 * source. That is a real corruption, and it is why the guard is not applied to
 * every cell that merely starts with a leader.
 *
 * **So a value that is plainly a number is left exactly as it was.** `-42` is
 * not an injection vector: a spreadsheet evaluates it to the number -42, which
 * is what it already was. Exempting it is what lets a machine read this file
 * back and still get -42, and it costs no safety, because the population being
 * defended against — `=`, `@`, an operator followed by anything that is not a
 * number — is disjoint from it. Everything outside the exemption gets the
 * apostrophe and reads differently to a parser than it did to the database.
 * That trade is deliberate: a wrong apostrophe is a data-quality bug somebody
 * can see, and a formula is code running on the machine of whoever opened the
 * file.
 *
 * The apostrophe goes at position 0, in front of any leading blank, because
 * that is the only position a spreadsheet honours it in.
 */
export function guardFormula(text: string): string {
  if (text.length === 0) return text;

  // A literal tab or carriage return in first position is itself treated as a
  // leader by some importers, which strip it and evaluate what follows.
  const leadingControl = text[0] === '\t' || text[0] === '\r';
  const body = text.replace(LEADING_BLANK, '');
  if (body.length === 0) return text;
  if (!leadingControl && !FORMULA_LEADERS.has(body[0])) return text;

  return PLAIN_NUMBER.test(body) ? text : `'${text}`;
}

/**
 * One cell, ready to sit in a row.
 *
 * Order matters and is the second thing people get wrong. The formula guard
 * runs on the raw text, and the CSV quoting runs on the result — so a value that
 * needs both comes out as `"'=1+1,x"`, with the apostrophe INSIDE the quotes and
 * applied once. Doing it the other way round would put the apostrophe outside
 * the quoting and produce a field no CSV reader can parse; doing it twice would
 * put two apostrophes in a cell that needed one.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const guarded = guardFormula(text);
  // Quote when the value could otherwise break the row apart. Doubling the
  // quote is the CSV escape, not a backslash.
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** CRLF: Excel still treats a bare LF file as one long row in some locales. */
const EOL = '\r\n';

function csvLine(cells: readonly string[]): string {
  return `${cells.join(',')}${EOL}`;
}

/**
 * A CSV file, one line at a time, from a source that hands rows over as it has
 * them.
 *
 * Each yield is a complete line including its terminator, so a consumer can
 * write it and forget it. Nothing accumulates here: the generator holds one row
 * and the column list, whatever the source is doing, which is the whole point —
 * an export has no row cap by design, so the only bound available is that no
 * stage keeps more than it is using.
 *
 * `columns` may be omitted, and then the header is taken from the keys of the
 * first row — the same rule the buffered read uses, applied at the only moment a
 * stream can apply it. A source that knows its columns up front should pass
 * them, because it is the only way an empty result gets a header row at all.
 */
export async function* csvLines(
  rows: AsyncIterable<CsvRow>,
  columns?: readonly string[],
): AsyncGenerator<string> {
  // A declared header goes out before the source is asked for anything, so an
  // empty result is still a file that says which columns were empty rather than
  // zero bytes.
  let header = columns;
  if (header !== undefined) yield csvLine(header.map(csvCell));

  for await (const row of rows) {
    if (header === undefined) {
      header = Object.keys(row);
      yield csvLine(header.map(csvCell));
    }
    yield csvLine(header.map((column) => csvCell(row[column])));
  }
}

/**
 * The whole file as a string.
 *
 * Kept because it is public API and because a caller holding a finished result
 * gains nothing from a stream. It is NOT what the export route uses — see
 * {@link csvLines} — and a caller reaching for it with an unbounded result is
 * choosing to hold the file.
 */
export function toCsv(result: { columns: string[]; rows: CsvRow[] }): string {
  const lines = [csvLine(result.columns.map(csvCell))];
  for (const row of result.rows) {
    lines.push(csvLine(result.columns.map((column) => csvCell(row[column]))));
  }
  return lines.join('');
}
