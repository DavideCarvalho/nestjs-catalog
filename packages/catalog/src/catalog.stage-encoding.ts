/**
 * How a staged batch is written down.
 *
 * `catalog_workflow_stage.rows` is where every row between two nodes sits, and
 * it was a JSON array of row objects — which means every property name is
 * written out again for every row. On the deployment that reads back as 9.04 GB
 * across ~16,233 staged batches in a week, for graphs that are two nodes long.
 *
 * ## Why not just stop staging
 *
 * Because the stage is not a cache. The durable engine checkpoints a step's
 * output so that a crash resumes instead of re-reading the source, and a
 * two-node graph is exactly the case where re-reading the source is the
 * expensive thing. Fusing the nodes and handing the array over in memory is
 * measurably faster and it spends the resume guarantee to get there. This file
 * makes the same guarantee cheaper instead.
 *
 * ## What the measurement said
 *
 * With the shipped code paths, 50,000 rows, the deployment's own column lists
 * and `BATCH_SIZE = 500`: `JSON.stringify` costs 488 ms and `JSON.parse` 285 ms,
 * against 6,302 ms of `INSERT`. So the encoding is 9.4% of the bill *as CPU* and
 * MySQL is 90.6% — which reads like an argument that the encoding does not
 * matter, and is the opposite. `INSERT` time is linear in bytes, and writing the
 * names once per batch rather than once per row halves the bytes. The saving
 * arrives through the `INSERT`, not through the parse.
 *
 * ## The shape
 *
 * A **shape dictionary**, not a single column list:
 *
 * ```json
 * { "enc": "columnar", "v": 1,
 *   "shapes":  [["id", "name"], ["id", "name", "note"]],
 *   "shapeOf": [0, 0, 1, 0],
 *   "values":  [[1, "a"], [2, null], [3, "c", "x"], [4, "d"]] }
 * ```
 *
 * `shapes` holds each **distinct key-set** in the batch, once. `shapeOf[i]`
 * says which one row `i` uses, and `values[i]` runs parallel to it.
 *
 * A single global column list with padding would have been simpler and is
 * wrong, because it has no way to say **absent**. The pipeline's rows are
 * `Record<string, unknown>` and a transform may emit differing shapes; a row
 * that lacks `note` and a row whose `note` is `null` are different facts, and a
 * padded array collapses them into the same `null`. That difference decides
 * whether a sink writes a column or leaves it alone, so collapsing it would
 * change committed data silently. Every sentinel that could stand for "absent"
 * inside a JSON array is also a value a row is entitled to hold, so there is no
 * sentinel available; naming each row's own key-set is the encoding that has
 * the distinction built in rather than bolted on.
 *
 * It also degrades gracefully rather than off a cliff. A batch of 500 rows with
 * 500 different key-sets stores 500 key-sets — the same names a row-oriented
 * encoding would have written, plus one small integer per row. A padded union
 * column list, on the same batch, would store a 500-way-wider row for every row
 * and be far *worse* than what it replaced.
 *
 * ## Key order
 *
 * Preserved exactly, which is **more** than the old encoding managed, and that
 * was worth checking before changing anything.
 *
 * A MySQL `JSON` column does not store the text it was given. It stores a
 * normalised binary document in which an object's members are sorted — by key
 * length, then by bytes — so a row staged as `{zebra, a, Middle_Name, b}` reads
 * back as `{a, b, zebra, Middle_Name}`. Verified against the local server, not
 * assumed. Every staged row has therefore been coming back reordered since the
 * stage existed.
 *
 * Here the names live in `shapes`, a JSON **array**, and arrays keep their
 * order in the same binary format. So a decoded row enumerates in the order the
 * producing node emitted it.
 *
 * Nothing downstream depended on either behaviour, which is why this is safe to
 * change in the fidelity direction. The sink path picks columns from the object
 * type's declared properties and reads each one by name — `MySqlWarehouseStore`
 * builds its `INSERT` column list from `type.properties`, the ClickHouse store
 * builds a fresh name-keyed record per row, and reads normalise back to
 * declared order regardless of what went in. The three places in the codebase
 * where a row's key order does decide something — schema discovery's proposed
 * column order, `csvLines` called without an explicit column list, and the
 * ClickHouse ad-hoc query fallback — none of them read a staged batch: schema
 * discovery samples the connector's fetcher directly, and the export route
 * passes its columns.
 *
 * ## `undefined`, functions, symbols
 *
 * Dropped, key and all — which is what `JSON.stringify` did to them under the
 * old encoding, and what `codeContext` does deliberately for the same reason:
 * `{"k": undefined}` and a missing `k` are the same thing through JSON and
 * different things through a deep-equality check. So a key whose value is one
 * of those three does not enter the row's shape, and the row decodes without
 * it, exactly as it did before.
 *
 * The one case this does not reproduce is a value carrying a `toJSON()` that
 * returns `undefined` — `JSON.stringify` drops that key, and here the key is in
 * the shape and its value serialises to `null`. Reproducing it would mean
 * invoking `toJSON` a second time, on caller code, to find out; the boundary is
 * documented rather than papered over, and no source in this codebase produces
 * such a value (rows arrive from SQL drivers, HTTP JSON, or a transform's
 * return value).
 */

/** The tag every batch written by this build carries. */
export const STAGE_ENCODING = 'columnar';

/**
 * Bumped when {@link ColumnarStageBatch} changes shape in a way an older reader
 * would misread. An older pod meeting a newer version refuses loudly rather
 * than decoding half of it — see {@link classifyStagePayload}.
 */
export const STAGE_ENCODING_VERSION = 1;

/** A staged batch, columnar. See the file comment for the argument. */
export interface ColumnarStageBatch {
  readonly enc: typeof STAGE_ENCODING;
  readonly v: typeof STAGE_ENCODING_VERSION;
  /** The distinct key-sets in this batch, each in its rows' own key order. */
  readonly shapes: ReadonlyArray<readonly string[]>;
  /** Per row, an index into {@link shapes}. */
  readonly shapeOf: readonly number[];
  /** Per row, the values, parallel to `shapes[shapeOf[i]]`. */
  readonly values: ReadonlyArray<readonly unknown[]>;
}

/**
 * What was found in the column, named.
 *
 * A closed union, and {@link decodeStageRows} switches over it exhaustively —
 * so adding a third encoding here without handling it there is a compile error
 * rather than a batch that decodes to nothing at three in the morning.
 */
export type StagePayload =
  | {
      /** The original encoding: a JSON array of row objects, carrying no tag. */
      readonly encoding: 'row-oriented/v0';
      readonly rows: readonly unknown[];
    }
  | {
      readonly encoding: 'columnar/v1';
      readonly batch: ColumnarStageBatch;
    };

function isRowRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether `JSON.stringify` would keep a property holding this value.
 *
 * The three it silently drops. Kept in one predicate so the encoder and the
 * documentation cannot drift apart about which three.
 */
function isSerialisableValue(value: unknown): boolean {
  return value !== undefined && typeof value !== 'function' && typeof value !== 'symbol';
}

/** The keys that will survive serialisation, in the row's own order. */
function serialisableKeys(row: Record<string, unknown>): string[] {
  const keys = Object.keys(row);
  // Scanned before filtering, so the overwhelmingly common batch — no
  // `undefined` anywhere in it — pays one pass and allocates nothing extra.
  for (const key of keys) {
    if (!isSerialisableValue(row[key])) {
      return keys.filter((each) => isSerialisableValue(row[each]));
    }
  }
  return keys;
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Rows in, one columnar batch out.
 *
 * The last shape is remembered and compared before anything is hashed, because
 * a batch whose rows all have the same keys — which is nearly every batch — then
 * costs one array comparison per row and builds no fingerprint string at all.
 * Only a row that differs from its predecessor pays for the dictionary lookup.
 */
export function encodeStageRows(rows: ReadonlyArray<Record<string, unknown>>): ColumnarStageBatch {
  const shapes: string[][] = [];
  const byFingerprint = new Map<string, number>();
  const shapeOf: number[] = [];
  const values: unknown[][] = [];

  let lastKeys: readonly string[] | undefined;
  let lastIndex = 0;

  for (const row of rows) {
    const keys = serialisableKeys(row);

    let at: number;
    if (lastKeys !== undefined && sameKeys(keys, lastKeys)) {
      at = lastIndex;
    } else {
      // The fingerprint is `JSON.stringify` of the key list rather than a join
      // on some separator, because every separator is a character a property
      // name is entitled to contain, and two different key-sets colliding into
      // one fingerprint would hand one row's values another row's names.
      const fingerprint = JSON.stringify(keys);
      const known = byFingerprint.get(fingerprint);
      if (known === undefined) {
        at = shapes.length;
        shapes.push(keys);
        byFingerprint.set(fingerprint, at);
      } else {
        at = known;
      }
      lastIndex = at;
      lastKeys = shapes[at];
    }

    shapeOf.push(at);
    const shape = lastKeys ?? keys;
    const out: unknown[] = new Array(shape.length);
    for (let index = 0; index < shape.length; index += 1) {
      const name = shape[index];
      out[index] = name === undefined ? null : row[name];
    }
    values.push(out);
  }

  return { enc: STAGE_ENCODING, v: STAGE_ENCODING_VERSION, shapes, shapeOf, values };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((each) => typeof each === 'string');
}

/**
 * A fully checked columnar batch — structure, and every index in range.
 *
 * Checked rather than trusted for the reason `readStage` always gave about the
 * old encoding: this is JSON that came out of a database, and the alternative to
 * validating it here is discovering it one `undefined` at a time somewhere that
 * cannot say what went wrong. Everything the decoder indexes into is proved
 * present by this function, which is why the decoder has no recovery paths.
 */
export function isColumnarStageBatch(value: unknown): value is ColumnarStageBatch {
  if (!isRowRecord(value)) return false;
  if (value.enc !== STAGE_ENCODING) return false;
  if (value.v !== STAGE_ENCODING_VERSION) return false;

  const { shapes, shapeOf, values: cells } = value;
  if (!Array.isArray(shapes) || !shapes.every(isStringArray)) return false;
  if (!Array.isArray(shapeOf) || !Array.isArray(cells)) return false;
  if (shapeOf.length !== cells.length) return false;

  return shapeOf.every(
    (at, index) => namesAShape(shapes, at) && fitsShape(shapes, at, cells[index]),
  );
}

/** Row `index` points at a shape this batch actually carries. */
function namesAShape(shapes: string[][], at: unknown): at is number {
  return typeof at === 'number' && Number.isInteger(at) && shapes[at] !== undefined;
}

/** …and carries exactly one value per name in it. Not one fewer, not one more. */
function fitsShape(shapes: string[][], at: number, cells: unknown): boolean {
  const shape = shapes[at];
  return shape !== undefined && Array.isArray(cells) && cells.length === shape.length;
}

/**
 * Name what is in the column, or refuse.
 *
 * The two encodings are disjoint **JSON types** — the old writer only ever
 * called `JSON.stringify` on an `Array<Record<string, unknown>>`, so anything it
 * produced parses back as an array, and this one only ever writes a tagged
 * object. A top-level JSON value cannot be both, so there is no batch for which
 * both branches match and nothing here is inferred from the *contents* of a
 * row. That is what makes the discrimination total rather than a guess: it does
 * not ask what the rows look like, it asks which of two mutually exclusive JSON
 * types the payload is, and then, for the object, reads the tag it was written
 * with.
 *
 * Anything else throws, and does not return an empty batch. An unreadable stage
 * decoded to zero rows would reach `runSink` as "this node produced nothing",
 * and for a full load the sink's own guard turns that into a refusal — but for
 * an *incremental* load it is a legitimate answer, and carry-forward would
 * commit a snapshot that quietly dropped whatever the batch held. The loud
 * failure is the cheap one.
 */
export function classifyStagePayload(stored: unknown): StagePayload {
  if (Array.isArray(stored)) return { encoding: 'row-oriented/v0', rows: stored };
  if (isColumnarStageBatch(stored)) return { encoding: 'columnar/v1', batch: stored };

  const tag = isRowRecord(stored) ? stored.enc : undefined;
  const version = isRowRecord(stored) ? stored.v : undefined;
  if (tag === STAGE_ENCODING) {
    throw new Error(
      `This staged batch is written in "${STAGE_ENCODING}" encoding version ${String(version)}, and this build reads version ${STAGE_ENCODING_VERSION}. It was written by a newer deployment; a rolled-back pod cannot resume a run that a newer one staged.`,
    );
  }
  throw new Error(
    `A staged batch is in an encoding this build does not know: ${
      tag === undefined
        ? `a JSON ${stored === null ? 'null' : typeof stored} with no "enc" tag`
        : `"${String(tag)}"`
    }. A batch is either a JSON array (the original row-oriented encoding) or an object tagged "${STAGE_ENCODING}".`,
  );
}

/**
 * Back into row records, whichever way the batch was written.
 *
 * The switch is exhaustive over {@link StagePayload} and the default branch
 * assigns to `never`, so a third encoding added to that union stops the build
 * here instead of falling through to a silent `[]`.
 */
export function decodeStageRows(stored: unknown): Array<Record<string, unknown>> {
  const payload = classifyStagePayload(stored);
  switch (payload.encoding) {
    case 'row-oriented/v0':
      // Narrowed rather than trusted, exactly as the original reader did: a
      // staged batch is JSON a transform produced, and anything that is not a
      // plain object could not have been written as a row.
      return payload.rows.filter(isRowRecord);
    case 'columnar/v1':
      return fromColumnar(payload.batch);
    default: {
      const unreachable: never = payload;
      throw new Error(`Unhandled staged batch encoding: ${JSON.stringify(unreachable)}`);
    }
  }
}

function fromColumnar(batch: ColumnarStageBatch): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const [index, at] of batch.shapeOf.entries()) {
    const shape = batch.shapes[at];
    const cells = batch.values[index];
    if (shape === undefined || cells === undefined) {
      // Unreachable: `isColumnarStageBatch` proved both present before this ran.
      // Loud rather than skipped, because a row silently dropped here is a row
      // the sink never sees and nobody ever counts.
      throw new Error(
        `Staged row ${index} names shape ${at}, which this batch does not carry. The batch failed to validate after it had already validated.`,
      );
    }
    const row: Record<string, unknown> = {};
    for (const [column, name] of shape.entries()) {
      row[name] = cells[column];
    }
    rows.push(row);
  }
  return rows;
}
