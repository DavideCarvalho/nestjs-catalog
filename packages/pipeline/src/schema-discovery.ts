import {
  CATALOG_RESERVED_COLUMNS,
  type CatalogConnector,
  type CatalogObjectTypeDef,
  type ConnectorKind,
  type ScalarType,
  isReservedColumn,
} from '@dudousxd/nestjs-catalog';
import { SOURCES, type SqlDescription, describeSql, toBufferedFetchResult } from './sources';

/**
 * Asking a connector what its source actually looks like.
 *
 * WHY THIS EXISTS
 * ---------------
 * A connector cannot create the type it loads into: `appendRowsAsSystem` looks
 * the type up in the registry and refuses when it is absent, so the only way one
 * comes into existence is a publisher — a decorated entity, or a
 * `PUT /publish/:type/schema` body somebody wrote. That is deliberate and stays
 * that way (see below). What it costs is that pointing the catalog at a table
 * nobody has written an entity for means writing the schema out by hand, column
 * by column, from a database somebody has to open a client against.
 *
 * This closes that gap from the other end: the connector runs its own configured
 * query, reads the columns off the answer, and REPORTS them. A person looks at
 * the report and confirms it, and confirming is what creates the type.
 *
 * WHY IT CREATES NOTHING
 * ----------------------
 * Nothing in this file writes. It does not call `upsertType`, it holds no store,
 * and the route that serves it commits nothing. That is not an oversight to be
 * tidied up later — a connector that invented types would grow the catalog by
 * accident, and the name it invented would come from the shape of a query rather
 * than from a person. The value of a catalog is that every type in it was named
 * on purpose. Discovery gives a person the tedious part; the naming, the
 * inclusion and the confirmation stay theirs.
 *
 * WHY IT RETURNS NO VALUES
 * ------------------------
 * Column names, types and counts — never a sampled value. For the non-SQL kinds
 * this reads real records out of somebody's source, and a route that echoed them
 * back would be a data-export endpoint wearing a schema-tool's name. The counts
 * are what a person actually needs to judge an inference ("string in 40 of 40
 * records" is convincing; "string in 2 of 40" is not), and they leak nothing.
 *
 * WHY DRIFT IS THE PART THAT MATTERS
 * ----------------------------------
 * The first discovery of a source happens once. Drift happens forever: a source
 * gains a column, widens one, or has one quietly retyped by a migration
 * upstream, and the load keeps succeeding — the extra column is dropped on the
 * floor by the store, and the retyped one is coerced into whatever the catalog
 * still believes. Both are silent. Comparing what the source reports now against
 * what the type already says costs one in-memory registry lookup, so a
 * re-discovery of an existing type answers the question that is asked far more
 * often than "what is in there".
 */

/** Where a discovery's column list came from, which is what it can promise. */
export type DiscoveryBasis =
  /** The driver described the result set. Names and types are the source's own. */
  | 'driver'
  /** Read off sampled records. An inference, and never more than that. */
  | 'sample';

export type ColumnConfidence =
  /** The source stated it. A driver type id mapped cleanly onto a catalog type. */
  | 'reported'
  /** Concluded from what was seen. Consistent across the sample, unproven beyond it. */
  | 'inferred'
  /** Nothing could be concluded. Deliberately not a guess — see {@link DiscoveredColumn.type}. */
  | 'unknown';

export interface DiscoveredColumn {
  /**
   * The column exactly as the source spells it, which is also what the property
   * has to be called.
   *
   * Not tidied into `firstName`, and this is the single most consequential
   * decision in the file. The warehouse store looks every field up as
   * `row[property.name]` — a load matches records to properties by property
   * NAME, not by the `columnName` mapping, which only decides the physical
   * column. A connector with no transform stores records exactly as they
   * arrive, so a type whose property is `firstName` fed by a source column
   * `first_name` writes null into that column on every run, forever, and the
   * load reports success. The store refuses only the case where *nothing*
   * matches; a schema that was tidied column by column matches nothing and
   * fails loudly, and one where half the names happened to be single words
   * matches partially and does not.
   *
   * So the proposal takes the source's spelling and the catalog's cosmetic
   * layer does the tidying afterwards: `displayName` is Tier 0, editable in the
   * console, and needs no migration.
   */
  name: string;
  /**
   * The catalog type, or **null** when discovery reached no conclusion.
   *
   * `null` is not the same as the `unknown` scalar. `unknown` is a decision — a
   * person looked at a column, decided nothing better fits, and the store gives
   * it a TEXT column. `null` is the absence of one, and the console refuses to
   * include such a column until somebody chooses. Defaulting it to `string`
   * instead would be the exact failure this whole file exists to avoid: a wrong
   * type becomes a wrong column in a lake nobody re-checks, and the load that
   * fills it succeeds every night.
   */
  type: ScalarType | null;
  confidence: ColumnConfidence;
  /**
   * What the source called it, in the source's own vocabulary — a driver type
   * id, or the shapes seen in the sample with their counts. Never a value.
   */
  sourceType: string;
  /** `null` where the source did not say. Postgres never says over a plain query. */
  nullable: boolean | null;
  /** Why this column is what it is, when that is not obvious from the type alone. */
  note?: string;
}

/**
 * What changed since the type was written down.
 *
 * `retyped` reports only columns discovery could type: an untyped column cannot
 * be said to have changed, and reporting one as drift would make every
 * re-discovery of a source with one odd column look like an incident.
 */
export interface SchemaDrift {
  /** In the source, absent from the type. These are dropped by the store today. */
  added: string[];
  /** On the type, absent from the source. These load as null today. */
  removed: string[];
  retyped: Array<{ property: string; was: ScalarType; now: ScalarType }>;
}

export interface ConnectorSchemaDiscovery {
  connectorId: string;
  connectorName: string;
  kind: ConnectorKind;
  targetType: string;
  /** Whether `targetType` already exists. False is the "this would create it" case. */
  typeExists: boolean;
  basis: DiscoveryBasis;
  /** How many records the inference looked at. Always 0 for a driver description. */
  sampled: number;
  /**
   * One sentence stating what this discovery can and cannot prove, carried in
   * the payload rather than left to the screen. Any console rendering this — or
   * any script piping it into a file — should be able to repeat the caveat
   * without having read this module.
   */
  caveat: string;
  columns: DiscoveredColumn[];
  /** `null` when the type does not exist yet: there is nothing to have drifted from. */
  drift: SchemaDrift | null;
}

export interface DiscoverSchemaInput {
  /**
   * The connector with its connection already folded in — `applyConnection`'s
   * output, exactly as the runner fetches with. Discovery that resolved the
   * address differently from the run would describe a different source from the
   * one that loads.
   */
  connector: CatalogConnector;
  secret?: string;
  /** The type as it stands, when it exists. What drift is measured against. */
  existing?: CatalogObjectTypeDef;
  /** How many records a sampled inference looks at. See {@link SAMPLE_LIMIT}. */
  sampleLimit?: number;
}

/**
 * How many records an inference reads.
 *
 * Enough that a column which is null in the first handful is usually not null in
 * all of them, and small enough that pressing the button is cheap. It bounds
 * what is INSPECTED, not what the source hands over — no fetcher here takes a
 * row limit, and inventing one per kind would mean discovery reading a source
 * differently from the way the run does.
 */
export const SAMPLE_LIMIT = 200;

/**
 * Run the connector's own source, read the shape, report it. Writes nothing.
 *
 * The read is the same read a run does, through the same fetcher, which is the
 * point: a discovery that used a different code path could describe columns the
 * load will never produce. What it deliberately does NOT do is keep the
 * fetcher's `state` — an S3 or SQL fetcher hands back the watermark it reached,
 * and persisting that here would mean pressing "discover" silently marked a
 * batch of objects as already read, so the next run skipped them. Discovery
 * moves nothing.
 */
export async function discoverConnectorSchema(
  input: DiscoverSchemaInput,
): Promise<ConnectorSchemaDiscovery> {
  const { connector, secret, existing } = input;

  if (connector.workflowId) {
    throw new Error(
      `"${connector.name}" takes its source from workflow ${connector.workflowId}, so its own kind and config are not read at all. Discover from the graph's source node instead — describing this connector's config would describe a source that never loads.`,
    );
  }

  const described =
    connector.kind === 'sql'
      ? await describeFromDriver(connector, secret)
      : await describeFromSample(connector, secret, input.sampleLimit ?? SAMPLE_LIMIT);

  const columns = flagUnusableNames(described.columns);

  return {
    connectorId: connector.id,
    connectorName: connector.name,
    kind: connector.kind,
    targetType: connector.targetType,
    typeExists: existing !== undefined,
    basis: described.basis,
    sampled: described.sampled,
    caveat: withTransformCaveat(described.caveat, connector),
    columns,
    drift: existing ? driftFrom(existing, columns) : null,
  };
}

/**
 * The caveat that outranks the others: this is the shape BEFORE the transform.
 *
 * A transform sits between the fetch and the publish, and what it emits is what
 * has to match the type — so on a connector that has one, every column here is
 * an input to code, not a column of the lake. Reported rather than refused: the
 * source's column list is exactly what somebody writing that transform needs,
 * and the alternative is them reading it out of a database client anyway.
 *
 * Not solvable by running the transform over the sample, either. The SQL path
 * reads no rows at all — that is the point of `LIMIT 0` — so there would be
 * nothing to run it over on the one kind where the description is otherwise
 * exact.
 */
function withTransformCaveat(caveat: string, connector: CatalogConnector): string {
  if (!connector.transformId) return caveat;
  return `${caveat} These are the columns the SOURCE returns; this connector runs a transform afterwards, and the type has to match what the transform emits, not this.`;
}

/** The SQL path: the driver describes the result set and no row is read. */
async function describeFromDriver(
  connector: CatalogConnector,
  secret: string | undefined,
): Promise<{
  basis: DiscoveryBasis;
  sampled: number;
  caveat: string;
  columns: DiscoveredColumn[];
}> {
  const description = await describeSql({ connector, secret });
  return {
    basis: 'driver',
    sampled: 0,
    caveat:
      description.dialect === 'postgres'
        ? 'Read from the driver, so the names and types are the database\'s own — but a plain query tells Postgres nothing about nullability, so every column here says "not stated".'
        : "Read from the driver, so the names, types and NOT NULL flags are the database's own. No row was read.",
    columns: columnsFromSqlDescription(description),
  };
}

/**
 * The non-SQL path: read records, and be honest that this is an inference.
 *
 * An HTTP endpoint, a CSV drop and a bucket of NDJSON have no schema to ask for.
 * The shape has to come from what arrived, which means a column that is absent
 * from the sample does not exist as far as this is concerned, and a column whose
 * every sampled value is null has no type at all. Both are reported as such
 * rather than smoothed over.
 */
async function describeFromSample(
  connector: CatalogConnector,
  secret: string | undefined,
  limit: number,
): Promise<{
  basis: DiscoveryBasis;
  sampled: number;
  caveat: string;
  columns: DiscoveredColumn[];
}> {
  const fetcher = SOURCES[connector.kind];
  if (!fetcher) {
    throw new Error(
      `Connector kind "${connector.kind}" has no fetcher, so there is nothing to read a shape from.`,
    );
  }

  // The limit goes to the buffer rather than to a `.slice` afterwards, so a
  // source that hands rows over one at a time is asked for `limit` of them and
  // then stopped. On a source that returns an array this is the same slice it
  // always was; on a streamed one it is the difference between describing a
  // table and reading it.
  const fetched = await toBufferedFetchResult(
    await fetcher({
      connector,
      secret,
      // Empty state and `full` on purpose. An incremental read would describe
      // only what changed since the last run, which on a quiet source is
      // nothing at all — a discovery that reports no columns because the load is
      // up to date is worse than useless.
      state: {},
      mode: 'full',
    }),
    limit,
  );
  const records = fetched.records;

  return {
    basis: 'sample',
    sampled: records.length,
    caveat:
      records.length === 0
        ? 'The source returned no records, so there is nothing to infer a shape from. This is not the same as a source with no columns.'
        : `Inferred from ${records.length} record${records.length === 1 ? '' : 's'}. A sample cannot prove a type or prove that a column is never null — it can only report what was consistent across what it read.`,
    columns: columnsFromRecords(records),
  };
}

/**
 * The two names a column can carry that the catalog cannot accept as they are.
 *
 * **A duplicate.** `SELECT a.id, b.id FROM a JOIN b` is a perfectly ordinary
 * query and both drivers describe two fields called `id` — but a row arrives as
 * an object, so one of them has already overwritten the other before anything
 * here sees it. That is data loss in the connector's own query, invisible in
 * every run report, and a discovery is the one moment somebody is looking at the
 * column list closely enough to be told.
 *
 * **A reserved name.** `_snapshot_id`, `_batch` and `_row` are the store's own
 * bookkeeping, and `CATALOG_RESERVED_COLUMNS` is imported rather than restated
 * so this cannot drift from what the publish path will actually refuse. Left to
 * the confirmation, the refusal arrives as a 400 about a column somebody has
 * already approved.
 *
 * Flagged, never silently renamed. A generated `id2` is a name nobody chose
 * appearing in a catalog whose whole claim is that its names were chosen.
 */
export function flagUnusableNames(columns: DiscoveredColumn[]): DiscoveredColumn[] {
  const counts = new Map<string, number>();
  for (const column of columns) {
    counts.set(column.name, (counts.get(column.name) ?? 0) + 1);
  }

  return columns.map((column) => {
    let note = column.note;
    if ((counts.get(column.name) ?? 0) > 1) {
      note = appendNote(
        note,
        `The query returns ${counts.get(column.name)} columns called "${column.name}". A record is an object, so only the last one survives — qualify them with different aliases in the query.`,
      );
    }
    if (isReservedColumn(column.name)) {
      note = appendNote(
        note,
        `"${column.name}" is one of the catalog's own bookkeeping columns (${CATALOG_RESERVED_COLUMNS.join(', ')}), so it cannot become a property. Alias it in the query.`,
      );
    }
    return note === column.note ? column : { ...column, note };
  });
}

function appendNote(existing: string | undefined, addition: string): string {
  return existing ? `${existing} ${addition}` : addition;
}

/** What the type says now, against what the source says now. */
export function driftFrom(
  existing: CatalogObjectTypeDef,
  columns: DiscoveredColumn[],
): SchemaDrift {
  const discovered = new Map(columns.map((column) => [column.name, column]));
  const known = new Map(existing.properties.map((property) => [property.name, property]));

  const retyped: SchemaDrift['retyped'] = [];
  for (const [name, column] of discovered) {
    const property = known.get(name);
    if (!property || column.type === null || column.type === property.type) continue;
    retyped.push({ property: name, was: property.type, now: column.type });
  }

  return {
    added: [...discovered.keys()].filter((name) => !known.has(name)),
    removed: [...known.keys()].filter((name) => !discovered.has(name)),
    retyped,
  };
}

/* ------------------------------------------------------------------ *
 * SQL: what the two drivers actually hand back
 * ------------------------------------------------------------------ */

/**
 * A driver's description of a result set, as catalog columns.
 *
 * Exported and pure, because this is where the whole SQL half of discovery is
 * decided — which oid is a date, which MySQL type id is a boolean and which is a
 * one-digit integer — and none of that should need a database to check. The
 * flagging in {@link flagUnusableNames} is deliberately NOT folded in here: the
 * sample path needs it too, and applying it twice would say everything twice.
 */
export function columnsFromSqlDescription(description: SqlDescription): DiscoveredColumn[] {
  return description.fields.map((field) => {
    const resolved =
      description.dialect === 'postgres'
        ? fromPostgresOid(field.typeId)
        : fromMysqlType(field.typeId, field.length, field.charset);

    return {
      name: field.name,
      type: resolved.type,
      confidence: resolved.type === null ? 'unknown' : resolved.confidence,
      sourceType: resolved.sourceType,
      nullable: field.nullable ?? null,
      ...(resolved.note ? { note: resolved.note } : {}),
    };
  });
}

interface ResolvedType {
  type: ScalarType | null;
  confidence: ColumnConfidence;
  sourceType: string;
  note?: string;
}

/**
 * Postgres type OIDs, as `pg` reports them in `result.fields[].dataTypeID`.
 *
 * A fixed table rather than a name lookup, because `pg` returns the oid and
 * nothing else: resolving it to a name means querying `pg_type`, which is a
 * second round trip against a database this is only meant to glance at. The
 * oids of the built-in types are stable across every Postgres release — they are
 * literal constants in the catalog bootstrap — so the table cannot rot.
 *
 * Two deliberate absences. `time`/`timetz` map to `string`, not to `date`,
 * because the store coerces a `date` column with `new Date("14:30:00")`, which
 * is Invalid Date, which is written as NULL — a time-of-day column typed as a
 * date would load as an entire column of nulls and nothing would report an
 * error. And an oid that is not in this table resolves to nothing at all
 * (`interval`, `bytea`, an enum, a domain, anything a user defined): the oid is
 * handed back in `sourceType` so a person can look it up, which is a far better
 * answer than a `string` column that quietly stringifies an object.
 */
const POSTGRES_OIDS = new Map<number, ScalarType>([
  [16, 'boolean'],
  [18, 'string'], // char
  [19, 'string'], // name
  [20, 'number'], // int8
  [21, 'number'], // int2
  [23, 'number'], // int4
  [25, 'string'], // text
  [26, 'number'], // oid
  [114, 'json'],
  [700, 'number'], // float4
  [701, 'number'], // float8
  [1042, 'string'], // bpchar
  [1043, 'string'], // varchar
  [1082, 'date'],
  [1083, 'string'], // time — see the note above
  [1114, 'date'], // timestamp
  [1184, 'date'], // timestamptz
  [1266, 'string'], // timetz — see the note above
  [1700, 'number'], // numeric
  [2950, 'uuid'],
  [3802, 'json'], // jsonb
  // Arrays arrive as JS arrays, which only the json type can hold.
  [1000, 'json'],
  [1005, 'json'],
  [1007, 'json'],
  [1009, 'json'],
  [1015, 'json'],
  [1016, 'json'],
  [1115, 'json'],
  [1182, 'json'],
  [1185, 'json'],
  [3807, 'json'],
]);

/** Which oids are a time of day, so the mapping above can explain itself. */
const POSTGRES_TIME_OIDS = new Set([1083, 1266]);

function fromPostgresOid(oid: number | undefined): ResolvedType {
  if (oid === undefined) {
    return {
      type: null,
      confidence: 'unknown',
      sourceType: 'no type reported',
      note: 'The driver described this column without a type id, so there is nothing to map.',
    };
  }

  const mapped = POSTGRES_OIDS.get(oid);
  if (!mapped) {
    return {
      type: null,
      confidence: 'unknown',
      sourceType: `oid ${oid}`,
      note: `Nothing is mapped to Postgres type ${oid} — an interval, a bytea, an enum or a type somebody defined. Choose what it should be rather than letting it be guessed.`,
    };
  }

  return {
    type: mapped,
    confidence: 'reported',
    sourceType: `oid ${oid}`,
    ...(POSTGRES_TIME_OIDS.has(oid)
      ? {
          note: 'A time of day, proposed as text. Stored as a date it would be parsed with `new Date("14:30:00")`, which is not a date, and the column would load entirely null.',
        }
      : {}),
  };
}

/**
 * MySQL column type ids, as `mysql2` reports them in `fields[].columnType`.
 *
 * The protocol's own numbers, unchanged since MySQL 4. Three of them need more
 * than a table:
 *
 * - **TINY.** `TINYINT(1)` is how MySQL spells a boolean and how every ORM
 *   writes one, and `mysql2` reports the display width in `columnLength`. Width
 *   1 is read as a boolean and said so in a note, because it is also a perfectly
 *   good one-digit integer and the person confirming is the one who knows.
 * - **The BLOB family.** `TEXT`, `MEDIUMTEXT` and `LONGTEXT` come back as blob
 *   type ids; what separates them from a real binary blob is the character set,
 *   where 63 means `binary`. Reading the id alone would report every text column
 *   in a MySQL database as untyped, which is most of the columns in most tables.
 * - **BIT and GEOMETRY.** Both arrive as Buffers. A Buffer through the store's
 *   TEXT path is `String(buffer)`, which is the bytes read as UTF-8 — garbage
 *   that looks like data. Left untyped so somebody decides.
 */
const MYSQL_TYPES = new Map<number, ScalarType>([
  [0, 'number'], // decimal
  [2, 'number'], // short
  [3, 'number'], // long
  [4, 'number'], // float
  [5, 'number'], // double
  [7, 'date'], // timestamp
  [8, 'number'], // longlong
  [9, 'number'], // int24
  [10, 'date'], // date
  [11, 'string'], // time — a time of day, see fromPostgresOid
  [12, 'date'], // datetime
  [13, 'number'], // year
  [14, 'date'], // newdate
  [15, 'string'], // varchar
  [245, 'json'],
  [246, 'number'], // newdecimal
  [247, 'string'], // enum
  [248, 'string'], // set
  [253, 'string'], // var_string
  [254, 'string'], // string
]);

const MYSQL_BLOB_TYPES = new Set([249, 250, 251, 252]);
const MYSQL_BINARY_CHARSET = 63;

function fromMysqlType(
  typeId: number | undefined,
  length: number | undefined,
  charset: number | undefined,
): ResolvedType {
  if (typeId === undefined) {
    return {
      type: null,
      confidence: 'unknown',
      sourceType: 'no type reported',
      note: 'The driver described this column without a type id, so there is nothing to map.',
    };
  }

  const sourceType = `mysql type ${typeId}`;

  if (typeId === 1) {
    return length === 1
      ? {
          type: 'boolean',
          confidence: 'inferred',
          sourceType: `${sourceType} (tinyint(1))`,
          note: 'TINYINT(1) is how MySQL spells a boolean, and also how it spells a one-digit integer. Change it to a number if this column counts something.',
        }
      : { type: 'number', confidence: 'reported', sourceType: `${sourceType} (tinyint)` };
  }

  if (MYSQL_BLOB_TYPES.has(typeId)) {
    return charset !== undefined && charset !== MYSQL_BINARY_CHARSET
      ? { type: 'string', confidence: 'reported', sourceType: `${sourceType} (text)` }
      : {
          type: null,
          confidence: 'unknown',
          sourceType: `${sourceType} (binary)`,
          note: 'A binary column. Stored as text it would be the raw bytes read as UTF-8, which looks like data and is not.',
        };
  }

  const mapped = MYSQL_TYPES.get(typeId);
  if (!mapped) {
    return {
      type: null,
      confidence: 'unknown',
      sourceType,
      note: `Nothing is mapped to MySQL type ${typeId} — a bit, a geometry, or something this table does not cover. Choose what it should be rather than letting it be guessed.`,
    };
  }

  return {
    type: mapped,
    confidence: 'reported',
    sourceType,
    ...(typeId === 11
      ? {
          note: 'A time of day, proposed as text. Stored as a date it would be parsed with `new Date("14:30:00")`, which is not a date, and the column would load entirely null.',
        }
      : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Records: what can honestly be concluded from a sample
 * ------------------------------------------------------------------ */

/** ISO-8601 as a `Date` writes it, which is what a JSON API almost always sends. */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

interface Tally {
  /** How many sampled records carried the key at all. */
  present: number;
  /** How many carried it as null. Absent counts as null-ish for nullability. */
  nulls: number;
  /** Shape name → how many records showed it. */
  kinds: Map<ScalarType, number>;
  /** Of the non-null string values, how many parse as ISO-8601. */
  isoLike: number;
}

function columnsFromRecords(records: readonly unknown[]): DiscoveredColumn[] {
  const tallies = new Map<string, Tally>();

  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    for (const key of Object.keys(record)) {
      const tally = tallies.get(key) ?? { present: 0, nulls: 0, kinds: new Map(), isoLike: 0 };
      count(tally, Reflect.get(record, key));
      tallies.set(key, tally);
    }
  }

  return [...tallies].map(([name, tally]) => toSampledColumn(name, tally, records.length));
}

/** One value of one column, folded into what has been seen of it so far. */
function count(tally: Tally, value: unknown): void {
  tally.present += 1;
  if (value === null || value === undefined) {
    tally.nulls += 1;
    return;
  }
  const kind = kindOf(value);
  tally.kinds.set(kind, (tally.kinds.get(kind) ?? 0) + 1);
  if (typeof value === 'string' && ISO_8601.test(value)) tally.isoLike += 1;
}

/**
 * One JS value, as the coarsest thing the catalog can say about it.
 *
 * A `Date` only ever arrives from an inline connector or a driver that parsed
 * one; JSON has no date, which is exactly why an ISO-looking string is reported
 * as a string and not promoted.
 */
function kindOf(value: unknown): ScalarType {
  if (value instanceof Date) return 'date';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number' || typeof value === 'bigint') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'json';
}

function toSampledColumn(name: string, tally: Tally, sampled: number): DiscoveredColumn {
  const nonNull = [...tally.kinds.values()].reduce((total, count) => total + count, 0);
  // Missing from a record is as good as null for the purposes of a column that
  // has to hold every row. Never having SEEN a null is not proof of the
  // opposite, so that case reports "not stated" rather than `false`.
  const everNull = tally.nulls > 0 || tally.present < sampled;
  const nullable = everNull ? true : null;
  const sourceType = describeKinds(tally, sampled);

  if (nonNull === 0) {
    return {
      name,
      type: null,
      confidence: 'unknown',
      sourceType,
      nullable: true,
      note: `Null or absent in all ${sampled} sampled records, so there is nothing to infer a type from. A column that is always empty in a sample is usually not always empty in the source.`,
    };
  }

  if (tally.kinds.size > 1) {
    return {
      name,
      type: null,
      confidence: 'unknown',
      sourceType,
      nullable,
      note: `The sample disagrees with itself (${[...tally.kinds.keys()].join(' and ')}), so no single type is right for all of it. A CSV column of numbers with one "n/a" in it looks exactly like this.`,
    };
  }

  const [kind] = [...tally.kinds.keys()];
  const isoNote =
    kind === 'string' && tally.isoLike === nonNull
      ? 'Every sampled value reads as an ISO-8601 timestamp. Proposed as text because a sample cannot prove that, and a value that fails to parse becomes null rather than an error — set it to a date if that is what it is.'
      : undefined;

  return {
    name,
    type: kind,
    confidence: 'inferred',
    sourceType,
    nullable,
    ...(isoNote ? { note: isoNote } : {}),
  };
}

/** "string ×38, null ×2 of 40 records" — shapes and counts, never a value. */
function describeKinds(tally: Tally, sampled: number): string {
  const parts = [...tally.kinds].map(([kind, count]) => `${kind} ×${count}`);
  const missing = sampled - tally.present;
  if (tally.nulls > 0) parts.push(`null ×${tally.nulls}`);
  if (missing > 0) parts.push(`absent ×${missing}`);
  return `${parts.join(', ')} of ${sampled} records`;
}
