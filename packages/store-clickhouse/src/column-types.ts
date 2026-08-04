import type { CatalogObjectTypeDef, ScalarType } from '@dudousxd/nestjs-catalog';

/**
 * Scalar type → ClickHouse column type.
 *
 * **Deliberately wide, and deliberately `Nullable`.** A warehouse is fed by
 * publishers that will widen a column one day without telling anyone, and a
 * load that fails on a value one character too long is a worse outcome than a
 * column that is roomier than it needs to be. `Nullable` costs a byte per value
 * and a little vectorisation, and it buys the thing that actually matters here:
 * a column added by a later schema evolution has to hold *something* for every
 * row that predates it, and on a column store that something has to be a real
 * absence rather than a zero that will later be averaged.
 *
 * Two mappings look wrong until you know what they are avoiding:
 *
 * - `uuid` becomes `String`, not `UUID`. ClickHouse's `UUID` rejects anything
 *   that is not a well-formed UUID, and this store is downstream of whatever a
 *   CSV had in the column its publisher called an id. A load that dies on one
 *   malformed row is not a better outcome than a string that reads back as it
 *   was given.
 * - `json` becomes `String`, not `JSON`. ClickHouse's `JSON` type is a moving
 *   target across the versions this package supports, and a column type that
 *   changes semantics under a server upgrade is not something to put whole
 *   datasets in when the alternative — text that every version reads the same —
 *   costs nothing here, since nothing in the catalog queries inside the value.
 */
export function clickHouseType(type: ScalarType): string {
  switch (type) {
    case 'number':
      return 'Nullable(Float64)';
    case 'boolean':
      // `UInt8` rather than `Bool` for the same reason MySQL uses TINYINT: the
      // value arrives as whatever the publisher had, and 0/1 round-trips
      // through every client and format identically on every server version.
      return 'Nullable(UInt8)';
    case 'date':
      // Pinned to UTC in the type itself. A `DateTime64` with no timezone takes
      // the *server's*, so the same load read from two differently-configured
      // nodes formats to two different wall clocks — the kind of discrepancy
      // that is blamed on the data for weeks.
      return "Nullable(DateTime64(3, 'UTC'))";
    default:
      return 'Nullable(String)';
  }
}

/**
 * A value on its way into ClickHouse.
 *
 * Dates go out as ISO strings and are parsed by the server with
 * `date_time_input_format = 'best_effort'`; sending a JS `Date` through
 * `JSONEachRow` would serialise as an ISO string anyway, so this makes the
 * conversion explicit and the failure mode (an unparseable date becomes NULL
 * here rather than a server-side exception mid-insert) the gentler one.
 */
export function coerce(value: unknown, type: ScalarType): unknown {
  if (value === undefined || value === null || value === '') return null;
  if (type === 'date') {
    const parsed = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (type === 'boolean') return value ? 1 : 0;
  if (type === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'json') return JSON.stringify(value);
  return String(value);
}

/**
 * A value on its way back out.
 *
 * ClickHouse's JSON output quotes 64-bit integers as strings so they survive a
 * JavaScript parse, and `Nullable(UInt8)` booleans come back as 0/1. Both are
 * correct on the wire and wrong in a table cell, so both are undone here rather
 * than in whatever screen happens to render the row.
 *
 * Dates get the same treatment for a reason that is about the library rather
 * than about ClickHouse: they arrive as `2026-01-01 00:00:00.000`, ClickHouse's
 * own rendering with no zone marker, where the MySQL store hands back an ISO
 * string. Two adapters behind one interface returning two date formats is a bug
 * that surfaces in the consumer, weeks later, as a date that sorts wrongly or
 * parses to `Invalid Date` in Safari. The column is declared
 * `DateTime64(3, 'UTC')`, so reading it as UTC is restoring what the wire format
 * dropped rather than assuming anything.
 */
export function normalise(
  row: Record<string, unknown>,
  properties: CatalogObjectTypeDef['properties'],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const property of properties) {
    out[property.name] = normaliseValue(row[property.name], property.type);
  }
  return out;
}

/**
 * One cell of {@link normalise}, in declaration order.
 *
 * The order is the contract: the declared type wins over the runtime one, so a
 * property declared `date` that arrives as a ClickHouse-formatted string is
 * read as UTC rather than falling through to the `instanceof Date` and
 * `bigint` rules, which exist only for values whose declared type says nothing
 * useful about how the driver happened to hand them over.
 */
function normaliseValue(value: unknown, type: ScalarType): unknown {
  if (value === null || value === undefined) return null;
  if (type === 'boolean') return Boolean(Number(value));
  if (type === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'date' && typeof value === 'string') {
    const parsed = new Date(`${value.replace(' ', 'T')}Z`);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/** JSON cannot carry BigInt or Date; neither can a table cell. */
export function normaliseCell(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  return value;
}

const SCALARS: ScalarType[] = ['string', 'number', 'boolean', 'date', 'json', 'uuid', 'unknown'];

export function toScalar(value: string): ScalarType {
  return SCALARS.find((s) => s === value) ?? 'unknown';
}

/**
 * A ClickHouse column type read back out of `system.columns`, mapped to the
 * catalog's scalars. Used only when this store has to describe relations with
 * no registry to ask, so an approximate answer beats no answer.
 */
export function fromClickHouseType(declared: string): ScalarType {
  const inner = declared.replace(/^Nullable\(/, '').replace(/\)$/, '');
  if (inner.startsWith('Date')) return 'date';
  if (inner === 'UInt8') return 'boolean';
  if (/^(U?Int|Float|Decimal)/.test(inner)) return 'number';
  if (inner === 'UUID') return 'uuid';
  return 'string';
}
