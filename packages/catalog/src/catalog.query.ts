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

/**
 * The same statement, asked for a row at a time.
 *
 * Two fields differ from {@link CatalogQueryRequest} and both differ because the
 * caller is an export rather than a screen.
 *
 * `maxRows` is optional here and **absent means every row**. A table is a page
 * of a result and a cap is what makes the page; an export is the whole thing by
 * definition, and a capped export is a prefix presented as a file.
 *
 * `timeoutMs` is optional for the matching reason. A statement backing a screen
 * has to answer while somebody waits; an export of a large table legitimately
 * runs for minutes, and the bound that matters for it is that no stage holds
 * more than a row — which is what the stream is for. An implementation given no
 * timeout should impose none of its own.
 */
export interface CatalogQueryStreamRequest {
  sql: string;
  maxRows?: number;
  timeoutMs?: number;
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

  /**
   * The same read, handing rows over as the engine produces them.
   *
   * **Optional, and the option is the store's to take rather than the caller's.**
   * A store fronting an API, or one on a driver that buffers its result set
   * before resolving, cannot offer this honestly, and a shim that collected the
   * rows and yielded them back would satisfy the type while doing the exact
   * thing the type exists to avoid. So an absent `streamQuery` is a real answer,
   * and {@link CatalogService.streamSavedQuery} falls back to the capped
   * buffered read for it — see the note there about what that costs.
   *
   * The contract on an implementation is one sentence: **do not read ahead of
   * the consumer.** Whatever the driver offers must pause when the consumer
   * stops pulling, all the way to the socket, or the memory has only moved.
   *
   * Returned synchronously — an async generator, not a promise for one — so that
   * a consumer's `for await` owns the resource from the first pull, and an
   * abandoned iteration runs the generator's `finally`.
   */
  streamQuery?(request: CatalogQueryStreamRequest): AsyncIterable<Record<string, unknown>>;
}

export function isQueryStore(store: unknown): store is CatalogQueryStore {
  return (
    typeof store === 'object' &&
    store !== null &&
    typeof Reflect.get(store, 'runQuery') === 'function'
  );
}

/** A query store that can hand rows over without materialising the result set. */
export function isStreamingQueryStore(
  store: unknown,
): store is CatalogQueryStore & Required<Pick<CatalogQueryStore, 'streamQuery'>> {
  return isQueryStore(store) && typeof Reflect.get(store, 'streamQuery') === 'function';
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
