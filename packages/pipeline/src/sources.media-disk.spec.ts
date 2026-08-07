import { Readable } from 'node:stream';
import type { CatalogConnector } from '@dudousxd/nestjs-catalog';
import { describe, expect, it, vi } from 'vitest';
import {
  CatalogStorage,
  MEDIA_STORAGE_SHARED,
  NO_STORAGE_DETAIL,
  storageMisboundDetail,
} from './media-storage';
import {
  type StorageManagerLike,
  fetchS3,
  isStorageManager,
  toBufferedFetchResult,
} from './sources';

/**
 * Reading a prefix through a media disk.
 *
 * The whole point of these is the pair of negatives. It is easy to test that a
 * disk-backed connector reads its rows; what actually goes wrong in production
 * is a connector that names a disk on a pod with no media and reads *nothing*
 * while reporting success — so most of what is asserted here is that the
 * refusals happen, and that they say which of the two things went wrong.
 */

interface FakeObject {
  key: string;
  text: string;
  lastModified: Date;
}

/** As much of a media `StorageDriver` as the fetcher calls, and nothing else. */
function fakeDisk(objects: FakeObject[], pageSize = 100) {
  const listed: Array<{ prefix: string; delimiter?: string; cursor?: string }> = [];
  const streamed: string[] = [];

  return {
    listed,
    streamed,
    driver: {
      async list(
        prefix: string,
        options?: { delimiter?: string; cursor?: string; limit?: number },
      ): Promise<unknown> {
        listed.push({
          prefix,
          ...(options?.delimiter !== undefined ? { delimiter: options.delimiter } : {}),
          ...(options?.cursor ? { cursor: options.cursor } : {}),
        });
        const matching = objects.filter((object) => object.key.startsWith(prefix));
        const start = options?.cursor ? Number(options.cursor) : 0;
        const page = matching.slice(start, start + pageSize);
        const next = start + pageSize;
        return {
          folders: [],
          files: page.map((object) => ({
            key: object.key,
            name: object.key.slice(prefix.length),
            sizeBytes: object.text.length,
            lastModified: object.lastModified,
          })),
          ...(next < matching.length ? { cursor: String(next) } : {}),
        };
      },
      async stream(path: string): Promise<unknown> {
        streamed.push(path);
        const object = objects.find((entry) => entry.key === path);
        if (!object) throw new Error(`no such key ${path}`);
        return Readable.from([Buffer.from(object.text, 'utf8')]);
      },
    },
  };
}

function manager(disks: Record<string, unknown>): StorageManagerLike {
  const narrowed: StorageManagerLike = {
    disk(name?: string): never | ReturnType<typeof fakeDisk>['driver'] {
      const driver = name === undefined ? undefined : disks[name];
      if (!driver) throw new Error(`unknown disk ${String(name)}`);
      if (!isDriver(driver)) throw new Error('not a driver');
      return driver;
    },
    diskNames: () => Object.keys(disks),
  };
  return narrowed;
}

function isDriver(value: unknown): value is ReturnType<typeof fakeDisk>['driver'] {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof Reflect.get(value, 'list') === 'function' &&
    typeof Reflect.get(value, 'stream') === 'function'
  );
}

function connector(config: Record<string, unknown>): CatalogConnector {
  const built: unknown = {
    id: 'c1',
    name: 'drops',
    kind: 's3',
    config,
    state: {},
    mode: 'full',
  };
  if (!isConnector(built)) throw new Error('unreachable');
  return built;
}

function isConnector(value: unknown): value is CatalogConnector {
  return !!value && typeof value === 'object' && typeof Reflect.get(value, 'kind') === 'string';
}

const AT = (iso: string): Date => new Date(iso);

describe('an s3 connector that names a media disk', () => {
  it('reads the rows through the disk, and never touches the AWS SDK', async () => {
    const disk = fakeDisk([
      {
        key: 'drops/a.ndjson',
        text: '{"n":1}\n{"n":2}\n',
        lastModified: AT('2026-01-01T00:00:00Z'),
      },
    ]);
    const fetched = await toBufferedFetchResult(
      await fetchS3({
        connector: connector({ disk: 'drops', prefix: 'drops/' }),
        state: {},
        mode: 'full',
        storage: manager({ drops: disk.driver }),
      }),
    );

    expect(fetched.records).toEqual([{ n: 1 }, { n: 2 }]);
    expect(disk.streamed).toEqual(['drops/a.ndjson']);
  });

  it('lists FLAT, so a nested prefix is not silently invisible', async () => {
    // The default `/` delimiter rolls nested keys up into folder prefixes. A
    // connector pointed at a partitioned prefix would then list one folder and
    // no files, read nothing, and report a successful run.
    const disk = fakeDisk([
      {
        key: 'drops/year=2026/month=07/part-0.ndjson',
        text: '{"n":1}\n',
        lastModified: AT('2026-01-01T00:00:00Z'),
      },
    ]);
    const fetched = await toBufferedFetchResult(
      await fetchS3({
        connector: connector({ disk: 'drops', prefix: 'drops/', format: 'ndjson' }),
        state: {},
        mode: 'full',
        storage: manager({ drops: disk.driver }),
      }),
    );

    expect(disk.listed.every((call) => call.delimiter === '')).toBe(true);
    expect(fetched.records).toEqual([{ n: 1 }]);
  });

  it('follows the cursor rather than reading only the first page', async () => {
    const objects = Array.from({ length: 5 }, (_, index) => ({
      key: `drops/part-${index}.ndjson`,
      text: `{"n":${index}}\n`,
      lastModified: AT(`2026-01-0${index + 1}T00:00:00Z`),
    }));
    const disk = fakeDisk(objects, 2);
    const fetched = await toBufferedFetchResult(
      await fetchS3({
        connector: connector({ disk: 'drops', prefix: 'drops/' }),
        state: {},
        mode: 'full',
        storage: manager({ drops: disk.driver }),
      }),
    );

    expect(fetched.records).toHaveLength(5);
    expect(disk.listed.length).toBeGreaterThan(1);
  });

  it('keeps the watermark and its tie set, exactly as the SDK path does', async () => {
    // The watermark logic lives above the transport seam, so this is really an
    // assertion that there is only one copy of it.
    const disk = fakeDisk([
      { key: 'drops/a.ndjson', text: '{"n":1}\n', lastModified: AT('2026-01-01T00:00:00Z') },
      { key: 'drops/b.ndjson', text: '{"n":2}\n', lastModified: AT('2026-01-02T00:00:00Z') },
      { key: 'drops/c.ndjson', text: '{"n":3}\n', lastModified: AT('2026-01-02T00:00:00Z') },
    ]);
    const fetched = await toBufferedFetchResult(
      await fetchS3({
        connector: connector({ disk: 'drops', prefix: 'drops/' }),
        state: {},
        mode: 'full',
        storage: manager({ drops: disk.driver }),
      }),
    );

    expect(fetched.state?.objectWatermark).toBe('2026-01-02T00:00:00.000Z');
    // Both keys at the watermark instant are remembered, so neither is re-read
    // and neither is lost.
    expect(new Set(asStrings(fetched.state?.objectWatermarkKeys))).toEqual(
      new Set(['drops/b.ndjson', 'drops/c.ndjson']),
    );
  });

  it('reads only what a later incremental run has not seen', async () => {
    const disk = fakeDisk([
      { key: 'drops/a.ndjson', text: '{"n":1}\n', lastModified: AT('2026-01-01T00:00:00Z') },
      { key: 'drops/b.ndjson', text: '{"n":2}\n', lastModified: AT('2026-01-05T00:00:00Z') },
    ]);
    const fetched = await toBufferedFetchResult(
      await fetchS3({
        connector: connector({ disk: 'drops', prefix: 'drops/' }),
        state: {
          objectWatermark: '2026-01-01T00:00:00.000Z',
          objectWatermarkKeys: ['drops/a.ndjson'],
        },
        mode: 'incremental',
        storage: manager({ drops: disk.driver }),
      }),
    );

    expect(fetched.records).toEqual([{ n: 2 }]);
    expect(disk.streamed).toEqual(['drops/b.ndjson']);
  });

  it('refuses an object the disk could not date, rather than skipping it', async () => {
    const undated = {
      async list(): Promise<unknown> {
        return {
          folders: [],
          files: [{ key: 'drops/x.ndjson', sizeBytes: 4, lastModified: null }],
        };
      },
      async stream(): Promise<unknown> {
        throw new Error('should not be read');
      },
    };

    await expect(
      fetchS3({
        connector: connector({ disk: 'drops', prefix: 'drops/' }),
        state: {},
        mode: 'full',
        storage: manager({ drops: undated }),
      }),
    ).rejects.toThrow(/has no lastModified.*skipped object is one nobody notices is missing/s);
  });
});

describe('naming a disk that cannot be opened', () => {
  it('distinguishes "no manager here" from "no disk by that name"', async () => {
    // The distinction the call-node picker draws between "there are none" and
    // "I cannot ask". One sends somebody to the deployment, the other to the
    // connector — and a single "could not open the disk" would send half of
    // them to the wrong place.
    const noManager = fetchS3({
      connector: connector({ disk: 'drops' }),
      state: {},
      mode: 'full',
      storage: undefined,
    });
    await expect(noManager).rejects.toThrow(/no storage manager resolved in this process/);

    const wrongName = fetchS3({
      connector: connector({ disk: 'drop' }),
      state: {},
      mode: 'full',
      storage: manager({ drops: fakeDisk([]).driver, archive: fakeDisk([]).driver }),
    });
    await expect(wrongName).rejects.toThrow(/not one this deployment configured/);
  });

  it('names the disks that would have worked, so the fix is on the screen', async () => {
    await expect(
      fetchS3({
        connector: connector({ disk: 'drop' }),
        state: {},
        mode: 'full',
        storage: manager({ drops: fakeDisk([]).driver, archive: fakeDisk([]).driver }),
      }),
    ).rejects.toThrow(/drops, archive/);
  });

  it('refuses rather than silently falling back to the SDK path', async () => {
    // The failure this exists to stop. A connector that names a disk carries no
    // bucket, so a silent fallback would not read the wrong objects — it would
    // read none, and call the run a success.
    const attempt = fetchS3({
      connector: connector({ disk: 'drops', bucket: '', prefix: 'drops/' }),
      state: {},
      mode: 'full',
      storage: undefined,
    });
    await expect(attempt).rejects.toThrow();
    await expect(attempt).rejects.not.toThrow(/no bucket configured/);
  });
});

describe('a connector that names no disk', () => {
  it('still demands a bucket, exactly as before', async () => {
    await expect(fetchS3({ connector: connector({}), state: {}, mode: 'full' })).rejects.toThrow(
      'This connector has no bucket configured.',
    );
  });
});

describe('what this deployment says about disks', () => {
  it('says what is LOST when no manager resolved, not merely that one is missing', () => {
    const availability = new CatalogStorage(undefined).availability();
    expect(availability.available).toBe(false);
    expect(availability.disks).toEqual([]);
    // The point of the sentence: a second copy of a credential is the cost, and
    // somebody who is not told that just mints one.
    expect(availability.detail).toBe(NO_STORAGE_DETAIL);
    expect(availability.detail).toMatch(/second copy of a credential/);
  });

  it('lists the disks a connector may name when one did resolve', () => {
    const availability = new CatalogStorage(
      manager({ drops: fakeDisk([]).driver, archive: fakeDisk([]).driver }),
    ).availability();
    expect(availability.available).toBe(true);
    expect(availability.disks).toEqual(['drops', 'archive']);
    expect(availability.detail).toMatch(/drops, archive/);
  });

  it('reports a manager with no disks as available-but-empty, which is a third answer', () => {
    const availability = new CatalogStorage(manager({})).availability();
    expect(availability.available).toBe(true);
    expect(availability.detail).toMatch(/no disks configured/);
  });

  it('treats something else bound under the token as unavailable, and warns once', () => {
    // Any package may bind a global symbol. "Something is there" is not "it can
    // open a disk", and a TypeError four frames into a run is the alternative.
    const warn = vi.fn();
    class NotAManager {}
    const storage = new CatalogStorage(new NotAManager());
    Reflect.set(storage, 'logger', { warn });

    expect(storage.manager()).toBeUndefined();
    expect(storage.availability().available).toBe(false);
    expect(storage.availability().detail).toBe(storageMisboundDetail('NotAManager'));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('resolves from the globally registered symbol media actually binds', () => {
    // Recreating the token is the whole of the coupling: a plain Symbol() could
    // not be reached from here without importing the package.
    expect(MEDIA_STORAGE_SHARED).toBe(Symbol.for('nestjs-media:storage'));
  });
});

describe('isStorageManager', () => {
  it('accepts a manager and refuses everything else', () => {
    expect(isStorageManager(manager({}))).toBe(true);
    expect(isStorageManager({ disk: () => undefined })).toBe(false);
    expect(isStorageManager(undefined)).toBe(false);
    expect(isStorageManager('drops')).toBe(false);
  });
});

function asStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}
