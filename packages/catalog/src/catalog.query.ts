/**
 * Ad-hoc SQL over the catalogued data.
 *
 * Separate from `CatalogReadStore` because not every store can offer it: a
 * read-through view of someone else's tables has no business handing out a SQL
 * console over them, and a store fronting an API has no SQL to run.
 */

export interface CatalogQueryRequest {
  sql: string;
  /** Hard cap on rows returned. The service clamps this. */
  maxRows?: number;
  /**
   * How long the statement may run, in milliseconds — **best effort**.
   *
   * Unlike `maxRows`, which the store enforces itself by wrapping the statement,
   * this is handed to the engine and the engine decides what to do with it. What
   * that buys varies more than it looks:
   *
   * - MySQL's `MAX_EXECUTION_TIME` applies to read-only SELECTs and is a hint
   *   the optimiser checks between stages, so a statement can overrun it.
   * - ClickHouse's `max_execution_time` is likewise checked between blocks.
   * - An engine with no statement-level timeout at all can only honour this by
   *   abandoning the client's side of the connection, which stops the caller
   *   waiting and does not stop the query.
   *
   * So a caller may not treat this as a guarantee that resources are released
   * when it elapses. The honest reading is "the store will ask, and will stop
   * waiting"; a deployment that needs a hard bound sets one on the database, in
   * the role the catalog's read connection uses.
   */
  timeoutMs?: number;
}

export interface CatalogQueryResult {
  /** True when this came from the cache rather than the database. */
  cached?: boolean;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  /** True when the cap cut the result short, so the UI can say so. */
  truncated: boolean;
  elapsedMs: number;
}

/** One queryable relation, for the editor's schema panel and autocomplete. */
export interface CatalogQueryRelation {
  /** What to write in a FROM clause. */
  name: string;
  kind: 'current' | 'history';
  objectType: string;
  description: string;
  columns: Array<{ name: string; type: string }>;
}

export interface CatalogQueryStore {
  /**
   * Run a read-only statement.
   *
   * Implementations are expected to enforce read-only at the *database*, not by
   * inspecting the string: a keyword denylist is a guess about a parser, and
   * the parser always wins eventually.
   */
  runQuery(request: CatalogQueryRequest): Promise<CatalogQueryResult>;

  /** What a query may select from. */
  queryRelations(): Promise<CatalogQueryRelation[]>;
}

export function isQueryStore(store: unknown): store is CatalogQueryStore {
  return (
    typeof store === 'object' &&
    store !== null &&
    typeof Reflect.get(store, 'runQuery') === 'function'
  );
}

/**
 * A cheap sanity check on the shape of a statement.
 *
 * Explicitly NOT the security boundary — that is the read-only transaction the
 * store opens. This exists to turn "you typed an UPDATE" into a clear message
 * instead of a database error, and to refuse the multi-statement form outright
 * since nothing legitimate here needs it.
 */
export function assertReadOnlyShape(sql: string): void {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (trimmed.length === 0) {
    throw new Error('The query is empty.');
  }
  if (trimmed.includes(';')) {
    throw new Error('Only one statement at a time. Remove the semicolon in the middle.');
  }
  // Leading comments have to come off before the keyword test. People paste
  // annotated SQL and they write notes above the statement — rejecting that as
  // "not a SELECT" is both wrong and baffling, since the SELECT is right there.
  const statement = stripLeadingComments(trimmed);
  if (statement.length === 0) {
    throw new Error('That is all comments — there is no statement to run.');
  }
  if (!/^(select|with)\b/i.test(statement)) {
    throw new Error(
      'Only SELECT (or WITH … SELECT) can run here. The catalog is read-only from this screen.',
    );
  }
}

/** Strips `-- line` and `/* block *\/` comments from the front of a statement. */
function stripLeadingComments(sql: string): string {
  let rest = sql.trimStart();
  for (;;) {
    if (rest.startsWith('--') || rest.startsWith('#')) {
      const newline = rest.indexOf('\n');
      if (newline === -1) return '';
      rest = rest.slice(newline + 1).trimStart();
      continue;
    }
    if (rest.startsWith('/*')) {
      const close = rest.indexOf('*/');
      if (close === -1) return '';
      rest = rest.slice(close + 2).trimStart();
      continue;
    }
    return rest;
  }
}
