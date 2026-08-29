import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
 */
export function localObjectStore(root: string): ObjectStore {
  const base = resolve(root);

  function pathFor(key: string): string {
    return join(base, key);
  }

  async function walk(directory: string, prefix: string, into: string[]): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
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
      await mkdir(dirname(pathFor(key)), { recursive: true });
      await writeFile(pathFor(key), body, 'utf8');
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
     * processes can each pass the etag check and then race on the final `writeFile`,
     * producing a silent lost update where both callers report success — this is not a
     * multi-writer compare-and-swap. It is safe against a single writer, or where writers
     * are serialized externally, which is what this binding is for; the real multi-writer
     * guarantee is S3's `If-Match`, which Task 13 supplies.
     */
    async putIfMatch(key, body, etag) {
      const current = await this.get(key);
      if (!current || current.etag !== etag) return undefined;
      await writeFile(pathFor(key), body, 'utf8');
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
