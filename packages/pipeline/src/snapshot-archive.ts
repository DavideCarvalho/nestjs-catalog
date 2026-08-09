import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  CatalogObjectTypeDef,
  ScalarType,
  SnapshotArchiveRef,
} from '@dudousxd/nestjs-catalog';
import { importOptional } from './optional-modules';
import { type RandomAccessBytes, parquetRecordsFrom } from './source-parquet';

/**
 * Copying a snapshot out of the database, as parquet, without holding it.
 *
 * ## What this is for
 *
 * A snapshot is a whole version of an object type, and committing a new one
 * leaves the old rows in `obj_<type>` beside the new ones. That is what makes
 * the cutover a pointer move rather than a rewrite, and it is bought with disk:
 * nothing removes an old snapshot, so a type loaded daily holds every day it has
 * ever been loaded. One deployment reached 441 retained snapshots and 100 GB,
 * and the database then refused connections — which takes the application down,
 * not merely the load.
 *
 * The obvious repair is a retention cap, and it is the wrong one. See
 * {@link archiveSnapshot} for the argument; the short form is that
 * `catalog_connector_run` records the snapshot each run produced, so deleting
 * old snapshots turns the run history into a list of pointers to nothing.
 *
 * ## What this file does and does not do
 *
 * It **writes** a verified copy and hands back where it went. It deletes
 * nothing, it repoints nothing, and it does not touch `catalog_snapshot` or
 * `obj_<type>`. Archives produced here accumulate beside a database that is
 * exactly the size it was — which is the point, because it makes the expensive
 * half of this feature reversible while confidence is being built. Removing rows
 * is a separate operation with its own refusals, and it may only act on an
 * archive that has been read back and found to match.
 *
 * ## Why it lives here and not in `@dudousxd/nestjs-catalog`
 *
 * This package is already the one allowed to know what a bucket is: the parquet
 * reader, the S3 SDK seam and the media-disk seam are all here, and it declares
 * zero runtime dependencies, reaching every driver through
 * {@link importOptional}. The catalog package holds the vocabulary
 * ({@link SnapshotArchiveRef}, on `SnapshotRef`) and gains no notion of storage
 * from any of this. `hyparquet-writer` is a devDependency and an optional import
 * exactly as `hyparquet` already is.
 */

/** The parquet writer, in the few terms this file uses. Hand-written; never imported as a type. */
interface ParquetWriterModule {
  parquetWriteRows(options: {
    writer: ArchiveWriter;
    rows: AsyncIterable<Record<string, unknown>>;
    columns: Array<{ name: string; type: string; nullable: boolean }>;
    rowGroupSize?: number | number[];
    kvMetadata?: Array<{ key: string; value: string }>;
  }): Promise<void>;
  ByteWriter: new (initialSize?: number) => ArchiveWriter;
}

/**
 * The writer seam `hyparquet-writer` drives, narrowed to what is overridden here.
 *
 * The real interface has some twenty `appendX` methods that the encoder calls;
 * none of them are listed because none are touched. A `ByteWriter` instance is
 * taken from the module and four of its members are replaced, which is the same
 * shape the library's own `fileWriter` uses — so every method not named here
 * keeps the implementation the encoder expects.
 *
 * `index` and `offset` are two different numbers and the difference is what
 * makes a flushing writer possible at all: `index` is the position in the
 * in-memory buffer and resets to zero on every flush, `offset` is the total
 * bytes written and must never reset, because the footer addresses row groups by
 * absolute byte offset. A flush that reset `offset` would produce a file whose
 * every chunk pointer is wrong, and it would still be a valid-looking parquet
 * file.
 */
interface ArchiveWriter {
  buffer: ArrayBuffer;
  index: number;
  offset: number;
  ensure(size: number): void;
  flush?(): void | Promise<void>;
  finish(): void | Promise<void>;
  getBuffer(): ArrayBuffer;
  getBytes(): Uint8Array;
}

/**
 * One column as the parquet writer is told to encode it.
 *
 * `text` is not passed to the writer — it is this file's own note that the
 * column's values are serialised to JSON text on the way in, so that the same
 * encoding is applied when the checksum is taken and when the archive is read
 * back to check it. See {@link parquetTypeFor} for why the JSON logical type is
 * not used.
 */
interface ArchiveColumn {
  name: string;
  type: string;
  nullable: boolean;
  text: boolean;
}

/**
 * Somewhere an archive can be written and read back.
 *
 * One interface rather than two, and both halves are required, because
 * verification has to go through the same store the write went to. Reading the
 * bytes back some other way — off the local disk they were staged on, through a
 * second client with different credentials — verifies a copy nobody will ever
 * read and leaves the real one unchecked.
 */
export interface ArchiveStore {
  /** Begin writing at `path`. The object must not be visible there until `finish`. */
  open(path: string): Promise<ArchiveSink>;
  /** The bytes at `path`, seekable, for verification and for reading an archive as data. */
  read(path: string): Promise<RandomAccessBytes>;
  /** Write a small whole object — the manifest. Never used for row data. */
  put(path: string, bytes: Uint8Array): Promise<void>;
}

/**
 * An object being written, a chunk at a time.
 *
 * **Nothing may appear at the destination until {@link finish} resolves.** That
 * is the load-bearing clause and it is what an implementation has to arrange:
 * a filesystem sink writes to a neighbouring temporary name and renames, S3
 * multipart gets it for free since an upload is not an object until it is
 * completed. Without it a crashed archive leaves a truncated parquet file at the
 * exact path a later reader trusts, and a truncated parquet file is not an
 * obviously broken one — it has a footer or it does not, and the failure arrives
 * as a missing row group rather than as an error.
 */
export interface ArchiveSink {
  /** Append the next chunk. Awaited before the next is produced. */
  append(chunk: Uint8Array): Promise<void>;
  /** Make the object visible at its path. */
  finish(): Promise<void>;
  /** Abandon the write, leaving nothing behind. Called in a `finally`. */
  abort(): Promise<void>;
}

/** What a written archive records about itself, beside the data. */
export interface SnapshotArchiveManifest {
  version: 1;
  objectType: string;
  snapshotId: string;
  format: 'parquet';
  rowCount: number;
  bytes: number;
  checksum: string;
  writtenAt: string;
  /**
   * The catalog's own names and types for the columns, in stream order.
   *
   * Recorded because a parquet file carries the parquet type and not the one the
   * catalog calls it, and the two are deliberately not the same — see
   * {@link parquetTypeFor}. A reader holding this manifest can map an archive
   * back to an object type without the registry that produced it, which is the
   * difference between an archive and a pile of files.
   */
  columns: Array<{ name: string; type: ScalarType; parquetType: string }>;
  writer: string;
}

/** The manifest's name inside a snapshot's directory. */
export const ARCHIVE_MANIFEST_NAME = '_manifest.json';

/** The single data file's name. Numbered so a later multi-part write needs no new layout. */
export const ARCHIVE_PART_NAME = 'part-0000.parquet';

/**
 * How many rows go in one row group.
 *
 * The whole memory bound of a write, and the reason a 48 GB type can be archived
 * by a pod with a gigabyte: `parquetWriteRows` pulls exactly this many rows,
 * writes them, flushes, and only then pulls more, so what is held is one group
 * of row objects plus its columnar transposition plus its encoded bytes —
 * never the dataset.
 *
 * 20,000 rather than the library's 100,000 default. The default is tuned for
 * arrays already in memory, where the group size costs nothing extra; here it
 * multiplies against the width of a type this exists for, and a 40-column type
 * at 100,000 rows is four million live JS values before the encoder starts. The
 * read side is bounded by the same number, since the reader materialises one row
 * group too, and it warns above a million.
 */
export const ARCHIVE_ROW_GROUP_ROWS = 20_000;

/**
 * The parquet type each catalog scalar is written as.
 *
 * ## Written as what the reader already produces, not as what the value means
 *
 * A `date` becomes a STRING and that is deliberate rather than lazy. By the time
 * a row reaches here the store's `normalise` has already turned every temporal
 * value into an ISO-8601 string, and the parquet reader in this package turns
 * every temporal parquet value into an ISO-8601 string as well — its `PARSERS`
 * exist for exactly that. So a date written as a TIMESTAMP would be parsed out
 * of a string, encoded as an integer, and decoded back to a string, and the only
 * things that round trip could add are a timezone assumption and a precision
 * choice. Written as a string it is the same bytes coming back.
 *
 * `uuid` is a STRING for the matching reason: the value in hand is already the
 * hyphenated text, and parquet's UUID is a 16-byte fixed array, so choosing it
 * would mean parsing text into bytes on the way in and formatting bytes into
 * text on the way out to arrive back where it started.
 *
 * `number` is a DOUBLE, which is the same width `read` already hands out —
 * `normalise` calls `Number()` on it, and a `bigint` from the driver becomes a
 * *string* rather than a number, so nothing reaches here that a double would
 * narrow. This mapping cannot lose a digit that the ordinary read path keeps.
 *
 * ## `json` and `unknown` are STRING, and that is a bug being routed around
 *
 * Parquet has a JSON logical type, `hyparquet-writer` offers it, and it **loses
 * data**. Measured against 0.16.5, which is the current release: a JSON column
 * holding `[{a:1}, null, {c:3}]` reads back as `[{a:1}, null, null]`, and
 * `[null, {b:2}, {c:3}]` reads back as `[null, null, {b:2}]`. Values after a
 * null are dropped or shifted. It is the writer rather than this package's
 * reader — hyparquet's own `parquetReadObjects`, with no custom parsers,
 * produces the same wrong answer from the same file — and the same three cases
 * are exact for STRING, DOUBLE and BOOLEAN, so it is specific to that one
 * encoder. A nullable JSON column is the ordinary case here, not an exotic one.
 *
 * So the value is serialised to text and written as a STRING, which round-trips
 * exactly. What that costs is a real divergence and it is worth naming: an
 * archived `json` column reads back as **the JSON text**, where the same column
 * read from the database gives the parsed value. The manifest carries both the
 * catalog's type and the parquet type for every column precisely so a reader can
 * undo this without guessing, and anything that reads an archive as data owes a
 * `JSON.parse` on the columns the manifest calls `json` or `unknown`.
 *
 * `unknown` goes the same way for the same reason and one more: the values under
 * it are whatever a source produced, so text is the only representation that
 * cannot narrow one.
 *
 * ## What is not here
 *
 * DECIMAL, INT96, INTERVAL, BSON and the geospatial types, all of which the
 * reader in this package refuses by name before its first row. None of them can
 * be produced: the catalog has seven scalar types and this maps every one of
 * them, so an archive written here is readable by the reader beside it. That is
 * a property of the narrow type system rather than a coincidence, and it is
 * worth stating because it is what makes an archive safe to rely on.
 */
export function parquetTypeFor(scalar: ScalarType): string {
  switch (scalar) {
    case 'boolean':
      return 'BOOLEAN';
    case 'number':
      return 'DOUBLE';
    default:
      return 'STRING';
  }
}

/** Whether a scalar's values are carried as JSON text rather than as themselves. */
export function isTextEncodedScalar(scalar: ScalarType): boolean {
  return scalar === 'json' || scalar === 'unknown';
}

/**
 * One value as the archive stores it.
 *
 * Only the JSON-bearing scalars are touched, and `null` stays `null` rather than
 * becoming the string `"null"` — a null is the absence of a value and encoding
 * it as text would make an archived absence indistinguishable from a stored JSON
 * null.
 */
function archiveValue(value: unknown, column: ArchiveColumn): unknown {
  if (!column.text) return value;
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * The columns of a type, in the order the archive fixes.
 *
 * Every property, in the type's own order, and nothing else. The system columns
 * are not here — `_snapshot_id` is constant across a snapshot and lives in the
 * manifest instead, and `_row` is the order rather than a value. `_batch` is a
 * real loss and is called out in this file's tests: it distinguishes rows a run
 * produced from rows it carried forward unchanged, which the SQL console offers
 * as a question people ask. Nothing is deleted here so the loss costs nothing
 * yet, and preserving it is a prerequisite for anything that does delete.
 */
export function archiveColumns(type: CatalogObjectTypeDef): ArchiveColumn[] {
  return type.properties.map((property) => ({
    name: property.name,
    type: parquetTypeFor(property.type),
    text: isTextEncodedScalar(property.type),
    // Every column, always. A property the type calls required can still be null
    // in an old snapshot written before it was required, and a non-nullable
    // parquet column holding a null is a write that fails halfway through a
    // 27-million-row stream rather than one that refuses at the top.
    nullable: true,
  }));
}

/** Where a snapshot's archive goes. */
export function archivePathFor(prefix: string, typeName: string, snapshotId: string): string {
  return [
    trimSlashes(prefix),
    archiveSegment(typeName, 'object type'),
    archiveSegment(snapshotId, 'snapshot id'),
  ]
    .filter((segment) => segment.length > 0)
    .join('/');
}

/**
 * One path segment, refused rather than escaped if it cannot be one.
 *
 * A snapshot id is caller-supplied — for a durable pipeline it is the run id —
 * and a type name is authored. Neither is validated as a path anywhere upstream
 * because neither has ever been one. Escaping would be the other option and is
 * worse: it makes the archive's location unpredictable from the id, which is the
 * one property the layout exists to have.
 */
function archiveSegment(value: string, what: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`An archive path needs a ${what} and this one is empty.`);
  }
  if (trimmed === '.' || trimmed === '..' || /[/\\]/.test(trimmed) || trimmed.includes('\0')) {
    throw new Error(
      `The ${what} "${value}" cannot be a path segment, so this snapshot has nowhere to be archived to. Archiving is refused rather than the name being escaped into something else, because a path that cannot be predicted from the id is one nothing can find again.`,
    );
  }
  return trimmed;
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Copy one snapshot to an archive, and read it back before saying it worked.
 *
 * ## The ordering is the whole safety property
 *
 * Write, verify, then — much later, in an operation that is not this one —
 * delete. A half-written archive beside a deleted snapshot is the only outcome
 * here that cannot be recovered from, so the sequence is arranged so that it
 * cannot be reached rather than merely not being reached today:
 *
 * 1. The rows are streamed out and encoded to a sink that shows nothing at its
 *    destination until it is finished. A crash leaves no object, not a short one.
 * 2. The bytes are read back **through this package's own parquet reader** — the
 *    same code any later read would use, with the same refusals — and the rows
 *    are counted and hashed again.
 * 3. Both numbers are compared against what went in. A mismatch removes the
 *    archive and throws.
 * 4. Only then is a {@link SnapshotArchiveRef} returned, carrying `verifiedAt`.
 *
 * Nothing may delete rows on the strength of anything less than a ref with
 * `verifiedAt` on it, and a ref cannot be built here without one.
 *
 * ## Why not a retention cap instead
 *
 * A cap is smaller, and it used to break something. `catalog_connector_run.
 * snapshotId` is "also the snapshot this run wrote, and the durable run id" —
 * one identifier across all three — and `dropSnapshot` deleted both the rows
 * *and* the `catalog_snapshot` row, so a cap would have left every run older
 * than the window naming a snapshot that has no record anywhere.
 *
 * The distinction that dissolved it: what makes the history resolvable is
 * *keeping the record*, and what makes it resolvable **to data** is keeping the
 * bytes. Those are separable. `dropSnapshot` now keeps the record as a
 * tombstone — see `SnapshotRef.droppedAt` — so a dropped snapshot is still
 * named, still attributed, and still says how large it was; what it no longer
 * has is the data, and every read of it refuses out loud rather than answering
 * with an empty result.
 *
 * That fixes the correctness objection and none of the rest. A tombstone can
 * say a snapshot was 27 million rows and cannot hand any of them back, which is
 * what this file is for: an archive is what makes a drop *recoverable* rather
 * than merely *honest*. Neither of them decides when anything should be
 * dropped — there is still no timer here and none in the catalog.
 *
 * ## Called by a host, never by a commit
 *
 * There is no timer here and no hook on the write path. The ClickHouse store's
 * `pruneSnapshots` already made this argument for the destructive case — "a
 * store that quietly enforced a retention window would be breaking that promise
 * on a schedule nobody chose" — and it applies with less force to a copy that
 * loses nothing, but the question of *who decides* has an answer already and
 * this follows it.
 */
export async function archiveSnapshot(input: {
  type: CatalogObjectTypeDef;
  snapshotId: string;
  /** The snapshot's rows, in `_row` order — a store's `streamSnapshot`. */
  rows: AsyncIterable<Record<string, unknown>>;
  /** What the snapshot says it holds. A disagreement is a refusal, not a note. */
  expectedRowCount: number;
  store: ArchiveStore;
  /** Directory the archive goes in, from {@link archivePathFor}. */
  path: string;
  /** Recorded on the ref, for a console that has to say where the bytes are. */
  disk?: string;
  rowGroupRows?: number;
}): Promise<SnapshotArchiveRef> {
  const { type, snapshotId, rows, expectedRowCount, store, path } = input;
  const columns = archiveColumns(type);
  if (columns.length === 0) {
    throw new Error(
      `"${type.name}" has no properties, so there is nothing of snapshot ${snapshotId} to archive. A parquet file with no columns is not a file this can write or read back.`,
    );
  }

  const partPath = `${path}/${ARCHIVE_PART_NAME}`;
  const written = await writeArchivePart({
    rows,
    columns,
    store,
    path: partPath,
    expectedRowCount,
    describe: `snapshot ${snapshotId} of "${type.name}"`,
    rowGroupRows: input.rowGroupRows ?? ARCHIVE_ROW_GROUP_ROWS,
    kvMetadata: [
      { key: 'catalog.objectType', value: type.name },
      { key: 'catalog.snapshotId', value: snapshotId },
    ],
  });

  const verified = await verifyArchivePart({
    store,
    path: partPath,
    columns,
    expected: written,
  });

  const writtenAt = new Date().toISOString();
  const manifest: SnapshotArchiveManifest = {
    version: 1,
    objectType: type.name,
    snapshotId,
    format: 'parquet',
    rowCount: written.rowCount,
    bytes: written.bytes,
    checksum: written.checksum,
    writtenAt,
    columns: type.properties.map((property) => ({
      name: property.name,
      type: property.type,
      parquetType: parquetTypeFor(property.type),
    })),
    writer: 'nestjs-catalog-pipeline/snapshot-archive@1',
  };
  await store.put(
    `${path}/${ARCHIVE_MANIFEST_NAME}`,
    new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
  );

  return {
    format: 'parquet',
    ...(input.disk === undefined ? {} : { disk: input.disk }),
    path,
    rowCount: written.rowCount,
    bytes: written.bytes,
    checksum: written.checksum,
    writtenAt,
    verifiedAt: verified,
  };
}

/** What one pass over the rows produced. */
interface ArchiveTally {
  rowCount: number;
  bytes: number;
  checksum: string;
}

/**
 * Encode the rows and put them through the sink, counting and hashing on the way.
 *
 * The count and the hash are taken **here**, from the same values handed to the
 * encoder, rather than from the source or from the file. Taken from the source
 * they would not notice a row the encoder dropped; taken from the file's footer
 * they would agree with a corrupt file about its own corruption.
 *
 * The row count is checked **before the sink is finished**, so a snapshot that
 * streamed short leaves no object at all rather than a complete-looking archive
 * that has to be found and removed. The two counts come from different
 * statements over one immutable snapshot and are meant to agree; a disagreement
 * means the snapshot moved under the read, and the archive of it is worthless
 * whichever way it moved.
 */
async function writeArchivePart(input: {
  rows: AsyncIterable<Record<string, unknown>>;
  columns: ArchiveColumn[];
  store: ArchiveStore;
  path: string;
  expectedRowCount: number;
  describe: string;
  rowGroupRows: number;
  kvMetadata: Array<{ key: string; value: string }>;
}): Promise<ArchiveTally> {
  const parquet = await importOptional<ParquetWriterModule>('hyparquet-writer', 'parquet writer');
  const hash = createHash('sha256');
  let rowCount = 0;

  /**
   * Encode, hash, and hand on — in that order, and all three on the same value.
   *
   * The hash is taken from the row **as it is about to be written**, not as it
   * arrived, so that it can be compared against the same rows read back without
   * either side having to remember to apply the encoding a second time. Getting
   * that wrong would not fail loudly: it would make every archive with a `json`
   * column fail verification, which reads exactly like a corrupt archive.
   */
  const encoded = async function* (): AsyncGenerator<Record<string, unknown>> {
    for await (const row of input.rows) {
      const out: Record<string, unknown> = {};
      for (const column of input.columns) out[column.name] = archiveValue(row[column.name], column);
      hash.update(canonicalRow(out, input.columns));
      rowCount += 1;
      yield out;
    }
  };

  const sink = await input.store.open(input.path);
  let settled = false;
  try {
    const writer = sinkWriter(new parquet.ByteWriter(), sink);
    await parquet.parquetWriteRows({
      writer,
      rows: encoded(),
      // Without this file's own `text` note, which the encoder has no use for
      // and which would ride along into the column spec it builds.
      columns: input.columns.map(({ name, type, nullable }) => ({ name, type, nullable })),
      rowGroupSize: input.rowGroupRows,
      kvMetadata: input.kvMetadata,
    });
    if (rowCount !== input.expectedRowCount) {
      throw new Error(
        `${input.describe} reports ${input.expectedRowCount} rows and ${rowCount} were read out of it. Those are two counts of one immutable snapshot and they are meant to agree, so nothing is written — a copy short by rows nobody can name is worse than no copy.`,
      );
    }
    await sink.finish();
    settled = true;
    return { rowCount, bytes: writer.offset, checksum: hash.digest('hex') };
  } finally {
    // Only when `finish` was not reached. Aborting a finished sink would remove
    // the object this just wrote, and the abort would be the last thing to run.
    if (!settled) await sink.abort().catch(() => undefined);
  }
}

/**
 * One row as the bytes that go into the checksum.
 *
 * The column order is the archive's, not the object's key order, so two rows
 * with the same values hash the same however the driver happened to build them.
 * A row separator that cannot occur inside `JSON.stringify` output keeps
 * `["ab"]` and `["a","b"]` from colliding.
 */
function canonicalRow(row: Record<string, unknown>, columns: ArchiveColumn[]): string {
  const values = columns.map((column) => {
    const value = row[column.name];
    return value === undefined ? null : value;
  });
  return `${JSON.stringify(values)}\n`;
}

/**
 * Wire the encoder's buffer to a sink, flushing between row groups.
 *
 * Four members replaced on a `ByteWriter` the module handed over, which is how
 * the library's own `fileWriter` does it — every `appendX` the encoder calls is
 * left exactly as it was, so nothing here can disagree with the encoder about
 * how a value is laid out.
 *
 * The flush point is between row groups and nowhere else, and that is forced
 * rather than chosen: `ensure` is synchronous in the writer contract, so a sink
 * that has to await cannot flush from it. What follows is the memory bound —
 * one encoded row group is held before it can be handed on — which is why
 * {@link ARCHIVE_ROW_GROUP_ROWS} is the number that matters in this file.
 */
function sinkWriter(writer: ArchiveWriter, sink: ArchiveSink): ArchiveWriter {
  const drain = async (): Promise<void> => {
    if (writer.index === 0) return;
    // A copy, not a view. The buffer is reused the moment `index` goes back to
    // zero, so a view handed to the sink would be rewritten underneath an
    // in-flight upload — and the corruption would land in the middle of a row
    // group rather than anywhere a length check would notice.
    const chunk = new Uint8Array(writer.buffer.slice(0, writer.index));
    writer.index = 0;
    await sink.append(chunk);
  };

  writer.flush = drain;
  writer.finish = drain;
  // Both throw for the reason `fileWriter`'s do: the bytes have left. Returning
  // what is still in the buffer would be returning the last row group and
  // calling it the file.
  writer.getBuffer = () => {
    throw new Error('An archive writer streams its bytes to a sink; there is no buffer to take.');
  };
  writer.getBytes = () => {
    throw new Error('An archive writer streams its bytes to a sink; there are no bytes to take.');
  };
  return writer;
}

/**
 * Read the archive back and confirm it is the thing that was written.
 *
 * Through {@link parquetRecordsFrom}, which is the reader every later read of
 * this file will use — including its refusal of column types it cannot decode,
 * which runs before the first row. Verifying with anything else would confirm
 * that *a* parquet reader can read it, and the only question worth answering is
 * whether *this* one can.
 *
 * Both numbers, and they fail differently. The count catches an archive that is
 * short. The checksum catches one that is complete and wrong — the same row
 * count with a value changed — which is the failure a count cannot see and the
 * one that would otherwise be discovered by somebody reading the archive a year
 * from now.
 */
async function verifyArchivePart(input: {
  store: ArchiveStore;
  path: string;
  columns: ArchiveColumn[];
  expected: ArchiveTally;
}): Promise<string> {
  const file = await input.store.read(input.path);
  const hash = createHash('sha256');
  let rowCount = 0;
  for await (const record of parquetRecordsFrom(file, input.path)) {
    if (record === null || typeof record !== 'object') {
      throw new Error(
        `Reading ${input.path} back produced a ${typeof record} where a row was expected. The archive is not recorded.`,
      );
    }
    hash.update(canonicalRow(intoRecord(record), input.columns));
    rowCount += 1;
  }

  const checksum = hash.digest('hex');
  if (rowCount !== input.expected.rowCount) {
    throw new Error(
      `${input.path} was written with ${input.expected.rowCount} rows and reads back as ${rowCount}. The archive is not recorded and nothing has been deleted.`,
    );
  }
  if (checksum !== input.expected.checksum) {
    throw new Error(
      `${input.path} holds ${rowCount} rows, which is the right number, and they do not hash to what was written — so at least one value changed on the way through. The archive is not recorded and nothing has been deleted.`,
    );
  }
  return new Date().toISOString();
}

/** A read-back row as a record, without asserting it is one. */
function intoRecord(value: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, held] of Object.entries(value)) out[key] = held;
  return out;
}

/**
 * An archive on the local filesystem.
 *
 * Real, and the reference implementation for the storage-backed ones: a host
 * that mounts a volume can use this as it stands, and a media-disk or S3 sink is
 * the same three methods with `append` becoming an uploaded part. It is also
 * what the tests here run against, so the contract above is exercised rather
 * than described.
 *
 * The temporary-name-and-rename is not a convenience. {@link ArchiveSink}
 * requires that nothing appear at the destination before `finish`, and on a
 * filesystem a rename within a directory is the only cheap way to get it.
 */
export function localArchiveStore(root: string): ArchiveStore {
  const resolve = (path: string): string => join(root, path);
  return {
    async open(path: string): Promise<ArchiveSink> {
      const target = resolve(path);
      await mkdir(dirname(target), { recursive: true });
      const staging = `${target}.partial`;
      const handle = await open(staging, 'w');
      let closed = false;
      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        await handle.close();
      };
      return {
        async append(chunk: Uint8Array): Promise<void> {
          await handle.write(chunk);
        },
        async finish(): Promise<void> {
          await close();
          await rename(staging, target);
        },
        async abort(): Promise<void> {
          await close();
          await rm(staging, { force: true });
        },
      };
    },
    async read(path: string): Promise<RandomAccessBytes> {
      const target = resolve(path);
      const info = await stat(target);
      return {
        byteLength: info.size,
        async slice(start: number, end?: number): Promise<ArrayBuffer> {
          const to = end ?? info.size;
          const chunks: Buffer[] = [];
          const stream = createReadStream(target, { start, end: to - 1 });
          for await (const chunk of stream) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const joined = Buffer.concat(chunks);
          return joined.buffer.slice(joined.byteOffset, joined.byteOffset + joined.byteLength);
        },
      };
    },
    async put(path: string, bytes: Uint8Array): Promise<void> {
      const target = resolve(path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    },
  };
}
