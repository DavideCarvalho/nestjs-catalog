import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Logger } from '@nestjs/common';

/**
 * Where a file-backed connector's bytes come from, and what keeps that read
 * bounded now that it is no longer bounded by "it all had to fit in a string".
 *
 * Every streamed payload is read **from a local file**. A local path is already
 * one. Anything remote — an HTTP body, an S3 object — is spooled to a temp file
 * first and streamed from there, and that is the single most important decision
 * in this file:
 *
 * **A slow consumer must not hold a remote socket open.** The pipeline's write
 * side flushes 500 rows at a time into MySQL and does not ask for the next row
 * until that write has finished, which is exactly the back-pressure that makes
 * streaming worth doing — and it is also exactly what kills a long-lived S3
 * read. flip hit this in production: an ingestion whose per-batch flushes
 * paused the read for minutes had the object store reset the connection
 * (ECONNRESET, three to four minutes in), because S3 closes a connection that
 * has gone quiet. Their fix was to download first and stream from disk, and it
 * is the same fix here. The download runs at full speed with nothing throttling
 * it, so the socket's lifetime is the object's size divided by the network
 * rather than the consumer's speed.
 *
 * What that costs, stated because it is a real cost: one object's worth of temp
 * disk, released as soon as the object's records have been read. Memory is
 * still bounded — a batch, not a file — and disk is bounded by the largest
 * single object, not by the prefix.
 *
 * The other reason it is a file rather than a socket: parquet is read by
 * seeking. Its footer is at the end and its row groups are addressed by byte
 * offset, so a reader needs random access. A one-directional body cannot give
 * that; a spool can, and so a single mechanism serves every streamed format.
 */

/**
 * **The seam, named — for whoever puts a storage driver behind it.**
 *
 * Nothing here knows what S3 is. The file-backed fetchers need exactly three
 * things from wherever bytes live, and they are deliberately small enough to
 * list:
 *
 * 1. **Enumerate a prefix**, yielding a key, a last-modified instant and a size.
 *    `listUnreadObjects`/`readListingEntry` in `sources.ts` are the only code
 *    that does this, and `S3Object` is the only shape it produces.
 * 2. **Open one key as chunks** — `AsyncIterable<Uint8Array>`, which is what
 *    {@link spool} takes. It is already transport-blind: `objectBodyChunks` in
 *    `sources.ts` is the whole S3-shaped part, and it is nine lines.
 * 3. **Read a byte range**, which only parquet wants, and which is satisfied
 *    today by spooling and seeking the spool.
 *
 * Those map onto `@dudousxd/nestjs-media`'s `StorageDriver` almost exactly —
 * `list()`, `stream()`, `stream(path, range)` — and an adapter should be one
 * small file rather than a rewrite of this one. **No media dependency is taken
 * here**; what follows is what reading that interface turned up, recorded so
 * the adapter's author does not have to find it twice.
 *
 * - **`list()` rolls keys up by default.** `ListOptions.delimiter` defaults to
 *   `'/'`, which puts deeper keys into `folders` instead of `files`. The
 *   catalog's listing passes *no* delimiter and is therefore recursive, so an
 *   adapter must ask for `delimiter: ''` or a connector pointed at a prefix of
 *   dated partitions will quietly see nothing but folder names. Silent, and
 *   indistinguishable from an empty bucket.
 * - **`ListEntry.lastModified` is `Date | null`.** The catalog *refuses* an
 *   entry it cannot place against the watermark rather than skipping it — see
 *   `readListingEntry` — because a skipped object is one nobody notices is
 *   missing. An adapter has to keep that refusal, not paper over a null with a
 *   `stat()` per key: a prefix of ten thousand objects would become ten
 *   thousand extra round trips per run.
 * - **`stat()` is not the cheaper path here, and it is worth saying why.** The
 *   suggestion that the current code fetches a body to learn last-modified is
 *   not what it does: `ListObjectsV2` returns `Key`, `LastModified` and `Size`
 *   in the listing itself, so the watermark already costs one paginated list
 *   and no `GetObject`. `stat()` would be strictly worse *for the fan-out*. It
 *   is genuinely useful for one thing this does not do yet — see the next point.
 * - **`capabilities.ranged` is the interesting one.** A driver that can serve a
 *   byte range could back a parquet read *without a spool at all*: parquet
 *   needs a length and random access, which is `stat().size` plus
 *   `stream(path, range)`, and `parquetRecordsFrom` in `source-parquet.ts` is
 *   already written against that pair rather than against a file handle. The
 *   text formats would still want the spool, for the back-pressure reason
 *   below, so `ranged` buys parquet and not CSV.
 */
const payloadLogger = new Logger('CatalogSourcePayload');

/**
 * How long a remote read may produce nothing before it is abandoned.
 *
 * Streaming removes the memory ceiling and does not remove this one: a socket
 * that opens, sends a header and then goes silent is not an error a `fetch` or
 * an SDK call reports — it is a promise that never settles, holding a durable
 * step until its lease expires with nothing recorded anywhere about why. The
 * timer is reset by every chunk, so a slow-but-alive transfer is never
 * interrupted; what it catches is a dead one.
 *
 * Overridable per connector with `readIdleTimeoutMs`.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

/**
 * A payload on this machine, whatever it arrived as.
 *
 * `release` is the caller's obligation and belongs in a `finally`. It removes a
 * spool and does nothing at all for a path the connector already pointed at —
 * deleting somebody's source file because a run finished reading it would be a
 * spectacular way to lose data.
 */
export interface LocalPayload {
  /** A path this process can open, seek and read repeatedly. */
  path: string;
  /** What the payload turned out to be, in bytes. */
  byteLength: number;
  release(): Promise<void>;
}

export interface PayloadLimits {
  /** Refuse a payload larger than this many bytes. Unset means no ceiling. */
  maxBytes?: number;
  /** How long a remote read may stall before it is abandoned. */
  idleTimeoutMs?: number;
}

/** Whether a connector's `path`/`url` names something to be fetched. */
export function isRemoteSource(source: string): boolean {
  return /^https?:\/\//.test(source);
}

/**
 * A connector's `path` or `url` as a local payload.
 *
 * A local path is used where it lies. A URL is spooled. The two are the same
 * type afterwards, which is what lets every streamed format have exactly one
 * reader rather than one per transport.
 */
export async function localPayload(source: string, limits: PayloadLimits): Promise<LocalPayload> {
  if (!isRemoteSource(source)) {
    const info = await stat(source);
    refuseOversize(info.size, source, limits.maxBytes);
    return { path: source, byteLength: info.size, release: async () => undefined };
  }

  const response = await fetch(source);
  if (!response.ok) throw new Error(`GET ${source} → ${response.status}`);
  if (!response.body) {
    throw new Error(`GET ${source} came back without a body, so there is nothing to read.`);
  }
  // The declared length, checked before a byte is written rather than only as
  // the bytes go past. A server that says how big the object is has told us
  // enough to refuse it without spending the transfer.
  refuseOversize(declaredLength(response), source, limits.maxBytes);

  const body = webBody(response.body);
  try {
    return await spool(body.chunks, source, limits);
  } catch (error) {
    // The socket, explicitly. A generator abandoned at a `read()` that will
    // never settle cannot close itself — its `finally` only runs when it is
    // resumed, and nothing is going to resume it. Cancelling the reader is what
    // actually resolves that pending read and frees the connection, and it is
    // the difference between a read that gave up after its idle timeout and a
    // worker that gave up and then held the socket anyway.
    body.abort();
    throw error;
  }
}

/**
 * An arriving body, written to a temp file and handed back as a path.
 *
 * The spool goes in its own directory so the cleanup is one `rm -r` of a
 * directory this process made, rather than an `unlink` of a path assembled from
 * a key somebody else chose.
 */
export async function spool(
  chunks: AsyncIterable<Uint8Array>,
  label: string,
  limits: PayloadLimits,
): Promise<LocalPayload> {
  const directory = await mkdtemp(join(tmpdir(), 'catalog-source-'));
  const path = join(directory, 'payload');
  const release = async (): Promise<void> => {
    await rm(directory, { recursive: true, force: true });
  };

  let byteLength = 0;
  try {
    await pipeline(
      counted(
        watched(chunks, limits.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, label),
        label,
        limits.maxBytes,
        (total) => {
          byteLength = total;
        },
      ),
      createWriteStream(path),
    );
  } catch (error) {
    // A half-written spool is not something a later run should find. Released
    // here rather than left to the caller's `finally`, because the caller never
    // receives a payload to release.
    await release();
    throw error;
  }

  return { path, byteLength, release };
}

/**
 * The bytes of a local payload, in chunks, with back-pressure.
 *
 * `createReadStream` async-iterated is the whole mechanism: Node stops reading
 * from the file descriptor while the consumer is away, so a reader that pauses
 * for a minute to flush a batch resumes against a file that has been sitting
 * there the entire time. That is the property the spool exists to buy, and the
 * reason nothing here has to think about timeouts a second time.
 */
export function payloadChunks(payload: LocalPayload): AsyncIterable<Uint8Array> {
  return createReadStream(payload.path);
}

/**
 * A `fetch` body as chunks, with a way to hang up on it.
 *
 * The abort is separate from the iterator on purpose. `return()`ing a generator
 * that is suspended at an `await` does not run its `finally` until that `await`
 * settles, so a body that has gone silent cannot be closed from the consumer's
 * side at all — which is precisely the case the idle timeout exists for.
 * `reader.cancel()` reaches past the generator to the stream, and a pending
 * `read()` resolves as done.
 */
function webBody(body: ReadableStream<Uint8Array>): {
  chunks: AsyncIterable<Uint8Array>;
  abort(): void;
} {
  const reader = body.getReader();
  const chunks = (async function* (): AsyncGenerator<Uint8Array> {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  })();
  return {
    chunks,
    abort: () => {
      void reader.cancel().catch(() => undefined);
    },
  };
}

/**
 * `Content-Length`, when the server gave one and it parses.
 *
 * Undefined means "it did not say", which is not the same as zero — a chunked
 * response has no length and is perfectly readable. The ceiling is still
 * enforced as the bytes arrive; this only lets an oversize object be refused
 * before it is transferred.
 */
function declaredLength(response: Response): number | undefined {
  const header = response.headers.get('content-length');
  if (header === null) return undefined;
  const parsed = Number(header);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function refuseOversize(
  size: number | undefined,
  label: string,
  maxBytes: number | undefined,
): void {
  if (maxBytes === undefined || size === undefined || size <= maxBytes) return;
  throw new Error(
    `${label} is ${size} bytes, over the ${maxBytes}-byte limit this connector sets with "maxBytes". Raise it, or narrow what the connector reads.`,
  );
}

/** Chunks, counted, and refused the moment the running total crosses the cap. */
async function* counted(
  chunks: AsyncIterable<Uint8Array>,
  label: string,
  maxBytes: number | undefined,
  report: (total: number) => void,
): AsyncGenerator<Uint8Array> {
  let total = 0;
  for await (const chunk of chunks) {
    total += chunk.byteLength;
    if (maxBytes !== undefined && total > maxBytes) {
      throw new Error(
        `${label} is over the ${maxBytes}-byte limit this connector sets with "maxBytes" — ${total} bytes had arrived when the read was abandoned. Raise it, or narrow what the connector reads.`,
      );
    }
    report(total);
    yield chunk;
  }
}

/**
 * Chunks, abandoned if the source goes quiet for too long.
 *
 * The pending read keeps its own rejection handler so that losing the race
 * cannot surface later as an unhandled rejection — the timeout wins, this
 * generator throws, and the read that was still outstanding settles into a
 * handler that ignores it. The upstream iterator is closed in the `finally`,
 * which is what actually tears the socket down.
 */
async function* watched(
  chunks: AsyncIterable<Uint8Array>,
  idleMs: number,
  label: string,
): AsyncGenerator<Uint8Array> {
  const iterator = chunks[Symbol.asyncIterator]();
  try {
    while (true) {
      const pending = iterator.next();
      // Attached before the race, not instead of it: `Promise.race` also
      // subscribes, but only the loser needs a handler that outlives it.
      pending.catch(() => undefined);

      let timer: NodeJS.Timeout | undefined;
      const idle = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `${label} sent nothing for ${idleMs}ms, so the read was abandoned rather than left to hold this step until its lease expired. Raise "readIdleTimeoutMs" on the connector if the source is genuinely this slow.`,
            ),
          );
        }, idleMs);
      });

      let result: IteratorResult<Uint8Array>;
      try {
        result = await Promise.race([pending, idle]);
      } finally {
        if (timer) clearTimeout(timer);
      }

      if (result.done) return;
      yield result.value;
    }
  } finally {
    // Not awaited. A source that stopped producing is a source whose `next()`
    // is still pending, and an async generator suspended at an `await` does not
    // reach its own `finally` until that settles — so awaiting this would hang
    // on exactly the read the timeout just gave up on. The close is asked for;
    // whether the source can honour it is the source's problem, and the caller
    // that owns the transport hangs up separately.
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
  }
}

/**
 * Say once that a payload was spooled, and how big it was.
 *
 * On the logger rather than the run's own log lines, because it is a fact about
 * this pod's disk rather than about the data — an operator chasing a full
 * volume needs it, and somebody reading a run does not.
 */
export function noteSpool(label: string, payload: LocalPayload): void {
  payloadLogger.debug(`Spooled ${label} to ${payload.path} (${payload.byteLength} bytes).`);
}
