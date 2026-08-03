/**
 * The Telescope entry `type` every recorded catalog event carries.
 *
 * Also the id of the navigable entry type this package contributes, and the
 * prefix of every dashboard, panel and provider name it registers. Telescope's
 * extension registry enforces global uniqueness across extensions on all three
 * namespaces, so keeping them derived from one constant is what stops a rename
 * from silently colliding with a sibling extension.
 */
export const CATALOG_ENTRY_TYPE = 'catalog';

/**
 * What a table cell shows when the honest answer is "we do not know".
 *
 * Deliberately not `0`, and this is the single most load-bearing convention in
 * this package. A load that is still running has no committed row count and no
 * duration; rendering either as `0` states that zero rows were committed and
 * that it took no time, which is a claim about a finished load, made about one
 * that has not finished. An operator reading a wall of zeroes at 3am concludes
 * the pipeline produced nothing. A dash says the number does not exist yet.
 */
export const NO_VALUE = '—';

/**
 * How much of a failure message survives into an entry or a table cell.
 *
 * A connector's error string is the one field on `aviary:catalog:*` that this
 * library does not control the contents of: it is whatever the remote system,
 * the driver or the transform threw, and a database error routinely echoes back
 * the statement — which can echo a row — while a connection failure routinely
 * echoes the DSN, which can carry a password. Everything else on the channel is
 * shape (type names, column names, connector names, counts).
 *
 * Capping is not redaction and is not claimed to be. It bounds the blast radius
 * of a leaky message and bounds entry size; a host that needs true redaction
 * layers Telescope's own `redact` on top for the watcher path. The cap matters
 * most on the provider path, where nothing else runs at all — see
 * {@link capError}.
 */
export const ERROR_CAP = 500;

/** How far back the durable panels look when a panel does not say otherwise. */
export const DEFAULT_SINCE_HOURS = 24;

/**
 * Rows a durable table panel returns before it stops.
 *
 * A busy catalog runs thousands of loads a day. A table is read by a human, and
 * a human reads the top of it, so the cap is set where scrolling stops being
 * how you find something and filtering starts.
 */
export const DEFAULT_TABLE_LIMIT = 50;

/**
 * Entries the live (watcher-fed) providers scan out of Telescope storage.
 *
 * Bounded because this is a full page fetch on every panel resolve, and the
 * live panels exist to answer "is anything happening right now", which the most
 * recent few thousand entries answer completely.
 */
export const LIVE_SCAN_LIMIT = 2_000;

/** Rows the live failures table shows. Smaller than the durable tables: it is a klaxon, not a ledger. */
export const LIVE_FAILURES_LIMIT = 25;

/**
 * Narrow an unknown to an indexable object.
 *
 * Everything crossing into this package arrives as `unknown` — a diagnostics
 * envelope published by another package, a stored entry's `content` column, a
 * panel query object off the wire — and all of it is narrowed with guards
 * rather than assertions, so a shape that changed upstream degrades to a
 * missing cell instead of throwing inside a dashboard resolve.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = Reflect.get(source, key);
  return typeof value === 'string' ? value : undefined;
}

export function numberField(source: Record<string, unknown>, key: string): number | undefined {
  const value = Reflect.get(source, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Cap a failure message at {@link ERROR_CAP}, preserving `undefined`/`null` as
 * "there was no message" rather than turning it into an empty string.
 *
 * Called on BOTH paths, for different reasons:
 *
 *  - On the watcher path it bounds the entry before the Recorder sees it. The
 *    host's `redact({ maxContentBytes })` would also bound it, but that is host
 *    configuration this package cannot assume, and an unbounded stack trace in
 *    a hot loop is the memory-pressure shape that has taken hosts down before.
 *
 *  - On the DataProvider path it is the ONLY thing that runs. Telescope core's
 *    redaction pipeline only applies to entries a watcher hands to `ctx.record`
 *    — a value a provider computes and returns goes straight into a table cell
 *    with no truncation and no redaction anywhere in between.
 */
export function capError(message: string | undefined | null): string | undefined {
  if (typeof message !== 'string' || message.length === 0) return undefined;
  if (message.length <= ERROR_CAP) return message;
  return `${message.slice(0, ERROR_CAP)}…`;
}

/**
 * Resolve the lookback window a durable panel queries, as an ISO instant.
 *
 * `sinceHours` comes off a panel's static `DataBinding.query`, so it is
 * whatever the dashboard author wrote; it is validated rather than trusted
 * because a `NaN` or a negative would produce an `Invalid Date` and a store
 * query with a garbage bound, which reads back as "no loads at all" — the exact
 * false-negative this package exists to prevent.
 */
export function resolveSince(query: Record<string, unknown> | undefined): string {
  const requested = isRecord(query) ? numberField(query, 'sinceHours') : undefined;
  const hours = requested !== undefined && requested > 0 ? requested : DEFAULT_SINCE_HOURS;
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

/** Resolve a panel's row cap, falling back to {@link DEFAULT_TABLE_LIMIT}. */
export function resolveLimit(query: Record<string, unknown> | undefined): number {
  const requested = isRecord(query) ? numberField(query, 'limit') : undefined;
  return requested !== undefined && requested > 0 ? Math.floor(requested) : DEFAULT_TABLE_LIMIT;
}
