import { S3Client } from '@aws-sdk/client-s3';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ObjectStore } from './object-store';
import { ensureBucket, s3ObjectStore } from './s3-object-store';

/**
 * The S3 binding, against MinIO.
 *
 * A container here and not for the contract, because this is the one part of the adapter
 * whose behaviour is the object store's rather than DuckDB's: conditional writes are the
 * mechanism the pointer swap rests on, and a fake that returned `undefined` on a losing race
 * would pass while proving nothing about `If-Match`.
 */
const MINIO_IMAGE = 'minio/minio:RELEASE.2025-04-22T22-12-26Z';

let container: StartedTestContainer;
let store: ObjectStore;

beforeAll(async () => {
  container = await new GenericContainer(MINIO_IMAGE)
    .withCommand(['server', '/data'])
    .withEnvironment({ MINIO_ROOT_USER: 'catalog', MINIO_ROOT_PASSWORD: 'catalogsecret' })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000).forStatusCode(200))
    .withStartupTimeout(240_000)
    .start();

  const endpoint = `${container.getHost()}:${container.getMappedPort(9000)}`;
  store = s3ObjectStore('s3://catalog-test/prefix', {
    endpoint,
    region: 'us-east-1',
    accessKeyId: 'catalog',
    secretAccessKey: 'catalogsecret',
    urlStyle: 'path',
    useSsl: false,
  });
  await createBucket(endpoint, 'catalog-test');
}, 300_000);

afterAll(async () => {
  await container?.stop();
});

/**
 * Declared separately so the bucket-creation detail does not sit inside the fixture.
 *
 * A throwaway client, not `store` itself: `ObjectStore` has no bucket-creation method — a
 * directory needs none, and `mkdir`-ing one is exactly what `prepare` is for on that binding
 * — so bootstrapping the one S3 has is a fixture concern, done once here with `ensureBucket`,
 * never something `s3ObjectStore` does on a caller's behalf mid-write.
 */
async function createBucket(endpoint: string, bucket: string): Promise<void> {
  const client = new S3Client({
    region: 'us-east-1',
    endpoint: `http://${endpoint}`,
    forcePathStyle: true,
    credentials: { accessKeyId: 'catalog', secretAccessKey: 'catalogsecret' },
  });
  try {
    await ensureBucket(client, bucket);
  } finally {
    client.destroy();
  }
}

describe('s3ObjectStore', () => {
  it('lets exactly one putIfAbsent win, which is what the pointer swap rests on', async () => {
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

  it('spells a key as an s3 URL DuckDB can read', () => {
    expect(store.locate('mvr/run-1/part-000001.parquet')).toBe(
      's3://catalog-test/prefix/mvr/run-1/part-000001.parquet',
    );
  });

  it('matches list and deletePrefix at a directory boundary, not a raw string prefix', async () => {
    // `run-1` is a string prefix of `run-10` — the exact pair the brief names as the failure
    // mode a bare `Prefix` would produce. This would fail if `list`'s `Prefix` were built
    // without the trailing slash: `list('mvr/run-1')` would also return `run-10`'s object, and
    // `deletePrefix('mvr/run-1')` would take `run-10`'s snapshot down with it.
    await store.put('mvr/run-1/part-000001.parquet', 'one');
    await store.put('mvr/run-10/part-000001.parquet', 'ten');

    expect(await store.list('mvr/run-1')).toEqual(['mvr/run-1/part-000001.parquet']);

    expect(await store.deletePrefix('mvr/run-1')).toBe(1);
    expect(await store.list('mvr/run-1')).toEqual([]);
    expect(await store.list('mvr/run-10')).toEqual(['mvr/run-10/part-000001.parquet']);
  });
});
