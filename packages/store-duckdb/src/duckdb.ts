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

/** As much of a DuckDB connection as this package uses. */
export class DuckDbConnection {
  constructor(
    private readonly connection: {
      run(sql: string): Promise<unknown>;
      runAndReadAll(sql: string): Promise<{ getRowObjects(): Array<Record<string, unknown>> }>;
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
