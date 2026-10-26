import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubprocessTransformRunner } from './transform-runner';

/**
 * How the runner reads what a child wrote to stdout: as text that may arrive
 * split anywhere, including inside a character and far inside a line.
 *
 * Real child processes, for the reason `transform-runner.spec.ts` gives. The
 * pipe is what decides where the chunks fall, so a stub would be testing a
 * chunking nobody ships.
 */
const runner = new SubprocessTransformRunner();

/** Two-, three- and four-byte UTF-8 characters, so some chunk boundary splits one. */
const MULTI_BYTE = 'é€😀';

describe('the batch path decodes stdout as one stream', () => {
  it('keeps a multi-byte character that a chunk boundary splits', async () => {
    // About 1.8 MB of output in 64 KiB pipe reads. Lengths of 2, 3 and 4 bytes
    // put a boundary inside a character with near certainty.
    const result = await runner.run(
      {
        language: 'javascript',
        code: `return [{ text: ${JSON.stringify(MULTI_BYTE)}.repeat(200000) }];`,
      },
      [],
    );

    const text = (result.rows[0] as { text: string }).text;
    expect(text).not.toContain('�');
    expect(text).toBe(MULTI_BYTE.repeat(200_000));
  });
});

/**
 * A transform that writes `é` to stderr as two separate writes of one byte
 * each, far enough apart that the parent reads them as two chunks, and then
 * exits non-zero so stderr lands in the error.
 */
const SPLIT_STDERR = `
  const bytes = Buffer.from("café ok", "utf8");
  process.stderr.write(bytes.subarray(0, 4));
  const until = Date.now() + 300;
  while (Date.now() < until) {}
  process.stderr.write(bytes.subarray(4));
  process.exit(3);
`;

describe('stderr is decoded as one stream', () => {
  it('keeps a character split across two chunks, on the batch path', async () => {
    const error = await runner
      .run({ language: 'javascript', code: SPLIT_STDERR }, [])
      .then(() => undefined, (caught: unknown) => caught);

    expect(String(error)).toContain('café ok');
    expect(String(error)).not.toContain('\uFFFD');
  });

  it('keeps a character split across two chunks, on the streaming path', async () => {
    const stream = await runner.runStream(
      {
        language: 'javascript',
        mode: 'record',
        code: `${SPLIT_STDERR}\nexport default function transform({ record }) { return record; }`,
      },
      (async function* () {
        yield { n: 1 };
      })(),
    );
    const error = await (async () => {
      for await (const _ of stream.rows) {
        // drained for the failure
      }
    })().then(() => undefined, (caught: unknown) => caught);

    expect(String(error)).toContain('café ok');
    expect(String(error)).not.toContain('\uFFFD');
  });
});

describe('the streaming path reads a long line once', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not rescan the start of a line for every chunk of it', async () => {
    let scanned = 0;
    const { indexOf } = String.prototype;
    vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (
      this: string,
      ...args: unknown[]
    ) {
      const length = String(this).length;
      if (args[0] === '\n' && length >= 1_000) scanned += length - Number(args[1] ?? 0);
      return Reflect.apply(indexOf, this, args);
    });

    const size = 8 * 1024 * 1024;
    const stream = await runner.runStream(
      {
        language: 'javascript',
        mode: 'record',
        code: `export default function transform() { return { text: 'x'.repeat(${size}) }; }`,
      },
      (async function* () {
        yield { n: 1 };
      })(),
    );
    const rows: Array<Record<string, unknown>> = [];
    for await (const row of stream.rows) rows.push(row);
    vi.restoreAllMocks();

    expect(rows).toHaveLength(1);
    expect((rows[0]?.text as string).length).toBe(size);
    // Searching the whole carried line again after each 64 KiB chunk looks at
    // ~128 chunks' worth of a line growing to 8 MB: over 500 million characters.
    expect(scanned).toBeLessThan(3 * size);
  });
});

describe('the streaming harness reads a long input line once', () => {
  it('does not rescan the start of a record line for every chunk of it', async () => {
    // The module's top level runs in the child before the harness reads stdin,
    // so it can count what the harness asks `indexOf` to scan for a newline
    // while it assembles the line carrying this one large record.
    const code = `
      const { indexOf } = String.prototype;
      globalThis.scanned = 0;
      String.prototype.indexOf = function (...args) {
        if (args[0] === "\\n" && this.length >= 1000) {
          globalThis.scanned += this.length - Number(args[1] ?? 0);
        }
        return Reflect.apply(indexOf, this, args);
      };
      export default function transform({ record }) {
        return { length: record.text.length, scanned: globalThis.scanned };
      }`;
    const size = 8 * 1024 * 1024;
    const stream = await runner.runStream(
      { language: 'javascript', mode: 'record', code },
      (async function* () {
        yield { text: 'x'.repeat(size) };
      })(),
    );
    const rows: Array<Record<string, unknown>> = [];
    for await (const row of stream.rows) rows.push(row);

    expect(rows[0]?.length).toBe(size);
    // Searching the whole carried line after each 64 KiB chunk is ~128 passes
    // over a line growing to 8 MB: over 500 million characters.
    expect(rows[0]?.scanned).toBeLessThan(3 * size);
  });
});
