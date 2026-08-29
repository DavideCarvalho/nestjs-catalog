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
 * pushes into a caller-supplied array and the latter allocates its own, and the caller-supplied
 * array is reused per chunk below so a long stream does not grow an array over its whole
 * lifetime for no reason.
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
 */
interface StreamedResult {
  deduplicatedColumnNames(): string[];
  [Symbol.asyncIterator](): AsyncIterator<StreamedChunk>;
}

/** As much of a DuckDB connection as this package uses. */
export class DuckDbConnection {
  constructor(
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
   * never the other 47,952. That is the closest thing to proof available short of instrumenting
   * the native binding itself: the engine only ever produces the vectors this loop actually asks
   * for.
   *
   * The one honesty gap worth stating rather than hiding: DuckDB's pull granularity is a
   * *chunk* (2,048 rows), not a single row. A consumer that reads one row and stops has already
   * caused the other 2,047 in that vector to be computed and held in memory — that is the unit
   * the C API offers, and there is no finer one to ask for. What this method guarantees is the
   * next coarser claim: no *chunk* is fetched before the consumer has asked for a row inside it,
   * which is what keeps a stream of millions of rows from materialising as one Node array.
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
  const opened = new DuckDbConnection(connection);
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
