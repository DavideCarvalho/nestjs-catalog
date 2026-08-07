import { readFile } from 'node:fs/promises';
import {
  type CatalogConnection,
  type CatalogConnector,
  SOURCE_FORMATS,
  type SourceFormat,
  isSourceFormat,
  unreachableSourceFormat,
} from '@dudousxd/nestjs-catalog';
import { Logger } from '@nestjs/common';
import { importOptional } from './optional-modules';
import {
  type BlankRowLedger,
  blankRowLedger,
  csvRecords,
  decodeChunks,
  ndjsonRecords,
} from './record-streams';
import { parquetRecords } from './source-parquet';
import {
  type LocalPayload,
  type PayloadLimits,
  localPayload,
  payloadChunks,
  spool,
} from './source-payloads';
import { admitsSecretEnv, credentialUnavailable, secretEnvAllowlist } from './secret-env-allowlist';

export { importOptional };

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
 *
 * That last sentence is true and used to be the end of the argument, which was
 * the mistake: the name is stored, but it is *chosen by the caller*, and a name
 * the caller chooses is a read of the pod's environment with a connector wrapped
 * around it. Which names may be chosen is now
 * {@link secretEnvAllowlist}'s answer — see `secret-env-allowlist.ts`, which
 * spells out the whole path from `POST pipeline/connectors` to somebody reading
 * `DATABASE_URL` back out of a catalog type.
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
  /**
   * What the fetcher had to say about rows the caller will never see.
   *
   * The ledger for anything a source discarded on its own account, before the
   * records reached anybody who counts them. Today that is
   * {@link blankRowNote} — the blank lines a CSV parser skips — and the reason
   * it is a field on the result rather than a `Logger` call is that a number
   * about *this load* belongs on *this run*, next to the count it does not
   * agree with, and not in a pod log an operator has to go and find.
   *
   * Absent when there is nothing to say, which is the overwhelmingly common
   * case: a well-formed file produces no notes at all.
   */
  notes?: string[];
}

/**
 * The same fetch, from a source that can hand rows over as they arrive.
 *
 * The third shape rather than a widening of {@link FetchResult}, because the two
 * differ in more than the container. An array is complete the moment it is
 * returned, so its `state` is a value. A stream is not complete until it has been
 * drained, so a watermark computed from it is *not yet known* when the fetcher
 * returns — which is why `state` here is a function the consumer calls **after**
 * exhausting `records`, and why calling it earlier would hand back a watermark
 * that stops short of the rows already written.
 *
 * Returning this instead of an array is what makes a read bounded: the fetcher
 * yields, the runner writes a batch, and the source is not asked for more until
 * that write has finished. Nothing in the pipeline holds the whole result. A
 * fetcher that cannot do that returns an array and loses nothing it had — see
 * {@link SourceFetcher}.
 */
export interface StreamedFetchResult {
  records: AsyncIterable<unknown>;
  /**
   * Where the read got to, asked **only after `records` is exhausted**.
   *
   * May throw, and {@link fetchSql}'s does: a bounded read whose rows never
   * carried the watermark column has nothing to advance to, and saying so is
   * the whole point of the check. By then some batches have been written —
   * they are left in an uncommitted snapshot, which is what the runner's
   * failure path does with every other error.
   */
  state?: () => Record<string, unknown> | undefined;
  /**
   * {@link FetchResult.notes}, asked **only after `records` is exhausted**.
   *
   * A function rather than the array {@link FetchResult} carries, for the same
   * reason `state` is one: the ledger a streamed read keeps is a running count,
   * and a note asked for before the last row would report a number smaller than
   * the truth. A file connector's whole-read path knows its blank-line count
   * the moment the parse returns; a streamed one does not know it until the
   * bytes run out.
   *
   * This is not optional decoration. The count exists because a `.filter` with
   * no counter silently removed 568 rows from a real drop, and a streamed CSV
   * read that dropped the ledger would put that defect straight back — for the
   * two fetchers it most affects.
   */
  notes?: () => string[];
}

/**
 * Pulling raw records out of one source.
 *
 * Three return shapes, and the first two are the original ones untouched: a bare
 * array, or {@link FetchResult} when there is state to remember. Every fetcher
 * here except the SQL one still returns an array, because an HTTP response, a
 * parsed CSV and a listed S3 prefix are each already whole in memory by the time
 * there is anything to hand over — streaming them would be a shape with no
 * saving behind it.
 *
 * {@link StreamedFetchResult} is for the sources that genuinely can be read a
 * row at a time. Adding it as a third shape rather than converting everything is
 * deliberate: a widening that made every fetcher async-iterable would have
 * rewritten four working sources to buy nothing, and each rewrite is a chance to
 * change what one of them returns.
 */
export type SourceFetcher = (
  context: FetchContext,
) => Promise<unknown[] | FetchResult | StreamedFetchResult>;

/** Normalise the two array shapes a fetcher may return. */
export function toFetchResult(value: unknown[] | FetchResult): FetchResult {
  return Array.isArray(value) ? { records: value } : value;
}

/**
 * Whether a fetcher handed back a stream rather than a finished array.
 *
 * On `records`, because that is the only field the two shapes share and it is
 * the one that actually differs. A predicate rather than a `kind` discriminant
 * so that a fetcher writes `{ records, state }` in both cases and nothing has to
 * be kept in step by hand.
 */
function isStreamedFetch(value: FetchResult | StreamedFetchResult): value is StreamedFetchResult {
  return !Array.isArray(value.records);
}

/**
 * Every fetch shape seen as the one a consumer can iterate.
 *
 * The array shapes are wrapped rather than copied — {@link fromArray} yields out
 * of the caller's own array — so a source that was already complete pays a
 * generator and not a second copy of its data.
 *
 * `streamed` is reported rather than left to be inferred from the connector
 * kind, because the connector runner has one thing to say that depends on it: a
 * connector with a transform buffers its read, and "this read could have been
 * bounded and was not" belongs on the run rather than being something an
 * operator deduces from the fact that the connector has a transform attached.
 * On the array shapes it is false, which is the truth — those sources had
 * nothing to stream.
 */
export interface RecordStream {
  records: AsyncIterable<unknown>;
  /** Where the read got to. Call only after `records` is exhausted. */
  state(): Record<string, unknown> | undefined;
  /** Whether the source was handing rows over incrementally. */
  streamed: boolean;
  /**
   * {@link FetchResult.notes}. Call only after `records` is exhausted.
   *
   * A function, and it did not used to be. When the array shapes were the only
   * ones that could produce a note, "known the moment the fetcher returns" was
   * true and the field was an array. It stopped being true when the file and
   * S3 fetchers began to stream: their blank-line ledger is a running count
   * over rows that have not been read yet, exactly as a watermark is, so it has
   * exactly the same timing as `state` and is asked at the same moment. On the
   * array shapes it answers immediately and always the same thing, which is
   * what a function over a settled value does.
   */
  notes(): string[];
}

export function toRecordStream(value: unknown[] | FetchResult | StreamedFetchResult): RecordStream {
  if (Array.isArray(value)) {
    return { records: fromArray(value), state: () => undefined, streamed: false, notes: () => [] };
  }
  if (isStreamedFetch(value)) {
    const settle = value.state;
    const settleNotes = value.notes;
    return {
      records: value.records,
      state: () => settle?.(),
      streamed: true,
      notes: () => settleNotes?.() ?? [],
    };
  }
  const state = value.state;
  const notes = value.notes ?? [];
  return {
    records: fromArray(value.records),
    state: () => state,
    streamed: false,
    notes: () => notes,
  };
}

/**
 * A fetch as a finished array, whatever shape it arrived in.
 *
 * For the two consumers that cannot work incrementally and are honest about it:
 * a workflow source node stages its whole output before the next node reads it,
 * and a schema discovery infers from a sample. Both held the whole thing before
 * this existed and still do; what this adds is that they keep working when a
 * fetcher streams.
 *
 * `limit` stops pulling rather than slicing afterwards, which is the difference
 * between a discovery reading twenty rows out of a million-row table and reading
 * the table. A truncated stream comes back **without state**, deliberately: the
 * watermark of a read that stopped early would name a row the caller never saw,
 * and storing it would skip everything after it forever. The array shapes keep
 * their state, because slicing an array the fetcher already read whole loses
 * nothing it knew.
 */
export async function toBufferedFetchResult(
  value: unknown[] | FetchResult | StreamedFetchResult,
  limit?: number,
): Promise<FetchResult> {
  if (Array.isArray(value)) {
    return { records: limit === undefined ? value : value.slice(0, limit) };
  }
  if (!isStreamedFetch(value)) {
    const records = limit === undefined ? value.records : value.records.slice(0, limit);
    // Notes survive the slice. They describe the *parse*, not the rows that came
    // out of it, so "568 blank lines were skipped" is as true of a twenty-row
    // discovery sample as it is of the whole read — and it is the discovery that
    // most wants to hear it, because that is where somebody is still deciding
    // what the file is.
    return {
      records,
      ...(value.state === undefined ? {} : { state: value.state }),
      ...(value.notes === undefined ? {} : { notes: value.notes }),
    };
  }

  const records: unknown[] = [];
  for await (const record of value.records) {
    // Neither state nor notes on a truncated read. The watermark reason is
    // above; the notes reason is the mirror of the one a sliced *array* keeps
    // them for — a discovery that stopped after twenty rows has not seen the
    // rest of the file, so "0 blank lines" would be a claim about a file it
    // never finished reading rather than a fact about the parse.
    if (limit !== undefined && records.length >= limit) return { records };
    records.push(record);
  }
  const state = value.state?.();
  const notes = value.notes?.() ?? [];
  return {
    records,
    ...(state === undefined ? {} : { state }),
    ...(notes.length === 0 ? {} : { notes }),
  };
}

/** An array, seen as the stream shape. Yields out of it rather than copying it. */
async function* fromArray(values: readonly unknown[]): AsyncGenerator<unknown> {
  for (const value of values) yield value;
}

export function resolveSecret(connector: CatalogConnector): string | undefined {
  return resolveSecretEnv(connector.secretEnvVar);
}

/**
 * Named for the question rather than for this file, because the reader of the
 * line is looking for the allow-list they have to configure and cannot grep for
 * `sources.ts` in their own deployment manifest.
 */
const secretLogger = new Logger('CatalogSecretEnv');

/**
 * Read a credential by the name of its variable — if this deployment admits
 * that name.
 *
 * Two things happen here that used to happen nowhere.
 *
 * **The allow-list is consulted before `process.env` is touched at all.** Not as
 * tidiness: it is what makes the refusal say nothing. A name that is not
 * admitted is refused by a function that never looked the variable up, so there
 * is no fact about the environment for the message to leak even by accident, and
 * no later edit can reintroduce one without moving this line.
 *
 * **The caller is told one sentence and the log is told which.** The message
 * this replaced named the variable and said it was "not set in this
 * environment", which turned every route that reaches here into an oracle for
 * the pod's environment, one variable at a time — and it did so on
 * `POST connectors/:id/discover`, which writes nothing and therefore leaves
 * nothing behind. {@link credentialUnavailable} is deliberately the same
 * sentence for both refusals; the warning below is the part that says which, to
 * the only audience entitled to know.
 *
 * Empty is still not-set, unchanged: a variable exported as `""` cannot
 * authenticate to anything, and the fetcher would otherwise go on to
 * authenticate as nobody and fail against the source instead.
 */
export function resolveSecretEnv(name?: string): string | undefined {
  if (!name) return undefined;

  const admitted = admitsSecretEnv(name, secretEnvAllowlist());
  const value = admitted ? process.env[name] : undefined;
  if (value) return value;

  secretLogger.warn(
    admitted
      ? `A connector asked for the credential in "${name}", which the allow-list admits and which is not set in this environment. The caller was told only that no credential is available.`
      : `A connector asked for the credential in "${name}", which this deployment's credential allow-list does not admit, so the variable was not read. If that name is a source this catalog is meant to authenticate to, add it to CatalogPipelineModule.forRoot({ secretEnvAllowlist }) or to CATALOG_SECRET_ENV_ALLOW. If it is not, somebody with catalog:write has just tried to read an environment variable through a connector, and the connector will say who.`,
  );
  throw new Error(credentialUnavailable(name));
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

/**
 * A JSON endpoint, optionally with the array nested inside an envelope.
 *
 * **Read whole, and deliberately left that way.** The question was asked
 * alongside making the file-backed fetchers stream, and the answer is that
 * there is nothing here to stream *to*. A JSON document is a single value with
 * no row boundary in it: an incremental parser would still have to read down to
 * wherever `path` points before it could yield anything, and for the common
 * case — a bare top-level array — the elements it would then yield are the
 * whole response anyway. What it would buy is not holding the parsed document
 * *and* the array at once, which is a constant factor rather than a ceiling.
 *
 * The honest bound for an HTTP source is pagination, and this connector does
 * not paginate. Streaming the body would move where the memory is held without
 * changing how much of it there is, and would cost an incremental JSON parser
 * that this repository has no way to exercise against real envelopes. A `file`
 * or `s3` connector in `json` format is left whole for the same reason — see
 * {@link FORMAT_READING}.
 */
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
 *
 * **Read as a stream unless the format has no row boundary.** This used to pull
 * the whole file into memory before it parsed a byte of it, which put a ceiling
 * on what a connector could read that had nothing to do with the source: a
 * 7.6 MB export is a 7.6 MB buffer plus a 7.6 MB string plus every record built
 * out of it, all held at once, inside a durable step. Now the bytes arrive in
 * chunks and the records go out as they are found, so what is held is a batch.
 * {@link StreamedFetchResult} explains why that is a different return shape
 * rather than a widening, and {@link FORMAT_READING} says which formats can do
 * it.
 *
 * Still no state either way. A file has no watermark to advance: nothing in a
 * path says which rows a previous run got to, and pretending otherwise is how a
 * re-read of an edited file quietly skips its first half.
 */
export const fetchFile: SourceFetcher = async ({ connector }) => {
  const source = String(connector.config.path ?? connector.config.url ?? '');
  if (!source) throw new Error('This connector has no path or url configured.');

  const format = resolveFormat(source, connector.config);
  if (FORMAT_READING[format] === 'stream') {
    const ledger = blankRowLedger();
    return {
      records: streamPayload(source, format, connector.config, ledger),
      notes: () => blankRowNotes(ledger, `"${source}"`),
    };
  }

  // Bytes, not text, and the encoding argument is gone from both branches on
  // purpose. `readFile(source, 'utf8')` and `Response.text()` both decode as
  // UTF-8 and replace every byte that is not valid UTF-8 with U+FFFD — which is
  // most of a `.xlsx`, because a `.xlsx` is a ZIP archive. Decoding here would
  // corrupt the payload *before* anything had decided what format it was, so the
  // decode moved to {@link parseRecords}, which knows.
  const bytes = /^https?:\/\//.test(source)
    ? await (async () => {
        const response = await fetch(source);
        if (!response.ok) throw new Error(`GET ${source} → ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      })()
    : // A `Buffer` already is a `Uint8Array`; wrapping it would copy the file a
      // second time for no gain.
      await readFile(source);

  const parsed = await parseRecords(bytes, source, connector.config);
  return {
    records: parsed.records,
    ...(parsed.blankRows > 0 ? { notes: [blankRowNote(parsed.blankRows, `"${source}"`)] } : {}),
  };
};

/**
 * One payload's records, with the payload released when they run out.
 *
 * The `finally` runs on an early `break` as well as on exhaustion, because a
 * `for await` that stops calls the generator's `return`. That is what keeps a
 * discovery reading twenty rows from leaving a spooled copy of a 27 MB export
 * on the worker's disk — see {@link toBufferedFetchResult}, which stops early
 * by design.
 */
async function* streamPayload(
  source: string,
  format: SourceFormat,
  config: Record<string, unknown>,
  ledger: BlankRowLedger,
): AsyncGenerator<unknown> {
  const payload = await localPayload(source, payloadLimits(config));
  try {
    yield* streamedRecords(payload, format, source, config, ledger);
  } finally {
    await payload.release();
  }
}

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
 *
 * **The read is a stream, and the watermark is what the stream got through.**
 * This used to concatenate every object's records into one array before it
 * returned, so a prefix of ten 40 MB drops was 400 MB of records in the heap
 * before a single row was written. Now the objects are read in order and the
 * rows go out as they are found, which is why the state is a *function*: the
 * list of objects this run consumed is not final until the last one has been
 * read, and the runner asks only after that. See {@link StreamedFetchResult}.
 *
 * The consequence worth stating is the one about failure. `completed` is
 * appended to only after an object's last record has been yielded, so a run
 * that dies on the fourth of ten objects never reaches `state()` at all and
 * advances nothing — the three objects it did read are left in an uncommitted
 * snapshot and read again next time, which is the same at-least-once behaviour
 * every other mid-run failure has here. A watermark computed from the *listing*
 * instead would have promised never to read objects four through ten again, and
 * they would be gone.
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

  let consumed: S3Object[];
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
    consumed = limit === undefined ? candidates : candidates.slice(0, limit);
  } catch (error) {
    // The listing is the only part that still runs before the fetcher returns,
    // so it is the only part whose failure can be caught here. Everything after
    // it is the generator's, including tearing the client down.
    client.destroy?.();
    throw error;
  }

  // Nothing new. Returning no state leaves the previous watermark exactly
  // where it was, which is what "nothing happened" should mean.
  if (consumed.length === 0) {
    client.destroy?.();
    return [];
  }

  // Filled by the generator as each object finishes, and read by `state` after
  // it. The two halves share this rather than the state being computed from
  // `consumed`, which is the list of objects this run *intended* to read.
  const completed: S3Object[] = [];
  const ledger = blankRowLedger();

  return {
    records: readObjectRecords({
      client,
      s3,
      bucket,
      objects: consumed,
      config: connector.config,
      completed,
      ledger,
    }),
    // State is returned even on a full run. It is a fact about what this run
    // read, true whichever mode asked for it, and recording it means switching
    // a connector to incremental afterwards continues from here instead of
    // loading the whole prefix a second time.
    state: () =>
      completed.length === 0
        ? undefined
        : nextObjectState(completed, previousWatermark, previousKeys),
    notes: () => blankRowNotes(ledger, `s3://${bucket}/${prefix}`),
  };
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
 *
 * **MySQL is read as a stream and Postgres is not, and the asymmetry is the
 * driver's rather than a preference.** This used to `await` the whole result set
 * on both, which meant the driver materialised every row before anything
 * downstream ran: the write side has been bounded since it was written
 * (`appendBatches`, 500 rows at a time) and the read side was the half nobody
 * had bounded. A 981,469-row table never got past it — the step's lease expired
 * while the rows were still arriving, with nothing recorded anywhere because
 * nothing had failed.
 *
 * mysql2 can hand rows over one at a time: its `Query` and `Execute` commands
 * both expose `.stream()`, which pauses the socket when the reader stops
 * pulling, so back-pressure reaches all the way to the wire. That is what
 * {@link streamMysql} uses, and it is why a MySQL connector now holds a batch
 * rather than a table.
 *
 * **`pg` cannot, and there is nothing here that can make it.** A plain
 * `client.query` is a single protocol round trip that buffers the whole result
 * set inside the driver before it resolves; row-at-a-time reading in Postgres
 * means an explicit portal, which lives in a separate package (`pg-cursor`, or
 * `pg-query-stream` on top of it) that this deployment does not require and this
 * repository has no way to exercise. Shipping an untested optional-driver path
 * under a docblock claiming it streams would be worse than the honest statement:
 * **a Postgres connector still materialises its result set**, and a large one
 * should be narrowed with a `watermarkColumn` or a `LIMIT` in the query until
 * that dependency is taken on deliberately.
 */
export const fetchSql: SourceFetcher = async ({ connector, secret, state, mode }) => {
  const { url, sql, dialect } = sqlTarget(connector, secret);
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

  if (dialect === 'postgres') {
    const rows = await queryPostgres(url, statement.text, statement.params);
    if (!bounded) return rows;
    const next = maxWatermark(rows, column, previous);
    return next === undefined ? { records: rows } : { records: rows, state: { watermark: next } };
  }

  const rows = streamMysql(url, statement.text, statement.params);
  if (!bounded) return { records: rows };

  // A running maximum rather than a pass over the finished array, which is the
  // only form a watermark can take when there is no finished array. Same
  // comparison, same refusal, same stored value — see {@link trackWatermark}.
  const watermark = trackWatermark(column, previous);
  return {
    records: observing(rows, watermark),
    state: () => {
      const next = watermark.settle();
      return next === undefined ? undefined : { watermark: next };
    },
  };
};

/** Every row, unchanged, with the watermark tracker shown each one on the way past. */
async function* observing(
  rows: AsyncIterable<unknown>,
  watermark: WatermarkTracker,
): AsyncGenerator<unknown> {
  for await (const row of rows) {
    watermark.observe(row);
    yield row;
  }
}

/**
 * Where a SQL connector reads from, and in whose dialect.
 *
 * One place rather than one per caller: the fetcher and the schema description
 * have to agree about which database they are talking to and which query, or a
 * discovery would describe a source the load never reads. The refusals are the
 * fetcher's original ones, kept verbatim — they are what an author sees when the
 * connector is half-configured.
 */
function sqlTarget(
  connector: CatalogConnector,
  secret: string | undefined,
): { url: string; sql: string; dialect: SqlDialect } {
  const url = secret ?? String(connector.config.url ?? '');
  const sql = String(connector.config.query ?? '');
  if (!url) {
    throw new Error(
      'This connector has no connection URL. Put it in an environment variable and name it in `Credential env var`, so the catalog never stores it.',
    );
  }
  if (!sql.trim()) throw new Error('This connector has no query configured.');

  return { url, sql, dialect: url.startsWith('postgres') ? 'postgres' : 'mysql' };
}

export type SqlDialect = 'postgres' | 'mysql';

/**
 * One column of a result set, as the driver described it.
 *
 * Everything here is optional except the name, and that is the shape of the
 * truth rather than defensiveness: Postgres reports a type oid and says nothing
 * about nullability, MySQL reports a type id, a display width, a character set
 * and a NOT NULL flag, and the two are not going to be made to agree by
 * pretending. Absent means the driver did not say. Mapping these onto catalog
 * types is `schema-discovery.ts`'s job, so a driver quirk is decoded in exactly
 * one place.
 */
export interface SqlFieldDescription {
  name: string;
  /** Postgres: the type oid. MySQL: the protocol's column type id. */
  typeId?: number;
  /** MySQL only: the declared display width, which is what separates `TINYINT(1)`. */
  length?: number;
  /** MySQL only, from the NOT_NULL flag. Undefined where the driver did not say. */
  nullable?: boolean;
  /** MySQL only: the character set number. 63 is `binary`, which is what tells a BLOB from a TEXT. */
  charset?: number;
}

export interface SqlDescription {
  dialect: SqlDialect;
  fields: SqlFieldDescription[];
}

/**
 * What the connector's query would return, without returning any of it.
 *
 * `LIMIT 0` is the whole trick: both drivers describe the result set before the
 * first row, so the statement is planned, described and never materialised — a
 * query over a billion-row table costs the same as one over an empty one. The
 * alternative is reading a row and guessing from the values in it, which is what
 * the non-SQL kinds are stuck with and is strictly worse: it cannot see a column
 * that is null in that row, and it cannot tell a `VARCHAR` holding "12" from an
 * `INT`.
 *
 * Read-only by construction, exactly as {@link fetchSql} is, and for the same
 * reason: the transaction refuses a write whatever the author's query turns out
 * to parse as. Discovery is a read of somebody else's database, and a route a
 * console can press must not be able to become anything else.
 */
export async function describeSql(
  context: Pick<FetchContext, 'connector' | 'secret'>,
): Promise<SqlDescription> {
  const { url, sql, dialect } = sqlTarget(context.connector, context.secret);
  const statement = zeroRowStatement(sql);
  return {
    dialect,
    fields:
      dialect === 'postgres'
        ? await describePostgres(url, statement)
        : await describeMysql(url, statement),
  };
}

/**
 * The author's query, wrapped so it returns its own columns and no rows.
 *
 * Wrapped rather than appended, for the reason {@link boundStatement} spells
 * out at length: the author's SQL is left exactly as written, and a query that
 * already ends in its own `LIMIT`, or in a `UNION`, still means what it meant.
 * The trailing semicolon goes for the same reason it does there — legal on its
 * own, a syntax error inside a derived table, and the single most likely thing
 * to have been pasted in.
 */
export function zeroRowStatement(sql: string): string {
  const body = sql.trim().replace(/;+\s*$/, '');
  return `SELECT * FROM (${body}) AS catalog_discovery LIMIT 0`;
}

async function describePostgres(url: string, sql: string): Promise<SqlFieldDescription[]> {
  const pg = await importOptional<{
    Client: new (c: { connectionString: string }) => PostgresClientLike;
  }>('pg', 'postgres');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    return readPostgresFields(await client.query(sql, []));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

async function describeMysql(url: string, sql: string): Promise<SqlFieldDescription[]> {
  const mysql = await importOptional<{
    createConnection: (url: string) => Promise<MysqlConnectionLike>;
  }>('mysql2/promise', 'mysql');
  const connection = await mysql.createConnection(url);
  try {
    await connection.query('START TRANSACTION READ ONLY');
    // `query`, not `execute`: there is nothing to bind, and a prepared statement
    // would be one more thing the server has to hold for a call whose entire
    // purpose is to be cheap.
    const [, fields] = await connection.query(sql);
    return readMysqlFields(fields);
  } finally {
    await connection.query('ROLLBACK').catch(() => undefined);
    await connection.end().catch(() => undefined);
  }
}

/**
 * `pg`'s `result.fields`, narrowed rather than trusted.
 *
 * Each entry carries `name` and `dataTypeID`, and that is all Postgres sends
 * over the wire in a `RowDescription` that a plain query can produce. There is
 * no nullability in it — the flag lives on `pg_attribute`, which would be a
 * second query against the source's system catalogue — so every field here
 * leaves `nullable` unset, and the discovery says so rather than defaulting to
 * something that reads as an answer.
 */
export function readPostgresFields(result: unknown): SqlFieldDescription[] {
  if (!result || typeof result !== 'object') return [];
  const fields: unknown = Reflect.get(result, 'fields');
  if (!Array.isArray(fields)) return [];

  const described: SqlFieldDescription[] = [];
  for (const field of fields) {
    if (!field || typeof field !== 'object') continue;
    const name: unknown = Reflect.get(field, 'name');
    if (typeof name !== 'string') continue;
    const oid = numberAt(field, 'dataTypeID');
    described.push({ name, ...(oid === undefined ? {} : { typeId: oid }) });
  }
  return described;
}

/** MySQL's NOT_NULL flag, bit 0 of the field's flags. */
const MYSQL_NOT_NULL_FLAG = 1;

/**
 * `mysql2`'s field packets, narrowed rather than trusted.
 *
 * Three keys are read under two names each, and none of that is paranoia. The
 * column type is `columnType` in mysql2 v3 and `type` in v1 and v2, and this
 * package declares mysql2 as an optional peer — so both spellings are in
 * deployments right now. The character set is `characterSet` or `charsetNr` for
 * the same reason, and it is not optional information: it is the only thing that
 * distinguishes a `TEXT` column from a binary blob, since both arrive as blob
 * type ids.
 */
export function readMysqlFields(fields: unknown): SqlFieldDescription[] {
  if (!Array.isArray(fields)) return [];

  const described: SqlFieldDescription[] = [];
  for (const field of fields) {
    const one = readMysqlField(field);
    if (one) described.push(one);
  }
  return described;
}

/** One field packet, or nothing if it does not describe a column. */
function readMysqlField(field: unknown): SqlFieldDescription | undefined {
  if (!field || typeof field !== 'object') return undefined;
  const name: unknown = Reflect.get(field, 'name');
  if (typeof name !== 'string') return undefined;

  const typeId = numberAt(field, 'columnType') ?? numberAt(field, 'type');
  const length = numberAt(field, 'columnLength');
  const charset = numberAt(field, 'characterSet') ?? numberAt(field, 'charsetNr');
  const flags = numberAt(field, 'flags');

  return {
    name,
    ...(typeId === undefined ? {} : { typeId }),
    ...(length === undefined ? {} : { length }),
    ...(charset === undefined ? {} : { charset }),
    // Absent flags mean the driver did not say, which is not the same as
    // nullable: a column reported as nullable when it is not is a schema a
    // person approves without noticing the claim was invented.
    ...(flags === undefined ? {} : { nullable: (flags & MYSQL_NOT_NULL_FLAG) === 0 }),
  };
}

function numberAt(source: object, key: string): number | undefined {
  const value: unknown = Reflect.get(source, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

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

/**
 * The same, for `mysql2/promise`. `query`/`execute` resolve to `[rows, fields]`.
 *
 * `connection` is the *core* connection the promise wrapper holds — the one
 * whose `query`/`execute` return the command object rather than a promise, which
 * is the only place a row stream can be got from. Typed as `unknown` because
 * reaching through a driver's internals is exactly the claim that should be
 * checked at run time rather than declared; {@link isRowStreamer} is the check.
 */
interface MysqlConnectionLike {
  query(sql: string): Promise<[unknown, unknown]>;
  execute(sql: string, params: unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
  connection?: unknown;
}

/**
 * The core connection's two statement methods, which return a command rather
 * than a promise.
 *
 * `unknown` returns on purpose: what comes back is a `Query` or an `Execute`,
 * and the only thing this file wants from either is `.stream()`, which
 * {@link rowStream} asks for and checks.
 */
interface MysqlRowStreamer {
  query(sql: string): unknown;
  execute(sql: string, params: unknown[]): unknown;
}

function isRowStreamer(value: unknown): value is MysqlRowStreamer {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'query') === 'function' &&
    typeof Reflect.get(value, 'execute') === 'function'
  );
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, Symbol.asyncIterator) === 'function'
  );
}

/** Named for what it warns about, since a log line is where this is read. */
const sqlLogger = new Logger('CatalogSqlSource');

/**
 * A mysql2 command's rows, as something `for await` can walk.
 *
 * `.stream()` is a `Readable` in object mode, and the back-pressure is the whole
 * reason this path exists: mysql2 pushes each decoded row into it, and when the
 * reader stops pulling, the push returns false and the driver pauses the socket.
 * A consumer that writes a batch before asking for the next row therefore holds
 * a batch, not a result set — all the way down to the wire.
 */
function rowStream(command: unknown): AsyncIterable<unknown> {
  if (!command || typeof command !== 'object') {
    throw new Error('The mysql driver did not return a statement to read rows from.');
  }
  const stream: unknown = Reflect.get(command, 'stream');
  if (typeof stream !== 'function') {
    throw new Error(
      'This mysql2 has no row stream on its statements, so a SQL read cannot be bounded. Upgrade mysql2, or narrow the connector query.',
    );
  }
  const readable: unknown = Reflect.apply(stream, command, []);
  if (!isAsyncIterable(readable)) {
    throw new Error('The mysql row stream is not iterable, so there is nothing to read from it.');
  }
  return readable;
}

/**
 * A MySQL result set, one row at a time.
 *
 * Read-only by construction exactly as the buffered read was, and for the same
 * reason: the transaction refuses a write whatever the author's query turns out
 * to parse as. `execute` when there is something to bind and `query` when there
 * is not, which is the same split {@link queryMysql} makes and for the same
 * reason — see the comment there, which is about a literal `?` in somebody's SQL
 * and is not a performance note.
 *
 * The ROLLBACK and the close sit in a `finally` on the *generator*, so they run
 * when the consumer stops early as well as when the rows run out: a `for await`
 * that breaks calls the generator's `return`, which unwinds this. A consumer
 * that abandons the iterator without closing it would leak the connection, which
 * is the one obligation this shape puts on a caller that the buffered one did
 * not.
 *
 * Falls back to the buffered read when the driver is not the one this expects.
 * Refusing would turn a working connector into a failed load over a shape
 * mismatch in somebody's `mysql2` alias, and the buffered read is what every
 * connector did until now — so the fallback is a return to the previous
 * behaviour rather than a degradation. It is said out loud because a silent one
 * would leave an operator reading this docblock and believing their load is
 * bounded when it is not.
 */
async function* streamMysql(url: string, sql: string, params: unknown[]): AsyncGenerator<unknown> {
  const mysql = await importOptional<{
    createConnection: (url: string) => Promise<MysqlConnectionLike>;
  }>('mysql2/promise', 'mysql');
  const connection = await mysql.createConnection(url);
  try {
    await connection.query('START TRANSACTION READ ONLY');

    const core = connection.connection;
    if (!isRowStreamer(core)) {
      sqlLogger.warn(
        'This mysql2 does not expose the core connection a row stream comes from, so the whole result set is being read into memory — the behaviour every SQL connector had before streaming existed. A very large table may exhaust the heap or outlive its step lease.',
      );
      const [rows] =
        params.length > 0 ? await connection.execute(sql, params) : await connection.query(sql);
      if (Array.isArray(rows)) yield* rows;
      return;
    }

    // `execute` when there is something to bind, because it prepares the
    // statement server-side and the value never touches the SQL text at all.
    // mysql2's `query` would interpolate it client-side by scanning for `?`
    // without knowing which of them sit inside string literals, so an author
    // whose query contains a literal question mark would have it take the bind
    // meant for the watermark. With nothing to bind there is nothing to
    // prepare, and an unbounded run keeps exactly the path it always had.
    yield* rowStream(params.length > 0 ? core.execute(sql, params) : core.query(sql));
  } finally {
    await connection.query('ROLLBACK').catch(() => undefined);
    await connection.end().catch(() => undefined);
  }
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

/** What the last run stored, or nothing if it never stored anything. */
function readWatermark(value: unknown, column: string): string | number | undefined {
  if (value === undefined || value === null) return undefined;
  return normaliseWatermark(value, column);
}

/**
 * The largest watermark value seen so far, kept while rows go past.
 *
 * A running maximum rather than a pass over a finished array, because a streamed
 * read has no finished array to pass over — and because the answer must be the
 * same either way. It *is* the same: {@link maxWatermark} is now this fed from a
 * loop, so the comparison, the refusal and the "did it move" test have one
 * implementation and a bounded read cannot drift from a buffered one.
 *
 * `settle` is the loud part, and it is loud rather than silent for the reason it
 * always was: a run that cannot advance would read the same rows again on the
 * next run, and again after that, and the only symptom would be a load that
 * keeps writing the same numbers. It is asked once, after the last row —
 * asking earlier would refuse a stream whose first page happened not to carry
 * the column.
 */
interface WatermarkTracker {
  /** Show it one row. Rows that are not objects still count towards the refusal. */
  observe(row: unknown): void;
  /** The new watermark, nothing if it did not move — or a throw if none could. */
  settle(): string | number | undefined;
}

function trackWatermark(column: string, previous: string | number | undefined): WatermarkTracker {
  let best = previous;
  let seen = false;
  let rows = 0;

  return {
    observe(row: unknown): void {
      rows += 1;
      if (!row || typeof row !== 'object') return;
      const value: unknown = Reflect.get(row, column);
      if (value === undefined || value === null) return;
      seen = true;
      const candidate = normaliseWatermark(value, column);
      if (best === undefined || isAfter(candidate, best)) best = candidate;
    },
    settle(): string | number | undefined {
      if (rows > 0 && !seen) {
        throw new Error(
          `The query returned ${rows} rows and none of them carried "${column}", so there is nothing to advance the watermark to and the next run would read them all again. Select the watermark column in the query.`,
        );
      }
      return best === previous ? undefined : best;
    },
  };
}

/** The same answer for a result set that is already whole. */
function maxWatermark(
  rows: unknown[],
  column: string,
  previous: string | number | undefined,
): string | number | undefined {
  const tracker = trackWatermark(column, previous);
  for (const row of rows) tracker.observe(row);
  return tracker.settle();
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
 *
 * Returns what it skipped as well as what it produced. Nothing it reads has
 * anything to skip any more — the two formats that did are streamed now, and
 * their ledger is {@link BlankRowLedger} — but the shape stays, because the
 * next whole-read format to arrive will have the same question and the caller
 * should not have to be changed to hear the answer.
 *
 * Only the formats {@link FORMAT_READING} calls `whole` reach here. The streamed
 * ones are read by {@link streamedRecords} from a file, and their whole-text
 * equivalents are not kept alive alongside it: two implementations of "where
 * does a row end" is two answers to what a quoted newline means, and the symptom
 * of them disagreeing would be a row count that differs by how the file happened
 * to be delivered.
 */
async function parseRecords(
  bytes: Uint8Array,
  source: string,
  config: Record<string, unknown>,
): Promise<{ records: unknown[]; blankRows: number }> {
  const format = resolveFormat(source, config);

  switch (format) {
    // The binary member that is still read whole, and the reason this takes
    // bytes. Handled before any decode, because the decode is what would
    // destroy it.
    //
    // `blankRows: 0` is the truth rather than a placeholder. A workbook has no
    // blank *line* to skip — a row of empty cells is a row of `null`s the
    // reader hands over like any other — so there is nothing to under-report.
    case 'xlsx':
      return { records: await parseWorkbook(bytes, source, config), blankRows: 0 };
    case 'json':
      return { records: unwrap(JSON.parse(decodeText(bytes)), config.jsonPath), blankRows: 0 };
    case 'csv':
    case 'ndjson':
    case 'parquet':
      throw new Error(
        `${source} is ${format}, which is read as a stream rather than from a finished buffer. This is unreachable through the fetchers and means FORMAT_READING and this switch have disagreed.`,
      );
    default:
      // Was `return unwrap(JSON.parse(text), …)` as an unconditional tail, which
      // is how a `.xlsx` used to be read as JSON. Every member is now named
      // above and this line is what a sixth one has to answer.
      return unreachableSourceFormat(format, 'parseRecords');
  }
}

/**
 * Which formats have a row boundary a reader can find as the bytes arrive.
 *
 * A map rather than a set, so that a format added to `SOURCE_FORMATS` leaves
 * this object missing a property and the build stops *here* — at the one place
 * that has to decide whether the new format can be read incrementally — rather
 * than at a run-time fallback that quietly picked one.
 *
 * `csv` and `ndjson` are line-oriented: a row ends at a newline the scanner has
 * already seen, and nothing later in the file can change that. `parquet` is
 * organised in row groups, which is a chunk boundary the format itself supplies.
 * `json` is one value with no boundary inside it — {@link fetchHttp} carries the
 * rest of that argument. `xlsx` is a ZIP whose shared-string table generally has
 * to be read before the sheet, which is why {@link parseWorkbook} caps its size
 * instead; a genuinely streaming workbook reader is a different piece of work.
 */
const FORMAT_READING = {
  csv: 'stream',
  ndjson: 'stream',
  json: 'whole',
  xlsx: 'whole',
  parquet: 'stream',
} satisfies Record<SourceFormat, 'stream' | 'whole'>;

/**
 * One local payload as records, in whichever streamed format it is.
 *
 * Every streamed format reads from a *file* rather than from whatever the bytes
 * arrived on — see `source-payloads.ts` for why a remote body is spooled first.
 * The text formats take the file as chunks and decode them; parquet seeks
 * around it.
 */
function streamedRecords(
  payload: LocalPayload,
  format: SourceFormat,
  source: string,
  config: Record<string, unknown>,
  ledger: BlankRowLedger,
): AsyncIterable<unknown> {
  switch (format) {
    case 'csv':
      return csvRecords(
        decodeChunks(payloadChunks(payload)),
        String(config.delimiter ?? ','),
        source,
        ledger,
      );
    case 'ndjson':
      return ndjsonRecords(decodeChunks(payloadChunks(payload)), source);
    case 'parquet':
      return parquetRecords(payload, source);
    case 'json':
    case 'xlsx':
      throw new Error(
        `${source} is ${format}, which is read whole rather than streamed. This is unreachable through the fetchers and means FORMAT_READING and this switch have disagreed.`,
      );
    default:
      return unreachableSourceFormat(format, 'streamedRecords');
  }
}

/** What a connector says about how much it will read and how long it will wait. */
function payloadLimits(config: Record<string, unknown>): PayloadLimits {
  const maxBytes = positiveInteger(config.maxBytes);
  const idleTimeoutMs = positiveInteger(config.readIdleTimeoutMs);
  return {
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
  };
}

/**
 * The note a drained stream has to make, or nothing.
 *
 * The plural of {@link blankRowNote} for a read whose ledger was filled as it
 * went. `where` is the first source that skipped something when there is one,
 * because that is what somebody opens; the prefix is the fallback for a read
 * over many objects, and the count of sources is what says it was many.
 */
function blankRowNotes(ledger: BlankRowLedger, fallback: string): string[] {
  if (ledger.blankRows === 0) return [];
  const first = ledger.firstSource;
  const where =
    first === undefined || ledger.sources > 1
      ? `${ledger.sources} sources read this run under "${fallback}"${first === undefined ? '' : `, the first being "${first}"`}`
      : `"${first}"`;
  return [blankRowNote(ledger.blankRows, where)];
}

/**
 * The bytes of a text payload, as text.
 *
 * `Buffer.toString('utf8')` rather than a `TextDecoder`, and the difference is
 * not stylistic: a `TextDecoder` strips a leading byte-order mark and
 * `readFile(path, 'utf8')` — which is what this replaced — does not. Stripping
 * it would be a defensible change and is not this one; a CSV whose first header
 * silently lost its BOM is a different column name than the transform written
 * against the old behaviour expects.
 *
 * The view is taken rather than the array copied, so a 27 MB CSV is not held
 * twice while it is decoded.
 */
function decodeText(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
}

/** Whether a payload is empty or nothing but ASCII whitespace. */
function isBlank(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    // space, tab, LF, CR, VT, FF — what `String.trim()` would have removed from
    // any body that reached the old text-only reader.
    if (byte !== 0x20 && (byte < 0x09 || byte > 0x0d)) return false;
  }
  return true;
}

/**
 * The format this payload is to be read as.
 *
 * An unrecognised `format` is refused rather than read as JSON. That was the
 * old behaviour and it is the one this exists to end: a connector configured
 * with `format: "parquet"` reported a JSON syntax error at some byte offset,
 * which names neither the format nor the mistake.
 */
function resolveFormat(source: string, config: Record<string, unknown>): SourceFormat {
  const configured = config.format;
  // Absent and empty mean the same thing — the console's "Format from the
  // extension" option submits `''` — and both defer to the extension.
  if (configured === undefined || configured === null || String(configured).trim() === '') {
    return guessFormat(source);
  }

  const named = String(configured).trim().toLowerCase();
  if (isSourceFormat(named)) return named;
  throw new Error(
    `"${String(configured)}" is not a format this can read. Use one of: ${SOURCE_FORMATS.join(', ')} — or leave it unset to take the format from the file extension.`,
  );
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

/**
 * Read each object and parse it into rows, in the order given.
 *
 * The blank-line counts are summed across the whole read and reported as **one**
 * note rather than one per object. A prefix is routinely hundreds of objects,
 * and a per-object line would be a note per part file — which the node's log cap
 * would then truncate, pushing out the lines that say what the run did. The
 * total is the number that matters, and the first affected key is what somebody
 * opens to see why. That is what {@link BlankRowLedger} carries, and it is now a
 * running tally rather than a returned sum for the reason everything else here
 * became one: the objects are read as the consumer pulls, so there is no moment
 * before the last row at which a total could be returned.
 *
 * The client is destroyed in this generator's `finally` rather than in the
 * fetcher's, and that move is forced rather than stylistic: the fetcher now
 * returns before a single object has been read, so a `finally` there would tear
 * the connection down before the first `GetObject`. The obligation it creates —
 * a consumer that abandons the iterator without closing it leaks the client —
 * is the same one {@link streamMysql} already carries, and every consumer in
 * this package either drains the stream or `break`s out of a `for await`, which
 * calls `return` and unwinds this.
 */
async function* readObjectRecords(input: {
  client: S3ClientLike;
  s3: S3Module;
  bucket: string;
  objects: readonly S3Object[];
  config: Record<string, unknown>;
  completed: S3Object[];
  ledger: BlankRowLedger;
}): AsyncGenerator<unknown> {
  const { client, s3, bucket, objects, config, completed, ledger } = input;

  try {
    for (const object of objects) {
      const uri = `s3://${bucket}/${object.key}`;
      // The same format logic a file connector uses, per object: the extension
      // decides unless the connector overrides it, which is what a prefix full
      // of `part-00000` files needs.
      const format = resolveFormat(object.key, config);
      const body = await client.send(new s3.GetObjectCommand({ Bucket: bucket, Key: object.key }));

      if (FORMAT_READING[format] === 'stream') {
        yield* streamObject(body, uri, format, config, ledger);
      } else {
        const bytes = await readObjectBytes(body, uri);
        // Was `!text.trim()` on the decoded body. Asked of the bytes instead so
        // the skip still happens for a whitespace-only object — which matters,
        // because the alternative is handing `""` to `JSON.parse` and failing a
        // whole run on an empty part file that this has always skipped.
        if (isBlank(bytes)) {
          completed.push(object);
          continue;
        }
        const parsed = await parseRecords(bytes, object.key, config);
        if (parsed.blankRows > 0) {
          ledger.blankRows += parsed.blankRows;
          ledger.sources += 1;
          if (ledger.firstSource === undefined) ledger.firstSource = uri;
        }
        // Yielded one at a time rather than spread into a `push`, because a
        // spread becomes one argument per row and a CSV drop with a few hundred
        // thousand of them overflows the call stack — a failure that only shows
        // up on the large files this connector exists to read.
        for (const record of parsed.records) yield record;
      }

      completed.push(object);
    }
  } finally {
    // The SDK keeps sockets alive for reuse, which keeps the process alive too
    // when a run is the only thing happening.
    client.destroy?.();
  }
}

/**
 * One object's rows, through a spool.
 *
 * The download is not interleaved with the parse, and that is the point. Left
 * as a live socket, a `GetObject` body would be paused by every batch flush
 * downstream — flip measured an ECONNRESET three to four minutes into exactly
 * that pattern, because S3 closes a connection that has gone quiet. Spooling
 * first means the socket's lifetime is the object's size over the network, and
 * the slow half reads from a local file that is not going anywhere. See
 * `source-payloads.ts`, which carries the rest of that argument.
 */
async function* streamObject(
  body: unknown,
  label: string,
  format: SourceFormat,
  config: Record<string, unknown>,
  ledger: BlankRowLedger,
): AsyncGenerator<unknown> {
  const payload = await spool(objectBodyChunks(body, label), label, payloadLimits(config));
  try {
    yield* streamedRecords(payload, format, label, config, ledger);
  } finally {
    await payload.release();
  }
}

/** The body of a `GetObject`, as the chunks it arrives in. */
function objectBodyChunks(value: unknown, label: string): AsyncIterable<Uint8Array> {
  const body: unknown = value && typeof value === 'object' ? Reflect.get(value, 'Body') : undefined;
  if (!isAsyncIterable(body)) {
    throw new Error(
      `${label} came back without a readable body. This needs an @aws-sdk/client-s3 whose response body is a Node stream.`,
    );
  }
  return chunksOf(body, label);
}

async function* chunksOf(body: AsyncIterable<unknown>, label: string): AsyncGenerator<Uint8Array> {
  for await (const chunk of body) {
    if (!ArrayBuffer.isView(chunk)) {
      throw new Error(`${label} produced something other than bytes, so it cannot be read.`);
    }
    yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
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

/**
 * The body of a `GetObject`, as bytes.
 *
 * `transformToByteArray` rather than `transformToString('utf8')`, for the reason
 * {@link fetchFile} stopped passing an encoding to `readFile`: the format is not
 * known here, and a UTF-8 decode of a `.xlsx` — a ZIP archive — replaces most of
 * it with U+FFFD before anything has had the chance to say so. The text formats
 * are decoded a step later, in {@link parseRecords}, from exactly these bytes.
 */
async function readObjectBytes(value: unknown, label: string): Promise<Uint8Array> {
  const body: unknown = value && typeof value === 'object' ? Reflect.get(value, 'Body') : undefined;
  const toBytes: unknown =
    body && typeof body === 'object' ? Reflect.get(body, 'transformToByteArray') : undefined;
  if (typeof toBytes !== 'function') {
    throw new Error(
      `${label} came back without a readable body. This fetcher reads whole objects; a stream the SDK cannot collect is not one.`,
    );
  }
  const bytes: unknown = await toBytes.call(body);
  if (!(bytes instanceof Uint8Array)) {
    throw new Error(
      `${label} came back as ${typeof bytes} rather than bytes, so there is nothing to parse. This needs an @aws-sdk/client-s3 whose response body exposes transformToByteArray().`,
    );
  }
  return bytes;
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

/**
 * The format an extension implies.
 *
 * The tail is still JSON, which is a guess and is meant to be: a signed URL ends
 * in a query string and an object key often has no extension at all. What is no
 * longer a guess is a workbook — `.xls` and `.xlsm` are claimed here alongside
 * `.xlsx` because all three are the same decision, and the alternative is that a
 * `.xls` drop falls through to JSON and reports a syntax error at byte 0.
 */
function guessFormat(source: string): SourceFormat {
  const withoutQuery = source.split('?')[0].toLowerCase();
  if (withoutQuery.endsWith('.csv')) return 'csv';
  if (withoutQuery.endsWith('.ndjson') || withoutQuery.endsWith('.jsonl')) {
    return 'ndjson';
  }
  if (
    withoutQuery.endsWith('.xlsx') ||
    withoutQuery.endsWith('.xlsm') ||
    withoutQuery.endsWith('.xls')
  ) {
    return 'xlsx';
  }
  // `.parq` alongside `.parquet` because both are in the wild and both are the
  // same decision — a `.parq` drop falling through to JSON would report a syntax
  // error at byte 0 of a binary file.
  if (withoutQuery.endsWith('.parquet') || withoutQuery.endsWith('.parq')) {
    return 'parquet';
  }
  return 'json';
}

/**
 * The most bytes a workbook may be before this refuses to read it.
 *
 * A guard rather than a limit anybody is expected to hit: 32 MiB of XLSX is a
 * very large sheet, and the default exists so that the failure mode of a wrong
 * `format` or a runaway export is a message rather than a stalled worker. See
 * {@link parseWorkbook} for why an unbounded one is dangerous here specifically.
 */
const DEFAULT_MAX_WORKBOOK_BYTES = 32 * 1024 * 1024;

/**
 * A spreadsheet workbook, as records.
 *
 * **The library is not a dependency of this package, and that is deliberate.**
 * It is loaded through {@link importOptional}, the same way `pg`, `mysql2` and
 * the S3 SDK are, so a deployment that never reads a spreadsheet does not carry
 * one. The reason is sharper than "keep the install small": SheetJS stopped
 * publishing to npm at `0.18.5`, and that version has two unfixed advisories
 * against it — CVE-2023-30533 (prototype pollution, fixed in 0.19.3) and
 * CVE-2024-22363 (ReDoS, fixed in 0.20.2). Neither fix is on npm; they are only
 * on the vendor's own CDN. Depending on `xlsx` directly would therefore put a
 * permanently-vulnerable package into the tree of every consumer of this
 * library, including the ones that never open a workbook — and it would pin
 * them to *our* choice of provenance. Loading it optionally lets a deployment
 * install `xlsx` from the vendor tarball at a patched version, or a maintained
 * fork, and this reads whichever it finds.
 *
 * **It parses on the main thread, synchronously, and does not use a worker.**
 * That is a real cost and is bounded rather than hidden. Parsing a large
 * workbook is seconds of uninterrupted CPU, and a source node runs inside a
 * durable step, so a long enough stall keeps a lock-renewal timer from firing
 * and lets the step be reclaimed while it is still running. A worker thread is
 * the mitigation that removes it, and it was rejected here for two reasons that
 * do not apply to an application: a worker needs a separate entry file resolved
 * from `dist` at run time, which a published library cannot rely on surviving a
 * consumer's bundler, and the worker would then have to resolve the *optional*
 * library out of the consumer's `node_modules` from inside our own package.
 * Both fail only in production. So the exposure is capped instead —
 * {@link DEFAULT_MAX_WORKBOOK_BYTES}, overridable per connector with
 * `maxBytes` — which turns an unbounded stall into a refusal naming the file.
 *
 * **It reads the whole workbook into memory.** The format does not permit
 * otherwise without a different library: XLSX is a ZIP archive whose sheet is
 * one XML part, and a row-at-a-time reader is a different design that would
 * also have to return {@link StreamedFetchResult}, which neither the file nor
 * the S3 fetcher does for any format today. Not done here; the size cap is what
 * stands in for it.
 */
async function parseWorkbook(
  bytes: Uint8Array,
  source: string,
  config: Record<string, unknown>,
): Promise<unknown[]> {
  const maxBytes = positiveInteger(config.maxBytes) ?? DEFAULT_MAX_WORKBOOK_BYTES;
  if (bytes.byteLength > maxBytes) {
    throw new Error(
      `${source} is ${bytes.byteLength} bytes, over the ${maxBytes}-byte workbook limit. Parsing a workbook is synchronous CPU that blocks this worker's event loop, so an unbounded one can outlive its own step lease. Raise "maxBytes" on the connector if this file really is meant to be read whole.`,
    );
  }

  const api = await workbookApi();
  const workbook = api.read(bytes);
  const name = chooseSheet(workbook.sheetNames, source, config);
  return readSheet(api, workbook.sheet(name), name, source, workbook.date1904);
}

/**
 * The handful of calls this needs from whichever spreadsheet library is
 * installed, each one checked before it is used.
 *
 * Narrowed rather than typed by assertion. The module arrives as `unknown` from
 * a dynamic import of a package this repo does not depend on, so there is no
 * declaration to trust and nothing to cast against — an interface written here
 * would be a claim about someone else's package, and a wrong one would surface
 * as `undefined is not a function` in the middle of a load.
 */
interface WorkbookApi {
  read(bytes: Uint8Array): {
    sheetNames: string[];
    sheet(name: string): unknown;
    /** The workbook's epoch flag — see {@link cellDateIso}. */
    date1904: boolean;
  };
  decodeRange(ref: string): { start: CellAddress; end: CellAddress };
  encodeCell(address: CellAddress): string;
  /** Whether a cell's number format is one that displays a date. */
  isDateFormat(format: unknown): boolean;
  /** A serial number as calendar fields, with no `Date` in between. */
  dateFields(serial: number, date1904: boolean): DateFields;
}

interface CellAddress {
  row: number;
  column: number;
}

interface DateFields {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
  milliseconds: number;
}

async function workbookApi(): Promise<WorkbookApi> {
  const module: unknown = await importOptional<unknown>('xlsx', 'spreadsheet');
  const read = callable(module, 'read', 'read()');
  const utils: unknown = property(module, 'utils');
  const decodeRange = callable(utils, 'decode_range', 'utils.decode_range()');
  const encodeCell = callable(utils, 'encode_cell', 'utils.encode_cell()');
  const ssf: unknown = property(module, 'SSF');
  const isDate = callable(ssf, 'is_date', 'SSF.is_date()');
  const parseDateCode = callable(ssf, 'parse_date_code', 'SSF.parse_date_code()');

  return {
    read(bytes) {
      // `cellDates` is deliberately OFF and `cellNF` deliberately ON: this wants
      // the raw serial and the cell's number format, not the library's idea of a
      // `Date`. See {@link cellDateIso} for why that distinction is the whole
      // correctness argument for dates.
      const workbook: unknown = read(bytes, { cellDates: false, cellNF: true, type: 'array' });
      const names: unknown = property(workbook, 'SheetNames');
      if (!Array.isArray(names) || !names.every((n) => typeof n === 'string')) {
        throw new Error(
          'The installed spreadsheet library returned a workbook with no SheetNames, so there is no sheet to read.',
        );
      }
      const sheets: unknown = property(workbook, 'Sheets');
      return {
        sheetNames: names,
        sheet(name) {
          return property(sheets, name);
        },
        // Absent means the ordinary 1900 epoch. Only a workbook saved by the
        // old Mac Excel sets it, and getting it wrong moves every date in the
        // file by four years and a day.
        date1904:
          property(property(property(workbook, 'Workbook'), 'WBProps'), 'date1904') === true,
      };
    },
    decodeRange(ref) {
      const range: unknown = decodeRange(ref);
      return { start: address(range, 's', ref), end: address(range, 'e', ref) };
    },
    encodeCell({ row, column }) {
      const encoded: unknown = encodeCell({ r: row, c: column });
      if (typeof encoded !== 'string') {
        throw new Error(
          'The installed spreadsheet library did not encode a cell address as a string.',
        );
      }
      return encoded;
    },
    isDateFormat(format) {
      // A cell with no format is a plain number. Asked before the call because
      // the library's own check takes a string.
      if (typeof format !== 'string') return false;
      return isDate(format) === true;
    },
    dateFields(serial, date1904) {
      const parsed: unknown = parseDateCode(serial, { date1904 });
      const fields = {
        year: property(parsed, 'y'),
        month: property(parsed, 'm'),
        day: property(parsed, 'd'),
        hours: property(parsed, 'H'),
        minutes: property(parsed, 'M'),
        seconds: property(parsed, 'S'),
        // Sub-second remainder, which the library reports as a fraction.
        fraction: property(parsed, 'u'),
      };
      if (
        typeof fields.year !== 'number' ||
        typeof fields.month !== 'number' ||
        typeof fields.day !== 'number' ||
        typeof fields.hours !== 'number' ||
        typeof fields.minutes !== 'number' ||
        typeof fields.seconds !== 'number'
      ) {
        throw new Error(
          `The spreadsheet serial ${serial} did not decode into calendar fields, so the date it names is not known.`,
        );
      }
      return {
        year: fields.year,
        month: fields.month,
        day: fields.day,
        hours: fields.hours,
        minutes: fields.minutes,
        seconds: fields.seconds,
        milliseconds: typeof fields.fraction === 'number' ? Math.round(fields.fraction * 1000) : 0,
      };
    },
  };
}

function property(host: unknown, name: string): unknown {
  return host && typeof host === 'object' ? Reflect.get(host, name) : undefined;
}

/** A function off the loaded module, bound to it, returning `unknown`. */
function callable(host: unknown, name: string, label: string): (...args: unknown[]) => unknown {
  const value: unknown = property(host, name);
  if (typeof value !== 'function') {
    throw new Error(
      `The installed spreadsheet library has no ${label}. This expects the SheetJS interface — "xlsx" from the vendor's own distribution, or a fork that keeps it.`,
    );
  }
  return (...args: unknown[]): unknown => Reflect.apply(value, host, args);
}

/** One corner of a decoded range, as numbers rather than as a shape to trust. */
function address(range: unknown, corner: string, ref: string): CellAddress {
  const point: unknown = property(range, corner);
  const row: unknown = property(point, 'r');
  const column: unknown = property(point, 'c');
  if (typeof row !== 'number' || typeof column !== 'number') {
    throw new Error(`The sheet range "${ref}" did not decode into row and column numbers.`);
  }
  return { row, column };
}

/**
 * Which sheet a workbook's records come from.
 *
 * A workbook holds many sheets and a source produces one stream of records, so
 * something has to choose. A single-sheet workbook chooses itself. Anything else
 * must be named with `sheet`, and this **refuses** rather than taking the first
 * one — taking the first is right most of the time, and the rest of the time it
 * loads the wrong sheet's rows under the right sheet's name, with nothing in the
 * run to point at. The error lists what the file actually contains, because the
 * person configuring the connector usually cannot open it.
 */
function chooseSheet(names: string[], source: string, config: Record<string, unknown>): string {
  const requested = config.sheet;
  if (requested !== undefined && requested !== null && String(requested).trim() !== '') {
    const wanted = String(requested).trim();
    // Matched exactly first: a workbook may legitimately hold both "Data" and
    // "data", and a case-insensitive match that picked one would be the silent
    // choice this function exists to avoid making.
    if (names.includes(wanted)) return wanted;
    throw new Error(
      `${source} has no sheet named "${wanted}". It has: ${names.map((n) => JSON.stringify(n)).join(', ')}.`,
    );
  }

  if (names.length === 0) throw new Error(`${source} has no sheets in it.`);
  if (names.length === 1) return names[0];
  throw new Error(
    `${source} has ${names.length} sheets and no "sheet" configured: ${names.map((n) => JSON.stringify(n)).join(', ')}. Name the one to read — this will not guess, because loading the wrong sheet looks exactly like loading the right one.`,
  );
}

/**
 * One sheet's used range, as records keyed by the header row.
 *
 * Walked cell by cell rather than handed to the library's own sheet-to-JSON
 * helper, which is the choice that makes everything below decidable here: the
 * helper has its own opinions about blank rows, duplicate headers and what a
 * date becomes, they differ between versions, and this loads production data.
 */
function readSheet(
  api: WorkbookApi,
  sheet: unknown,
  name: string,
  source: string,
  date1904: boolean,
): unknown[] {
  // No `!ref` means the sheet has no used range — a genuinely empty tab, which
  // is nothing to read rather than something to refuse.
  const ref: unknown = property(sheet, '!ref');
  if (typeof ref !== 'string') return [];

  const { start, end } = api.decodeRange(ref);
  const columns: { name: string; index: number }[] = [];
  const seen = new Map<string, number>();

  for (let column = start.column; column <= end.column; column += 1) {
    const address = api.encodeCell({ row: start.row, column });
    const heading = cellValue(api, property(sheet, address), address, name, source, date1904);
    // A blank heading becomes the sheet's own column letter rather than `""`.
    // The column may still hold data, and dropping it — or letting every blank
    // heading collide on one empty key — loses it silently.
    const label =
      heading === null
        ? address.replace(/\d+$/, '')
        : String(heading).trim() || address.replace(/\d+$/, '');

    const previous = seen.get(label);
    if (previous !== undefined) {
      throw new Error(
        `${source} sheet "${name}" has two columns headed "${label}" (${api.encodeCell({ row: start.row, column: previous })} and ${address}). One would overwrite the other and the load would be short a column with nothing to show for it.`,
      );
    }
    seen.set(label, column);
    columns.push({ name: label, index: column });
  }

  const records: unknown[] = [];
  for (let row = start.row + 1; row <= end.row; row += 1) {
    const record: Record<string, CellValue> = {};
    let populated = false;
    for (const column of columns) {
      const address = api.encodeCell({ row, column: column.index });
      const value = cellValue(api, property(sheet, address), address, name, source, date1904);
      if (value !== null) populated = true;
      record[column.name] = value;
    }
    // Matches what the CSV reader does with a row of empty fields: a spacer row
    // is formatting, not a record.
    if (populated) records.push(record);
  }

  return records;
}

/**
 * What one cell becomes.
 *
 * The mapping is written out because a spreadsheet cell has a type and a CSV
 * field does not, so this is a decision rather than a passthrough:
 *
 * - text stays text, untrimmed — trimming is the transform's job, as it is for CSV
 * - a number stays a number, a boolean a boolean
 * - a **date becomes an ISO-8601 string**, never a serial number and never a
 *   `Date`. See {@link spreadsheetDateIso}, which is where the timezone goes
 * - an **empty or absent cell becomes `null`**, which is what the CSV reader
 *   puts in a short row, so a transform written against one works on the other
 * - an **error cell is refused**, loudly and by address
 *
 * That last one is the only opinionated refusal. A cell holding `#REF!` or
 * `#N/A` means the export itself is broken, and the alternatives are to pass the
 * text `"#N/A"` into what is probably a numeric column or to null it — one
 * corrupts the load, the other hides it. Failing names the cell.
 *
 * **Merged cells:** only the top-left cell of a merged range holds the value.
 * Every other cell it covers is absent and therefore arrives as `null` — the
 * value is *not* carried down or across. Anything that needs the merged value
 * repeated down a column (a header-per-group layout, which real exports use
 * heavily — the sample this was tested against has 1,732 merges in 974 rows)
 * must fill it forward in a transform, and this note is here because that
 * transform cannot be written without knowing it.
 */
type CellValue = string | number | boolean | null;

function cellValue(
  api: WorkbookApi,
  cell: unknown,
  address: string,
  sheet: string,
  source: string,
  date1904: boolean,
): CellValue {
  if (cell === null || cell === undefined || typeof cell !== 'object') return null;

  const type: unknown = Reflect.get(cell, 't');
  const value: unknown = Reflect.get(cell, 'v');

  // 'z' is the tag for a cell that carries formatting and no value.
  if (type === 'z' || value === undefined || value === null) return null;
  if (type === 'e') {
    const rendered: unknown = Reflect.get(cell, 'w');
    const text = typeof rendered === 'string' ? rendered : String(value);
    throw new Error(
      `${source} sheet "${sheet}" cell ${address} holds the spreadsheet error ${text}. Refusing the file rather than loading the error as a value or as a null, either of which would land in the warehouse looking like data.`,
    );
  }

  // A date is a number wearing a date format, and this is where it stops being
  // one. Checked before the plain-number branch, which is what it would
  // otherwise fall into and leave as 46183.
  if (typeof value === 'number' && api.isDateFormat(Reflect.get(cell, 'z'))) {
    return cellDateIso(api, value, date1904);
  }

  // Otherwise dispatched on what the value *is* rather than on the tag beside
  // it. The tag vocabulary belongs to the library, which is not a dependency
  // here and may be a fork; the runtime type of the value is checkable.
  //
  // A `Date` should not arrive at all, since the workbook is read with
  // `cellDates: false`. It is handled anyway, because a fork that ignores the
  // option would otherwise reach the refusal below — and `toISOString()` is
  // right for the convention every version of the library that produces Dates
  // has used here, which is UTC components holding the cell's wall clock.
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  throw new Error(
    `${source} sheet "${sheet}" cell ${address} came back as ${typeof value}, which this does not know how to store.`,
  );
}

/**
 * A date cell as an ISO-8601 string, built from the serial and never from a
 * `Date`.
 *
 * This is the most deliberate decision in the reader, because a date is where a
 * spreadsheet load goes wrong quietly. Three things had to be true at once:
 *
 * 1. **Not the serial.** A cell showing `2026-06-10` holds the number 46183. A
 *    column of those arriving in the warehouse is not obviously wrong, which is
 *    what makes it dangerous, so the serial never survives this function.
 * 2. **The right epoch.** That 46183 counts from 1899-12-30 in an ordinary
 *    workbook and from 1904-01-01 in one saved by the old Mac Excel. The flag
 *    lives on the workbook and is passed in; ignoring it moves every date in the
 *    file by four years and a day.
 * 3. **No timezone, at all.** This is why the conversion goes through the
 *    library's serial decoder rather than through a `Date`. The decoder returns
 *    calendar fields — year, month, day, hours — which is what the cell actually
 *    contains: a spreadsheet date has no zone. Building a `Date` from it would
 *    immediately impose the server's, and whether `toISOString()` then agreed
 *    with the cell would depend on whether the library had constructed that
 *    `Date` with local or UTC components. Both conventions exist across
 *    versions of it, they differ by exactly the machine's offset, and this
 *    library does not control which version a deployment installs. Reading the
 *    fields and formatting them directly makes the question not arise.
 *
 * The `Z` is therefore a statement about the format and not a claim about a
 * zone: it says these are the fields the cell shows, so that two runs of the
 * same file in two regions produce the same string.
 */
function cellDateIso(api: WorkbookApi, serial: number, date1904: boolean): string {
  const { year, month, day, hours, minutes, seconds, milliseconds } = api.dateFields(
    serial,
    date1904,
  );
  const pad = (value: number, width: number): string => String(value).padStart(width, '0');
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(milliseconds, 3)}Z`;
}

/**
 * The one line a reader gets about rows a parse threw away.
 *
 * Written once and shared by every fetcher that parses, so a file connector and
 * an object-store connector reading the same drop say the same sentence about
 * it — the reason {@link parseRecords} is shared, one level up.
 *
 * It names the count, says the count above does not include them, and says what
 * a blank line is, in that order: a reader arrives here because two numbers
 * disagreed, and the first thing they need is the size of the disagreement.
 * The last clause exists to head off the reflex dismissal — "that will be the
 * trailing newline" — which would be wrong, and would put the number back to
 * being ignored.
 */
function blankRowNote(blankRows: number, where: string): string {
  const plural = blankRows === 1 ? '' : 's';
  return `Skipped ${blankRows} blank line${plural} in ${where}: every cell on them was empty, and they are not in the record count. A file ending in one newline does not produce these, so they are empty lines in the file itself.`;
}

/**
 * The CSV reader moved to `record-streams.ts`.
 *
 * It is the same scanner, with the variables that carried state between
 * characters lifted into a closure so it can be fed a chunk at a time — which
 * is what lets a `file` or `s3` connector hand rows over as the bytes arrive.
 * Nothing about what a row *is* changed, `emptyAsNull` went with it unaltered,
 * and the blank-line count went from a returned sum to `BlankRowLedger`,
 * because a streamed read has no moment before the last row at which it could
 * return one. The whole-text entry points are still exported from there, so the
 * streamed and buffered readings of one file are the same code rather than two
 * implementations that agree until a chunk lands mid-quoted-field.
 */
