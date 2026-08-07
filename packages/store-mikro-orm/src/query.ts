import type {
  CatalogObjectTypeDef,
  CatalogQueryRelation,
  CatalogQueryRequest,
  CatalogQueryResult,
} from '@dudousxd/nestjs-catalog';
import type { EntityManager } from '@mikro-orm/sql';
import { BadRequestException } from '@nestjs/common';
import { type CatalogSqlDialect, MYSQL_DIALECT } from './dialect';
import { SNAPSHOT_COLUMN, outputAlias, physicalColumn, tableFor } from './identifiers';

/**
 * `Mvr` -> `mvr`. The view a query writes in its FROM clause.
 *
 * Views, rather than teaching the query layer to rewrite table names: a view is
 * a thing MySQL already understands, so joins, subqueries, CTEs and aggregates
 * all work without anyone writing a SQL parser. The alternative — intercepting
 * identifiers in a statement we did not parse — is how query layers acquire
 * their worst bugs.
 */
export function viewFor(typeName: string): string {
  return typeName
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .toLowerCase();
}

/**
 * Point a type's view at the snapshot readers should get.
 *
 * Called on commit. Until a type has committed once it has no view at all,
 * which is the honest state: a name that resolves to an empty result is worse
 * than one that does not resolve, because the first looks like an answer.
 *
 * **One predicate over one table, and it stays that way even for incremental
 * loads.** That is not an accident of the current feature set, it is the whole
 * reason incremental loads copy the previous snapshot's surviving rows forward
 * instead of storing a delta: a snapshot is always the complete state, so
 * "current" is a filter and "as of last Tuesday" is the same filter with a
 * different value. Had deltas been stored instead, this function would have to
 * emit a union back to the last full load, every reader that ever selects from
 * the physical table by hand would have to reproduce that union correctly, and
 * a snapshot in the middle of a broken chain would answer confidently and
 * wrongly. The copy is paid once per load; the alternative is paid on every
 * read, forever, by people who did not know they were paying it.
 *
 * **The output alias is `outputAlias(p.name)`, not `p.name`.** This line used to
 * take the property's name verbatim, and since `ident` refuses rather than
 * escapes, that made "is this a SQL identifier?" a condition on every property
 * name in the catalog — enforced at publish time, and enforced for the sake of
 * this one statement. The cost of that condition landed somewhere else entirely:
 * a source whose columns really are called `Asset Id` had to be published under
 * renamed properties, and a load reads `row[property.name]`, so every renamed
 * column went in NULL on every row of every run. See `outputAlias` in the core
 * package for what it does and for why a name that is already an identifier is
 * still kept exactly as it is — no view that resolves today changes shape.
 */
export async function refreshView(
  em: EntityManager,
  type: CatalogObjectTypeDef,
  snapshotId: string,
  dialect: CatalogSqlDialect = MYSQL_DIALECT,
): Promise<void> {
  const { ident } = dialect;
  const view = viewFor(type.name);
  const columns = type.properties.map(
    (p) => `${ident(physicalColumn(p.name))} AS ${ident(outputAlias(p.name))}`,
  );
  // The snapshot id rides along so a query can tell which load it is reading
  // without joining back to the snapshot table.
  columns.push(`${ident(SNAPSHOT_COLUMN)} AS ${ident('_snapshot')}`);

  // A list of statements rather than one, because the two engines cannot do this
  // with the same statement. MySQL replaces the view in place under a metadata
  // lock; Postgres refuses `CREATE OR REPLACE VIEW` outright whenever the column
  // list has grown anywhere but at the end — which is every type that gains a
  // property, since `_snapshot` above is pinned last — and so drops and
  // recreates inside a transaction instead. See `dialect.ts` for the measurement
  // and for why the atomicity claim survives.
  const statements = dialect.refreshViewStatements({
    view,
    select: columns.join(', '),
    table: tableFor(type.name),
    snapshotColumn: SNAPSHOT_COLUMN,
    quotedSnapshotValue: em.getPlatform().quoteValue(snapshotId),
  });
  const connection = em.getConnection();
  for (const statement of statements) await connection.execute(statement);
}

export async function dropView(
  em: EntityManager,
  typeName: string,
  dialect: CatalogSqlDialect = MYSQL_DIALECT,
): Promise<void> {
  await em.getConnection().execute(`DROP VIEW IF EXISTS ${dialect.ident(viewFor(typeName))}`);
}

/**
 * What a query may select from.
 *
 * Two relations per type, and the distinction is the whole point of the screen:
 * the view is the committed snapshot, the physical table is every load that has
 * ever run. Querying across versions means selecting from the second and
 * filtering on `_snapshot_id`.
 *
 * Both column lists are what the SQL actually exposes rather than what the type
 * calls the field: `outputAlias` for the view because that is what
 * {@link refreshView} aliases to, `physicalColumn` for the table because that is
 * the column the load wrote. A schema panel that listed the property name for a
 * property called `Asset Id` would be offering an autocompletion that fails.
 */
export function relationsFor(types: CatalogObjectTypeDef[]): CatalogQueryRelation[] {
  const relations: CatalogQueryRelation[] = [];
  for (const type of types) {
    const columns = type.properties.map((p) => ({
      name: outputAlias(p.name),
      type: p.type,
    }));
    relations.push({
      name: viewFor(type.name),
      kind: 'current',
      objectType: type.name,
      description: `${type.displayName} as of the committed snapshot.`,
      columns: [...columns, { name: '_snapshot', type: 'string' }],
    });
    relations.push({
      name: tableFor(type.name),
      kind: 'history',
      objectType: type.name,
      // `_batch` is described rather than merely listed because it is the one
      // column here whose meaning is not guessable, and it answers a question
      // people do ask of an incremental load: which of these rows did this run
      // actually produce, and which are just still true from last time.
      description: `Every load of ${type.displayName} ever written. Filter on _snapshot_id to pick one, or group by it to compare. Within a snapshot, _batch is which chunk of the load a row arrived in; _batch = -1 marks rows carried forward unchanged from the previous snapshot by an incremental run.`,
      columns: [
        ...type.properties.map((p) => ({
          name: physicalColumn(p.name),
          type: p.type,
        })),
        { name: '_snapshot_id', type: 'string' },
        { name: '_principal_id', type: 'string' },
        { name: '_loaded_at', type: 'date' },
        { name: '_batch', type: 'number' },
      ],
    });
  }
  return relations;
}

/**
 * Run one statement and make sure it cannot write.
 *
 * `START TRANSACTION READ ONLY` is the guarantee — MySQL refuses any write
 * inside it, whatever the statement turned out to parse as. The keyword check
 * upstream only exists to produce a readable message; this is what makes the
 * screen safe to expose. Verified against MySQL 8.0 rather than assumed: an
 * `INSERT` issued between the `START TRANSACTION` and the `ROLLBACK` below comes
 * back as `Cannot execute statement in a READ ONLY transaction`, sequentially
 * and with eight of these sequences in flight at once. The statements do share
 * one session — the connection id is stable across all four.
 *
 * The timeout is a per-statement optimizer HINT rather than `SET SESSION
 * MAX_EXECUTION_TIME`, and that difference matters to whoever is hosting this.
 * A session variable rides on the pooled connection: set it here and it stays
 * set on that connection after the query returns, for whoever borrows it next.
 * With no `contextName` configured, `catalogConnectionProviders` binds this
 * package to the HOST's `EntityManager` (see `context.ts`) — so the connection
 * being poisoned is one of the host's, and the next thing the host runs on it
 * silently inherits a 15-second statement timeout it never asked for and cannot
 * see. Measured: after one query-console request, a *different* `em.fork()`
 * read `@@SESSION.MAX_EXECUTION_TIME` back as the value set here.
 *
 * The hint has the same teeth and no residue. Both forms interrupt a runaway
 * cross join at 1.00 s; the hint leaves the session variable at 0. It also
 * removes a round trip, since it rides on the statement instead of preceding
 * it. It attaches to the outer `SELECT` — the wrapper below, which is always a
 * plain `SELECT`, never the caller's text — so the caller's statement is not
 * rewritten and a `WITH` that starts their query is untouched.
 */
export async function runReadOnlyQuery(
  em: EntityManager,
  request: CatalogQueryRequest,
  dialect: CatalogSqlDialect = MYSQL_DIALECT,
): Promise<CatalogQueryResult> {
  const maxRows = request.maxRows ?? 1_000;
  const timeoutMs = request.timeoutMs ?? 15_000;
  const started = Date.now();

  // MySQL's own kill switch, so a runaway join cannot hold a connection for as
  // long as it likes. Floored at a second, matching what the session form did.
  const budgetMs = Math.max(1000, Math.floor(timeoutMs));
  // Fetch one extra row: if it comes back, the cap cut the result short and the
  // UI can say so rather than quietly showing a prefix as if it were the whole.
  // The budget reaches the engine differently on each. MySQL rides an optimizer
  // hint on the wrapper; Postgres has no such hint — the same comment there
  // parses, runs, and enforces nothing — and takes `SET LOCAL statement_timeout`
  // inside the transaction opened just below. `LOCAL` is what makes the two
  // equivalent rather than merely similar: it is unset when the transaction
  // ends, so neither form leaves residue on the pooled connection, which is the
  // whole reason the session variable was rejected in the first place.
  const budget = dialect.statementTimeout(budgetMs);
  const wrapped = `SELECT ${budget.hint}* FROM (${request.sql.trim().replace(/;\s*$/, '')}) AS ${dialect.ident('q')} LIMIT ${maxRows + 1}`;

  const connection = em.getConnection();
  await connection.execute('START TRANSACTION READ ONLY');
  try {
    if (budget.preamble) await connection.execute(budget.preamble);
    const rows = await connection.execute<Array<Record<string, unknown>>>(wrapped);
    const truncated = rows.length > maxRows;
    const page = truncated ? rows.slice(0, maxRows) : rows;

    return {
      columns: page.length > 0 ? Object.keys(page[0]) : [],
      rows: page.map(normaliseRow),
      rowCount: page.length,
      truncated,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    // The database's message is the useful one here — "Unknown column 'foo'" is
    // exactly what the person typing needs, and wrapping it in something
    // friendlier would hide it.
    throw new BadRequestException(error instanceof Error ? error.message : String(error));
  } finally {
    await connection.execute('ROLLBACK').catch(() => undefined);
  }
}

/**
 * The same read, one row at a time.
 *
 * Written for the CSV export, which has no row cap by design and therefore
 * cannot use {@link runReadOnlyQuery}: that function's whole shape is a page —
 * it fetches `maxRows + 1` and reports whether it cut the result short, which is
 * the right answer for a screen and the wrong one for a file that is supposed to
 * be everything.
 *
 * **The back-pressure is real and comes from the driver.** MikroORM v7 runs on
 * Kysely, and `connection.stream()` compiles the statement, asks the executor to
 * stream it, and yields rows as the dialect produces them. Under MySQL that
 * dialect is mysql2's row stream, which pauses the socket when the reader stops
 * pulling — so a consumer that writes a line to a socket before asking for the
 * next row holds one row, not a result set, all the way down to the wire.
 *
 * **The read-only transaction is the same guarantee `runReadOnlyQuery` makes and
 * is obtained differently.** That function issues `START TRANSACTION READ ONLY`
 * as a statement; a stream needs its rows read *inside* the transaction, so this
 * takes a real transaction handle (`begin({ readOnly: true })`, which Kysely
 * emits as `START TRANSACTION READ ONLY`) and passes it to `stream` as the
 * context. Passing the handle is not a nicety: without it the stream would be
 * executed on some other connection from the pool and the access mode set here
 * would be protecting nothing.
 *
 * **The rollback sits in a `finally` on the generator**, so it runs when the
 * consumer stops early as well as when the rows run out — a `for await` that
 * breaks, or a client that closes the download halfway, calls the generator's
 * `return`, which unwinds this. A consumer that abandons the iterator without
 * closing it would leak the transaction, which is the one obligation this shape
 * puts on a caller that the buffered one does not.
 *
 * **The timeout is optional here and mandatory there.** A statement behind a
 * screen has somebody waiting on it; an export of a large table legitimately
 * runs for minutes, and cutting it off at the console's fifteen seconds would
 * make the export impossible for exactly the tables that need one. Given no
 * budget, no hint is attached and MySQL applies none.
 */
export async function* streamReadOnlyQuery(
  em: EntityManager,
  request: { sql: string; maxRows?: number; timeoutMs?: number },
  dialect: CatalogSqlDialect = MYSQL_DIALECT,
): AsyncGenerator<Record<string, unknown>> {
  const connection = em.fork().getConnection();
  const trx = await connection.begin({ readOnly: true });
  try {
    // Inside the transaction and before the stream, so a Postgres deployment's
    // `SET LOCAL statement_timeout` is scoped to this handle and unset with it.
    const preamble =
      request.timeoutMs === undefined
        ? undefined
        : dialect.statementTimeout(Math.max(1000, Math.floor(request.timeoutMs))).preamble;
    if (preamble) await connection.execute(preamble, [], 'run', trx);

    for await (const row of connection.stream<Record<string, unknown>>(
      streamStatement(request, dialect),
      [],
      trx,
    )) {
      yield normaliseRow(row);
    }
  } catch (error) {
    // The database's message is the useful one, exactly as in the buffered read
    // — "Unknown column 'foo'" is what the person who wrote the query needs.
    throw new BadRequestException(error instanceof Error ? error.message : String(error));
  } finally {
    await connection.rollback(trx).catch(() => undefined);
  }
}

/**
 * The statement a streamed read runs.
 *
 * Wrapped in a `SELECT *` for the same reason the buffered one is: an optimizer
 * hint is only legal on a plain `SELECT`, and the caller's text may start with
 * `WITH`. Unwrapped when there is neither a budget nor a cap to attach, because
 * then the wrapper would be a subquery bought for nothing.
 */
function streamStatement(
  request: { sql: string; maxRows?: number; timeoutMs?: number },
  dialect: CatalogSqlDialect,
): string {
  const sql = request.sql.trim().replace(/;\s*$/, '');
  const hint =
    request.timeoutMs === undefined
      ? ''
      : dialect.statementTimeout(Math.max(1000, Math.floor(request.timeoutMs))).hint;
  const limit = request.maxRows === undefined ? '' : ` LIMIT ${Math.max(0, request.maxRows)}`;
  if (hint === '' && limit === '') return sql;
  return `SELECT ${hint}* FROM (${sql}) AS ${dialect.ident('q')}${limit}`;
}

/** JSON cannot carry BigInt or Date; neither can a table cell. */
function normaliseRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'bigint') out[key] = value.toString();
    else if (value instanceof Date) out[key] = value.toISOString();
    else if (Buffer.isBuffer(value)) out[key] = value.toString('base64');
    else out[key] = value;
  }
  return out;
}
