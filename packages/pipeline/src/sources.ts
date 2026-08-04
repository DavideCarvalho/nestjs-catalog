import { readFile } from 'node:fs/promises';
import type { CatalogConnection, CatalogConnector } from '@dudousxd/nestjs-catalog';

/**
 * Pulling raw records out of a source.
 *
 * Deliberately dumb: every fetcher returns whatever the source gave, unshaped.
 * Shaping is the transform's job, and a fetcher that quietly renamed a column
 * would make the transform a lie about what arrived.
 *
 * Credentials are never stored on the connector. Each fetcher reads one named
 * environment variable, so what the catalog database holds is the *name* of a
 * secret — a leak gives away the shape of an integration, not the keys to it.
 */
export interface FetchContext {
  connector: CatalogConnector;
  /** The resolved credential, if the connector named an env var. */
  secret?: string;
  /**
   * Where the last run of this connector got to.
   *
   * Empty on the first run and after somebody clears it. A fetcher that cannot
   * use a watermark ignores this and reads everything, which is the honest
   * behaviour for a source that offers no way to ask what changed.
   */
  state: Record<string, unknown>;
  /** Whether the caller wants everything or only what changed. */
  mode: 'full' | 'incremental';
}

/**
 * What a fetch produced, and how far it got.
 *
 * A fetcher may return the bare records when it has nothing to remember. When
 * it does — a watermark, the object keys it consumed — it returns `state`, and
 * the runner persists that only after the load commits. Advancing before the
 * commit would mean a run that failed halfway had already promised never to
 * read those rows again.
 */
export interface FetchResult {
  records: unknown[];
  state?: Record<string, unknown>;
}

export type SourceFetcher = (context: FetchContext) => Promise<unknown[] | FetchResult>;

/** Normalise the two shapes a fetcher may return. */
export function toFetchResult(value: unknown[] | FetchResult): FetchResult {
  return Array.isArray(value) ? { records: value } : value;
}

export function resolveSecret(connector: CatalogConnector): string | undefined {
  return resolveSecretEnv(connector.secretEnvVar);
}

/** Read a credential by the name of its variable, or say why it could not. */
export function resolveSecretEnv(name?: string): string | undefined {
  if (!name) return undefined;
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set in this environment, so the connector cannot authenticate.`,
    );
  }
  return value;
}

/**
 * Fold a named connection into the connector that reads through it.
 *
 * The connection supplies the address and the credential; the connector
 * supplies what is specific to this load. When both name the same key the
 * connector wins — a connection is a default, and a load that needs a different
 * prefix under the same bucket should not need a second connection.
 *
 * The kinds must agree. A connector reading SQL through an S3 connection would
 * otherwise reach the fetcher with a bucket where a connection URL belongs, and
 * fail describing the symptom rather than the mistake.
 */
export function applyConnection(
  connector: CatalogConnector,
  connection?: CatalogConnection,
): CatalogConnector {
  if (!connection) return connector;
  if (connection.kind !== connector.kind) {
    throw new Error(
      `"${connector.name}" is a ${connector.kind} connector reading through "${connection.name}", which is a ${connection.kind} connection. They have to be the same kind.`,
    );
  }
  return {
    ...connector,
    config: { ...connection.config, ...connector.config },
    secretEnvVar: connector.secretEnvVar ?? connection.secretEnvVar,
  };
}

/** Records typed straight into the config. Useful for trying a transform. */
export const fetchInline: SourceFetcher = async ({ connector }) => {
  const records = connector.config.records;
  return Array.isArray(records) ? records : [];
};

/** A JSON endpoint, optionally with the array nested inside an envelope. */
export const fetchHttp: SourceFetcher = async ({ connector, secret }) => {
  const url = String(connector.config.url ?? '');
  if (!url) throw new Error('This connector has no url configured.');

  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      ...((connector.config.headers as Record<string, string>) ?? {}),
    },
  });
  if (!response.ok) throw new Error(`GET ${url} → ${response.status}`);

  return unwrap(await response.json(), connector.config.path);
};

/**
 * A file — a local path, or anything `fetch` can GET.
 *
 * Format from the extension, overridable by config, because a signed S3 URL
 * ends in a query string and a `Content-Type` of `application/octet-stream` is
 * what most object stores actually send.
 */
export const fetchFile: SourceFetcher = async ({ connector }) => {
  const source = String(connector.config.path ?? connector.config.url ?? '');
  if (!source) throw new Error('This connector has no path or url configured.');

  const text = /^https?:\/\//.test(source)
    ? await (async () => {
        const response = await fetch(source);
        if (!response.ok) throw new Error(`GET ${source} → ${response.status}`);
        return response.text();
      })()
    : await readFile(source, 'utf8');

  return parseRecords(text, source, connector.config);
};

/**
 * An object store prefix — S3, MinIO, anything that speaks S3.
 *
 * The unit of work is an object rather than a bucket: a run lists what is under
 * the prefix, reads the objects it has not read before, and remembers where it
 * got to. That only answers "have I read this one" because drops land as whole
 * objects and are not rewritten in place; a source that mutates objects would
 * need a content hash, and this deliberately does not pretend to offer one.
 *
 * Credentials default to the SDK's own chain, which is the only thing that
 * works in EKS: the pod's role is handed to the SDK by the environment, and
 * naming an env var there would mean minting a static key pair that never
 * expires. `secretEnvVar` exists for a local MinIO and holds
 * `accessKeyId:secretAccessKey`.
 */
export const fetchS3: SourceFetcher = async ({ connector, secret, state, mode }) => {
  const bucket = String(connector.config.bucket ?? '').trim();
  if (!bucket) throw new Error('This connector has no bucket configured.');

  const prefix = String(connector.config.prefix ?? '');
  const suffix = String(connector.config.suffix ?? '');
  const limit = positiveInteger(connector.config.maxObjectsPerRun);

  // A full run reads the whole prefix by definition, so it ignores the stored
  // watermark rather than being refused one.
  const previousWatermark =
    mode === 'incremental' && typeof state.objectWatermark === 'string'
      ? state.objectWatermark
      : undefined;
  const previousKeys = new Set(
    Array.isArray(state.objectWatermarkKeys)
      ? state.objectWatermarkKeys.filter((key): key is string => typeof key === 'string')
      : [],
  );

  const s3 = await importOptional<S3Module>('@aws-sdk/client-s3', 'S3');
  const client = createS3Client(s3, connector, secret);

  try {
    const candidates = await listUnreadObjects({
      client,
      s3,
      bucket,
      prefix,
      suffix,
      previousWatermark,
      previousKeys,
    });

    // Oldest first, and ties broken by key so the order is the same on every
    // run. Without that, `maxObjectsPerRun` would cut a tie group in a
    // different place each time and the keys recorded at the watermark would
    // not be the ones actually read.
    candidates.sort(byOldestThenKey);
    const consumed = limit === undefined ? candidates : candidates.slice(0, limit);
    // Nothing new. Returning no state leaves the previous watermark exactly
    // where it was, which is what "nothing happened" should mean.
    if (consumed.length === 0) return [];

    const records = await readObjectRecords({
      client,
      s3,
      bucket,
      objects: consumed,
      config: connector.config,
    });

    // State is returned even on a full run. It is a fact about what this run
    // read, true whichever mode asked for it, and recording it means switching
    // a connector to incremental afterwards continues from here instead of
    // loading the whole prefix a second time.
    return {
      records,
      state: nextObjectState(consumed, previousWatermark, previousKeys),
    };
  } finally {
    // The SDK keeps sockets alive for reuse, which keeps the process alive too
    // when a run is the only thing happening.
    client.destroy?.();
  }
};

/**
 * A SQL database, by connection URL.
 *
 * Read-only by construction rather than by inspection: the statement runs
 * inside a read-only transaction, so the database refuses any write whatever
 * the query turned out to parse as. The alternative — checking the SQL for
 * keywords — is a guess about a parser, and the parser wins eventually.
 *
 * The driver is resolved at run time. A deployment that never uses a SQL
 * connector should not have to install a Postgres client to boot.
 *
 * `watermarkColumn` in the config makes an incremental run read only what is
 * past where the last one got to. Without it — or in `full` mode — this reads
 * everything, which is the behaviour a source with no ordering column can
 * honestly offer.
 */
export const fetchSql: SourceFetcher = async ({ connector, secret, state, mode }) => {
  const url = secret ?? String(connector.config.url ?? '');
  const sql = String(connector.config.query ?? '');
  if (!url) {
    throw new Error(
      'This connector has no connection URL. Put it in an environment variable and name it in `Credential env var`, so the catalog never stores it.',
    );
  }
  if (!sql.trim()) throw new Error('This connector has no query configured.');

  const dialect = url.startsWith('postgres') ? 'postgres' : 'mysql';
  const column = String(connector.config.watermarkColumn ?? '').trim();
  const bounded = mode === 'incremental' && column.length > 0;

  // The first incremental run has nothing to start after, so it reads
  // everything and records where that got to. There is no honest alternative:
  // a source cannot be asked what changed before anything has been read once.
  const previous = bounded ? readWatermark(state.watermark, column) : undefined;
  const statement =
    previous === undefined
      ? { text: sql, params: [] }
      : boundStatement(sql, column, previous, dialect);

  const rows =
    dialect === 'postgres'
      ? await queryPostgres(url, statement.text, statement.params)
      : await queryMysql(url, statement.text, statement.params);

  if (!bounded) return rows;

  const next = maxWatermark(rows, column, previous);
  return next === undefined ? { records: rows } : { records: rows, state: { watermark: next } };
};

/**
 * The incremental form of an author's query.
 *
 * The value is *bound*, never interpolated. It came out of a source database on
 * an earlier run, which makes it exactly the sort of value that turns a catalog
 * load into an injection the moment somebody pastes it into SQL. The column
 * name cannot be bound — no driver parameterises an identifier — so it is
 * checked against a plain-identifier pattern and quoted for the dialect, and a
 * name with a quote, a dot or a space in it is refused rather than escaped.
 *
 * Wrapping the author's query rather than asking them to place a `:watermark`
 * placeholder inside it, because a query written around a placeholder is not a
 * valid query on the *first* run, when there is no value to put there. The
 * author would have to write something correct both bounded and unbounded, in a
 * form that works on Postgres and MySQL alike, and getting that subtly wrong
 * returns fewer rows rather than an error — a silent under-read is the one
 * failure mode a watermark must not have. Wrapping leaves their SQL untouched
 * and puts the bound in one place this file controls.
 *
 * What wrapping costs, and it is worth knowing before configuring one: the
 * watermark column has to appear in the query's own output, and a query that
 * ends in its own LIMIT or aggregates its rows gets filtered *after* that step,
 * which changes what it returns. The first fails loudly with an unknown column.
 * The second cannot be detected without parsing the SQL, and guessing at a
 * parser is how this file would end up wrong about a dialect it never saw.
 */
function boundStatement(
  sql: string,
  column: string,
  previous: string | number,
  dialect: 'postgres' | 'mysql',
): { text: string; params: unknown[] } {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(column)) {
    throw new Error(
      `"${column}" is not a plain column name. The watermark column is quoted into the query as an identifier — no driver can bind one — so it must be the bare name as it appears in the query's output, without a table qualifier or an expression.`,
    );
  }
  const quoted = dialect === 'postgres' ? `"${column}"` : `\`${column}\``;
  // A trailing semicolon is legal on its own and a syntax error inside a
  // derived table, and it is the single most likely thing to be pasted in.
  const body = sql.trim().replace(/;+\s*$/, '');
  const marker = dialect === 'postgres' ? '$1' : '?';
  return {
    text: `SELECT * FROM (${body}) AS catalog_incremental WHERE ${quoted} > ${marker}`,
    params: [reviveWatermark(previous)],
  };
}

/**
 * As much of `pg`'s client as this file actually calls.
 *
 * The rows stay `unknown[]`: they are whatever the author's query selected out
 * of somebody else's database, which is the one thing here that genuinely has
 * no type at this boundary. Declaring the *methods* is not the same claim — a
 * driver without them fails at the call either way.
 */
interface PostgresClientLike {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows?: unknown[] }>;
  end(): Promise<void>;
}

/** The same, for `mysql2/promise`. `query`/`execute` resolve to `[rows, fields]`. */
interface MysqlConnectionLike {
  query(sql: string): Promise<[unknown, unknown]>;
  execute(sql: string, params: unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}

async function queryPostgres(url: string, sql: string, params: unknown[]): Promise<unknown[]> {
  const pg = await importOptional<{
    Client: new (c: { connectionString: string }) => PostgresClientLike;
  }>('pg', 'postgres');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const result = await client.query(sql, params);
    return result.rows ?? [];
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

async function queryMysql(url: string, sql: string, params: unknown[]): Promise<unknown[]> {
  const mysql = await importOptional<{
    createConnection: (url: string) => Promise<MysqlConnectionLike>;
  }>('mysql2/promise', 'mysql');
  const connection = await mysql.createConnection(url);
  try {
    await connection.query('START TRANSACTION READ ONLY');
    // `execute` when there is something to bind, because it prepares the
    // statement server-side and the value never touches the SQL text at all.
    // mysql2's `query` would interpolate it client-side by scanning for `?`
    // without knowing which of them sit inside string literals, so an author
    // whose query contains a literal question mark would have it take the bind
    // meant for the watermark. With nothing to bind there is nothing to
    // prepare, and an unbounded run keeps exactly the path it always had.
    const [rows] =
      params.length > 0 ? await connection.execute(sql, params) : await connection.query(sql);
    return Array.isArray(rows) ? rows : [];
  } finally {
    await connection.query('ROLLBACK').catch(() => undefined);
    await connection.end().catch(() => undefined);
  }
}

/** What the last run stored, or nothing if it never stored anything. */
function readWatermark(value: unknown, column: string): string | number | undefined {
  if (value === undefined || value === null) return undefined;
  return normaliseWatermark(value, column);
}

/**
 * The largest watermark value in a result set, or nothing if it did not move.
 *
 * Loud rather than silent when the column is missing from every row: a run that
 * cannot advance would read the same rows again on the next run, and again
 * after that, and the only symptom would be a load that keeps writing the same
 * numbers.
 */
function maxWatermark(
  rows: unknown[],
  column: string,
  previous: string | number | undefined,
): string | number | undefined {
  let best = previous;
  let seen = false;

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const value: unknown = Reflect.get(row, column);
    if (value === undefined || value === null) continue;
    seen = true;
    const candidate = normaliseWatermark(value, column);
    if (best === undefined || isAfter(candidate, best)) best = candidate;
  }

  if (rows.length > 0 && !seen) {
    throw new Error(
      `The query returned ${rows.length} rows and none of them carried "${column}", so there is nothing to advance the watermark to and the next run would read them all again. Select the watermark column in the query.`,
    );
  }
  return best === previous ? undefined : best;
}

/**
 * A watermark in the form that survives being written to the state column.
 *
 * State is stored as JSON, so a `Date` has to become a string before it goes in
 * and will never come back as a `Date`. ISO-8601 is the form chosen because it
 * is fixed-width and UTC, which makes a string comparison of two of them agree
 * with a comparison of the instants they name — `toString()` does not.
 */
function normaliseWatermark(value: unknown, column: string): string | number {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return value;
  throw new Error(
    `"${column}" came back as ${value === null ? 'null' : typeof value}, which cannot be stored or compared as a watermark. Use a timestamp or an increasing numeric column.`,
  );
}

/**
 * Turn a stored watermark back into something the driver will compare against
 * the column it came from.
 *
 * MySQL will not coerce an ISO-8601 string ending in `Z` into a DATETIME: it
 * warns and the comparison evaluates to NULL, which returns zero rows and looks
 * exactly like "nothing has changed". Both drivers serialise a `Date`
 * correctly, so a stored timestamp is revived into one.
 */
function reviveWatermark(value: string | number): string | number | Date {
  if (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    return new Date(value);
  }
  return value;
}

/**
 * Ordering in the value's own domain rather than on its string form.
 *
 * MySQL hands back BIGINT and DECIMAL as strings to avoid losing precision, and
 * `"9" > "10"` is true lexicographically — which would park the watermark on
 * the ninth row of an autoincrementing id and never move it again.
 */
function isAfter(candidate: string | number, current: string | number): boolean {
  if (typeof candidate === 'number' && typeof current === 'number') {
    return candidate > current;
  }
  const a = asInteger(candidate);
  const b = asInteger(current);
  if (a !== undefined && b !== undefined) return a > b;
  return String(candidate) > String(current);
}

function asInteger(value: string | number): bigint | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? BigInt(value) : undefined;
  }
  return /^-?\d+$/.test(value) ? BigInt(value) : undefined;
}

/**
 * Import a driver only when a connector needs it.
 *
 * The error names the package, because "Cannot find module 'pg'" in a catalog
 * log tells an operator nothing about which connector caused it.
 */
export async function importOptional<T>(specifier: string, label: string): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch {
    // The package, not the entry point: "mysql2/promise" is not installable and
    // neither is "@aws-sdk", so a scoped name keeps both of its segments.
    const parts = specifier.split('/');
    const pkg = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    throw new Error(
      `This deployment has no ${label} driver installed. Add "${pkg}" to the catalog service to use ${label} connectors.`,
    );
  }
}

export const SOURCES: Record<string, SourceFetcher> = {
  http: fetchHttp,
  file: fetchFile,
  s3: fetchS3,
  sql: fetchSql,
  inline: fetchInline,
};

/**
 * The only place a payload becomes records.
 *
 * Shared by the file and S3 fetchers on purpose: an object store connector that
 * parsed CSV even slightly differently from a file connector would mean the
 * same drop loads two different ways depending on where it was read from, and
 * the difference would show up as a column of nulls rather than as an error.
 */
function parseRecords(text: string, source: string, config: Record<string, unknown>): unknown[] {
  const format = String(config.format ?? guessFormat(source)).toLowerCase();

  if (format === 'ndjson') {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  if (format === 'csv') return parseCsv(text, config);
  return unwrap(JSON.parse(text), config.jsonPath);
}

/**
 * What this file needs from `@aws-sdk/client-s3`, and nothing else.
 *
 * Written out rather than imported, because the SDK is loaded at run time and a
 * top-level `import type` from a package a deployment may not have installed is
 * a compile error for everyone who does not use S3.
 */
interface S3Module {
  S3Client: new (
    config: Record<string, unknown>,
  ) => {
    send: (command: unknown) => Promise<unknown>;
    destroy?: () => void;
  };
  ListObjectsV2Command: new (input: Record<string, unknown>) => unknown;
  GetObjectCommand: new (input: Record<string, unknown>) => unknown;
}

type S3ClientLike = InstanceType<S3Module['S3Client']>;

interface S3Object {
  key: string;
  /** ISO-8601, so a string comparison agrees with a comparison of instants. */
  lastModified: string;
  size: number;
}

/**
 * `accessKeyId:secretAccessKey` out of the named env var, or nothing.
 *
 * Nothing is the good case in a deployed environment: the SDK's default chain
 * picks up the pod's role, and those credentials rotate. This split exists for
 * a MinIO running on a laptop.
 */
function parseS3Credentials(
  secret: string | undefined,
  envVar: string | undefined,
): { accessKeyId: string; secretAccessKey: string } | undefined {
  if (!secret) return undefined;
  const separator = secret.indexOf(':');
  if (separator <= 0 || separator === secret.length - 1) {
    throw new Error(
      `${envVar ?? 'The credential env var'} must hold "accessKeyId:secretAccessKey" for an S3 connector. Leave it unset to use the ambient AWS credentials, which is what a deployment with a pod role should do.`,
    );
  }
  return {
    accessKeyId: secret.slice(0, separator),
    secretAccessKey: secret.slice(separator + 1),
  };
}

/**
 * An S3 client configured from the connector, and nothing else.
 *
 * Every key is absent rather than present-and-empty. `region: undefined` and
 * `credentials: undefined` are not the same thing as an unset key to every SDK
 * release, and an empty endpoint is a URL parse error rather than "use the AWS
 * one" — which is why this is a pile of conditional spreads rather than an
 * object literal with some undefined values in it.
 */
function createS3Client(
  s3: S3Module,
  connector: CatalogConnector,
  secret: string | undefined,
): S3ClientLike {
  const region = String(connector.config.region ?? '').trim();
  const endpoint = String(connector.config.endpoint ?? '').trim();
  const credentials = parseS3Credentials(secret, connector.secretEnvVar);

  return new s3.S3Client({
    ...(region ? { region } : {}),
    ...(endpoint ? { endpoint } : {}),
    // MinIO addresses buckets as a path segment. The virtual-host style the SDK
    // prefers resolves to a `bucket.localhost` that does not exist.
    ...(connector.config.forcePathStyle === true ? { forcePathStyle: true } : {}),
    ...(credentials ? { credentials } : {}),
  });
}

/**
 * Every object under the prefix this run has not already read.
 *
 * Every run lists the whole prefix, because S3 has no "modified since" filter —
 * the only server-side narrowing it offers is `StartAfter`, which is
 * lexicographic on the key, and keys almost never sort in the order the objects
 * arrived. The listing is what the watermark costs; `prefix` is the lever that
 * keeps it cheap, so point a connector at a partition rather than at the root of
 * a bucket that has been collecting drops for years.
 *
 * Unordered: the caller sorts, because the order is what `maxObjectsPerRun` cuts
 * against and that belongs next to the slice.
 */
async function listUnreadObjects(input: {
  client: S3ClientLike;
  s3: S3Module;
  bucket: string;
  prefix: string;
  suffix: string;
  previousWatermark: string | undefined;
  previousKeys: Set<string>;
}): Promise<S3Object[]> {
  const { client, s3, bucket, prefix, suffix, previousWatermark, previousKeys } = input;
  const candidates: S3Object[] = [];
  let token: string | undefined;

  do {
    const page = readListing(
      await client.send(
        new s3.ListObjectsV2Command({
          Bucket: bucket,
          ...(prefix ? { Prefix: prefix } : {}),
          ...(token ? { ContinuationToken: token } : {}),
        }),
      ),
    );
    for (const object of page.objects) {
      if (isUnread(object, suffix, previousWatermark, previousKeys)) candidates.push(object);
    }
    token = page.nextToken;
  } while (token);

  return candidates;
}

/** Whether one listed object is in scope and was not already read by an earlier run. */
function isUnread(
  object: S3Object,
  suffix: string,
  previousWatermark: string | undefined,
  previousKeys: Set<string>,
): boolean {
  if (suffix && !object.key.endsWith(suffix)) return false;
  if (object.size === 0) return false;
  if (previousWatermark === undefined) return true;
  if (object.lastModified < previousWatermark) return false;
  // The tie set. Two objects can share a `LastModified` to the millisecond, so a
  // strict `>` would drop the second one forever and a `>=` would re-read the
  // first one every run. Only the keys sitting at exactly the watermark are
  // remembered, which is why that list cannot grow without bound the way "every
  // key ever seen" would.
  return !(object.lastModified === previousWatermark && previousKeys.has(object.key));
}

/** Oldest first, ties broken by key, so every run reads in the same order. */
function byOldestThenKey(a: S3Object, b: S3Object): number {
  if (a.lastModified === b.lastModified) return a.key.localeCompare(b.key);
  return a.lastModified < b.lastModified ? -1 : 1;
}

/** Read each object and parse it into rows, in the order given. */
async function readObjectRecords(input: {
  client: S3ClientLike;
  s3: S3Module;
  bucket: string;
  objects: readonly S3Object[];
  config: Record<string, unknown>;
}): Promise<unknown[]> {
  const { client, s3, bucket, objects, config } = input;
  const records: unknown[] = [];

  for (const object of objects) {
    const text = await readObjectText(
      await client.send(new s3.GetObjectCommand({ Bucket: bucket, Key: object.key })),
      `s3://${bucket}/${object.key}`,
    );
    if (!text.trim()) continue;
    // The same format logic a file connector uses, per object: the extension
    // decides unless the connector overrides it, which is what a prefix full of
    // `part-00000` files needs.
    //
    // Appended one at a time rather than spread into `push`, because a spread
    // becomes one argument per row and a CSV drop with a few hundred thousand of
    // them overflows the call stack — a failure that only shows up on the large
    // files this connector exists to read.
    for (const record of parseRecords(text, object.key, config)) {
      records.push(record);
    }
  }

  return records;
}

/** Where this run got to, carrying the tie set forward when it did not advance. */
function nextObjectState(
  consumed: readonly S3Object[],
  previousWatermark: string | undefined,
  previousKeys: Set<string>,
): { objectWatermark: string; objectWatermarkKeys: string[] } {
  const watermark = consumed[consumed.length - 1].lastModified;
  const keys = new Set(
    consumed.filter((object) => object.lastModified === watermark).map((object) => object.key),
  );
  if (watermark === previousWatermark) {
    for (const key of previousKeys) keys.add(key);
  }
  return { objectWatermark: watermark, objectWatermarkKeys: [...keys] };
}

/**
 * One page of a listing, narrowed rather than trusted.
 *
 * An entry with no `LastModified` is refused instead of skipped: it cannot be
 * placed against the watermark, and quietly dropping it would mean an object
 * nobody ever reads and nobody ever notices missing.
 */
function readListing(value: unknown): {
  objects: S3Object[];
  nextToken?: string;
} {
  if (!value || typeof value !== 'object') {
    throw new Error('The S3 listing came back as something other than a response.');
  }
  const contents: unknown = Reflect.get(value, 'Contents');
  const token: unknown = Reflect.get(value, 'NextContinuationToken');
  const objects: S3Object[] = [];

  if (Array.isArray(contents)) {
    for (const entry of contents) {
      const object = readListingEntry(entry);
      if (object) objects.push(object);
    }
  }

  return {
    objects,
    nextToken: typeof token === 'string' && token.length > 0 ? token : undefined,
  };
}

/**
 * One entry of a listing, or nothing if it does not describe an object.
 *
 * Nothing means "not an object": a malformed entry, or a key ending in a slash,
 * which is the console's idea of a folder with no object behind it. An entry
 * that *is* an object but cannot be placed against the watermark throws instead
 * — see {@link readListing}.
 */
function readListingEntry(entry: unknown): S3Object | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const key: unknown = Reflect.get(entry, 'Key');
  const modified: unknown = Reflect.get(entry, 'LastModified');
  const size: unknown = Reflect.get(entry, 'Size');
  if (typeof key !== 'string') return undefined;
  if (key.endsWith('/')) return undefined;
  if (!(modified instanceof Date)) {
    throw new Error(
      `The listing entry for "${key}" has no LastModified, so this run cannot tell whether it is new. Refusing rather than skipping it, because a skipped object is one nobody notices is missing.`,
    );
  }
  return {
    key,
    lastModified: modified.toISOString(),
    // Absent size means "read it and find out" rather than "it is empty".
    size: typeof size === 'number' ? size : 1,
  };
}

/** The body of a `GetObject`, as text. */
async function readObjectText(value: unknown, label: string): Promise<string> {
  const body: unknown = value && typeof value === 'object' ? Reflect.get(value, 'Body') : undefined;
  const toText: unknown =
    body && typeof body === 'object' ? Reflect.get(body, 'transformToString') : undefined;
  if (typeof toText !== 'function') {
    throw new Error(
      `${label} came back without a readable body. This fetcher reads whole text objects; a stream the SDK cannot collect is not one.`,
    );
  }
  const text: unknown = await toText.call(body, 'utf8');
  return typeof text === 'string' ? text : String(text);
}

function positiveInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Follow a dotted path into a response envelope. */
function unwrap(payload: unknown, path: unknown): unknown[] {
  const target =
    typeof path === 'string' && path.length > 0
      ? path.split('.').reduce<unknown>((value, key) => {
          if (value && typeof value === 'object') return Reflect.get(value, key);
          return undefined;
        }, payload)
      : payload;

  if (!Array.isArray(target)) {
    throw new Error(
      `Expected an array${typeof path === 'string' && path ? ` at "${path}"` : ''}, got ${typeof target}.`,
    );
  }
  return target;
}

function guessFormat(source: string): string {
  const withoutQuery = source.split('?')[0].toLowerCase();
  if (withoutQuery.endsWith('.csv')) return 'csv';
  if (withoutQuery.endsWith('.ndjson') || withoutQuery.endsWith('.jsonl')) {
    return 'ndjson';
  }
  return 'json';
}

/**
 * A CSV reader that handles quotes and embedded newlines.
 *
 * Not a split on commas. Real exports contain `"Smith, John"` and multi-line
 * address fields, and a naive split turns both into silently wrong rows —
 * which is worse than failing, because nobody notices.
 */
function parseCsv(text: string, config: Record<string, unknown>): unknown[] {
  const rows = splitCsvRows(text, String(config.delimiter ?? ','));

  const [header, ...body] = rows.filter((r) => r.some((c) => c.length > 0));
  if (!header) return [];

  return body.map((cells) =>
    Object.fromEntries(header.map((name, index) => [name, cells[index] ?? null])),
  );
}

/**
 * The scanner half of {@link parseCsv}: text in, rows of raw cells out.
 *
 * Split from the record shaping because it is the part that carries state
 * across characters, and it reads far better without the header logic sitting
 * under it. It knows nothing about headers and makes no judgement about which
 * rows are worth keeping.
 */
function splitCsvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char === '"') {
      // Appended rather than assigned, because a quoted run is part of the
      // field and not necessarily the whole of it: `ab"c,d"ef` is one field.
      const quoted = readQuotedField(text, index + 1);
      field += quoted.value;
      index = quoted.end;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }

  return rows;
}

/**
 * The contents of a quoted run, starting just past the opening quote.
 *
 * Returns where the closing quote sat, so the scanner resumes after it. Inside
 * the quotes a delimiter and a newline are ordinary characters — which is the
 * whole reason this reader exists rather than a split on commas — and a doubled
 * quote is the CSV escape for one literal quote.
 *
 * An unterminated quote yields the rest of the text rather than throwing, which
 * is what the previous inline scanner did: a truncated export is far more
 * common than a deliberately malformed one, and the row count is what makes it
 * noticed.
 */
function readQuotedField(text: string, start: number): { value: string; end: number } {
  let value = '';
  let index = start;

  while (index < text.length) {
    const char = text[index];
    if (char !== '"') {
      value += char;
      index += 1;
    } else if (text[index + 1] === '"') {
      value += '"';
      index += 2;
    } else {
      return { value, end: index };
    }
  }

  return { value, end: index };
}
