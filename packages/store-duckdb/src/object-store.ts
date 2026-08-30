import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';

/**
 * The blob transport, as three reads, three writes and a path.
 *
 * A port rather than an S3 client, for two reasons that pull the same way. The first is
 * testability: the contract suite is 21 cases against a real engine, and requiring MinIO to
 * run any of them would make the cheapest, most-run gate the slowest one. The second is
 * that the two writes this store actually depends on — create-if-absent and
 * compare-and-swap — exist on S3 as `If-None-Match: *` and `If-Match`, and exist on a
 * filesystem as `O_CREAT|O_EXCL` and a read-then-write. Naming them here means the store
 * is written against the guarantee rather than against either implementation.
 *
 * `putIfAbsent` and `putIfMatch` answer `undefined` when they lose, never throw. Losing a
 * race is an ordinary outcome that the caller retries; an exception would make it look like
 * a fault.
 */
export interface ObjectStore {
  get(key: string): Promise<{ body: string; etag: string } | undefined>;
  put(key: string, body: string): Promise<{ etag: string }>;
  putIfAbsent(key: string, body: string): Promise<{ etag: string } | undefined>;
  putIfMatch(key: string, body: string, etag: string): Promise<{ etag: string } | undefined>;
  list(prefix: string): Promise<string[]>;
  /**
   * Remove every key under `prefix`, and answer how many were removed.
   *
   * **Removed, not attempted** — and stating it here rather than in one binding, because both
   * bindings arrive at the number the same way and each has its own way of being wrong about
   * it. Both list the prefix and then delete it, so the count comes from the listing; what a
   * binding owes is that the delete's failure reaches the caller instead of being rounded up
   * into that count. On a filesystem `rm` raises. On S3 a per-key failure is *not* an
   * exception — the request answers `200 OK` carrying an `Errors` array — so that binding has
   * to read the response and throw itself; see `assertDeleteSucceeded` in `s3-object-store.ts`.
   *
   * A partial failure therefore throws rather than returning a smaller number. There is no
   * count that would describe it usefully: the one caller that matters, `dropSnapshot`, writes
   * its tombstone only after this returns, so a throw leaves the record still claiming the rows
   * and the retry re-lists and finishes the job. A number would have let the tombstone land.
   *
   * A key written after the listing is neither counted nor deleted. That race is not closed
   * here, deliberately: closing it would need the port to hold a lock over a whole prefix, and
   * the only caller — `dropSnapshot` — is already written so that running it again is the
   * repair.
   */
  deletePrefix(prefix: string): Promise<number>;
  /**
   * How DuckDB names this key.
   *
   * The store hands DuckDB a path for `COPY … TO` and `read_parquet`, and DuckDB reaches
   * the bytes itself rather than through this port — so the two must agree on one spelling.
   */
  locate(key: string): string;
  /**
   * Make {@link locate}'s destination writable for a key that does not exist yet.
   *
   * DuckDB writes the row objects itself, at the path `locate` builds, and it will not
   * create the directory leading to one. On object storage there is no directory to
   * create and this is a no-op — which is exactly why it belongs on the port rather
   * than in the store: only the binding knows whether the question means anything.
   */
  prepare(key: string): Promise<void>;
}

function etagOf(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/** The suffix {@link writeThenRename} appends to a body it has not finished putting in place. */
const STAGING_SUFFIX = '.staging';

/**
 * What `list` refuses to report: a file whose name is a destination plus a UUID plus
 * {@link STAGING_SUFFIX}, which is exactly the shape {@link writeThenRename} builds.
 *
 * A staging object lives in its destination's own directory, so it is visible to a listing for
 * as long as the write takes — and a listing that returned it would hand its caller a key that
 * stops existing a moment later. The caller that would suffer is the snapshot history:
 * `readSortedRefs` gets and parses every key under `_snapshots/`, so a visible staging object
 * puts the same record in the history twice, once under each name.
 *
 * Matched by the whole shape rather than by a bare suffix, and applied to files only, because
 * the hazard is in a path COMPONENT and not in a key. Keys are derived by `identifiers.ts` and
 * end in `.json` or `.parquet`, but a snapshot id is a caller's string and becomes a directory
 * component of `snapshotPrefix`, so a run called `nightly.staging` is a directory of that name.
 * A bare-suffix test skips a directory and its whole subtree, so any listing that reached one
 * from above would report the prefix as empty while the objects sit in it — and empty is the
 * one wrong answer nothing downstream can tell apart from the truth. No listing this package
 * takes today starts above a snapshot directory, but that is a fact about the current call
 * sites rather than a property of this port, and the rule belongs to the port. Requiring the
 * UUID makes the collision unconstructible instead of merely unlikely; the `isDirectory` check
 * makes it impossible for a directory regardless. Neither guard is load-bearing alone.
 */
const STAGING_NAME = /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.staging$/;

/**
 * Put a body at a path in one step, so a concurrent reader sees the old object or the new one
 * and never a half-written key.
 *
 * `writeFile` aimed straight at the destination cannot promise that: it opens with
 * `O_CREAT|O_TRUNC` and writes the body in a separate operation afterwards, leaving the key
 * zero bytes on disk in between. That window is wide enough to hit constantly — pointed at
 * `_current.json`, the db-spec's cutover race reads an empty pointer 229-8,296 times per run —
 * and the body's size does not shrink it, because the gap is ahead of the write rather than
 * inside it. `rename` has no such gap: the destination is the old object until it is the new
 * one.
 *
 * The staging object must be a SIBLING of the destination, which is why this takes a path and
 * derives one rather than building it under `tmpdir()`: `rename` is atomic only within one
 * filesystem, and a temp directory is a separate mount on most machines. Crossing one turns
 * the rename into a copy, which puts the window back and reports nothing while doing it.
 *
 * A failure unlinks the staging object and rethrows the original error. The unlink is allowed
 * to fail silently precisely so it cannot displace that error: a caller must still see the
 * `EACCES` or `ENOSPC` that stopped the write, not a second fault raised while cleaning up
 * after it.
 */
async function writeThenRename(destination: string, body: string): Promise<void> {
  const staging = `${destination}.${randomUUID()}${STAGING_SUFFIX}`;
  try {
    await writeFile(staging, body, 'utf8');
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Narrows a caught value to the shape Node's `fs` errors actually have, so `.code` can be
 * read without an `as` cast. `putIfAbsent` and `get` both need this: they treat one specific
 * errno as an ordinary outcome (a lost race, an absent key) and must let everything else —
 * `EACCES`, `ENOSPC`, `EMFILE` — surface as the fault it is, rather than reporting it as the
 * ordinary case and leaving a caller to retry forever against a disk that is simply full.
 */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * A directory on this machine, behaving like a bucket.
 *
 * What it is for: the contract suite, local development, and a single-node deployment. What
 * it is not for is concurrent writers: `putIfAbsent` is genuinely atomic, through
 * `O_CREAT|O_EXCL`, but `putIfMatch` is not — see its own docblock. Both are also *not*
 * atomic across NFS clients, where even the exclusive open is advisory.
 *
 * Concurrent READERS are a different question and this binding does answer it: `put` and
 * `putIfMatch` both land through {@link writeThenRename}, so a `get` racing a write returns
 * the old object or the new one, never a key caught mid-truncate.
 */
export function localObjectStore(root: string): ObjectStore {
  const base = resolve(root);

  function pathFor(key: string): string {
    return join(base, key);
  }

  /**
   * Descend one directory, appending every file below it as a key.
   *
   * Only `ENOENT` answers "nothing here". A prefix that was never written is the ordinary case
   * — `countStaged` asks before a load has staged anything, `carryForward` asks about a
   * predecessor that may not exist — so that one has to be `[]`.
   *
   * Everything else propagates, and the reason is {@link STAGING_NAME}'s: empty is the one
   * wrong answer nothing downstream can tell apart from the truth. An `EACCES` on a directory
   * mid-listing, an `EMFILE` under load, an `EIO` off a failing disk — each used to be reported
   * as an empty prefix, and each caller then did something irreversible with it. `countStaged`
   * commits `rowCount: 0`; `read` takes its empty-glob guard and answers a zero-row page;
   * `dropSnapshot` writes a tombstone claiming the snapshot held nothing and deletes what it
   * could not read; `countCarried` and `carryForward`'s `previousObjects` decide a merge
   * carried nothing forward. `get` in this same binding was narrowed to `ENOENT` for exactly this reason, and
   * this is the listing half of it.
   */
  async function walk(directory: string, prefix: string, into: string[]): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (isErrnoException(error) && error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      // A body being written right now is not a key yet — see STAGING_NAME, which also says
      // why a directory is never skipped no matter what it is called.
      if (!entry.isDirectory() && STAGING_NAME.test(entry.name)) continue;
      const key = posix.join(prefix, entry.name);
      if (entry.isDirectory()) {
        await walk(join(directory, entry.name), key, into);
      } else {
        into.push(key);
      }
    }
  }

  return {
    async get(key) {
      const body = await readFile(pathFor(key), 'utf8').catch((error: unknown) => {
        if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
        throw error;
      });
      return body === undefined ? undefined : { body, etag: etagOf(body) };
    },

    async put(key, body) {
      // One `mkdir` covers both objects: the staging one is a sibling of the destination, so
      // the directory `prepare` would make for the key is the directory it lands in too, at
      // any depth.
      await mkdir(dirname(pathFor(key)), { recursive: true });
      await writeThenRename(pathFor(key), body);
      return { etag: etagOf(body) };
    },

    async putIfAbsent(key, body) {
      await mkdir(dirname(pathFor(key)), { recursive: true });
      // 'wx' fails when the file exists, and the check and the create are one syscall —
      // which is the whole point. A stat followed by a write has a window between them, and
      // the window is exactly what two workers committing at once find. Only EEXIST is the
      // lost race this method promises to report as `undefined`; anything else (EACCES,
      // ENOSPC, EMFILE, …) is a real fault and must surface as one.
      const handle = await open(pathFor(key), 'wx').catch((error: unknown) => {
        if (isErrnoException(error) && error.code === 'EEXIST') return undefined;
        throw error;
      });
      if (!handle) return undefined;
      try {
        await handle.writeFile(body, 'utf8');
      } finally {
        await handle.close();
      }
      return { etag: etagOf(body) };
    },

    /**
     * A read followed by a write, with no synchronization between them. Two same-host
     * processes can each pass the etag check and then race on the final write, producing a
     * silent lost update where both callers report success — this is not a multi-writer
     * compare-and-swap. It is safe against a single writer, or where writers are serialized
     * externally, which is what this binding is for; the real multi-writer guarantee is S3's
     * `If-Match`, which Task 13 supplies.
     *
     * The write itself goes through {@link writeThenRename} like `put`'s does, which is a
     * different guarantee from the one this method lacks and worth keeping apart: a lost update
     * is two WRITERS disagreeing about who won, while a truncated destination is a READER
     * seeing a key that momentarily holds nothing. Only the first of those is still true here.
     */
    async putIfMatch(key, body, etag) {
      const current = await this.get(key);
      if (!current || current.etag !== etag) return undefined;
      await writeThenRename(pathFor(key), body);
      return { etag: etagOf(body) };
    },

    async list(prefix) {
      const found: string[] = [];
      await walk(pathFor(prefix), prefix, found);
      return found;
    },

    async deletePrefix(prefix) {
      const keys = await this.list(prefix);
      await rm(pathFor(prefix), { recursive: true, force: true });
      return keys.length;
    },

    locate(key) {
      return pathFor(key);
    },

    async prepare(key) {
      await mkdir(dirname(pathFor(key)), { recursive: true });
    },
  };
}

/** Whether a root names object storage rather than a directory. */
export function isS3Root(root: string): boolean {
  return root.startsWith('s3://');
}

/** Present so a caller can assert a local root exists before the store writes to it. */
export async function ensureLocalRoot(root: string): Promise<void> {
  await mkdir(resolve(root), { recursive: true });
  await stat(resolve(root));
}
