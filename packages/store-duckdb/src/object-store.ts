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
 * filesystem as an exclusive open and a stat-then-rename. Naming them here means the store
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
 * A directory on this machine, behaving like a bucket.
 *
 * What it is for: the contract suite, local development, and a single-node deployment. What
 * it is not for is a shared filesystem — the compare-and-swap below is a read followed by a
 * write, which is atomic against another process on the same host through the exclusive
 * open in `putIfAbsent` and is *not* atomic across NFS clients.
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
      const body = await readFile(pathFor(key), 'utf8').catch(() => undefined);
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
      // the window is exactly what two workers committing at once find.
      const handle = await open(pathFor(key), 'wx').catch(() => undefined);
      if (!handle) return undefined;
      try {
        await handle.writeFile(body, 'utf8');
      } finally {
        await handle.close();
      }
      return { etag: etagOf(body) };
    },

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
