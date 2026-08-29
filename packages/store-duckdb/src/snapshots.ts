import type { SnapshotRef } from '@dudousxd/nestjs-catalog';
import { currentKey, snapshotRecordKey, typePrefix } from './identifiers';
import type { ObjectStore } from './object-store';

/**
 * How many snapshot records one list reads.
 *
 * Its own constant rather than a shared one. The two adapters already in this repo each set
 * 500 independently and each said the core package is where it belongs "if a third adapter
 * wants it" — but agreeing on an integer is not a dependency worth inventing between
 * packages that otherwise have none.
 */
export const SNAPSHOT_LIST_LIMIT = 500;

/**
 * Where this store remembers which loads exist and which one is served.
 *
 * A port, because the two shipped adapters answer it in opposite ways and both are right
 * about something. The MikroORM store keeps the pointer in a transactional table, which is
 * the strongest answer available when a transactional database is present. The ClickHouse
 * store keeps it in ClickHouse, arguing that requiring a second database "makes the adapter
 * undeployable without a second database, and it puts the pointer that decides what readers
 * see in a system that can be up while the one holding the data is down."
 *
 * With Parquet in object storage both arguments can be honoured: the default binding below
 * keeps the record beside the data, so a bucket is the only dependency, and a host that has
 * a transactional database binds one that uses it. The invariant every binding owes is that
 * **the snapshot a type is serving is never a tombstone** — `read` relies on it to avoid a
 * lookup on the hot path.
 */
export interface SnapshotCatalog {
  /** Write the whole record. Never a partial update: a merge would blank the fields it was not given. */
  put(typeName: string, ref: SnapshotRef): Promise<void>;
  /** Exact lookup, tombstone included, `undefined` only when it never existed. */
  find(typeName: string, snapshotId: string): Promise<SnapshotRef | undefined>;
  /** Newest first, tombstones included, bounded. */
  list(typeName: string, limit?: number): Promise<SnapshotRef[]>;
  current(typeName: string): Promise<string | undefined>;
  /**
   * Move the served pointer.
   *
   * A blind write, not a compare-and-swap: two concurrent commits of different snapshots to
   * the same type leave the pointer at whichever landed last, and both callers report
   * success. That is the intended semantic rather than an oversight — `commit`'s own
   * semantics are last-writer-wins, since committing an *older* snapshot is how a rollback
   * is expressed, and a CAS retry loop here would only re-apply the same write and reach the
   * identical outcome. It would buy something only for a caller that wants to *detect* the
   * conflict, and nothing here does.
   */
  setCurrent(typeName: string, snapshotId: string): Promise<void>;
}

function isSnapshotRef(value: unknown): value is SnapshotRef {
  if (typeof value !== 'object' || value === null) return false;
  const candidate: Record<string, unknown> = { ...value };
  return typeof candidate.id === 'string' && typeof candidate.createdAt === 'string';
}

function parseRef(body: string): SnapshotRef | undefined {
  const parsed: unknown = JSON.parse(body);
  return isSnapshotRef(parsed) ? parsed : undefined;
}

/**
 * Records and pointer as objects beside the rows.
 *
 * `find` is a single GET at a derived key rather than a scan, which is what lets it answer
 * about a snapshot older than any bound. `list` reads the record prefix, which is the one
 * operation here whose cost grows with history — bounded by {@link SNAPSHOT_LIST_LIMIT},
 * and the reason `find` is not implemented on top of it.
 */
export function objectSnapshotCatalog(objects: ObjectStore): SnapshotCatalog {
  return {
    async put(typeName, ref) {
      await objects.put(snapshotRecordKey(typeName, ref.id), JSON.stringify(ref));
    },

    async find(typeName, snapshotId) {
      const found = await objects.get(snapshotRecordKey(typeName, snapshotId));
      return found ? parseRef(found.body) : undefined;
    },

    async list(typeName, limit = SNAPSHOT_LIST_LIMIT) {
      const keys = await objects.list(`${typePrefix(typeName)}/_snapshots`);
      const refs: SnapshotRef[] = [];
      for (const key of keys) {
        const found = await objects.get(key);
        const ref = found ? parseRef(found.body) : undefined;
        if (ref) refs.push(ref);
      }
      refs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return refs.slice(0, limit);
    },

    async current(typeName) {
      const found = await objects.get(currentKey(typeName));
      if (!found) return undefined;
      const parsed: unknown = JSON.parse(found.body);
      if (typeof parsed !== 'object' || parsed === null) return undefined;
      const candidate: Record<string, unknown> = { ...parsed };
      return typeof candidate.snapshotId === 'string' ? candidate.snapshotId : undefined;
    },

    async setCurrent(typeName, snapshotId) {
      await objects.put(currentKey(typeName), JSON.stringify({ snapshotId }));
    },
  };
}
