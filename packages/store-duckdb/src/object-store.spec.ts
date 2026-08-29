import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ObjectStore, localObjectStore } from './object-store';

let root: string;
let store: ObjectStore;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'catalog-duckdb-obj-'));
  store = localObjectStore(root);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('localObjectStore', () => {
  it('round-trips a body and reports an etag that changes with the content', async () => {
    const first = await store.put('a/b.json', '{"n":1}');
    const read = await store.get('a/b.json');
    expect(read?.body).toBe('{"n":1}');
    expect(read?.etag).toBe(first.etag);
    const second = await store.put('a/b.json', '{"n":2}');
    expect(second.etag).not.toBe(first.etag);
  });

  it('answers undefined for a key that was never written', async () => {
    expect(await store.get('nope.json')).toBeUndefined();
  });

  it('lets exactly one putIfAbsent win', async () => {
    // This is the create-if-absent half of the pointer swap. On S3 it is
    // `If-None-Match: *`; here it is an exclusive open. Both give the same
    // answer: the first write to finish succeeds and the rest are told no.
    const results = await Promise.all([
      store.putIfAbsent('race.json', 'one'),
      store.putIfAbsent('race.json', 'two'),
      store.putIfAbsent('race.json', 'three'),
    ]);
    expect(results.filter((result) => result !== undefined)).toHaveLength(1);
  });

  it('refuses a putIfMatch whose etag has moved', async () => {
    const written = await store.put('cas.json', 'v1');
    await store.put('cas.json', 'v2');
    expect(await store.putIfMatch('cas.json', 'v3', written.etag)).toBeUndefined();
  });

  it('accepts a putIfMatch on the current etag', async () => {
    const written = await store.put('cas2.json', 'v1');
    expect(await store.putIfMatch('cas2.json', 'v2', written.etag)).toBeDefined();
  });

  it('lists a prefix and deletes it whole', async () => {
    await store.put('p/one.parquet', 'x');
    await store.put('p/two.parquet', 'y');
    expect((await store.list('p')).sort()).toEqual(['p/one.parquet', 'p/two.parquet']);
    expect(await store.deletePrefix('p')).toBe(2);
    expect(await store.list('p')).toEqual([]);
  });

  it('makes a deeply nested key writable after prepare', async () => {
    // The real dependency: DuckDB's `COPY … TO` writes at the path `locate` builds and will
    // not create the directory leading to it. Assert the actual behaviour the store relies
    // on — a plain fs write to that path succeeding — rather than asserting the directory
    // exists, which would pass even if `locate` and `prepare` disagreed on the path.
    const key = 'deep/nested/dir/object.parquet';
    await store.prepare(key);
    await writeFile(store.locate(key), 'ok', 'utf8');
  });

  it('propagates a get failure that is not "the key is absent"', async () => {
    // EISDIR is a cheap, reliable way to produce a non-ENOENT fault without filling a disk:
    // reading a directory as though it were a file. `get` must not report this as "never
    // written" — a reader built on `get` (the snapshot lookup Task 5 adds) needs "this does
    // not exist" and "I could not read it" to land in different places.
    mkdirSync(join(root, 'a-directory'));
    await expect(store.get('a-directory')).rejects.toThrow();
  });

  it('propagates a putIfAbsent failure that is not a lost race', async () => {
    // A permission fault under the target directory, not EEXIST. `mkdir` on an
    // already-existing directory is a no-op regardless of its permissions, so the failure
    // surfaces where it actually would in production: the exclusive `open` itself, as
    // EACCES. That must not be swallowed as "someone else already wrote it".
    const lockedDir = join(root, 'locked');
    mkdirSync(lockedDir);
    chmodSync(lockedDir, 0o000);
    try {
      await expect(store.putIfAbsent('locked/race.json', 'x')).rejects.toThrow();
    } finally {
      chmodSync(lockedDir, 0o700);
    }
  });
});
