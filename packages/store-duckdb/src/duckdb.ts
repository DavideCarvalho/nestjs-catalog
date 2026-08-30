import { DuckDBInstance } from '@duckdb/node-api';
import type { CatalogDuckDbStoreOptions } from './options';

/**
 * A string literal for a statement this package builds.
 *
 * Only ever for paths and prefixes this package derived itself — never for a caller's
 * value, which goes through a bound parameter. Doubling the quote is the SQL rule; the
 * reason it is a function rather than a template is that a path containing an apostrophe is
 * rare enough that an inline version would be written correctly and then copied wrongly.
 */
export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * One fetched vector of rows, pulled from the engine on demand.
 *
 * The shape `DuckDbConnection.stream` actually depends on out of `@duckdb/node-api`'s
 * `DuckDBDataChunk` — `appendToRowObjects` rather than `getRowObjects`, because the former
 * pushes into a caller-supplied array and the latter allocates its own. `stream` below passes
 * it a fresh array per chunk, not a reused one — a chunk's rows are handed to the consumer via
 * `yield*` before the next chunk is fetched, so there is nothing to reuse the array FOR; keeping
 * one across chunks would only risk a consumer holding a reference into a chunk-2 write.
 */
interface StreamedChunk {
  appendToRowObjects(columnNames: readonly string[], into: Array<Record<string, unknown>>): void;
}

/**
 * A streaming result, as much of `@duckdb/node-api`'s `DuckDBResult` as `DuckDbConnection.stream`
 * uses.
 *
 * `[Symbol.asyncIterator]` is the part this package depends on for honesty: reading its
 * implementation in `node_modules/.../DuckDBResult.js` shows each `next()` call awaits exactly
 * one `fetch_chunk` call into the native driver and yields that chunk alone, never more. That is
 * what makes `DuckDbConnection.stream` below a real pull rather than a materialise-then-replay —
 * see that method's own docblock for how this was checked against the running engine rather
 * than only read off the type.
 *
 * That is a claim about the PRIMITIVE, not about any query built on top of it, and the
 * distinction is not academic — see `stream`'s own docblock for the two ways this file learned
 * that the hard way: a second connection interleaving a query mid-stream, and a caller's own
 * `ORDER BY` forcing DuckDB to materialise before chunk 1 ever comes back, both defeat the
 * property from outside `stream` while leaving this class's own contract technically true.
 */
interface StreamedResult {
  deduplicatedColumnNames(): string[];
  [Symbol.asyncIterator](): AsyncIterator<StreamedChunk>;
}

/**
 * As much of `@duckdb/node-api`'s driver-level instance as this package uses: a handle a second
 * connection can be opened on, independent of whichever connection is doing the opening.
 */
interface DuckDbEngine {
  connect(): Promise<{
    run(sql: string): Promise<unknown>;
    runAndReadAll(sql: string): Promise<{ getRowObjects(): Array<Record<string, unknown>> }>;
    stream(sql: string): Promise<StreamedResult>;
    closeSync(): void;
  }>;
}

/** As much of a DuckDB connection as this package uses. */
export class DuckDbConnection {
  constructor(
    private readonly engine: DuckDbEngine,
    private readonly connection: {
      run(sql: string): Promise<unknown>;
      runAndReadAll(sql: string): Promise<{ getRowObjects(): Array<Record<string, unknown>> }>;
      stream(sql: string): Promise<StreamedResult>;
      closeSync(): void;
    },
  ) {}

  async run(sql: string): Promise<void> {
    await this.connection.run(sql);
  }

  async rows(sql: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.connection.runAndReadAll(sql);
    return result.getRowObjects();
  }

  /**
   * A second, independent connection on the same engine, for a caller that needs to hold a
   * connection open across `await`s without contending with `this.ready()`'s single memoized
   * connection.
   *
   * ## Why this exists: a stream and any other query on one connection corrupt each other
   *
   * DuckDB serialises a *connection*, not the whole engine. Verified against the running
   * driver: opening a stream, fetching one chunk, then running an unrelated query on THAT SAME
   * connection and fetching the stream's next chunk afterward returned a chunk reporting
   * `rowCount: 0` on a million-row table — not an error, not the true continuation, a silent
   * empty read that a `for await` sees as the stream simply ending. A consumer of `streamSnapshot`
   * would iterate a truncated snapshot, see the loop end normally, and report success — exactly
   * the failure this package's dropped-snapshot refusal exists to prevent, reintroduced through
   * a different door. Repeating the same interleaving against a stream opened on a connection
   * from a SECOND `engine.connect()` call read every one of the million rows correctly; the
   * engine only serialises within one connection, and DuckDB's own settings — `memory_limit`,
   * `threads`, `temp_directory` — and any `CREATE SECRET` are engine-global, not per-connection,
   * confirmed the same way: set on one connection, read back through `current_setting()` and
   * `duckdb_secrets()` on a second connection opened afterward, with nothing re-applied. So a
   * connection this method opens needs none of `openDuckDb`'s setup repeated on it.
   *
   * ## Why a whole second connection rather than serialising callers against an open stream
   *
   * Because the alternative makes every unrelated `read`/`write`/`countStaged`/`carryForward`
   * on the store wait for however long a stream's consumer takes to finish pulling — which can
   * be the length of a downstream write to another system — for a store whose own methods have
   * no other reason to serialise against each other. A second connection costs one `connect()`
   * and is closed the moment the stream is; it does not make anything else wait.
   */
  async openStreamConnection(): Promise<DuckDbConnection> {
    const raw = await this.engine.connect();
    return new DuckDbConnection(this.engine, raw);
  }

  /**
   * One row at a time, pulled off the engine's own chunk-at-a-time result rather than read in
   * full first.
   *
   * `runAndReadAll`/`rows` above calls `fetchAllChunks`, which loops `fetchChunk` until the
   * result is exhausted before this package ever sees a row — the whole result set sits in
   * memory before the first row is handed back, which is exactly what the core package's
   * `CatalogSnapshotStreamStore` interface's "do not read ahead of the consumer" contract
   * forbids for a dataset sized for the feature to matter. `stream`'s underlying `DuckDBResult`
   * never calls `fetchChunk` on its own; each `for await` step below calls it exactly once, so
   * a consumer that stops pulling — breaks its loop, or lets the generator be abandoned — leaves
   * every chunk after that point unfetched rather than sitting in a Node array nobody asked for.
   *
   * Verified against the running engine, not only against the driver's own source: a table of
   * 50,000 rows chunks at 2,048 rows per `fetchChunk` call (DuckDB's own vector size), calling
   * `fetchChunk` twice by hand pulled exactly 4,096 rows and no more, and driving this exact
   * `for await` shape and breaking after 10 rows observed only the first chunk's 2,048 rows —
   * never the other 47,952.
   *
   * **That experiment used an unsorted query, and the gap between it and a sorted one turned
   * out to matter.** A `SELECT` ending in `ORDER BY` is a blocking operator: DuckDB must see
   * every input row before it can produce the first output row, so `stream` faithfully pulls
   * chunk-by-chunk from a result that was itself computed in full before chunk 1 existed to
   * pull. Measured directly: an unsorted 4,000,000-row scan returned its first chunk in single-
   * digit milliseconds with a few megabytes of RSS growth; the identical table read with
   * `ORDER BY` took roughly ten times as long and pulled tens of megabytes into the process
   * before that same first chunk came back. `stream` itself did not lie in either case — it
   * still called `fetchChunk` exactly once per `next()` — but the *query* handed to it had
   * already done the one thing this whole method exists to avoid before `stream` ever got a
   * chance to be honest about it. This is why `duckdb-warehouse.store.ts`'s `streamSnapshot`
   * does not hand this method a query with a snapshot-wide `ORDER BY` — see that method's own
   * docblock for what it does instead.
   *
   * The one honesty gap worth stating rather than hiding, independent of the caller's SQL:
   * DuckDB's pull granularity is a *chunk* (2,048 rows), not a single row. A consumer that
   * reads one row and stops has already caused the other 2,047 in that vector to be computed
   * and held in memory — that is the unit the C API offers, and there is no finer one to ask
   * for. What this method guarantees, and only this, is the coarser claim: no *chunk* is
   * fetched before the consumer has asked for a row inside it, and no query result is
   * materialised beyond what the query itself forces DuckDB to compute before it can answer.
   */
  async *stream(sql: string): AsyncIterableIterator<Record<string, unknown>> {
    const result = await this.connection.stream(sql);
    const columnNames = result.deduplicatedColumnNames();
    for await (const chunk of result) {
      const rows: Array<Record<string, unknown>> = [];
      chunk.appendToRowObjects(columnNames, rows);
      yield* rows;
    }
  }

  async close(): Promise<void> {
    this.connection.closeSync();
  }
}

/**
 * Open the engine, configured for a container rather than for a laptop.
 *
 * DuckDB's defaults are every CPU core and 80% of RAM, and both are measured against the
 * machine rather than against a cgroup — so a pod with a memory limit is OOMKilled by a
 * query DuckDB believed was inside its budget. `temp_directory` matters for the same reason
 * in the other direction: spilling to a path that is not on a writable volume turns a large
 * sort into a failure rather than into a slow query.
 *
 * The database is in-memory. Nothing in this store is kept in a DuckDB file — every byte
 * that survives a restart is a Parquet object or a JSON record in the object store — so a
 * file would add DuckDB's single-writer file lock to a process that does not need it.
 */
export async function openDuckDb(options: CatalogDuckDbStoreOptions): Promise<DuckDbConnection> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const opened = new DuckDbConnection(instance, connection);
  if (options.memoryLimit) {
    await opened.run(`SET memory_limit = ${quoteLiteral(options.memoryLimit)}`);
  }
  if (options.threads !== undefined) {
    await opened.run(`SET threads = ${options.threads}`);
  }
  if (options.tempDirectory) {
    await opened.run(`SET temp_directory = ${quoteLiteral(options.tempDirectory)}`);
  }
  if (options.root.startsWith('s3://')) {
    await configureS3(opened, options);
  }
  return opened;
}

/**
 * Point DuckDB at object storage.
 *
 * `CREATE SECRET` with `PROVIDER credential_chain` is the form that picks up an instance
 * profile, an assumed role or a pod identity, which is what a deployment has and a laptop
 * does not. `ENDPOINT` and `REGION` are set explicitly rather than left to be derived: the
 * derivation has a known defect in GovCloud, where the region slug is dropped from the
 * generated host, and the issue reporting it was closed without a fix.
 */
export async function configureS3(
  connection: DuckDbConnection,
  options: CatalogDuckDbStoreOptions,
): Promise<void> {
  await connection.run('INSTALL httpfs');
  await connection.run('LOAD httpfs');
  const s3 = options.s3 ?? {};
  const settings: string[] = ['TYPE s3'];
  if (s3.accessKeyId && s3.secretAccessKey) {
    settings.push('PROVIDER config');
    settings.push(`KEY_ID ${quoteLiteral(s3.accessKeyId)}`);
    settings.push(`SECRET ${quoteLiteral(s3.secretAccessKey)}`);
    if (s3.sessionToken) settings.push(`SESSION_TOKEN ${quoteLiteral(s3.sessionToken)}`);
  } else {
    settings.push('PROVIDER credential_chain');
  }
  if (s3.region) settings.push(`REGION ${quoteLiteral(s3.region)}`);
  if (s3.endpoint) settings.push(`ENDPOINT ${quoteLiteral(s3.endpoint)}`);
  if (s3.urlStyle) settings.push(`URL_STYLE ${quoteLiteral(s3.urlStyle)}`);
  if (s3.useSsl === false) settings.push('USE_SSL false');
  await connection.run(`CREATE OR REPLACE SECRET catalog_s3 (${settings.join(', ')})`);
}
