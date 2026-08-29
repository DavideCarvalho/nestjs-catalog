import type { ObjectStore } from './object-store';

export const CATALOG_DUCKDB_OPTIONS = Symbol('CATALOG_DUCKDB_OPTIONS');

/** Credentials for an `s3://` root. Omit to let DuckDB use the AWS credential chain. */
export interface DuckDbS3Options {
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /** `vhost` (default) or `path`, for S3-compatible servers that need the latter. */
  urlStyle?: 'vhost' | 'path';
  useSsl?: boolean;
}

export interface CatalogDuckDbStoreOptions {
  /**
   * Where snapshots live: a directory path, or `s3://bucket/prefix`.
   *
   * Required, with no default. See the refusal in `store.module.ts`.
   */
  root: string;
  s3?: DuckDbS3Options;
  /**
   * DuckDB's defaults are every core and 80% of RAM, which is measured against
   * the machine rather than the cgroup — so a pod with a memory limit is
   * OOMKilled by a query that DuckDB believed was within budget.
   */
  memoryLimit?: string;
  threads?: number;
  tempDirectory?: string;
  /**
   * Overrides the binding derived from {@link root}. Supplied by tests, and by a host
   * with its own transport.
   */
  objectStore?: ObjectStore;
}
