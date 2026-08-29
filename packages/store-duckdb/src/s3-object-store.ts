import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import type { ObjectStore } from './object-store';
import type { DuckDbS3Options } from './options';

/**
 * A precondition loss on a `PutObjectCommand`: `412 Precondition Failed` for both
 * `If-None-Match` and `If-Match`, and `409 Conflict`, which S3 raises when a delete lands
 * mid-flight on the key a conditional write is targeting. All three are the ordinary "someone
 * else won" outcome `putIfAbsent`/`putIfMatch` report as `undefined`; anything else — a bad
 * credential, a missing bucket, a throttle — is a real fault and must surface as one.
 */
function isPreconditionFailure(error: unknown): boolean {
  if (!(error instanceof S3ServiceException)) return false;
  const status = error.$metadata.httpStatusCode;
  return status === 412 || status === 409;
}

/**
 * Object storage, with the two conditional writes the pointer swap needs.
 *
 * `If-None-Match: *` is create-if-absent and `If-Match` is compare-and-swap, and unlike the
 * local binding's version of the same two methods (see its own docblock), both are genuinely
 * atomic here: AWS's stated guarantee is that "the first write operation to finish succeeds",
 * and every other concurrent writer gets back a precondition failure rather than a lost
 * update. This binding is where that guarantee — the one the whole port exists to name —
 * becomes real instead of approximated.
 *
 * Every write below is a single `PutObjectCommand`, deliberately: the objects behind this
 * port are a pointer and a snapshot record, never rows, so there is never a reason to reach
 * for a multipart upload — and a good thing too, because a `409` on `CompleteMultipartUpload`
 * cannot be resolved by retrying that call, only by re-initiating the whole upload.
 *
 * `If-Match` needs `s3:GetObject` on top of `s3:PutObject` in the caller's IAM policy — S3
 * has to read the current object to compare its etag before deciding whether the write is
 * allowed, and a policy scoped to write-only fails every `putIfMatch` with `403`.
 */
export function s3ObjectStore(root: string, options: DuckDbS3Options = {}): ObjectStore {
  const withoutScheme = root.slice('s3://'.length);
  const slash = withoutScheme.indexOf('/');
  const bucket = slash === -1 ? withoutScheme : withoutScheme.slice(0, slash);
  const prefix = slash === -1 ? '' : withoutScheme.slice(slash + 1).replace(/\/$/, '');

  const client = new S3Client({
    region: options.region,
    ...(options.endpoint
      ? { endpoint: `${options.useSsl === false ? 'http' : 'https'}://${options.endpoint}` }
      : {}),
    forcePathStyle: options.urlStyle === 'path',
    ...(options.accessKeyId && options.secretAccessKey
      ? {
          credentials: {
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey,
            ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
          },
        }
      : {}),
  });

  function keyFor(key: string): string {
    return prefix ? `${prefix}/${key}` : key;
  }

  /**
   * Strips the root prefix a key was stored under, so a caller sees the same key back that
   * it listed or wrote with — never the bucket-wide path this binding actually uses on S3.
   */
  function keyFrom(objectKey: string): string {
    return prefix ? objectKey.slice(prefix.length + 1) : objectKey;
  }

  return {
    async get(key) {
      const response = await client
        .send(new GetObjectCommand({ Bucket: bucket, Key: keyFor(key) }))
        .catch((error: unknown) => {
          if (error instanceof S3ServiceException && error.name === 'NoSuchKey') {
            return undefined;
          }
          throw error;
        });
      if (!response?.Body || !response.ETag) return undefined;
      return { body: await response.Body.transformToString(), etag: response.ETag };
    },

    async put(key, body) {
      const response = await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: keyFor(key), Body: body }),
      );
      return { etag: response.ETag ?? '' };
    },

    async putIfAbsent(key, body) {
      try {
        const response = await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: keyFor(key),
            Body: body,
            IfNoneMatch: '*',
          }),
        );
        return { etag: response.ETag ?? '' };
      } catch (error) {
        if (isPreconditionFailure(error)) return undefined;
        throw error;
      }
    },

    async putIfMatch(key, body, etag) {
      try {
        const response = await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: keyFor(key),
            Body: body,
            IfMatch: etag,
          }),
        );
        return { etag: response.ETag ?? '' };
      } catch (error) {
        if (isPreconditionFailure(error)) return undefined;
        throw error;
      }
    },

    /**
     * Matched at the same boundary the local binding walks: a directory. S3 has no
     * directories, only a flat namespace where `Prefix: 'p'` would also return `p2/x` — so
     * `Prefix` is built as `<key>/`, one path segment, exactly like the local binding's
     * `readdir` never descending from `p` into a sibling `p2`. Getting this wrong is not
     * cosmetic: two snapshots whose ids share a prefix (`run-1` and `run-10`) would otherwise
     * see each other's objects in `list`, and everything built on it — `deletePrefix`,
     * snapshot listing — would silently follow.
     */
    async list(listPrefix) {
      const found: string[] = [];
      let token: string | undefined;
      do {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: `${keyFor(listPrefix)}/`,
            ContinuationToken: token,
          }),
        );
        for (const object of response.Contents ?? []) {
          if (object.Key) found.push(keyFrom(object.Key));
        }
        token = response.NextContinuationToken;
      } while (token);
      return found;
    },

    async deletePrefix(deletePrefix) {
      const keys = await this.list(deletePrefix);
      if (keys.length === 0) return 0;
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.map((key) => ({ Key: keyFor(key) })) },
        }),
      );
      return keys.length;
    },

    locate(key) {
      return `s3://${bucket}/${keyFor(key)}`;
    },

    /**
     * A no-op. `prepare` exists on the port because the local binding has a real directory
     * to create before DuckDB's `COPY … TO` will write there; object storage has no
     * directories to create, and asking S3 to make one would be answering a question that
     * makes no sense for this binding — which is exactly why the question is asked through
     * the port rather than assumed by the store.
     */
    async prepare() {},
  };
}

/**
 * Creates a bucket if it is absent, swallowing the "already owned by you" answer a second
 * caller gets for the same bucket. Not called by {@link s3ObjectStore} itself — a running
 * store should never discover mid-write that its bucket needs provisioning — so this is for
 * a test fixture or a first-boot script to call once, ahead of handing the same connection
 * details to {@link s3ObjectStore}.
 */
export async function ensureBucket(client: S3Client, bucket: string): Promise<void> {
  await client.send(new CreateBucketCommand({ Bucket: bucket })).catch((error: unknown) => {
    if (error instanceof S3ServiceException && error.name === 'BucketAlreadyOwnedByYou') return;
    throw error;
  });
}
