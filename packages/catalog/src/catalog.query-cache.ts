import { createHash } from 'node:crypto';
import type { CatalogQueryResult } from './catalog.query';

/**
 * A small in-process cache for query results.
 *
 * In-process on purpose. A shared cache would need invalidation on every
 * commit from every publisher, across every pod, and getting that wrong means
 * showing someone last week's numbers with this week's confidence. A per-pod
 * cache with a short TTL is a worse cache and a much better failure mode: the
 * staleness is bounded by a number the query's author chose.
 *
 * Keyed on the SQL *and* the catalog version, so a curation edit that renames a
 * column cannot serve a result computed under the old name.
 */
export class QueryCache {
  private readonly entries = new Map<string, { result: CatalogQueryResult; expiresAt: number }>();

  constructor(private readonly maxEntries = 200) {}

  static key(sql: string, catalogVersion: number): string {
    return createHash('sha1').update(`${catalogVersion}\u0000${sql.trim()}`).digest('hex');
  }

  get(key: string): CatalogQueryResult | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh insertion order so the eviction below is least-recently-used
    // rather than least-recently-written.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.result;
  }

  set(key: string, result: CatalogQueryResult, ttlSeconds: number): void {
    if (ttlSeconds <= 0) return;
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest) this.entries.delete(oldest);
    }
    this.entries.set(key, {
      result,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
