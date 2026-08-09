import type { ClickHouseClient } from '@clickhouse/client';
import type { SnapshotRef } from '@dudousxd/nestjs-catalog';
import { Logger } from '@nestjs/common';

/**
 * Snapshot bookkeeping, kept in ClickHouse rather than beside it.
 *
 * The obvious objection is that ClickHouse is a poor place for mutable
 * metadata: no transactions, no unique constraints, no UPDATE that is not a
 * mutation. All true. The alternative — requiring a MySQL or Postgres next to
 * the warehouse purely to remember which load is current — is worse in the way
 * that matters: it makes the adapter undeployable without a second database,
 * and it puts the pointer that decides what readers see in a system that can be
 * up while the one holding the data is down.
 *
 * So the rows are mutated the way ClickHouse mutates rows: `ReplacingMergeTree`
 * keyed on identity, versioned, with every update written as a new row carrying
 * a higher version. Reads are `FINAL`, which resolves duplicates at query time
 * rather than waiting for a merge. This is the *right* use of that engine — a
 * handful of rows whose old versions nobody will ever want — and it is exactly
 * the use the object tables must not make of it, since collapsing old versions
 * is precisely what would destroy time travel.
 *
 * Deletion is a `deleted` flag and an explicit predicate rather than the
 * engine's `is_deleted` parameter, because whether `SELECT ... FINAL` hides an
 * `is_deleted` row without a cleanup merge has changed across ClickHouse
 * versions, and a snapshot that reappears after a server upgrade is not a
 * failure anyone would look for.
 *
 * ## `deleted` and `dropped_at` are different questions, and that is why there
 * are two columns
 *
 * `deleted` removes the *record*: a row flagged that way is invisible to every
 * query below, and there is no longer any code that sets it. It survives
 * because deployments written by earlier versions of this package have rows
 * carrying it — a `deleteSnapshot` helper was what `dropSnapshot` called, and
 * it is gone — and a predicate dropped from these queries would resurrect every
 * snapshot those deployments meant to be rid of.
 *
 * `dropped_at` removes the *rows*, and keeps the record. That is the state this
 * store should have been producing all along and now does: see
 * {@link SnapshotRecord.droppedAt}.
 */

export const SNAPSHOT_TABLE = 'catalog_ch_snapshot';
export const CURRENT_TABLE = 'catalog_ch_current';

/**
 * Tables this package creates and manages at boot. The object tables —
 * `obj_<type>`, one per published type, plus their `__stage` twins — are
 * deliberately absent: their names are not knowable ahead of time, they are
 * created by the store as types arrive, and no change-management tool should be
 * allowed to reason about them at all.
 */
export function catalogClickHouseManagedTables(): string[] {
  return [SNAPSHOT_TABLE, CURRENT_TABLE];
}

export interface SnapshotRecord {
  typeName: string;
  snapshotId: string;
  principalId: string;
  rowCount: number;
  committed: boolean;
  createdAt: Date;
  committedAt?: Date;
  labels?: Record<string, string>;
  /**
   * When this snapshot's rows were dropped, if they have been. Present makes
   * the record a **tombstone**, and maps to `SnapshotRef.droppedAt` — see that
   * field in the core package for the argument the whole thing rests on.
   *
   * `rowCount` on a tombstone is what the load held at the moment it was
   * dropped, taken immediately before the partitions went. It is as final as a
   * committed snapshot's count, and no later scan can rediscover it.
   */
  droppedAt?: Date;
}

interface SnapshotRow {
  type_name: string;
  snapshot_id: string;
  principal_id: string;
  row_count: string | number;
  committed: number;
  created_at: string;
  committed_at: string | null;
  dropped_at: string | null;
  labels: string;
}

/**
 * A version number that never goes backwards and never repeats in this process.
 *
 * `ReplacingMergeTree` keeps the row with the highest version and picks
 * arbitrarily between ties, so a wall clock alone is not enough: two updates to
 * the same snapshot inside one millisecond — which is what a fast loop of small
 * batches is — would leave it undefined which row count survives. Clamping to
 * "at least one more than the last one I issued" makes the sequence strictly
 * increasing within a process while staying roughly wall-clock, so versions
 * from two processes still order sensibly against each other.
 */
let lastVersion = 0;
export function nextVersion(): number {
  const now = Date.now() * 1000;
  lastVersion = now > lastVersion ? now : lastVersion + 1;
  return lastVersion;
}

/** Format a `Date` the way `DateTime64(3)` reads it back identically. */
function toClickHouseDateTime(value: Date): string {
  return value.toISOString().replace('T', ' ').replace('Z', '');
}

function parseClickHouseDateTime(value: string): Date {
  // ClickHouse hands back `YYYY-MM-DD hh:mm:ss.mmm` with no zone marker. The
  // column is declared `DateTime64(3, 'UTC')`, so appending the Z is restoring
  // information the wire format dropped rather than assuming anything.
  return new Date(`${value.replace(' ', 'T')}Z`);
}

function parseLabels(value: string): Record<string, string> | undefined {
  if (!value) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function toRecord(row: SnapshotRow): SnapshotRecord {
  return {
    typeName: row.type_name,
    snapshotId: row.snapshot_id,
    principalId: row.principal_id,
    rowCount: Number(row.row_count),
    committed: row.committed === 1,
    createdAt: parseClickHouseDateTime(row.created_at),
    committedAt: row.committed_at ? parseClickHouseDateTime(row.committed_at) : undefined,
    droppedAt: row.dropped_at ? parseClickHouseDateTime(row.dropped_at) : undefined,
    labels: parseLabels(row.labels),
  };
}

export function toRef(record: SnapshotRecord): SnapshotRef {
  return {
    id: record.snapshotId,
    createdAt: record.createdAt.toISOString(),
    rowCount: record.rowCount,
    principalId: record.principalId,
    labels: record.labels,
    // Spread rather than assigned, so a live snapshot's ref has no `droppedAt`
    // key at all instead of one holding `undefined`. Callers serialise these to
    // JSON and compare them; `{"droppedAt": null}` reads as a fact about a
    // snapshot that has none.
    ...(record.droppedAt ? { droppedAt: record.droppedAt.toISOString() } : {}),
  };
}

/**
 * The sentence a reader of a tombstoned snapshot gets, in place of zero rows.
 *
 * One function so the refusal sites cannot drift into several accounts of the
 * same state, and so the date is always in it: "that snapshot was dropped"
 * sends a reader to look for a bug, and "dropped on the 8th" sends them to
 * whoever ran the drop. Word for word the MySQL adapter's, because the two
 * stores are behind one interface and a caller should not be able to tell which
 * one refused it.
 */
export function droppedMessage(typeName: string, record: SnapshotRecord, droppedAt: Date): string {
  return `Snapshot ${record.snapshotId} of ${typeName} held ${record.rowCount} row(s) and they were dropped on ${droppedAt.toISOString()}. The record of the load is kept so the runs that produced it stay resolvable, but the data is gone and no read of it can be answered. This is refused rather than returned as an empty result, because an empty result here is indistinguishable from a load that collapsed.`;
}

/**
 * Create the two bookkeeping tables.
 *
 * `CREATE TABLE IF NOT EXISTS` and nothing else — no differ, no fingerprint.
 * There are two tables, they are this package's alone, and ClickHouse gives no
 * safe automatic way to reshape a table anyway. When these need a column, it
 * will be added here as an explicit `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`,
 * which is metadata-only and cannot lose data.
 */
export async function ensureCatalogClickHouseSchema(client: ClickHouseClient): Promise<void> {
  const logger = new Logger('CatalogClickHouseSchema');

  await client.command({
    query: `CREATE TABLE IF NOT EXISTS ${SNAPSHOT_TABLE} (
      \`type_name\`    String,
      \`snapshot_id\`  String,
      \`principal_id\` String,
      \`row_count\`    UInt64,
      \`committed\`    UInt8,
      \`deleted\`      UInt8,
      \`created_at\`   DateTime64(3, 'UTC'),
      \`committed_at\` Nullable(DateTime64(3, 'UTC')),
      \`dropped_at\`   Nullable(DateTime64(3, 'UTC')),
      \`labels\`       String,
      \`_version\`     UInt64
    ) ENGINE = ReplacingMergeTree(\`_version\`)
      ORDER BY (\`type_name\`, \`snapshot_id\`)`,
  });

  // The explicit `ALTER` the docblock above promised, for the deployments whose
  // table was created before `dropped_at` existed. Metadata-only on a
  // `Nullable` column with no default — ClickHouse records the new column and
  // reads it as NULL out of the parts that predate it, without rewriting one of
  // them — so it is safe to run on every boot and it cannot lose data.
  await client.command({
    query: `ALTER TABLE ${SNAPSHOT_TABLE}
              ADD COLUMN IF NOT EXISTS \`dropped_at\` Nullable(DateTime64(3, 'UTC'))
              AFTER \`committed_at\``,
  });

  await client.command({
    query: `CREATE TABLE IF NOT EXISTS ${CURRENT_TABLE} (
      \`type_name\`   String,
      \`snapshot_id\` String,
      \`_version\`    UInt64
    ) ENGINE = ReplacingMergeTree(\`_version\`)
      ORDER BY (\`type_name\`)`,
  });

  logger.log(`Schema ready for ${catalogClickHouseManagedTables().join(', ')}`);
}

const SNAPSHOT_COLUMNS =
  '`type_name`, `snapshot_id`, `principal_id`, `row_count`, `committed`, `created_at`, `committed_at`, `dropped_at`, `labels`';

/**
 * How many snapshots {@link listSnapshots} hands back when a caller names no
 * bound.
 *
 * The same number, and for the same reason, as the MikroORM adapter's
 * `CATALOG_SNAPSHOT_LIST_LIMIT`. 50 was a page size doing a bound's job: this
 * list is the only account of a type's history anything has, and a console
 * watching a deployment that has loaded daily for a year was blind to all but
 * the last seven weeks of it. Tombstones make that worse rather than better —
 * a dropped snapshot used to leave the list and now stays in it.
 *
 * Not imported from the MikroORM package, and not shared: these two adapters
 * have no dependency on each other and inventing one so they can agree on an
 * integer would be the wrong trade. If a third adapter wants it, the core
 * package is where it belongs.
 */
export const CATALOG_SNAPSHOT_LIST_LIMIT = 500;

/**
 * Write the current state of a snapshot row.
 *
 * Always a whole row, never a partial update — `ReplacingMergeTree` replaces,
 * it does not merge fields, so a caller that wrote only the changed column
 * would silently blank every other one. Callers read the record, change what
 * they mean to change, and write it back.
 */
export async function putSnapshot(client: ClickHouseClient, record: SnapshotRecord): Promise<void> {
  await client.insert({
    table: SNAPSHOT_TABLE,
    format: 'JSONEachRow',
    values: [
      {
        type_name: record.typeName,
        snapshot_id: record.snapshotId,
        principal_id: record.principalId,
        row_count: record.rowCount,
        committed: record.committed ? 1 : 0,
        // Never 1 from here, and nothing else writes this table. See the
        // module docblock: `deleted` erases the record, which is the thing this
        // store spent a release doing by accident and no longer does.
        deleted: 0,
        created_at: toClickHouseDateTime(record.createdAt),
        committed_at: record.committedAt ? toClickHouseDateTime(record.committedAt) : null,
        dropped_at: record.droppedAt ? toClickHouseDateTime(record.droppedAt) : null,
        labels: JSON.stringify(record.labels ?? {}),
        _version: nextVersion(),
      },
    ],
  });
}

/**
 * One snapshot's record, tombstone or not.
 *
 * A tombstone comes back rather than reading as absent, and every caller has to
 * mean it: `commit` refuses on it, `read` refuses on it, `dropSnapshot` uses it
 * to stay idempotent, and `write` carries its `droppedAt` through untouched so
 * that rows landing in a dropped snapshot cannot silently un-drop it. Absent
 * still means absent — a snapshot id nothing has ever written.
 */
export async function findSnapshot(
  client: ClickHouseClient,
  typeName: string,
  snapshotId: string,
): Promise<SnapshotRecord | undefined> {
  const result = await client.query({
    query: `SELECT ${SNAPSHOT_COLUMNS} FROM ${SNAPSHOT_TABLE} FINAL
             WHERE \`type_name\` = {t:String} AND \`snapshot_id\` = {s:String}
               AND \`deleted\` = 0`,
    query_params: { t: typeName, s: snapshotId },
    format: 'JSONEachRow',
  });
  const rows = await result.json<SnapshotRow>();
  return rows.length > 0 ? toRecord(rows[0]) : undefined;
}

/**
 * Every snapshot of a type, tombstones included.
 *
 * Tombstones are in it deliberately: the record surviving a drop is the whole
 * of the change, and a list that hid them would leave a connector run naming a
 * snapshot nothing can be learnt about — which is the state this was fixed to
 * avoid. Callers that need "snapshots that still hold rows" ask
 * {@link listSnapshotsWithRows} and get that question answered in SQL, rather
 * than filtering a bounded list after the bound has already been applied.
 */
export async function listSnapshots(
  client: ClickHouseClient,
  typeName: string,
  limit = CATALOG_SNAPSHOT_LIST_LIMIT,
): Promise<SnapshotRecord[]> {
  const result = await client.query({
    query: `SELECT ${SNAPSHOT_COLUMNS} FROM ${SNAPSHOT_TABLE} FINAL
             WHERE \`type_name\` = {t:String} AND \`deleted\` = 0
             ORDER BY \`created_at\` DESC, \`snapshot_id\` DESC
             LIMIT {n:UInt32}`,
    query_params: { t: typeName, n: limit },
    format: 'JSONEachRow',
  });
  return (await result.json<SnapshotRow>()).map(toRecord);
}

/**
 * The snapshots of a type that still hold their rows, newest first.
 *
 * The predicate is in the statement rather than applied to
 * {@link listSnapshots}'s result, and that is not a micro-optimisation: the
 * limit is applied by the engine, so filtering afterwards would take the newest
 * N *records* and then discard the tombstones among them. A type with more
 * tombstones than the limit would come back with no live snapshots in it at
 * all, and the caller that asks this question — {@link
 * ClickHouseWarehouseStore.pruneSnapshots} — would read that as "nothing to
 * prune" and quietly stop enforcing the cap.
 */
export async function listSnapshotsWithRows(
  client: ClickHouseClient,
  typeName: string,
  limit = CATALOG_SNAPSHOT_LIST_LIMIT,
): Promise<SnapshotRecord[]> {
  const result = await client.query({
    query: `SELECT ${SNAPSHOT_COLUMNS} FROM ${SNAPSHOT_TABLE} FINAL
             WHERE \`type_name\` = {t:String} AND \`deleted\` = 0
               AND \`dropped_at\` IS NULL
             ORDER BY \`created_at\` DESC, \`snapshot_id\` DESC
             LIMIT {n:UInt32}`,
    query_params: { t: typeName, n: limit },
    format: 'JSONEachRow',
  });
  return (await result.json<SnapshotRow>()).map(toRecord);
}

/**
 * The newest committed snapshot that is neither this one nor newer than it.
 *
 * Asked of the snapshot table rather than of the current-snapshot pointer, and
 * the two agree right up until the moment it matters. A durable run that
 * retries *after* its commit step succeeded replays every step, and by then the
 * pointer names this very snapshot — carrying forward from itself would delete
 * the carried rows and then find nothing to replace them with, silently
 * reducing the dataset to whatever the run happened to fetch. Asking for the
 * newest committed snapshot that is not this one, and that existed before this
 * one did, gives the same answer on the first run and on the tenth replay.
 *
 * Tombstones are excluded, and that clause is what keeps a drop from becoming a
 * silent truncation one load later. The record survives a drop now, so the
 * newest committed snapshot can be one whose rows are gone — reachable by
 * rolling back to an older load and then dropping the bad one, which is the
 * ordinary way a bad load is cleaned up. Merging onto it would copy nothing,
 * and the load would commit holding only what this run happened to fetch: a
 * full replacement wearing an incremental load's name. Skipping to the next
 * committed snapshot that still has its data lands on the one the type is
 * actually serving, which is what a merge is a merge against.
 */
export async function findPreviousCommitted(
  client: ClickHouseClient,
  typeName: string,
  snapshotId: string,
  notAfter: Date,
): Promise<SnapshotRecord | undefined> {
  const result = await client.query({
    query: `SELECT ${SNAPSHOT_COLUMNS} FROM ${SNAPSHOT_TABLE} FINAL
             WHERE \`type_name\` = {t:String} AND \`deleted\` = 0
               AND \`dropped_at\` IS NULL
               AND \`committed\` = 1 AND \`snapshot_id\` != {s:String}
               AND \`created_at\` <= {before:DateTime64(3)}
             ORDER BY \`created_at\` DESC, \`snapshot_id\` DESC
             LIMIT 1`,
    query_params: {
      t: typeName,
      s: snapshotId,
      before: toClickHouseDateTime(notAfter),
    },
    format: 'JSONEachRow',
  });
  const rows = await result.json<SnapshotRow>();
  return rows.length > 0 ? toRecord(rows[0]) : undefined;
}

/**
 * Which snapshot readers get by default.
 *
 * A single row keyed by type name, and moving it is a single INSERT — which is
 * where this adapter's atomic cutover actually lives. ClickHouse commits one
 * insert as one part, visible in full or not at all, so no read ever sees a
 * type with no current snapshot or with half of a new one. The SQL console's
 * view is repointed alongside it and that also has an atomic primitive
 * (`EXCHANGE TABLES`), but the two are separate statements: see the comment on
 * `commit()` for what a failure between them leaves behind.
 */
export async function readCurrent(
  client: ClickHouseClient,
  typeName: string,
): Promise<string | undefined> {
  const result = await client.query({
    query: `SELECT \`snapshot_id\` FROM ${CURRENT_TABLE} FINAL
             WHERE \`type_name\` = {t:String}`,
    query_params: { t: typeName },
    format: 'JSONEachRow',
  });
  const rows = await result.json<{ snapshot_id: string }>();
  const id = rows[0]?.snapshot_id;
  // An empty string is how a type whose pointer was cleared reads back, and it
  // is not a snapshot id. Treated as "nothing committed" rather than looked up.
  return id ? id : undefined;
}

export async function writeCurrent(
  client: ClickHouseClient,
  typeName: string,
  snapshotId: string,
): Promise<void> {
  await client.insert({
    table: CURRENT_TABLE,
    format: 'JSONEachRow',
    values: [
      {
        type_name: typeName,
        snapshot_id: snapshotId,
        _version: nextVersion(),
      },
    ],
  });
}
