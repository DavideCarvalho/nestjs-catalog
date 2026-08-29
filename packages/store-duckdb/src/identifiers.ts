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

/** One snapshot's record, under a prefix the row glob cannot reach. */
export function snapshotRecordKey(typeName: string, snapshotId: string): string {
  return `${typePrefix(typeName)}/_snapshots/${snapshotId}.json`;
}

/** The served pointer for one type. */
export function currentKey(typeName: string): string {
  return `${typePrefix(typeName)}/_current.json`;
}
