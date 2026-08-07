import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogConnector } from '@dudousxd/nestjs-catalog';
import { describe, expect, it } from 'vitest';
import { type FetchResult, fetchFile } from './sources';

/**
 * What a CSV parse hands back, and what it says about what it threw away.
 *
 * These cases are a reconstruction of a measurement rather than an invention:
 * `af_fleet.csv` out of flip's 21 LRS drop has 103,087 data rows, of which 568
 * are entirely blank lines and 13,061 more carry a blank `Mgmt Cd`. The source
 * node reported 102,519 and nothing anywhere accounted for the missing 568.
 * The numbers below are those numbers, so a regression reads as the same gap.
 */

async function csvFile(text: string, name = 'drop.csv'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'catalog-csv-'));
  const path = join(dir, name);
  await writeFile(path, text, 'utf8');
  return path;
}

function connector(path: string, config: Record<string, unknown> = {}): CatalogConnector {
  return {
    id: 'c1',
    name: 'Drop',
    kind: 'file',
    targetType: 'AfFleet',
    config: { path, ...config },
    enabled: true,
    createdBy: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * Read a CSV through the real fetcher, as a {@link FetchResult}.
 *
 * Through `fetchFile` rather than by reaching for the parser, because the parser
 * is not exported and the thing under test is what a *connector* produces —
 * including whether the note survives the trip out of the fetcher, which is the
 * half that was missing.
 */
async function read(text: string, config: Record<string, unknown> = {}): Promise<FetchResult> {
  const result = await fetchFile({
    connector: connector(await csvFile(text), config),
    state: {},
    mode: 'full',
  });
  if (Array.isArray(result) || !Array.isArray(result.records)) {
    throw new Error('fetchFile returned a shape this test does not understand.');
  }
  return { records: result.records, ...('notes' in result ? { notes: result.notes } : {}) };
}

/** `af_fleet.csv`, to scale: 103,087 data rows, 568 of them blank lines. */
const TOTAL_DATA_ROWS = 103_087;
const BLANK_LINES = 568;
const BLANK_MGMT_CD = 13_061;

function afFleet(): string {
  const lines = ['mgmtCd,assetId'];
  for (let i = 0; i < TOTAL_DATA_ROWS - BLANK_LINES - BLANK_MGMT_CD; i += 1) {
    lines.push(`FB,A${i}`);
  }
  for (let i = 0; i < BLANK_MGMT_CD; i += 1) lines.push(`,B${i}`);
  for (let i = 0; i < BLANK_LINES; i += 1) lines.push('');
  return `${lines.join('\n')}\n`;
}

describe('parseCsv, on a well-formed file', () => {
  // The constraint on the whole fix: a trailing newline is how nearly every CSV
  // ends, and a note on every one of them is a note nobody reads. The scanner
  // closes its last row at the `\n` and starts no new one, so there is nothing
  // to report — this pins that, because a "helpful" change to `splitCsvRows`
  // would turn the ledger into noise without failing anything else.
  it('says nothing about a file ending in a single newline', async () => {
    const result = await read('a,b\n1,2\n3,4\n');
    expect(result.records).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
    expect(result.notes).toBeUndefined();
  });

  it('says nothing about CRLF line endings either', async () => {
    const result = await read('a,b\r\n1,2\r\n');
    expect(result.records).toEqual([{ a: '1', b: '2' }]);
    expect(result.notes).toBeUndefined();
  });

  it('says nothing about a file with no trailing newline at all', async () => {
    const result = await read('a,b\n1,2');
    expect(result.records).toEqual([{ a: '1', b: '2' }]);
    expect(result.notes).toBeUndefined();
  });
});

describe('parseCsv, on blank lines', () => {
  // The measured defect. 103,087 data rows in, 102,519 records out, and before
  // this the 568 were unaccounted for anywhere.
  it('still skips them, and now reports how many', async () => {
    const result = await read(afFleet());

    expect(result.records).toHaveLength(102_519);
    expect(TOTAL_DATA_ROWS - result.records.length).toBe(BLANK_LINES);
    expect(result.notes).toEqual([expect.stringContaining('Skipped 568 blank lines')]);
    expect(result.notes?.[0]).toContain('not in the record count');
  });

  it('counts a blank line in the middle of the rows', async () => {
    const result = await read('a,b\n1,2\n\n3,4\n');
    expect(result.records).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
    expect(result.notes?.[0]).toContain('Skipped 1 blank line in');
  });

  // A row of nothing but delimiters is blank in the sense that matters: every
  // cell of it is empty. It is also the shape a spreadsheet writes for a row
  // somebody cleared rather than deleted, which is where the 568 came from.
  it('counts a row that is nothing but delimiters', async () => {
    const result = await read('a,b\n1,2\n,\n');
    expect(result.records).toEqual([{ a: '1', b: '2' }]);
    expect(result.notes?.[0]).toContain('Skipped 1 blank line');
  });

  // A blank line before the header does not just get skipped — it changes which
  // line the header is read from. The behaviour is unchanged, deliberately, but
  // it is now said out loud, which is the only reason anybody would find it.
  it('counts a blank line before the header, which is what shifts it', async () => {
    const result = await read('\na,b\n1,2\n');
    expect(result.records).toEqual([{ a: '1', b: '2' }]);
    expect(result.notes?.[0]).toContain('Skipped 1 blank line');
  });

  it('names the file, so a reader knows which drop to open', async () => {
    const result = await read('a,b\n1,2\n\n', {});
    expect(result.notes?.[0]).toContain('drop.csv');
  });
});

describe('parseCsv, on what a cell becomes', () => {
  // A wire contract as much as a parse detail, and the reason it is pinned in
  // this file rather than only in the workbook one: a blank cell and a missing
  // cell are both `null`, so `present isNotNull` means the same thing whichever
  // format the source read. Aligning CSV on `null` is `emptyAsNull`'s job — see
  // its docblock — and a reader that answered `""` here would make the same drop
  // filter two ways depending on whether it arrived as .csv or .xlsx.
  it('makes both a blank cell and a missing cell null', async () => {
    const result = await read('a,b\n,2\n1\n');
    expect(result.records).toEqual([
      { a: null, b: '2' },
      { a: '1', b: null },
    ]);
  });

  // The counter runs on the raw cells, before `emptyAsNull`. Worth its own case
  // because the two are one line apart and both are about what a blank becomes:
  // a row of empty cells is still counted as a blank *line*, and is not confused
  // with a row of real values that happen to map to null.
  it('counts a blank line even though every kept cell also becomes null', async () => {
    const result = await read('a,b\n,\n,2\n');
    expect(result.records).toEqual([{ a: null, b: '2' }]);
    expect(result.notes?.[0]).toContain('Skipped 1 blank line');
  });
});
