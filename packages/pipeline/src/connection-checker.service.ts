import type { CatalogConnection, ConnectionCheck } from '@dudousxd/nestjs-catalog';
import { Injectable, Logger } from '@nestjs/common';
import { importOptional, resolveSecretEnv } from './sources';

/**
 * Reaching a source to find out whether it can be reached.
 *
 * The reason a named connection earns its place: without this, the only way to
 * learn that a host is wrong, a credential is missing or a bucket is spelled
 * differently is to run a load and read the failure — which happens on a
 * schedule, hours after somebody typed it, attributed to a connector rather
 * than to the address it borrowed.
 *
 * Every check is deliberately the cheapest call that proves reachability *and*
 * authorisation, and nothing more. Listing a whole bucket or running the
 * author's query would make "test" a different amount of work from source to
 * source, and a test that can take minutes is a test nobody presses.
 */
@Injectable()
export class ConnectionChecker {
  private readonly logger = new Logger(ConnectionChecker.name);

  async check(connection: CatalogConnection): Promise<ConnectionCheck> {
    const started = Date.now();
    try {
      const detail = await this.probe(connection);
      return { ok: true, detail, elapsedMs: Date.now() - started };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`${connection.name} unreachable: ${message}`);
      return {
        ok: false,
        detail: 'Could not reach it.',
        elapsedMs: Date.now() - started,
        error: message,
      };
    }
  }

  private async probe(connection: CatalogConnection): Promise<string> {
    const secret = resolveSecretEnv(connection.secretEnvVar);
    const config = connection.config;
    const text = (key: string): string => (typeof config[key] === 'string' ? config[key] : '');

    if (connection.kind === 'http') {
      const url = text('url');
      if (!url) throw new Error('This connection has no url.');
      const response = await fetch(url, {
        method: 'GET',
        headers: secret ? { authorization: `Bearer ${secret}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      // Any answer at all proves the host resolves and is listening, which is
      // most of what a check is for. A 4xx is reported rather than thrown
      // because "reachable but refused" and "unreachable" send an operator to
      // different places.
      if (!response.ok) {
        throw new Error(`${url} answered ${response.status}.`);
      }
      return `${url} answered ${response.status}.`;
    }

    if (connection.kind === 'sql') {
      const url = secret ?? text('url');
      if (!url) {
        throw new Error('This connection has no URL. Name the environment variable that holds it.');
      }
      return url.startsWith('postgres') ? await probePostgres(url) : await probeMysql(url);
    }

    if (connection.kind === 's3') {
      const bucket = text('bucket');
      if (!bucket) throw new Error('This connection has no bucket.');
      return await probeS3(connection, secret);
    }

    if (connection.kind === 'file') {
      // Nothing to reach: a file connector's path belongs to the load, not to a
      // shared address. Saying so is better than inventing a check that always
      // passes and means nothing.
      return 'Nothing to reach — a file source is checked when it is read.';
    }

    return 'This kind needs no connection.';
  }
}

async function probeMysql(url: string): Promise<string> {
  const mysql = await importOptional<{
    createConnection: (url: string) => Promise<MysqlLike>;
  }>('mysql2/promise', 'mysql');
  const connection = await mysql.createConnection(url);
  try {
    const [rows] = await connection.query('SELECT VERSION() AS version');
    return `MySQL ${versionFrom(rows)}`;
  } finally {
    await connection.end().catch(() => undefined);
  }
}

async function probePostgres(url: string): Promise<string> {
  const pg = await importOptional<{
    Client: new (config: { connectionString: string }) => PostgresLike;
  }>('pg', 'postgres');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query('SELECT version() AS version');
    return `PostgreSQL ${versionFrom(result.rows)}`;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function probeS3(connection: CatalogConnection, secret?: string): Promise<string> {
  const config = connection.config;
  const text = (key: string): string => (typeof config[key] === 'string' ? config[key] : '');
  const bucket = text('bucket');

  const s3 = await importOptional<{
    S3Client: new (config: Record<string, unknown>) => S3Like;
    ListObjectsV2Command: new (input: Record<string, unknown>) => object;
  }>('@aws-sdk/client-s3', 's3');

  const [accessKeyId, secretAccessKey] = (secret ?? '').split(':');
  const client = new s3.S3Client({
    ...(text('region') ? { region: text('region') } : {}),
    ...(text('endpoint') ? { endpoint: text('endpoint') } : {}),
    ...(config.forcePathStyle === true ? { forcePathStyle: true } : {}),
    // Omitted rather than set to undefined, so the SDK falls through to its own
    // credential chain — which is how this authenticates under IRSA on EKS.
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });

  // One key, not the prefix. Listing proves the bucket exists and the
  // credential may read it, and asking for a single key keeps the cost the same
  // whether the bucket holds ten objects or ten million.
  const result = await client.send(
    new s3.ListObjectsV2Command({
      Bucket: bucket,
      ...(text('prefix') ? { Prefix: text('prefix') } : {}),
      MaxKeys: 1,
    }),
  );
  const count = typeof result.KeyCount === 'number' ? result.KeyCount : 0;
  return count > 0
    ? `Reached ${bucket}, and there is at least one object under the prefix.`
    : `Reached ${bucket}, but nothing is under the prefix yet.`;
}

/** Pull a version string out of whatever shape the driver returned. */
function versionFrom(rows: unknown): string {
  if (!Array.isArray(rows) || rows.length === 0) return '(no version reported)';
  const first: unknown = rows[0];
  if (first && typeof first === 'object' && 'version' in first) {
    const value = Reflect.get(first, 'version');
    if (typeof value === 'string') return value.split(' ')[0];
  }
  return '(no version reported)';
}

interface MysqlLike {
  query(sql: string): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}

interface PostgresLike {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

interface S3Like {
  send(command: object): Promise<{ KeyCount?: number }>;
}
