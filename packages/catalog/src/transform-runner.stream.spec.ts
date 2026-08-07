import { describe, expect, it } from 'vitest';
import { recordModeRefusal, transformMode } from './catalog.pipeline';
import { SubprocessTransformRunner } from './transform-runner';

/**
 * The per-record streaming path, against a real child process for the reason
 * `transform-runner.spec.ts` gives at length: the harness exists only as a
 * string of source for another interpreter, so a stub proves nothing about the
 * one thing that can be wrong.
 *
 * What is under test here that is not under test there is the **transport** —
 * chunk boundaries, back-pressure, the stall clock, and the attribution of a
 * failure to a record. Chunk boundaries in particular are where a lost row
 * hides, so several of these deliberately use record counts either side of
 * `RECORDS_PER_LINE` and `FLUSH_RECORDS` rather than round numbers.
 */
const runner = new SubprocessTransformRunner();

const RENAME = `export default function transform({ record }) {
  return { mgmtCd: record["Mgmt Cd"] };
}`;

async function* feed(records: unknown[]): AsyncGenerator<unknown> {
  for (const record of records) yield record;
}

/** Drain a stream into rows plus its summary, the way a consumer must. */
async function drain(code: string, records: unknown[], options = {}) {
  const stream = await runner.runStream(
    { language: 'javascript', code, mode: 'record' },
    feed(records),
    options,
  );
  const rows: Array<Record<string, unknown>> = [];
  for await (const row of stream.rows) rows.push(row);
  return { rows, summary: stream.summary() };
}

function fleet(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({ 'Mgmt Cd': `C${600 + (i % 40)}`, i }));
}

describe('the mode discriminant', () => {
  // The whole backward-compatibility argument in one assertion: nothing stored
  // before the field existed carries it, and every one of them is a batch.
  it('reads an absent mode as batch', () => {
    expect(transformMode({})).toBe('batch');
    expect(transformMode({ mode: undefined })).toBe('batch');
    expect(transformMode({ mode: 'record' })).toBe('record');
  });

  it('refuses a per-record transform written as a bare body, naming the export', () => {
    const refusal = recordModeRefusal({
      language: 'javascript',
      code: 'return records.map(r => r);',
      mode: 'record',
    });
    expect(refusal).toContain('must be a module');
    expect(refusal).toContain('export default function transform({ record, context })');
  });

  it('refuses a per-record transform in Python, and says why not yet', () => {
    const refusal = recordModeRefusal({
      language: 'python',
      code: 'return records',
      mode: 'record',
    });
    expect(refusal).toContain('cannot be written in Python yet');
  });

  it('says nothing about a whole-batch transform of any shape', () => {
    expect(recordModeRefusal({ language: 'python', code: 'return records', mode: 'batch' })).toBe(
      undefined,
    );
    expect(recordModeRefusal({ language: 'javascript', code: 'return records;' })).toBe(undefined);
  });
});

describe('runStream', () => {
  it('calls the code once per record and streams the rows back', async () => {
    const { rows, summary } = await drain(RENAME, [{ 'Mgmt Cd': 'C601' }, { 'Mgmt Cd': 'C602' }]);
    expect(rows).toEqual([{ mgmtCd: 'C601' }, { mgmtCd: 'C602' }]);
    expect(summary.recordsIn).toBe(2);
    expect(summary.rowsOut).toBe(2);
  });

  // The count that matters most, and the one a chunked wire can get wrong. 1,501
  // is deliberately not a multiple of RECORDS_PER_LINE (500) or FLUSH_RECORDS
  // (200): a row lost to a boundary shows up here and nowhere else.
  it('loses no record across the chunk boundaries of the wire', async () => {
    const records = fleet(1_501);
    const { rows, summary } = await drain(RENAME, records);
    expect(rows).toHaveLength(1_501);
    expect(summary.recordsIn).toBe(1_501);
    expect(rows[0]).toEqual({ mgmtCd: 'C600' });
    expect(rows[1_500]).toEqual({ mgmtCd: `C${600 + (1_500 % 40)}` });
  });

  it('handles a record count of exactly one line, and of exactly none', async () => {
    expect((await drain(RENAME, fleet(500))).rows).toHaveLength(500);
    const empty = await drain(RENAME, []);
    expect(empty.rows).toEqual([]);
    expect(empty.summary.recordsIn).toBe(0);
  });

  // The four return shapes the mode promises, in one transform, so that "map,
  // filter and flatMap under one rule" is a test rather than a docblock.
  it('reads an object as one row, an array as those rows, and null as none', async () => {
    const code = `export default function transform({ record }) {
      if (record.drop) return null;
      if (record.none) return [];
      if (record.two) return [{ n: 1 }, { n: 2 }];
      return { n: 0 };
    }`;
    const { rows, summary } = await drain(code, [
      { two: true },
      { drop: true },
      {},
      { none: true },
    ]);
    expect(rows).toEqual([{ n: 1 }, { n: 2 }, { n: 0 }]);
    expect(summary.recordsIn).toBe(4);
    expect(summary.rowsOut).toBe(3);
  });

  it('drops anything that is not a plain object, as the batch path does', async () => {
    const code =
      'export default function transform({ record }) { return record.bad ? 7 : { n: 1 }; }';
    const { rows } = await drain(code, [{ bad: true }, {}]);
    expect(rows).toEqual([{ n: 1 }]);
  });

  it('hands the code the context, frozen, on every record', async () => {
    const code = `export default function transform({ record, context }) {
      return { env: context.env.TOKEN, frozen: Object.isFrozen(context), n: record.n };
    }`;
    const stream = await runner.runStream(
      { language: 'javascript', code, mode: 'record' },
      feed([{ n: 1 }, { n: 2 }]),
      { context: { contract: 1, rowCount: 2, inputs: [], env: { TOKEN: 'abc' } } },
    );
    const rows = [];
    for await (const row of stream.rows) rows.push(row);
    expect(rows).toEqual([
      { env: 'abc', frozen: true, n: 1 },
      { env: 'abc', frozen: true, n: 2 },
    ]);
  });

  it('captures what the code logged, in call order, once for the whole run', async () => {
    const code =
      'export default function transform({ record }) { console.log("saw " + record.n); return { n: record.n }; }';
    const { summary } = await drain(code, [{ n: 1 }, { n: 2 }]);
    expect(summary.logs).toEqual(['saw 1', 'saw 2']);
  });
});

describe('what a failing stream says', () => {
  // The whole failure-attribution argument: a batch call can say only that the
  // transform threw. This names the record, which is the difference between a
  // reproducible bug and an afternoon.
  it('names the record it died on', async () => {
    const code = `export default function transform({ record }) {
      if (record.i === 617) throw new Error("no");
      return { i: record.i };
    }`;
    await expect(drain(code, fleet(1_000))).rejects.toThrow(/failed on record 618: Error: no/);
  });

  it('carries the tail of what the code logged into the failure', async () => {
    const code = `export default function transform({ record }) {
      console.log("before " + record.i);
      if (record.i === 2) throw new Error("boom");
      return { i: record.i };
    }`;
    await expect(drain(code, fleet(10))).rejects.toThrow(/before 1/);
  });

  it('refuses a module that exports no function, by name', async () => {
    await expect(drain('export const nope = 1;', [{}])).rejects.toThrow(/export default/);
  });

  it('refuses to stream a whole-batch transform rather than calling it per record', async () => {
    await expect(
      runner.runStream({ language: 'javascript', code: RENAME, mode: 'batch' }, feed([])),
    ).rejects.toThrow(/function over the whole batch/);
  });

  it('refuses the summary before the rows have been drained', async () => {
    const stream = await runner.runStream(
      { language: 'javascript', code: RENAME, mode: 'record' },
      feed(fleet(10)),
    );
    expect(() => stream.summary()).toThrow(/has not finished/);
    for await (const _ of stream.rows) {
      // drained so the child is not left holding a pipe
    }
    expect(stream.summary().recordsIn).toBe(10);
  });
});

describe('the stall clock', () => {
  // The failure the timeout exists for: user code hung on one record. It is
  // caught, the group is killed, and the message locates it — which is strictly
  // more than the batch timeout could say, where a hang reported only that
  // thirty seconds had passed.
  it('stops a transform that hangs on a record, and locates it', async () => {
    const code = `export default function transform({ record }) {
      if (record.i === 3) { while (true) {} }
      return { i: record.i };
    }`;
    await expect(drain(code, fleet(10), { timeoutMs: 750 })).rejects.toThrow(
      /stopped making progress for 750ms.*somewhere in records 1 to 10/s,
    );
  }, 20_000);

  // The window narrows to what the child last reported, so a hang past the first
  // flush is located within FLUSH_RECORDS rather than within the whole load.
  it('narrows the window to the last progress the child reported', async () => {
    const code = `export default function transform({ record }) {
      if (record.i === 450) { while (true) {} }
      return { i: record.i };
    }`;
    await expect(drain(code, fleet(600), { timeoutMs: 750 })).rejects.toThrow(
      /somewhere in records 401 to 600/,
    );
  }, 20_000);

  // The case a total wall-clock bound would have broken, and the reason the
  // clock had to become a stall clock rather than being carried over: a source
  // slower than the timeout is an ordinary load, not a hung transform.
  it('does not fire while the source is slow and the child has nothing to do', async () => {
    async function* slowly(): AsyncGenerator<unknown> {
      for (let i = 0; i < 4; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        yield { 'Mgmt Cd': `C${600 + i}` };
      }
    }
    const stream = await runner.runStream(
      { language: 'javascript', code: RENAME, mode: 'record' },
      slowly(),
      { timeoutMs: 400 },
    );
    const rows = [];
    for await (const row of stream.rows) rows.push(row);
    expect(rows).toHaveLength(4);
  }, 20_000);

  // The other case, and the one that is easy to get wrong in the opposite
  // direction: a sink writing to a busy warehouse must back-pressure the whole
  // chain without reading as a hang.
  it('does not fire while the consumer is slow', async () => {
    const stream = await runner.runStream(
      { language: 'javascript', code: RENAME, mode: 'record' },
      feed(fleet(1_200)),
      { timeoutMs: 400 },
    );
    const rows = [];
    for await (const row of stream.rows) {
      if (rows.length % 400 === 0) await new Promise((resolve) => setTimeout(resolve, 600));
      rows.push(row);
    }
    expect(rows).toHaveLength(1_200);
    expect(stream.summary().recordsIn).toBe(1_200);
  }, 30_000);
});
