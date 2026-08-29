import type { ScalarType } from '@dudousxd/nestjs-catalog';

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
      const asNumber = typeof value === 'bigint' ? Number(value) : Number(value);
      return Number.isFinite(asNumber) ? asNumber : null;
    }
    case 'boolean':
      return coerceBoolean(value);
    case 'date': {
      const asDate = value instanceof Date ? value : new Date(String(value));
      return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
    }
    case 'json':
      return typeof value === 'string' ? value : JSON.stringify(value);
    default:
      return typeof value === 'string' ? value : String(value);
  }
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
 */
export function normalise(value: unknown, type: ScalarType): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return Number(value);
  if (type === 'date' && typeof value === 'string') return new Date(value).toISOString();
  return value;
}
