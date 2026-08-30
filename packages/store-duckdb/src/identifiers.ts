import { CATALOG_RESERVED_COLUMNS, assertSafeIdentifier } from '@dudousxd/nestjs-catalog';
import { BadRequestException } from '@nestjs/common';

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

/**
 * What a path component of a key may be, and the reason this adapter needs a rule its
 * siblings do not.
 *
 * On the MikroORM and ClickHouse stores a snapshot id is a VALUE in a column: it is bound as
 * a parameter, it addresses nothing, and the worst a hostile one can do is match no rows.
 * Here it is a path — `snapshotPrefix` makes it a directory component and `pathFor` in
 * `object-store.ts` hands the result to `join()`. So the same string that is inert over there
 * decides, over here, which directory DuckDB's `COPY … TO` writes into and which directory
 * `deletePrefix` removes recursively. It arrives from outside: the publish controller takes it
 * as `@Param('snapshot')` and its own docblock says the id is the caller's, chosen so a retry
 * replaces its batches. Nothing between that parameter and `join()` looked at it before this.
 *
 * The rule is deliberately NOT {@link assertSafeIdentifier}. That one answers a different
 * question — what may be written into SQL as an identifier — and its answer,
 * `[A-Za-z_][A-Za-z0-9_]{0,62}`, rejects `run-1` and every UUID, which is to say every id the
 * pipeline actually generates (`newSnapshotId` builds `<prefix>-<8 hex>`; a durable run id is
 * a UUID). Borrowing it would refuse ordinary traffic, which is what would make this look like
 * a security-versus-compatibility trade instead of what it is.
 *
 * What it rejects, and why each one:
 *
 * - **`..`, and `.` and empty with it** — `join` normalises, so `snapshotPrefix` of `'..'`
 *   makes the key `<type>/..` and `pathFor` resolves that to the configured root itself. A
 *   `deletePrefix` on it is `rm(root, { recursive: true, force: true })` — every type, every
 *   snapshot, in one ordinary drop. `.` and empty both address the type prefix instead, which
 *   is the same mistake one level down.
 * - **`/`, `\` and NUL** — `/` is the separator this package builds keys from, so a segment
 *   carrying one silently becomes two and reaches any depth `..` can climb from. `\` is the
 *   same thing wherever the path is handled by something that treats it as a separator, and a
 *   NUL truncates a path at the syscall boundary rather than at the character the caller sees.
 * - **A leading `_`** — which reserves `_snapshots` and `_current.json` by construction rather
 *   than by a list that could fall out of step with `snapshotRecordKey` and `currentKey`. With
 *   no traversal character at all, `snapshotId = '_snapshots'` makes `snapshotPrefix` name the
 *   directory holding the type's whole snapshot HISTORY, and `dropSnapshot` deletes that
 *   prefix — one ordinary drop erasing every record the type ever had.
 * - **A leading `-` or `.`** — not a traversal risk on its own, but `.`-leading is how `..`
 *   is reached one character at a time and `-`-leading is a filename every shell tool reads
 *   as a flag. Neither is a legitimate id and both are cheaper to refuse than to reason about.
 *
 * 128 rather than 255, which is the per-component ceiling on the filesystems this binding
 * targets: a snapshot id also becomes a FILE name through `snapshotRecordKey`
 * (`<id>.json`), and `writeThenRename` appends `.<uuid>.staging` — 37 more characters — to
 * the name it is putting in place. 128 + 5 + 37 is comfortably under 255; 255 would not be.
 */
const KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Refuse a path component that cannot safely be joined into a key.
 *
 * `BadRequestException` rather than a bare `Error` for the reason the refusals in
 * `duckdb-warehouse.store.ts` throw one: the value came in on an HTTP request — the publish
 * controller's `:type` and `:snapshot` path parameters — and a 400 naming the parameter is the
 * answer a caller can act on, where a 500 hides the message behind a generic body.
 */
function assertKeySegment(kind: string, value: string): void {
  if (!KEY_SEGMENT.test(value)) {
    throw new BadRequestException(
      `Refusing "${value}" as a ${kind}: it becomes a directory in this store's object keys, so it must be 1-128 characters of letters, digits, dot, dash or underscore, starting with a letter or a digit. A leading underscore is reserved for this store's own objects (_snapshots, _current.json).`,
    );
  }
}

/**
 * The prefix holding everything about one object type.
 *
 * Checked as well as the snapshot id, and not because a type name arrives from the same place
 * — it comes from the published type registry, not from a request body. It is checked because
 * this function is what turns it into a path component, and a rule that lives with the join is
 * a rule that cannot be bypassed by a future caller who reaches `typePrefix` from somewhere the
 * registry is not in the way.
 */
export function typePrefix(typeName: string): string {
  assertKeySegment('type name', typeName);
  return typeName.toLowerCase();
}

/** The prefix holding one snapshot's row objects, and nothing else. */
export function snapshotPrefix(typeName: string, snapshotId: string): string {
  assertKeySegment('snapshot id', snapshotId);
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

/**
 * One snapshot's record, under a prefix the row glob cannot reach.
 *
 * The snapshot id is checked here too, and not only in {@link snapshotPrefix}. This function
 * builds a path out of it with its own `${}` rather than by calling that one, so the rule the
 * docblock on {@link typePrefix} claims "cannot be bypassed by a future caller" has to live at
 * every join, not at the one the write path happens to go through. This is the READ half of the
 * same hazard: `objectSnapshotCatalog.find` builds this key, and `read`, `commit`,
 * `dropSnapshot` and `findSnapshot` all call `find` before anything else validates — so
 * `?snapshot=../../../../etc/hosts` reached `join()` through a plain time-travel GET, and a
 * non-JSON file's first bytes came back out in the `JSON.parse` failure `parseJson` reports.
 * No write and no delete, but a read oracle is still a read.
 *
 * Safe for every caller: the only two are `SnapshotCatalog`'s `put` and `find` (`snapshots.ts`),
 * and any id reaching `put` came off a record `write` had already validated.
 */
export function snapshotRecordKey(typeName: string, snapshotId: string): string {
  assertKeySegment('snapshot id', snapshotId);
  return `${typePrefix(typeName)}/_snapshots/${snapshotId}.json`;
}

/** The served pointer for one type. */
export function currentKey(typeName: string): string {
  return `${typePrefix(typeName)}/_current.json`;
}
