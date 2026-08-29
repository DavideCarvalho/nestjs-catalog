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
  /**
   * Newest first, tombstones included. `limit` bounds what is RETURNED, not what is READ —
   * see the binding's own docblock for what a call actually costs.
   */
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
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.rowCount === 'number' &&
    typeof candidate.principalId === 'string'
  );
}

/**
 * `JSON.parse`, but a failure names the object it was reading and what that object was for.
 *
 * A truncated or hand-edited object under a type's `_snapshots/` prefix otherwise throws a
 * bare `SyntaxError` out of `list()` for the whole type, naming neither the key nor the
 * reason anyone was reading it — which sends an operator looking for a bug in this module
 * rather than at the one object actually at fault. Thrown rather than swallowed: skipping a
 * corrupt governance record silently is worse than failing loudly on it.
 */
function parseJson(body: string, key: string, purpose: string): unknown {
  try {
    return JSON.parse(body);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${purpose} at "${key}" is not valid JSON (${reason}).`);
  }
}

function parseRef(body: string, key: string): SnapshotRef | undefined {
  const parsed = parseJson(body, key, 'Snapshot record');
  return isSnapshotRef(parsed) ? parsed : undefined;
}

/**
 * Records and pointer as objects beside the rows.
 *
 * `find` is a single GET at a derived key rather than a scan, which is what lets it answer
 * about a snapshot older than any bound. `list` has no equivalent shortcut: it reads every
 * record ever written for the type, and its cost grows with history regardless of `limit`,
 * which bounds only what comes back. The alternative — encoding recency into the key so a
 * listing itself could be bounded — needs an inverted timestamp, and an inverted-timestamp
 * key is incompatible with `find`'s single derived-key `get`, the invariant this module
 * exists to protect. A second alternative, an index object, would bound `list` but adds a
 * contention point to a binding whose whole argument is that it needs nothing but a bucket.
 * Neither trade is taken here: a host for which `list`'s cost is a problem binds its own
 * `SnapshotCatalog` over a transactional database — which is exactly why this is a port and
 * not a class. Nothing on the hot path pays this cost regardless: an incremental load
 * resolves its merge source through `current()`, a single get, never through `list`.
 */
export function objectSnapshotCatalog(objects: ObjectStore): SnapshotCatalog {
  return {
    async put(typeName, ref) {
      await objects.put(snapshotRecordKey(typeName, ref.id), JSON.stringify(ref));
    },

    async find(typeName, snapshotId) {
      const key = snapshotRecordKey(typeName, snapshotId);
      const found = await objects.get(key);
      return found ? parseRef(found.body, key) : undefined;
    },

    async list(typeName, limit = SNAPSHOT_LIST_LIMIT) {
      const keys = await objects.list(`${typePrefix(typeName)}/_snapshots`);
      const refs: SnapshotRef[] = [];
      for (const key of keys) {
        const found = await objects.get(key);
        const ref = found ? parseRef(found.body, key) : undefined;
        if (ref) refs.push(ref);
      }
      refs.sort((left, right) => {
        const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
        if (byCreatedAt !== 0) return byCreatedAt;
        // `createdAt` is the caller's clock, not this store's: two snapshots created in
        // the same batch, or under a coarse clock, can share it exactly. `id` breaks the
        // tie so "newest first" is a total order rather than whatever `objects.list()`
        // happened to return — an ordering that port makes no promise of.
        return right.id.localeCompare(left.id);
      });
      return refs.slice(0, limit);
    },

    async current(typeName) {
      const key = currentKey(typeName);
      const found = await objects.get(key);
      if (!found) return undefined;
      const parsed = parseJson(found.body, key, 'Current-snapshot pointer');
      if (typeof parsed !== 'object' || parsed === null) return undefined;
      const candidate: Record<string, unknown> = { ...parsed };
      return typeof candidate.snapshotId === 'string' ? candidate.snapshotId : undefined;
    },

    async setCurrent(typeName, snapshotId) {
      await objects.put(currentKey(typeName), JSON.stringify({ snapshotId }));
    },
  };
}
