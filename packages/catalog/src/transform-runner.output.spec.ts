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
