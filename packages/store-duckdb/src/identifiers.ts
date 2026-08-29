import { CATALOG_RESERVED_COLUMNS, assertSafeIdentifier } from '@dudousxd/nestjs-catalog';

/**
 * The reserved columns, taken from the core package rather than rebuilt here.
 *
 * The ClickHouse adapter built its own list out of its own constants and agreed with the
 * core's by coincidence; the coincidence was the bug. Re-exported so this package's own
 * code has one name for them and a reader can see where they came from.
 */
export const RESERVED_COLUMNS = CATALOG_RESERVED_COLUMNS;

export const SNAPSHOT_COLUMN = '_snapshot_id';
export const PRINCIPAL_COLUMN = '_principal_id';
export const LOADED_AT_COLUMN = '_loaded_at';
export const BATCH_COLUMN = '_batch';
export const ROW_COLUMN = '_row';

/**
 * Quote an identifier for DuckDB, having first refused every name that is not plainly safe.
 *
 * Rejecting rather than escaping, because this file's output ends up in `COPY`, `CREATE
 * TABLE` and `read_parquet` globs — statements whose blast radius is a whole object or a
 * whole prefix. The character rule itself lives in the core package so all adapters agree
 * on what a safe name is.
 */
export function ident(value: string): string {
  assertSafeIdentifier(value);
  return `"${value}"`;
}

/** The prefix holding everything about one object type. */
export function typePrefix(typeName: string): string {
  return typeName.toLowerCase();
}

/** The prefix holding one snapshot's row objects, and nothing else. */
export function snapshotPrefix(typeName: string, snapshotId: string): string {
  return `${typePrefix(typeName)}/${snapshotId}`;
}

/**
 * One batch's object key.
 *
 * Derived from `(type, snapshot, batch)` and nothing else, which is the whole idempotence
 * story: the interface requires that a re-sent batch replace itself rather than append, and
 * a deterministic key makes that a property of the address rather than of a statement the
 * adapter has to get right.
 *
 * Zero-padded because a listing sorts lexicographically, and `part-10` before `part-9` is a
 * total order nobody wants to debug.
 */
export function batchKey(typeName: string, snapshotId: string, batch: number): string {
  return `${snapshotPrefix(typeName, snapshotId)}/part-${String(batch).padStart(6, '0')}.parquet`;
}

/**
 * The `_batch` value a carried row is stamped with.
 *
 * `-1`, matching every sibling adapter — not a store-local invention. The core package's own
 * `CATALOG_PROVENANCE_COLUMNS` docblock (`packages/catalog/src/catalog.store.ts`, around lines
 * 898-918) explains why `-1` and nothing else is safe to use as the marker: {@link
 * DuckDbWarehouseStore.write}, in this very file's companion module, refuses a negative batch
 * by name before it ever reaches {@link batchKey} — so `-1` is a value no caller of `write` can
 * ever forge into an ordinary batch object. A larger sentinel like `999_999` has no such
 * guard behind it; a real batch numbered that high would collide with it and nothing here
 * would notice.
 *
 * Read's own `ORDER BY (_batch, _row)` — see that method's docblock — sorts a carried row
 * before batch `0`, which is the same property the ClickHouse sibling's `read` has for the
 * same reason: a negative value in the tiebreak's first column sorts first everywhere SQL's
 * default `ASC` applies. Consistent across adapters, not merely consistent within this one.
 */
export const CARRY_FORWARD_BATCH = -1;

/**
 * The carry-forward object's own key, and deliberately not one {@link batchKey} could ever
 * produce.
 *
 * `batchKey` zero-pads `String(batch)`, and `String(-1).padStart(6, '0')` is `'0000-1'` — a
 * key nothing could `read_parquet` back out cleanly and a suffix that does not even end in
 * `.parquet` in the padded portion. The marker column and the object key are two different
 * questions: `_batch = -1` is what a reader consults, `carry.parquet` is where the bytes for
 * that merge live, and this function exists so the second answer never has to be derived from
 * the first. A merge is also unique per `(type, snapshot)` — there is exactly one — so a fixed
 * name is all the idempotence a re-run needs: a second `carryForward` call overwrites this
 * same key rather than needing a batch number to make the overwrite deterministic.
 */
export function carryForwardKey(typeName: string, snapshotId: string): string {
  return `${snapshotPrefix(typeName, snapshotId)}/carry.parquet`;
}

/** One snapshot's record, under a prefix the row glob cannot reach. */
export function snapshotRecordKey(typeName: string, snapshotId: string): string {
  return `${typePrefix(typeName)}/_snapshots/${snapshotId}.json`;
}

/** The served pointer for one type. */
export function currentKey(typeName: string): string {
  return `${typePrefix(typeName)}/_current.json`;
}
