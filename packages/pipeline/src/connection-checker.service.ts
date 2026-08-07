import type { CatalogConnection, ConnectionCheck } from '@dudousxd/nestjs-catalog';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { CatalogStorage } from './media-storage';
import { redactSecrets } from './run-logs';
import {
  type StorageManagerLike,
  importOptional,
  namedDisk,
  resolveSecretEnv,
  unknownDiskDetail,
} from './sources';

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

  constructor(
    // Optional and the only dependency this has, so every spec that constructs
    // it bare keeps compiling. Absent means no disk can be named here, which is
    // what {@link probeDisk} then says.
    @Optional() private readonly storage?: CatalogStorage,
  ) {}

  async check(connection: CatalogConnection): Promise<ConnectionCheck> {
    const started = Date.now();
    try {
      const detail = await this.probe(connection);
      return { ok: true, detail, elapsedMs: Date.now() - started };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The process log gets it whole; the RESPONSE does not.
      //
      // `POST connections/:id/check` asks only `catalog:read`, and a probe that
      // fails throws with the address in the message — `GET https://…` for an
      // HTTP source, a driver's own text for a SQL one. A connection URL is the
      // credential, so the softest scope in the system was reading the
      // strongest secret in it through an error string, which is the same leak
      // `config-secrets.ts` was written to close on the config itself.
      //
      // Redacted rather than replaced: which host refused, and as whom, is the
      // whole value of a failed check. What goes is the password, the query
      // string and the fragment.
      this.logger.warn(`${connection.name} unreachable: ${message}`);
      return {
        ok: false,
        detail: 'Could not reach it.',
        elapsedMs: Date.now() - started,
        error: redactSecrets(message),
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
      return await probeHttp(url, secret);
    }

    if (connection.kind === 'sql') {
      const url = secret ?? text('url');
      if (!url) {
        throw new Error('This connection has no URL. Name the environment variable that holds it.');
      }
      return url.startsWith('postgres') ? await probePostgres(url) : await probeMysql(url);
    }

    if (connection.kind === 's3') {
      // A named disk is checked first, and instead — a connection that names one
      // carries no bucket and no credential of its own, so asking about a bucket
      // would refuse it for the wrong reason.
      const disk = namedDisk(config);
      if (disk) return await probeDisk(this.storage?.manager(), disk);

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

async function probeHttp(url: string, secret?: string): Promise<string> {
  const response = await fetch(url, {
    method: 'GET',
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  // Any answer at all proves the host resolves and is listening, which is most
  // of what a check is for. A 4xx is reported rather than thrown because
  // "reachable but refused" and "unreachable" send an operator to different
  // places.
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}.`);
  }
  return `${url} answered ${response.status}.`;
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

/**
 * A named media disk, checked the way every other kind is: the cheapest call
 * that proves it is both there and readable.
 *
 * Two refusals rather than one, and the split is the same one the call-node
 * picker draws between "there are none" and "I cannot ask". A disk that does not
 * exist is an authoring mistake and the message carries the list of names that
 * would have worked; no manager at all is a deployment fact and no amount of
 * retyping the name will fix it. Collapsing them into "could not open the disk"
 * would send half of everybody to the wrong place.
 *
 * The list is `MaxKeys`-equivalent — one page, one object — for the reason
 * {@link probeS3} gives: a test that can take minutes is a test nobody presses.
 */
async function probeDisk(storage: StorageManagerLike | undefined, disk: string): Promise<string> {
  if (!storage) {
    throw new Error(
      `This connection reads the media disk "${disk}", and no storage manager resolved in this process, so nothing here can open it. Mount @dudousxd/nestjs-media on this deployment, or clear the disk and give the connection a bucket and a credential of its own.`,
    );
  }
  const available = storage.diskNames();
  if (!available.includes(disk)) throw new Error(unknownDiskDetail(disk, available));

  const driver = storage.disk(disk);
  const result: unknown = await driver.list('', { delimiter: '', limit: 1 });
  const files: unknown =
    result && typeof result === 'object' ? Reflect.get(result, 'files') : undefined;
  const count = Array.isArray(files) ? files.length : 0;
  return count > 0
    ? `Reached the disk "${disk}", and there is at least one object on it.`
    : `Reached the disk "${disk}", but nothing is on it yet.`;
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
