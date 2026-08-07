import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { CatalogConnector } from '@dudousxd/nestjs-catalog';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FetchContext,
  fetchFile,
  fetchS3,
  toBufferedFetchResult,
  toRecordStream,
} from './sources';

/**
 * The file and S3 fetchers, read as streams.
 *
 * What is under test here is not "does it produce the right records" — the
 * readers themselves are covered in `record-streams.spec.ts` and
 * `sources.parquet.spec.ts`. It is the four properties that only exist once a
 * fetcher hands rows over instead of returning them:
 *
 * - **It pulls.** The next chunk is not read until the consumer takes a record,
 *   which is the whole reason the memory is bounded.
 * - **The watermark is what was finished.** A run that dies partway must not
 *   advance past objects nobody read. This is the one where a subtle mistake
 *   silently skips data on the *next* run, so it is asserted from both ends.
 * - **The ledger survives.** The blank-line count that PR #94 added must still
 *   reach the run, which for a stream means a function asked after the last row.
 * - **Nothing is left behind.** A spooled payload is released whether the read
 *   ran out or the consumer walked away.
 */

let directory: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'catalog-stream-'));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

function file(name: string, text: string): string {
  const path = join(directory, name);
  writeFileSync(path, text, 'utf8');
  return path;
}

function connector(kind: 'file' | 's3', config: Record<string, unknown>): CatalogConnector {
  return {
    id: 'c1',
    name: 'Drop',
    kind,
    targetType: 'Fleet',
    config,
    enabled: true,
    createdBy: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const FULL: Pick<FetchContext, 'state' | 'mode'> = { state: {}, mode: 'full' };

describe('a file connector hands rows over', () => {
  it('reports itself as streamed, which is what the runner logs about', async () => {
    const path = file('rows.csv', 'a,b\n1,2\n3,4\n');
    const stream = toRecordStream(await fetchFile({ connector: connector('file', { path }), ...FULL }));
    expect(stream.streamed).toBe(true);
  });

  it('leaves json whole, because a document has no row boundary', async () => {
    const path = file('rows.json', '[{"a":1},{"a":2}]');
    const stream = toRecordStream(await fetchFile({ connector: connector('file', { path }), ...FULL }));
    expect(stream.streamed).toBe(false);
  });

  it('reads a csv the same as a buffered read would', async () => {
    const path = file('same.csv', 'a,b\n"x,y",2\n\n3,4\n');
    const result = await toBufferedFetchResult(
      await fetchFile({ connector: connector('file', { path }), ...FULL }),
    );
    expect(result.records).toEqual([
      { a: 'x,y', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('carries the blank-line note out of a streamed read', async () => {
    const path = file('blanks.csv', 'a,b\n1,2\n\n\n3,4\n');
    const result = await toBufferedFetchResult(
      await fetchFile({ connector: connector('file', { path }), ...FULL }),
    );
    expect(result.records).toHaveLength(2);
    expect(result.notes).toEqual([expect.stringContaining('Skipped 2 blank lines')]);
    expect(result.notes?.[0]).toContain('blanks.csv');
  });

  /**
   * The note is a *function*, and asking it early is the mistake to catch.
   *
   * A streamed ledger is a running count. Anything that read the value before
   * the last row would report zero for every file in the world, and the symptom
   * would be the exact silence #94 exists to end.
   */
  it('reports nothing before the stream is drained, and the truth after', async () => {
    const path = file('timing.csv', 'a\n1\n\n2\n');
    const stream = toRecordStream(await fetchFile({ connector: connector('file', { path }), ...FULL }));

    expect(stream.notes()).toEqual([]);
    const records: unknown[] = [];
    for await (const record of stream.records) records.push(record);
    expect(records).toHaveLength(2);
    expect(stream.notes()).toEqual([expect.stringContaining('Skipped 1 blank line')]);
  });

  it('reads ndjson a line at a time', async () => {
    const path = file('rows.ndjson', '{"a":1}\n{"a":2}\n');
    const result = await toBufferedFetchResult(
      await fetchFile({ connector: connector('file', { path }), ...FULL }),
    );
    expect(result.records).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('refuses a payload over the connector`s own maxBytes', async () => {
    const path = file('big.csv', `a\n${'x'.repeat(500)}\n`);
    const stream = toRecordStream(
      await fetchFile({ connector: connector('file', { path, maxBytes: 10 }), ...FULL }),
    );

    const drain = async (): Promise<void> => {
      for await (const _ of stream.records) {
        // drained for the throw
      }
    };
    await expect(drain()).rejects.toThrow(/over the 10-byte limit/);
  });
});

describe('what a read still costs when it is unbounded', () => {
  /**
   * Streaming removes the memory ceiling and not this one.
   *
   * A remote source that opens a connection, sends a header and then goes quiet
   * is not an error any SDK reports — it is a promise that never settles,
   * holding a durable step until its lease expires with nothing recorded about
   * why. The timer is reset by every chunk, so a slow-but-alive transfer is
   * never interrupted; what it catches is a dead one.
   */
  it('abandons a remote read that has gone silent', async () => {
    const url = 'https://example.invalid/drop.csv';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('a,b\n'));
            // and then nothing, forever
          },
        }),
        { headers: { 'content-type': 'text/csv' } },
      ),
    );

    try {
      const stream = toRecordStream(
        await fetchFile({
          connector: connector('file', { url, format: 'csv', readIdleTimeoutMs: 30 }),
          ...FULL,
        }),
      );
      const drain = async (): Promise<void> => {
        for await (const _ of stream.records) {
          // drained for the throw
        }
      };
      await expect(drain()).rejects.toThrow(/sent nothing for 30ms/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('leaves no spool behind when a remote read fails', async () => {
    const before = await readdir(tmpdir());
    const spoolsBefore = before.filter((name) => name.startsWith('catalog-source-')).length;

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('a,b\n'));
          },
        }),
      ),
    );

    try {
      const stream = toRecordStream(
        await fetchFile({
          connector: connector('file', {
            url: 'https://example.invalid/drop.csv',
            format: 'csv',
            readIdleTimeoutMs: 30,
          }),
          ...FULL,
        }),
      );
      await expect(
        (async () => {
          for await (const _ of stream.records) {
            // drained for the throw
          }
        })(),
      ).rejects.toThrow();
    } finally {
      fetchSpy.mockRestore();
    }

    const after = await readdir(tmpdir());
    expect(after.filter((name) => name.startsWith('catalog-source-')).length).toBe(spoolsBefore);
  });
});

/**
 * As much of `@aws-sdk/client-s3` as the fetcher calls.
 *
 * The SDK is a devDependency here and is loaded at run time by
 * `importOptional`, so the mock is registered against the specifier the fetcher
 * imports — vitest resolves a dynamic `import()` through the same registry as a
 * static one. The bucket is a plain map of key to text; the response bodies are
 * real Node streams, because "is this thing async-iterable" is one of the
 * checks under test.
 */
interface FakeBucket {
  objects: Array<{ key: string; text: string; lastModified: Date }>;
  /** Keys whose body throws partway, so a mid-read failure can be staged. */
  failOn: Set<string>;
  /** Every key a `GetObject` was issued for, in order. */
  fetched: string[];
  destroyed: boolean;
}

const bucket = vi.hoisted(() => ({ current: undefined as FakeBucket | undefined }));

vi.mock('@aws-sdk/client-s3', () => {
  class ListObjectsV2Command {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class GetObjectCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class S3Client {
    async send(command: unknown): Promise<unknown> {
      const state = bucket.current;
      if (!state) throw new Error('No bucket was installed for this case.');

      if (command instanceof ListObjectsV2Command) {
        return {
          Contents: state.objects.map((object) => ({
            Key: object.key,
            LastModified: object.lastModified,
            Size: object.text.length,
          })),
        };
      }
      if (command instanceof GetObjectCommand) {
        const key = String(command.input.Key);
        state.fetched.push(key);
        const object = state.objects.find((entry) => entry.key === key);
        if (!object) throw new Error(`no such key ${key}`);
        const fails = state.failOn.has(key);
        return {
          Body: Readable.from(
            (async function* () {
              const bytes = new TextEncoder().encode(object.text);
              yield bytes.subarray(0, Math.ceil(bytes.length / 2));
              if (fails) throw new Error(`the connection to ${key} was reset`);
              yield bytes.subarray(Math.ceil(bytes.length / 2));
            })(),
          ),
        };
      }
      throw new Error('unexpected command');
    }
    destroy(): void {
      if (bucket.current) bucket.current.destroyed = true;
    }
  }
  return { S3Client, ListObjectsV2Command, GetObjectCommand };
});

function install(objects: FakeBucket['objects'], failOn: string[] = []): FakeBucket {
  const state: FakeBucket = {
    objects,
    failOn: new Set(failOn),
    fetched: [],
    destroyed: false,
  };
  bucket.current = state;
  return state;
}

function at(iso: string): Date {
  return new Date(iso);
}

beforeEach(() => {
  bucket.current = undefined;
});

describe('an s3 connector reads objects one at a time', () => {
  it('reads every object under the prefix, oldest first', async () => {
    install([
      { key: 'drops/b.csv', text: 'a\n2\n', lastModified: at('2026-01-02T00:00:00Z') },
      { key: 'drops/a.csv', text: 'a\n1\n', lastModified: at('2026-01-01T00:00:00Z') },
    ]);

    const result = await toBufferedFetchResult(
      await fetchS3({ connector: connector('s3', { bucket: 'drops', prefix: 'drops/' }), ...FULL }),
    );
    expect(result.records).toEqual([{ a: '1' }, { a: '2' }]);
  });

  it('does not fetch the second object before the first one`s records are taken', async () => {
    const state = install([
      { key: 'a.csv', text: 'h\n1\n2\n', lastModified: at('2026-01-01T00:00:00Z') },
      { key: 'b.csv', text: 'h\n3\n', lastModified: at('2026-01-02T00:00:00Z') },
    ]);

    const stream = toRecordStream(
      await fetchS3({ connector: connector('s3', { bucket: 'drops' }), ...FULL }),
    );
    const iterator = stream.records[Symbol.asyncIterator]();

    expect(state.fetched).toEqual([]);
    await iterator.next();
    expect(state.fetched).toEqual(['a.csv']);
    await iterator.next();
    expect(state.fetched).toEqual(['a.csv']);
    await iterator.next();
    expect(state.fetched).toEqual(['a.csv', 'b.csv']);
    await iterator.return?.();
  });

  it('sums the blank lines across objects into one note', async () => {
    install([
      { key: 'a.csv', text: 'h\n1\n\n', lastModified: at('2026-01-01T00:00:00Z') },
      { key: 'b.csv', text: 'h\n2\n\n\n', lastModified: at('2026-01-02T00:00:00Z') },
    ]);

    const result = await toBufferedFetchResult(
      await fetchS3({ connector: connector('s3', { bucket: 'drops' }), ...FULL }),
    );
    expect(result.records).toEqual([{ h: '1' }, { h: '2' }]);
    expect(result.notes).toEqual([expect.stringContaining('Skipped 3 blank lines')]);
    expect(result.notes?.[0]).toContain('2 sources read this run');
  });

  it('closes the client when the read runs out', async () => {
    const state = install([
      { key: 'a.csv', text: 'h\n1\n', lastModified: at('2026-01-01T00:00:00Z') },
    ]);
    await toBufferedFetchResult(
      await fetchS3({ connector: connector('s3', { bucket: 'drops' }), ...FULL }),
    );
    expect(state.destroyed).toBe(true);
  });

  it('closes the client when the consumer walks away early', async () => {
    const state = install([
      { key: 'a.csv', text: 'h\n1\n2\n3\n', lastModified: at('2026-01-01T00:00:00Z') },
    ]);
    const stream = toRecordStream(
      await fetchS3({ connector: connector('s3', { bucket: 'drops' }), ...FULL }),
    );
    for await (const _ of stream.records) break;
    expect(state.destroyed).toBe(true);
  });

  it('closes the client and advances nothing when the prefix holds nothing new', async () => {
    const state = install([]);
    const result = await fetchS3({ connector: connector('s3', { bucket: 'drops' }), ...FULL });
    expect(result).toEqual([]);
    expect(state.destroyed).toBe(true);
  });
});

/**
 * The watermark, and what a run that dies halfway is allowed to promise.
 *
 * This is the part where a subtle mistake silently skips data on the next run.
 * A watermark computed from the *listing* would say "I have read everything up
 * to the tenth object" the moment the run started; a run that died on the
 * fourth would then never read five through ten again, and nothing anywhere
 * would say so. The state is therefore computed from the objects whose last
 * record has actually gone past.
 */
describe('the watermark is what the stream got through', () => {
  const three = (): FakeBucket['objects'] => [
    { key: 'a.csv', text: 'h\n1\n', lastModified: at('2026-01-01T00:00:00Z') },
    { key: 'b.csv', text: 'h\n2\n', lastModified: at('2026-01-02T00:00:00Z') },
    { key: 'c.csv', text: 'h\n3\n', lastModified: at('2026-01-03T00:00:00Z') },
  ];

  it('advances to the last object when every one of them was read', async () => {
    install(three());
    const stream = toRecordStream(
      await fetchS3({ connector: connector('s3', { bucket: 'drops' }), ...FULL }),
    );
    for await (const _ of stream.records) {
      // drained
    }
    expect(stream.state()).toEqual({
      objectWatermark: '2026-01-03T00:00:00.000Z',
      objectWatermarkKeys: ['c.csv'],
    });
  });

  it('advances only as far as the objects it finished, when one fails', async () => {
    install(three(), ['b.csv']);
    const stream = toRecordStream(
      await fetchS3({ connector: connector('s3', { bucket: 'drops' }), ...FULL }),
    );

    await expect(
      (async () => {
        for await (const _ of stream.records) {
          // drained for the throw
        }
      })(),
    ).rejects.toThrow(/the connection to b\.csv was reset/);

    // The runner never asks after a throw — it propagates and the snapshot is
    // left uncommitted. Asked here anyway, because the value it *would* give is
    // the thing that must not name an object nobody read.
    expect(stream.state()).toEqual({
      objectWatermark: '2026-01-01T00:00:00.000Z',
      objectWatermarkKeys: ['a.csv'],
    });
  });

  it('advances nothing at all when the very first object fails', async () => {
    install(three(), ['a.csv']);
    const stream = toRecordStream(
      await fetchS3({ connector: connector('s3', { bucket: 'drops' }), ...FULL }),
    );
    await expect(
      (async () => {
        for await (const _ of stream.records) {
          // drained for the throw
        }
      })(),
    ).rejects.toThrow();
    expect(stream.state()).toBeUndefined();
  });

  it('resumes after the watermark on the next incremental run', async () => {
    install(three());
    const result = await toBufferedFetchResult(
      await fetchS3({
        connector: connector('s3', { bucket: 'drops' }),
        state: { objectWatermark: '2026-01-02T00:00:00.000Z', objectWatermarkKeys: ['b.csv'] },
        mode: 'incremental',
      }),
    );
    expect(result.records).toEqual([{ h: '3' }]);
  });

  /**
   * A sample is not a read, so it carries no watermark.
   *
   * `toBufferedFetchResult` with a limit stops pulling rather than slicing
   * afterwards, and the watermark of a read that stopped early would name a row
   * the caller never saw. Storing it would skip everything after it forever.
   */
  it('gives no state to a caller that only wanted a sample', async () => {
    install(three());
    const result = await toBufferedFetchResult(
      await fetchS3({ connector: connector('s3', { bucket: 'drops' }), ...FULL }),
      1,
    );
    expect(result.records).toHaveLength(1);
    expect(result.state).toBeUndefined();
  });
});
