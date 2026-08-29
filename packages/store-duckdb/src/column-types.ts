import { DuckDBTimestampTZValue } from '@duckdb/node-api';
import type { ScalarType } from '@dudousxd/nestjs-catalog';

/**
 * `micros` since the Unix epoch, UTC — the shape every `TIMESTAMP WITH TIME ZONE` column this
 * store ever declares comes back as (see {@link duckDbType}: `date` maps to that type and no
 * other), converted to the millisecond `Date` the rest of this file already speaks.
 *
 * Found, not assumed: `runAndReadAll().getRowObjects()` and `stream()`'s chunk-at-a-time
 * `appendToRowObjects` were both checked against a real TIMESTAMPTZ column, and both handed
 * back a `DuckDBTimestampTZValue` — never a native `Date` — so this conversion is not specific
 * to either read path. Before this existed, `normalise` fell through every branch below for
 * that value and returned it untouched: no test had ever asserted the *value* of a date-typed
 * column read back from a live query (only that filtering on one narrowed the right rows), so
 * every `_loaded_at` and every declared `date` property this store has ever served was this
 * opaque, un-stringified object rather than the ISO string this function's own docblock
 * promises.
 */
function fromTimestampTZ(value: DuckDBTimestampTZValue): Date {
  return new Date(Number(value.micros / 1000n));
}

/**
 * The DuckDB type each catalog scalar lands in.
 *
 * Deliberately wide, and deliberately without DECIMAL. Width first: this store is
 * downstream of whatever a CSV had, and a load that fails because a value is one character
 * too long is a worse outcome than a column roomier than it needs to be.
 *
 * DECIMAL is a harder rule than a preference. `hyparquet-writer` 0.16.8 writes wrong
 * `min`/`max` statistics for it — a column whose only value is `123.45` is recorded as
 * `11786577.92` — and a reader that skips row groups on statistics then answers a query
 * that should match with no rows and no error. The archive writer already in this repo
 * avoids the type by mapping `number` to DOUBLE and everything else to text; this mapping
 * keeps that property on purpose rather than by luck.
 *
 * `json` and `uuid` are text for the same reason they are text in the archive: DuckDB's
 * UUID rejects anything that is not a well-formed UUID, and a JSON logical type is the one
 * the writer gets wrong. Text round-trips exactly, and the type the catalog declares
 * travels beside the data so a reader can undo this without guessing.
 */
export function duckDbType(type: ScalarType): string {
  switch (type) {
    case 'number':
      return 'DOUBLE';
    case 'boolean':
      return 'BOOLEAN';
    case 'date':
      return 'TIMESTAMP WITH TIME ZONE';
    case 'string':
    case 'json':
    case 'uuid':
    case 'unknown':
      return 'VARCHAR';
    default: {
      // Exhaustive: a scalar added to the core package must be answered here rather than
      // falling through to a default that silently stores it as text.
      const unreachable: never = type;
      throw new Error(`unmapped scalar type: ${String(unreachable)}`);
    }
  }
}

/**
 * Coerce a boolean value from various sources. A CSV has no boolean type, so "false"
 * arrives as text — and `Boolean("false")` is `true`, which would invert every false
 * this store ever loaded. Instead, we explicitly check for falsey representations.
 */
function coerceBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (text === 'false' || text === '0' || text === '') return false;
  return true;
}

/** What a row value becomes on the way in. `null` means "nobody sent one". */
export function coerce(value: unknown, type: ScalarType): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'number': {
      const asNumber = Number(value);
      return Number.isFinite(asNumber) ? asNumber : null;
    }
    case 'boolean':
      return coerceBoolean(value);
    case 'date': {
      // Accept numeric epochs (milliseconds since epoch) directly, then string representations.
      let asDate: Date;
      if (typeof value === 'number' || typeof value === 'bigint') {
        asDate = new Date(Number(value));
      } else if (value instanceof Date) {
        asDate = value;
      } else {
        asDate = new Date(String(value));
      }
      return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
    }
    case 'json':
      return typeof value === 'string' ? value : JSON.stringify(value);
    default:
      return typeof value === 'string' ? value : String(value);
  }
}

/**
 * The `type === 'date'` half of {@link normalise}, split out so that function's own branching
 * stays under this file's complexity budget. A date-typed value that arrives as a bigint or
 * number (epoch ms) must return an ISO string, not a raw number — never a DuckDB epoch, since
 * that column's own type is `TIMESTAMP WITH TIME ZONE`, not `DOUBLE`.
 */
function normaliseDate(value: unknown): unknown {
  let asDate: Date;
  if (value instanceof Date) {
    asDate = value;
  } else if (value instanceof DuckDBTimestampTZValue) {
    asDate = fromTimestampTZ(value);
  } else if (typeof value === 'number' || typeof value === 'bigint') {
    asDate = new Date(Number(value));
  } else if (typeof value === 'string') {
    asDate = new Date(value);
  } else {
    return null;
  }
  return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
}

/**
 * What a stored value becomes on the way out.
 *
 * Two adapters behind one interface returning two renderings of the same instant is a bug
 * that surfaces weeks later in a consumer, as a date that sorts wrongly or parses to
 * `Invalid Date`. So dates leave here as ISO strings, whatever the driver handed over.
 *
 * `bigint` is the other half: DuckDB returns INT64 as one, and `JSON.stringify` throws on a
 * bigint rather than rendering it — so a row that reached a response body untouched would
 * fail the serialiser rather than the read.
 *
 * Date-typed values return as ISO strings regardless of their input representation (a `Date`
 * instance, a `DuckDBTimestampTZValue` off the driver, a numeric epoch, or a string), matching
 * the file's contract. An unparseable string returns `null` rather than throwing, consistent
 * with `coerce` — a warehouse driver may hand back invalid state and crashing the read is worse
 * than losing the value.
 */
export function normalise(value: unknown, type: ScalarType): unknown {
  if (value === null || value === undefined) return null;
  // Checked ahead of the generic type checks below, which would otherwise hand a
  // `DuckDBTimestampTZValue` or a bigint straight back unconverted.
  if (type === 'date') return normaliseDate(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof DuckDBTimestampTZValue) return fromTimestampTZ(value).toISOString();
  if (typeof value === 'bigint') return Number(value);
  return value;
}
