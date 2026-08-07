import { type FileHandle, open } from 'node:fs/promises';
import { Logger } from '@nestjs/common';
import { importIfPresent, importOptional } from './optional-modules';
import type { LocalPayload } from './source-payloads';

/**
 * Apache Parquet as records.
 *
 * **Read a row group at a time, because that is the unit the format has.** A
 * parquet file is columnar and its footer describes row groups, each a
 * self-contained block of rows with its own column chunks at known byte
 * offsets. So chunked reading here is not an adaptation of a whole-file reader
 * — it is the shape the format was written in. What this holds at any moment is
 * one row group's rows, never the file's.
 *
 * That does put the memory ceiling in the *writer's* hands rather than this
 * reader's: a producer that wrote one row group of five million rows gets a
 * five-million-row read, and no reader can do better without decoding the same
 * column chunk repeatedly. {@link ROW_GROUP_ROWS_TO_NOTE} is where this says so
 * out loud in the log rather than leaving an operator to discover it as a heap
 * profile.
 *
 * **The library is loaded optionally, and the reason is not the one `xlsx` has.**
 * `hyparquet` is in good order — MIT, no runtime dependencies at all, published
 * within the week, and no advisory against any version in OSV — so a plain
 * dependency would be defensible on its own merits. It is optional anyway
 * because this package deliberately ships with *zero* runtime dependencies:
 * `pg`, `mysql2` and the S3 SDK are all loaded this way, and a consumer that
 * never reads a parquet file should not acquire a parquet decoder by installing
 * a catalog. The seam earns its keep a second time for compression — see
 * {@link resolveCompressors}, where a codec beyond the two hyparquet implements
 * natively needs a second package that only a deployment reading such files
 * should have to install.
 */

const parquetLogger = new Logger('CatalogParquetSource');

/**
 * A row group big enough to be worth a line in the log.
 *
 * Not a refusal. A large row group is a legal file that this will read
 * correctly; it is just one whose peak memory is the writer's choice rather
 * than the reader's, and an operator looking at a worker that grew by a
 * gigabyte deserves to find out from a log line rather than from a heap dump.
 */
const ROW_GROUP_ROWS_TO_NOTE = 1_000_000;

/**
 * The codecs hyparquet decompresses without help.
 *
 * Everything else — GZIP, ZSTD, BROTLI, LZ4, LZ4_RAW — lives in the companion
 * `hyparquet-compressors` package, which carries the WASM to do it. Naming the
 * two that work here means the refusal below can name the codec, the file and
 * the package to install, rather than surfacing as
 * "parquet unsupported compression codec" from inside a dependency.
 */
const NATIVE_CODECS: ReadonlySet<string> = new Set(['UNCOMPRESSED', 'SNAPPY']);

/**
 * A parquet payload as records, one row group at a time.
 *
 * The schema is checked *before the first row is read*, which is the part worth
 * knowing: a column this cannot represent honestly fails while the run has
 * written nothing, rather than a hundred thousand rows in. See
 * {@link refuseUnreadableColumns} for what is refused and why each one is worse
 * than a guess.
 */
export async function* parquetRecords(
  payload: LocalPayload,
  source: string,
): AsyncGenerator<unknown> {
  const api = await parquetApi();
  const handle = await open(payload.path, 'r');
  try {
    const file = fileBuffer(handle, payload.byteLength);
    const metadata = readMetadata(await api.metadata(file), source);
    refuseUnreadableColumns(metadata.schema, source);
    const compressors = await resolveCompressors(metadata, source);
    const columns = topLevelColumns(metadata.schema);

    let rowStart = 0;
    for (const group of metadata.rowGroups) {
      const rowEnd = rowStart + group;
      if (group >= ROW_GROUP_ROWS_TO_NOTE) {
        parquetLogger.warn(
          `${source} has a row group of ${group} rows. A row group is the smallest thing a parquet reader can decode, so this read holds that many rows at once however it is consumed. Ask the producer for smaller row groups if this worker is memory-bound.`,
        );
      }
      const rows = await api.readObjects({
        file,
        metadata: metadata.raw,
        rowStart,
        rowEnd,
        parsers: PARSERS,
        ...(compressors ? { compressors } : {}),
      });
      for (const row of rows) yield shapeRow(row, columns, source);
      rowStart = rowEnd;
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Every temporal type as an ISO-8601 string in UTC, and never as a `Date`.
 *
 * Three reasons, in the order they matter.
 *
 * **Precision.** A parquet `TIMESTAMP(MICROS)` or a legacy `INT96` carries
 * sub-millisecond precision that a JavaScript `Date` cannot hold, and the
 * library's own default parser divides it away. Rounding a microsecond
 * timestamp to the millisecond is a silent edit to somebody's data — the same
 * class of thing as a spreadsheet date arriving as `45231`, and harder to
 * notice because the result still looks like a timestamp.
 *
 * **What actually lands.** A record here becomes a row in a snapshot, which is
 * JSON. A `Date` in that JSON is an ISO string by the time anybody reads it, so
 * producing one directly is the honest description of what a transform will see
 * — and it removes any question of *which* `Date`, since nothing has to be
 * built from local components and read back as UTC.
 *
 * **A DATE is not an instant.** `dateFromDays` produces `YYYY-MM-DD` and stops
 * there. A parquet DATE is a calendar day with no time and no zone; turning it
 * into midnight UTC would invent an instant the file never contained, and a
 * consumer in a negative offset would then read the day before.
 *
 * These are merged over the library's defaults, so the parsers not named here —
 * strings, JSON, UUID, geometry — keep their normal behaviour.
 */
const PARSERS = {
  timestampFromMilliseconds: (millis: bigint): string => epochIso(millis, 1_000n, 3),
  timestampFromMicroseconds: (micros: bigint): string => epochIso(micros, 1_000_000n, 6),
  timestampFromNanoseconds: (nanos: bigint): string => epochIso(nanos, 1_000_000_000n, 9),
  dateFromDays: (days: number): string => dayIso(days),
};

/** The largest millisecond offset from the epoch a `Date` can represent. */
const MAX_EPOCH_MS = 8.64e15;

/**
 * An instant, as ISO-8601 with the precision the file actually carried.
 *
 * The seconds go through a `Date` — which is exact for whole milliseconds and
 * timezone-free when built from an epoch and read with `toISOString` — and the
 * fraction is appended as digits, so nothing is divided away. `-1n / 1000n` is
 * `0n` in BigInt, so the remainder is corrected towards negative infinity
 * before it is used; without that, an instant one millisecond before 1970 would
 * render as `1970-01-01T00:00:00.-01Z`.
 */
function epochIso(value: bigint, perSecond: bigint, digits: number): string {
  let seconds = value / perSecond;
  let fraction = value % perSecond;
  if (fraction < 0n) {
    seconds -= 1n;
    fraction += perSecond;
  }

  const millis = Number(seconds) * 1000;
  if (!Number.isFinite(millis) || Math.abs(millis) > MAX_EPOCH_MS) {
    throw new Error(
      `A parquet timestamp of ${value} is outside the range of representable dates, so it cannot be read as one. Read that column as a raw integer instead.`,
    );
  }

  const whole = new Date(millis).toISOString();
  // `toISOString` always ends in `.mmmZ`; the fraction replaces it wholesale
  // rather than being appended to it.
  return `${whole.slice(0, whole.length - 5)}.${fraction.toString().padStart(digits, '0')}Z`;
}

/** A calendar day, as a calendar day. */
function dayIso(days: number): string {
  const millis = days * 86_400_000;
  if (!Number.isFinite(millis) || Math.abs(millis) > MAX_EPOCH_MS) {
    throw new Error(
      `A parquet date of ${days} days from the epoch is outside the range of representable dates, so it cannot be read as one.`,
    );
  }
  return new Date(millis).toISOString().slice(0, 10);
}

/**
 * One row, under the column names the file declares.
 *
 * Built from the schema's column list rather than from the row's own keys, so
 * every record has every column whether or not the value was null — a record
 * whose keys vary by row is a shape a transform cannot be written against.
 */
function shapeRow(row: unknown, columns: readonly string[], source: string): unknown {
  if (!row || typeof row !== 'object') {
    throw new Error(`${source} produced a row that is not an object, so it cannot become a record.`);
  }
  const record: Record<string, unknown> = {};
  for (const column of columns) {
    record[column] = parquetValue(Reflect.get(row, column), column, source);
  }
  return record;
}

/**
 * One value, as something that survives being written to a snapshot.
 *
 * **A null is `null`.** Parquet says so itself: a value's presence is carried in
 * the definition levels, so a null field and a field holding the empty string
 * are different things *in the file*, and there is no third reading to choose
 * between. That leaves the open question about a blank CSV cell exactly where
 * it was — a CSV genuinely contains an empty field where parquet contains an
 * absence, and this format's answer does not argue either way about that one.
 *
 * **A 64-bit integer is a number when that is exact, and a refusal when it is
 * not.** hyparquet hands INT64 over as a `bigint`, which `JSON.stringify`
 * throws on outright — so it cannot simply be passed along — and `Number(...)`
 * of a value past 2^53 silently returns a different number. An id that changes
 * in its last three digits on the way into the catalog is the worst outcome
 * available here, so the value is named and the run stops.
 *
 * Arrays and objects — a LIST, a MAP, a nested group, a GeoJSON geometry — are
 * walked and kept. They are what the file says the column holds, they survive
 * JSON, and flattening them here would be the fetcher shaping data, which is
 * the one thing every fetcher in this package refuses to do.
 */
function parquetValue(value: unknown, column: string, source: string): unknown {
  if (value === undefined || value === null) return null;

  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean' || kind === 'number') return value;

  if (typeof value === 'bigint') {
    if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(value);
    }
    throw new Error(
      `"${column}" in ${source} holds ${value}, which is past ±2^53 and cannot be carried as a JSON number without changing it. Cast that column to a string in whatever writes the file — a 64-bit id that quietly loses its last digits is worse than a load that stops.`,
    );
  }

  // Defensive rather than expected: every temporal parser above returns a
  // string. A library upgrade that added a parser this does not override would
  // otherwise put a `Date` into a record and leave the timezone question to
  // whoever serialises it next.
  if (value instanceof Date) return value.toISOString();

  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new Error(
      `"${column}" in ${source} is raw bytes, which has no honest reading as a record value. ${BINARY_ADVICE}`,
    );
  }

  if (Array.isArray(value)) {
    return value.map((entry) => parquetValue(entry, column, source));
  }

  if (kind === 'object') {
    const nested: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      nested[key] = parquetValue(Reflect.get(value, key), column, source);
    }
    return nested;
  }

  throw new Error(`"${column}" in ${source} came back as ${kind}, which cannot be stored as a value.`);
}

const BINARY_ADVICE =
  'Give the column a STRING or UUID logical type if it is text, or drop it from what the connector reads.';

/**
 * Columns this cannot read honestly, refused by name before any row is.
 *
 * Every entry here is a case where the library would hand back something that
 * *looks* like an answer. That is the whole reason the list exists: hyparquet
 * has no parser hook for these, so the alternative to refusing is a number
 * whose units nobody stated, a float that lost digits, or a byte array read as
 * if it were text.
 *
 * - **TIME.** Arrives as a bare number of milliseconds — or, at microsecond
 *   precision, as a `bigint` — since midnight, with nothing in the value saying
 *   so. This is exactly the "a timestamp that silently arrives as an integer"
 *   failure, and there is no hook to convert it.
 * - **DECIMAL wider than a double.** hyparquet converts every DECIMAL to a
 *   `number` by scaling, and there is no hook to stop it. Up to 15 significant
 *   digits that is exact; past it, a `DECIMAL(38,9)` money column silently
 *   becomes an approximation. Small decimals are still read, because those are
 *   exact and refusing them would be refusing the common case.
 * - **Raw binary.** A `BYTE_ARRAY` with no logical type is bytes, and the
 *   library's default is to decode every byte array as UTF-8 — which turns a
 *   blob into mojibake rather than into an error.
 * - **INTERVAL, BSON, VARIANT.** The library throws on the first two from
 *   somewhere deep inside a page decoder and returns undecoded bytes for the
 *   third. Named here so the message says which column and which file.
 */
function refuseUnreadableColumns(schema: readonly SchemaNode[], source: string): void {
  const refusals: string[] = [];

  for (const node of schema) {
    const reason = unreadableReason(node);
    if (reason) refusals.push(`"${node.path.join('.')}" ${reason}`);
  }

  if (refusals.length > 0) {
    throw new Error(
      `${source} has ${refusals.length === 1 ? 'a column' : 'columns'} this cannot read as records: ${refusals.join('; ')}. Refusing rather than guessing — every one of these would otherwise arrive as a value that looks right and is not.`,
    );
  }
}

/** Why one schema element cannot be read, or nothing if it can. */
function unreadableReason(node: SchemaNode): string | undefined {
  const converted = node.convertedType;
  const logical = node.logicalType;

  if (converted === 'TIME_MILLIS' || converted === 'TIME_MICROS' || logical === 'TIME') {
    return 'is a TIME, which arrives as a bare count since midnight with no unit attached to it. Cast it to a string or a TIMESTAMP in whatever writes the file.';
  }
  if (converted === 'INTERVAL' || logical === 'INTERVAL') {
    return 'is an INTERVAL, which has no representation here.';
  }
  if (converted === 'BSON' || logical === 'BSON') {
    return 'is BSON, which this does not decode.';
  }
  if (logical === 'VARIANT') {
    return 'is a VARIANT, whose value arrives as undecoded bytes.';
  }
  if (node.isDecimal && node.precision !== undefined && node.precision > EXACT_DECIMAL_DIGITS) {
    return `is a DECIMAL(${node.precision}${node.scale === undefined ? '' : `,${node.scale}`}), which is read through a double and would lose digits past ${EXACT_DECIMAL_DIGITS}. Cast it to a string in whatever writes the file.`;
  }
  if (node.isBinary && !node.isText && !node.isDecimal) {
    return `is raw binary. ${BINARY_ADVICE}`;
  }
  return undefined;
}

/** How many significant digits a double carries without losing any. */
const EXACT_DECIMAL_DIGITS = 15;

/**
 * The compressors this file needs, or nothing if it needs none.
 *
 * hyparquet implements UNCOMPRESSED and SNAPPY itself and delegates the rest.
 * Rather than let a GZIP file fail four row groups in with a message from
 * inside a page decoder, the codecs are read out of the footer up front and the
 * companion package is loaded — or refused with the codec, the file and the
 * package name in one sentence.
 */
async function resolveCompressors(
  metadata: ParquetMetadata,
  source: string,
): Promise<Record<string, unknown> | undefined> {
  const foreign = [...metadata.codecs].filter((codec) => !NATIVE_CODECS.has(codec));
  if (foreign.length === 0) return undefined;

  const module: unknown = await importIfPresent('hyparquet-compressors');
  const compressors: unknown =
    module && typeof module === 'object' ? Reflect.get(module, 'compressors') : undefined;
  if (!compressors || typeof compressors !== 'object') {
    throw new Error(
      `${source} is compressed with ${foreign.join(', ')}, which needs the "hyparquet-compressors" package. Add it to the catalog service, or ask the producer to write SNAPPY — the codec hyparquet decompresses on its own.`,
    );
  }
  return objectRecord(compressors);
}

/** As much of `hyparquet` as this file calls, checked before it is called. */
interface ParquetApi {
  metadata(file: AsyncBuffer): Promise<unknown>;
  readObjects(options: Record<string, unknown>): Promise<unknown[]>;
}

/**
 * The library, narrowed rather than declared.
 *
 * It arrives as `unknown` from a dynamic import of a package this repository
 * does not depend on, so there is nothing to trust and nothing to assert
 * against. Checking the two functions here means a version that moved or
 * renamed one of them says so by name, instead of surfacing as
 * "x is not a function" partway through a load.
 */
async function parquetApi(): Promise<ParquetApi> {
  const module: unknown = await importOptional<unknown>('hyparquet', 'parquet');
  const metadata = functionAt(module, 'parquetMetadataAsync');
  const readObjects = functionAt(module, 'parquetReadObjects');

  return {
    async metadata(file: AsyncBuffer): Promise<unknown> {
      return await metadata(file);
    },
    async readObjects(options: Record<string, unknown>): Promise<unknown[]> {
      const rows: unknown = await readObjects(options);
      if (!Array.isArray(rows)) {
        throw new Error('The parquet reader returned something other than rows for a row group.');
      }
      return rows;
    },
  };
}

function functionAt(module: unknown, name: string): (...args: unknown[]) => Promise<unknown> {
  const value: unknown = module && typeof module === 'object' ? Reflect.get(module, name) : undefined;
  if (typeof value !== 'function') {
    throw new Error(
      `This deployment's "hyparquet" has no ${name}(), so a parquet connector cannot read anything. Install a 1.x release of the package.`,
    );
  }
  return async (...args: unknown[]): Promise<unknown> => Reflect.apply(value, module, args);
}

/**
 * What a parquet reader needs from a file: a length and the ability to seek.
 *
 * The footer is at the *end* — the last eight bytes name its size — and every
 * row group is addressed by byte offset from the front. A reader therefore
 * jumps around a parquet file rather than walking it, which is why a payload
 * that arrived over a socket is spooled to disk before this sees it. See
 * `source-payloads.ts`.
 */
interface AsyncBuffer {
  byteLength: number;
  slice(start: number, end?: number): Promise<ArrayBuffer>;
}

/** An open file handle, seen as the buffer the reader wants. */
function fileBuffer(handle: FileHandle, byteLength: number): AsyncBuffer {
  return {
    byteLength,
    async slice(start: number, end?: number): Promise<ArrayBuffer> {
      const from = Math.max(0, Math.min(start, byteLength));
      const to = Math.max(from, Math.min(end ?? byteLength, byteLength));
      const length = to - from;
      if (length === 0) return new ArrayBuffer(0);

      const buffer = Buffer.alloc(length);
      let filled = 0;
      // Looped because a single `read` is allowed to return short, and a slice
      // that came back half-filled would be decoded as a corrupt page rather
      // than reported as a truncated read.
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, from + filled);
        if (bytesRead === 0) {
          throw new Error(
            `A parquet read asked for bytes ${from}–${to} and the file ended at ${from + filled}. The payload is truncated.`,
          );
        }
        filled += bytesRead;
      }
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
  };
}

/** One element of the file's schema, in the few terms this file reasons about. */
interface SchemaNode {
  /** The dotted path from the root, which is what a refusal has to name. */
  path: string[];
  convertedType?: string;
  logicalType?: string;
  precision?: number;
  scale?: number;
  isDecimal: boolean;
  isBinary: boolean;
  isText: boolean;
}

interface ParquetMetadata {
  /** The library's own object, handed straight back to it for the row reads. */
  raw: unknown;
  schema: SchemaNode[];
  /** Rows per row group, in file order. */
  rowGroups: number[];
  codecs: Set<string>;
}

/** The footer, narrowed to the parts this reasons about. */
function readMetadata(value: unknown, source: string): ParquetMetadata {
  if (!value || typeof value !== 'object') {
    throw new Error(`${source} did not produce parquet metadata, so it is not a parquet file.`);
  }

  const schemaValue: unknown = Reflect.get(value, 'schema');
  if (!Array.isArray(schemaValue) || schemaValue.length === 0) {
    throw new Error(`${source} has no parquet schema in its footer.`);
  }

  const rowGroupsValue: unknown = Reflect.get(value, 'row_groups');
  const rowGroups: number[] = [];
  const codecs = new Set<string>();
  if (Array.isArray(rowGroupsValue)) {
    for (const group of rowGroupsValue) {
      rowGroups.push(countAt(group, 'num_rows', source));
      collectCodecs(group, codecs);
    }
  }

  return { raw: value, schema: readSchema(schemaValue), rowGroups, codecs };
}

/** A row count, which the footer carries as a bigint. */
function countAt(group: unknown, key: string, source: string): number {
  const value: unknown = group && typeof group === 'object' ? Reflect.get(group, key) : undefined;
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${source} declares a row group of ${value} rows, which is not a readable file.`);
    }
    return Number(value);
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  throw new Error(`${source} has a row group that does not say how many rows are in it.`);
}

function collectCodecs(group: unknown, into: Set<string>): void {
  const columns: unknown = group && typeof group === 'object' ? Reflect.get(group, 'columns') : undefined;
  if (!Array.isArray(columns)) return;
  for (const column of columns) {
    const meta: unknown = column && typeof column === 'object' ? Reflect.get(column, 'meta_data') : undefined;
    const codec: unknown = meta && typeof meta === 'object' ? Reflect.get(meta, 'codec') : undefined;
    if (typeof codec === 'string') into.add(codec);
  }
}

/**
 * The flat schema list as nodes with their paths.
 *
 * Parquet writes its schema depth-first with a child count on each group, and
 * the first element is the root — which is not a column and is skipped. The
 * walk exists so a refusal can name `contact.phone` rather than `phone`, which
 * in a file with three groups is the difference between a message somebody can
 * act on and one they cannot.
 */
function readSchema(elements: readonly unknown[]): SchemaNode[] {
  const nodes: SchemaNode[] = [];
  const path: string[] = [];
  /** How many more children each open group is still expecting. */
  const remaining: number[] = [];

  for (let index = 1; index < elements.length; index += 1) {
    const element = elements[index];
    const name: unknown = element && typeof element === 'object' ? Reflect.get(element, 'name') : undefined;
    path.push(typeof name === 'string' ? name : `column ${index}`);
    nodes.push(readSchemaNode(element, [...path]));

    const children: unknown =
      element && typeof element === 'object' ? Reflect.get(element, 'num_children') : undefined;
    if (typeof children === 'number' && children > 0) {
      remaining.push(children);
      continue;
    }

    // A leaf closes itself and every group whose last child it was.
    path.pop();
    while (remaining.length > 0) {
      const left = (remaining.pop() ?? 1) - 1;
      if (left > 0) {
        remaining.push(left);
        break;
      }
      path.pop();
    }
  }

  return nodes;
}

const TEXT_CONVERTED: ReadonlySet<string> = new Set(['UTF8', 'ENUM', 'JSON', 'DECIMAL', 'BSON']);
const TEXT_LOGICAL: ReadonlySet<string> = new Set([
  'STRING',
  'ENUM',
  'JSON',
  'BSON',
  'UUID',
  'DECIMAL',
  'FLOAT16',
  'GEOMETRY',
  'GEOGRAPHY',
  'VARIANT',
]);

function readSchemaNode(element: unknown, path: string[]): SchemaNode {
  const at = (key: string): unknown =>
    element && typeof element === 'object' ? Reflect.get(element, key) : undefined;

  const converted = at('converted_type');
  const convertedType = typeof converted === 'string' ? converted : undefined;
  const logicalValue = at('logical_type');
  const logicalName =
    logicalValue && typeof logicalValue === 'object' ? Reflect.get(logicalValue, 'type') : undefined;
  const logicalType = typeof logicalName === 'string' ? logicalName : undefined;

  const type = at('type');
  const isBinary = type === 'BYTE_ARRAY' || type === 'FIXED_LEN_BYTE_ARRAY';
  const isDecimal = convertedType === 'DECIMAL' || logicalType === 'DECIMAL';

  return {
    path,
    ...(convertedType === undefined ? {} : { convertedType }),
    ...(logicalType === undefined ? {} : { logicalType }),
    ...decimalWidth(logicalValue, at('precision'), at('scale')),
    isDecimal,
    isBinary,
    isText:
      (convertedType !== undefined && TEXT_CONVERTED.has(convertedType)) ||
      (logicalType !== undefined && TEXT_LOGICAL.has(logicalType)),
  };
}

/**
 * Precision and scale, from wherever the writer put them.
 *
 * The logical type carries its own pair and the schema element carries a second
 * pair for the older `converted_type` spelling. Writers set one, the other, or
 * both; reading only one is how a `DECIMAL(38,9)` gets past the check on a file
 * written by a producer that used the other spelling.
 */
function decimalWidth(
  logical: unknown,
  precision: unknown,
  scale: unknown,
): { precision?: number; scale?: number } {
  const fromLogical = logical && typeof logical === 'object' ? logical : undefined;
  const p = integerOf(fromLogical ? Reflect.get(fromLogical, 'precision') : undefined) ?? integerOf(precision);
  const s = integerOf(fromLogical ? Reflect.get(fromLogical, 'scale') : undefined) ?? integerOf(scale);
  return { ...(p === undefined ? {} : { precision: p }), ...(s === undefined ? {} : { scale: s }) };
}

function integerOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return undefined;
}

/**
 * The names a record is keyed by: the schema's *top-level* fields.
 *
 * A nested field is part of its parent's value rather than a column of its own,
 * which is how the library keys its rows, and building the record from the same
 * list is what keeps a record's shape the file's rather than this row's.
 */
function topLevelColumns(schema: readonly SchemaNode[]): string[] {
  const names: string[] = [];
  for (const node of schema) {
    const first = node.path[0];
    if (node.path.length === 1 && first !== undefined) names.push(first);
  }
  return names;
}

/** An object's own entries, without claiming anything about their values. */
function objectRecord(value: object): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const key of Object.keys(value)) record[key] = Reflect.get(value, key);
  return record;
}
