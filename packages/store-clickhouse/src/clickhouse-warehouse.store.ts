import type { ClickHouseClient } from '@clickhouse/client';
import { CATALOG_FILTER_OPERATORS, CatalogRegistry, emitCatalog } from '@dudousxd/nestjs-catalog';
import type {
  CarryForwardResult,
  CatalogFilteringReadStore,
  CatalogMergeStore,
  CatalogObjectTypeDef,
  CatalogPropertyDef,
  CatalogQueryRelation,
  CatalogQueryRequest,
  CatalogQueryResult,
  CatalogQueryStore,
  CatalogReadQuery,
  CatalogReadResult,
  CatalogResolvedFilter,
  CatalogStoreCapabilities,
  ScalarType,
  SnapshotRef,
} from '@dudousxd/nestjs-catalog';
import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { clickHouseType, coerce, fromClickHouseType, normalise } from './column-types';
import { CATALOG_CLICKHOUSE_CLIENT, CATALOG_CLICKHOUSE_QUERY_CLIENT } from './context';
import {
  BATCH_COLUMN,
  CARRY_FORWARD_BATCH,
  LOADED_AT_COLUMN,
  PRINCIPAL_COLUMN,
  RESERVED_COLUMNS,
  ROW_COLUMN,
  SNAPSHOT_COLUMN,
  ident,
  outputAlias,
  physicalColumn,
  stageFor,
  tableFor,
  viewFor,
} from './identifiers';
import { CATALOG_CLICKHOUSE_OPTIONS, type CatalogClickHouseStoreOptions } from './options';
import { refreshView, relationsFor, runReadOnlyQuery } from './query';
import {
  type SnapshotRecord,
  deleteSnapshot,
  findPreviousCommitted,
  findSnapshot,
  listSnapshots,
  putSnapshot,
  readCurrent,
  toRef,
  writeCurrent,
} from './snapshots';

/**
 * ClickHouse as a warehouse: one physical table per object type, append-only,
 * one partition per (snapshot, batch).
 *
 * **Snapshots are emulated here too, and that is the honest label.** A column
 * store's reputation suggests otherwise, so it is worth saying plainly:
 * ClickHouse keeps no history of its own. Its `ReplacingMergeTree` is often
 * mistaken for versioning, and it is the opposite — a background merge that
 * *discards* every version but the newest, on its own schedule, with no
 * guarantee about when. Building the object tables on it would mean the
 * catalog's central promise, that you can read last month's load, quietly
 * became "you can read last month's load until a merge runs". So history is a
 * column here exactly as it is on MySQL, and ClickHouse was chosen for read
 * speed over wide tables rather than because it would make this class simpler.
 * The engines that give history for free are table formats — Iceberg, Delta —
 * read *through* an engine like this one.
 *
 * **What is genuinely different from the MySQL store, and why.** ClickHouse has
 * no transactional delete: `ALTER TABLE ... DELETE` is a mutation, which runs
 * asynchronously, rewrites whole parts, and offers no instant at which the old
 * rows are gone and the new ones are not yet visible. Transliterating MySQL's
 * `DELETE` + `INSERT` would therefore have produced a store whose retries
 * appeared to work and occasionally doubled a batch. What ClickHouse does have
 * is partition manipulation: `DROP PARTITION` is a metadata operation, and
 * `REPLACE PARTITION ... FROM` swaps one partition's parts between two
 * identically-shaped tables under a single metadata commit, hardlinking rather
 * than copying. So the unit of idempotence is the partition, the partition key
 * is `(_snapshot_id, _batch)`, and a re-sent batch is built in a staging table
 * and swapped in. Not one mutation is issued anywhere in this file.
 *
 * A consequence worth stating because it decides how a caller should chunk a
 * load: **a batch is a partition.** ClickHouse is comfortable with hundreds to
 * low thousands of partitions per table and miserable above that, so batches
 * should be large — tens of thousands of rows or more — and the number of
 * retained snapshots is the other multiplier. A load streamed in 100-row
 * batches will work and will slowly ruin the table.
 *
 * Three things were investigated and rejected, since the reasons are not
 * obvious from the code that is here:
 *
 * - **`insert_deduplication_token`** looks like the natural answer to a retried
 *   batch, and it is a trap. The deduplication window is bounded (a fixed
 *   number of recent blocks, expiring after a fixed time), so a retry that
 *   arrives after the window has rolled is not deduplicated — it is appended.
 *   The failure mode is a silently doubled batch, which is the exact bug this
 *   store exists to make impossible.
 * - **A `ReplacingMergeTree` keyed on the object's primary key**, which would
 *   make the incremental merge free, costs time travel: see above.
 * - **Lightweight `DELETE`**, which is still a mutation, and would make every
 *   batch retry rewrite the parts of a whole snapshot.
 */

/**
 * Provenance and flag at once, kept in the snapshot's labels because it is
 * genuinely provenance — "these rows came from there" is the first thing asked
 * of an incremental snapshot that looks wrong — and because a label needs no
 * column, so an older deployment reading this table is unaffected.
 */
const CARRIED_FROM_LABEL = '_carriedFrom';
/** Value of the label when the type had nothing committed to carry from. */
const CARRIED_FROM_NOTHING = 'none';
/** Set when a batch landed after the carry-forward. `commit` refuses on it. */
const CARRY_FORWARD_STALE_LABEL = '_carryForwardStale';

/** What the physical layout must be for anything below to mean what it says. */
const REQUIRED_ENGINE = 'MergeTree';
const REQUIRED_PARTITION_KEY = `${SNAPSHOT_COLUMN}, ${BATCH_COLUMN}`;
const REQUIRED_SORTING_KEY = `${BATCH_COLUMN}, ${ROW_COLUMN}`;

/**
 * The contract's capabilities, plus the ones it has no field for.
 *
 * The three declared by `CatalogStoreCapabilities` come out identical to the
 * MySQL store's, which is the truthful answer and also an unsatisfying one:
 * they say nothing about the differences that actually decide whether this
 * adapter is safe for a given deployment. Rather than overstate or understate
 * them there, the extra facts are declared here as their own fields, and the
 * core package is the right place for them to end up.
 */
export interface ClickHouseStoreCapabilities extends CatalogStoreCapabilities {
  /**
   * Whether a committed snapshot becomes visible to readers all at once.
   *
   * True for this adapter, and non-obviously so. The pointer `read()` consults
   * moves in a single INSERT, which ClickHouse commits as one part — visible
   * whole or not at all. The SQL console's view moves by `EXCHANGE TABLES`,
   * which an Atomic database performs as one metadata commit. Notably it is
   * *not* `CREATE OR REPLACE VIEW`, which drops and recreates the name and does
   * have a window in which the view does not exist.
   */
  atomicCutover: boolean;
  /**
   * Whether a re-sent batch replaces itself without a visible intermediate
   * state. True here: the batch is staged and swapped in by `REPLACE
   * PARTITION`. The MySQL store's `DELETE` + `INSERT` briefly shows neither
   * copy, which matters only when the batch is re-sent into a snapshot that is
   * already committed and serving — which is exactly what a durable retry after
   * a successful commit does.
   */
  atomicBatchReplace: boolean;
  /**
   * Whether a multi-step operation is all-or-nothing. **False**, and there is
   * no way to make it true: ClickHouse has no transactions across statements.
   * `commit()` is a view exchange, a snapshot row and a pointer row; a crash
   * between them leaves a state that a re-run repairs and that nothing else
   * will. Every operation here is written to be re-runnable for that reason.
   */
  transactional: boolean;
}

@Injectable()
export class ClickHouseWarehouseStore
  implements CatalogMergeStore, CatalogQueryStore, CatalogFilteringReadStore
{
  private readonly logger = new Logger(ClickHouseWarehouseStore.name);

  /**
   * Every operator, because every one of them is a predicate this engine can
   * take — see {@link predicateFor}.
   *
   * Declared rather than assumed, and the absence of this line was the bug it
   * replaces. The core package offers a screen exactly the operators its store
   * reports and refuses a filter naming anything else, so a store that reported
   * nothing did not fall back to filtering badly — it offered no controls at all
   * and turned a hand-built filter into a refusal. That is the *correct* failure
   * for a store that cannot filter and simply the wrong answer for this one,
   * which has had the whole of `read()`'s WHERE clause available the entire time.
   *
   * Kept as the core's own list rather than a subset written out here, so an
   * operator added to the contract fails in {@link predicateFor}'s exhaustiveness
   * check — a compile error naming the operator — instead of being quietly
   * offered by this line and then thrown on at read time.
   */
  readonly objectFilterOperators = CATALOG_FILTER_OPERATORS;

  readonly capabilities: ClickHouseStoreCapabilities = {
    snapshots: 'emulated',
    writable: true,
    timeTravel: true,
    atomicCutover: true,
    atomicBatchReplace: true,
    transactional: false,
  };

  /**
   * Tables already brought in line with their type in this process.
   *
   * Per process, not persisted: a deploy that changes the schema starts with an
   * empty set, which is exactly when the check needs to run again.
   */
  private readonly ensured = new Set<string>();

  constructor(
    @Inject(CATALOG_CLICKHOUSE_CLIENT)
    private readonly client: ClickHouseClient,
    @Inject(CATALOG_CLICKHOUSE_QUERY_CLIENT)
    private readonly queryClient: ClickHouseClient,
    @Inject(CATALOG_CLICKHOUSE_OPTIONS)
    private readonly options: CatalogClickHouseStoreOptions,
    /**
     * Only ever used to describe what the SQL console may select from. This
     * adapter stores rows, not the model; a deployment that keeps its model
     * somewhere else still gets a working store, and the console falls back to
     * introspecting the object tables it finds.
     */
    @Optional() private readonly registry?: CatalogRegistry,
  ) {}

  /**
   * Bring the physical tables in line with the type definition.
   *
   * **Additive only.** A column that appears is created; a column that
   * disappears from the definition is left alone, and a column whose type
   * changes is left alone. Dropping and retyping are the changes that lose data
   * and break readers, and a service that accepts them over HTTP from whatever
   * application happened to deploy first is one bad release away from an
   * outage. Those go through a human.
   *
   * **Two tables, always in step.** ClickHouse refuses `REPLACE PARTITION`
   * between tables whose columns differ, so a column added to the object table
   * and not to its staging twin does not produce a missing value — it produces
   * a load that fails outright on the next batch, with `INCOMPATIBLE_COLUMNS`
   * and no hint about which table is behind. Both are altered here, and both
   * are re-checked from scratch on the first write after a boot, so a crash
   * between the two ALTERs self-heals.
   */
  async ensureType(type: CatalogObjectTypeDef): Promise<void> {
    const table = tableFor(type.name);
    const stage = stageFor(type.name);

    this.assertNoReservedCollision(type);

    const columns = await this.existingColumns([table, stage]);
    const existing = columns.get(table) ?? new Set<string>();
    const staged = columns.get(stage) ?? new Set<string>();

    if (existing.size === 0) {
      const declared = type.properties.map(
        (p) => `${ident(physicalColumn(p.name))} ${clickHouseType(p.type)}`,
      );
      await this.client.command({
        query: `CREATE TABLE IF NOT EXISTS ${ident(table)} (
           ${ident(SNAPSHOT_COLUMN)} String,
           ${ident(PRINCIPAL_COLUMN)} String,
           ${ident(LOADED_AT_COLUMN)} DateTime64(3, 'UTC'),
           ${ident(BATCH_COLUMN)} Int32,
           ${ident(ROW_COLUMN)} UInt64,
           ${declared.join(',\n           ')}
         ) ENGINE = MergeTree
           PARTITION BY (${ident(SNAPSHOT_COLUMN)}, ${ident(BATCH_COLUMN)})
           ORDER BY (${ident(BATCH_COLUMN)}, ${ident(ROW_COLUMN)})`,
      });
      // `AS <table>` rather than a second copy of the DDL: the two must agree
      // on columns, engine, partition key and sorting key, and the surest way
      // for two hand-written statements to disagree is for someone to edit one.
      await this.client.command({
        query: `CREATE TABLE IF NOT EXISTS ${ident(stage)} AS ${ident(table)}`,
      });

      this.logger.log(`Created ${table} with ${type.properties.length} columns`);
      emitCatalog('schema.changed', {
        typeName: type.name,
        table,
        addedColumns: type.properties.map((p) => physicalColumn(p.name)),
        created: true,
      });
      this.ensured.add(table);
      return;
    }

    if (this.options.verifyEngine !== false) await this.assertLayout(table);

    // The staging table can postdate the object table — a deployment upgraded
    // from a version that had none, or a crash between the two CREATEs. Made
    // from the object table so it inherits whatever shape that has now.
    if (staged.size === 0) {
      await this.client.command({
        query: `CREATE TABLE IF NOT EXISTS ${ident(stage)} AS ${ident(table)}`,
      });
      this.logger.log(`Created staging table ${stage}`);
    }

    const missing = type.properties.filter(
      (p) => !existing.has(physicalColumn(p.name).toLowerCase()),
    );
    for (const property of missing) {
      const column = ident(physicalColumn(property.name));
      const declared = clickHouseType(property.type);
      // Metadata-only on ClickHouse: a new column with a default is not
      // materialised into existing parts until something asks for it, so this
      // is cheap even on a table holding every load ever made. `IF NOT EXISTS`
      // on both so a partial previous run is not an error.
      await this.client.command({
        query: `ALTER TABLE ${ident(table)} ADD COLUMN IF NOT EXISTS ${column} ${declared}`,
      });
      await this.client.command({
        query: `ALTER TABLE ${ident(stage)} ADD COLUMN IF NOT EXISTS ${column} ${declared}`,
      });
      staged.add(physicalColumn(property.name).toLowerCase());
    }
    // A column added to the object table by an earlier run that then failed
    // before altering the staging table would be missed by the loop above,
    // because the loop is driven by what the *type* declares against what the
    // object table has. Reconciled directly, because the symptom otherwise is
    // every subsequent load of this type failing with INCOMPATIBLE_COLUMNS.
    if (staged.size > 0) {
      for (const property of type.properties) {
        const column = physicalColumn(property.name);
        if (staged.has(column.toLowerCase())) continue;
        await this.client.command({
          query: `ALTER TABLE ${ident(stage)} ADD COLUMN IF NOT EXISTS ${ident(column)} ${clickHouseType(property.type)}`,
        });
      }
    }

    if (missing.length > 0) {
      this.logger.log(
        `Added ${missing.length} column(s) to ${table}: ${missing.map((p) => p.name).join(', ')}`,
      );
      emitCatalog('schema.changed', {
        typeName: type.name,
        table,
        addedColumns: missing.map((p) => physicalColumn(p.name)),
        created: false,
      });
    }

    this.ensured.add(table);
  }

  async write(
    type: CatalogObjectTypeDef,
    rows: Array<Record<string, unknown>>,
    options: {
      snapshotId: string;
      principalId: string;
      /**
       * Which batch of this load these rows are.
       *
       * Load-bearing, not bookkeeping: a durable step that retries restarts
       * from the top and re-sends every batch, so without an identity per batch
       * a retry silently doubles the data. Here the identity is physical — the
       * batch is a partition — so sending batch 2 twice replaces it, and
       * sending batches 1..N again replaces the whole load.
       */
      batch?: number;
      labels?: Record<string, string>;
    },
  ): Promise<{ written: number }> {
    if (rows.length === 0) return { written: 0 };

    const table = tableFor(type.name);
    const stage = stageFor(type.name);

    // Once per table per process, make sure the table matches the type before
    // writing to it. Publishing the type used to be the only thing that ran
    // this, so a table whose type had not been republished since a column was
    // added stayed one column short — and the failure surfaced on an ordinary
    // load, hours or releases away from the change that caused it.
    if (!this.ensured.has(table)) await this.ensureType(type);
    const properties = type.properties;

    // Records that match nothing are a misconfiguration, not a load.
    //
    // Every field is looked up by property name, so records whose keys share no
    // name with the type produce rows of pure NULL — and the load then reports
    // the row count as a success and commits, which repoints the view at data
    // that says nothing. Losing sight of a real dataset because a CSV had
    // different headers is the failure this refuses. One matching property is
    // enough: a partial load is a judgement call, no matching property is not.
    const matched = properties.filter((property) =>
      rows.some((row) => row[property.name] !== undefined),
    );
    if (matched.length === 0) {
      const incoming = Object.keys(rows[0] ?? {});
      throw new BadRequestException(
        `None of the incoming fields match ${type.name}. Got ${
          incoming.length > 0 ? incoming.slice(0, 8).join(', ') : 'no fields'
        }; expected any of ${properties
          .slice(0, 8)
          .map((p) => p.name)
          .join(', ')}. A transform is where a source's names become the type's.`,
      );
    }

    const batch = Number.isFinite(options.batch) ? Number(options.batch) : 0;
    // Negative batch numbers belong to the store. Carry-forward writes under
    // one so its rows stay tellable from a load's and can be replaced
    // wholesale, which means a caller numbering a batch -1 would have that
    // batch silently deleted by the next merge. Cheaper to refuse here than to
    // work out later why one chunk of a load keeps disappearing.
    if (batch < 0) {
      throw new BadRequestException(
        `Batch numbers count up from 0, and ${batch} is negative. Negative batches are reserved for rows the store writes on your behalf, such as the rows an incremental load carries forward.`,
      );
    }

    const now = new Date().toISOString();
    const values = rows.map((row, index) => {
      const record: Record<string, unknown> = {
        [SNAPSHOT_COLUMN]: options.snapshotId,
        [PRINCIPAL_COLUMN]: options.principalId,
        [LOADED_AT_COLUMN]: now,
        [BATCH_COLUMN]: batch,
        // Position within the batch, and therefore — with the batch number —
        // a total order over the snapshot. ClickHouse has no auto-increment,
        // and paging a table with no total order silently repeats and skips
        // rows between pages.
        [ROW_COLUMN]: index,
      };
      for (const property of properties) {
        record[physicalColumn(property.name)] = coerce(row[property.name], property.type);
      }
      return record;
    });

    // Build the batch somewhere nobody reads, then swap it in. The leading drop
    // is what makes a retry idempotent rather than additive: a previous attempt
    // that inserted into staging and then failed before the swap has left rows
    // behind, and appending to them would move a doubled batch into the real
    // table under a single atomic statement — the worst possible combination.
    await this.dropPartition(stage, options.snapshotId, batch);
    await this.client.insert({
      table: stage,
      format: 'JSONEachRow',
      values,
    });
    // The whole point of the staging table. One metadata commit: readers of the
    // object table see the old batch or the new one, never neither. That
    // matters most on the case that looks impossible — a durable run whose
    // commit succeeded and which then retries from the top, re-sending batches
    // into a snapshot that is live and being served.
    await this.client.command({
      query: `ALTER TABLE ${ident(table)} REPLACE PARTITION tuple({s:String}, {b:Int32}) FROM ${ident(stage)}`,
      query_params: { s: options.snapshotId, b: batch },
    });
    await this.dropPartition(stage, options.snapshotId, batch);

    // Counted, not accumulated: a replaced batch must not be added twice, and
    // the table is the only thing that knows what actually survived.
    const total = await this.countSnapshot(table, options.snapshotId);

    const existing = await findSnapshot(this.client, type.name, options.snapshotId);
    const record: SnapshotRecord = existing ?? {
      typeName: type.name,
      snapshotId: options.snapshotId,
      principalId: options.principalId,
      rowCount: 0,
      committed: false,
      createdAt: new Date(),
      labels: options.labels,
    };

    // A batch that lands after a carry-forward invalidates it.
    //
    // The merge decides which of the previous snapshot's rows survive by
    // looking at the batches present when it runs, so a batch arriving
    // afterwards has nothing to displace: the previous version of every row it
    // touches is still sitting there, carried, and the snapshot now holds both.
    // Marked rather than repaired, and certainly rather than ignored — the
    // carried rows are not deleted here because that would tear a hole in a
    // snapshot that may already be committed and serving, and `commit` refuses
    // on the mark, so the only way past this point is to run the carry-forward
    // again. Which is exactly what a retry does anyway.
    if (record.labels?.[CARRIED_FROM_LABEL] !== undefined) {
      record.labels = {
        ...record.labels,
        [CARRY_FORWARD_STALE_LABEL]: 'true',
      };
    }
    record.rowCount = total;
    await putSnapshot(this.client, record);

    emitCatalog('snapshot.written', {
      typeName: type.name,
      snapshotId: options.snapshotId,
      principalId: options.principalId,
      rows: rows.length,
    });
    return { written: rows.length };
  }

  /**
   * Copy the previous snapshot forward, letting this load's rows win.
   *
   * One statement decides the whole thing, and the shape of it is the design:
   * a `LEFT ANTI JOIN` from the previous snapshot against the rows already
   * written here, so a previous row is selected only when nothing in this load
   * carries its primary key. "The incoming row replaces the old one" is
   * therefore not a second step that could half-happen — the old one is simply
   * never copied.
   *
   * It is SQL rather than a read-modify-write through Node because these tables
   * hold whole datasets. Pulling a snapshot into memory to merge it would put
   * the size of the largest object type into the heap of the process that
   * happened to run the connector.
   *
   * The result lands in the staging table and is swapped into the carry-forward
   * partition, for two reasons. It makes a second call idempotent — the swap
   * replaces the partition rather than adding to it — and it keeps the
   * statement from reading and writing one table at once, which ClickHouse does
   * not define the way a row store's buffered `INSERT ... SELECT` does.
   */
  async carryForward(
    type: CatalogObjectTypeDef,
    snapshotId: string,
    options: { principalId: string; labels?: Record<string, string> },
  ): Promise<CarryForwardResult> {
    // First, before anything has been touched: a type with no key cannot be
    // merged, and a failed carry-forward must leave the snapshot exactly as it
    // found it so the run can be fixed and retried.
    const keys = primaryKeyProperties(type);
    const keyColumns = keys.map((property) => physicalColumn(property.name));

    const table = tableFor(type.name);
    const stage = stageFor(type.name);
    if (!this.ensured.has(table)) await this.ensureType(type);

    const own = await findSnapshot(this.client, type.name, snapshotId);
    const previous = await findPreviousCommitted(
      this.client,
      type.name,
      snapshotId,
      own?.createdAt ?? new Date(),
    );

    // Before anything is written, so that a load which cannot legally be merged
    // leaves the snapshot byte for byte as it found it.
    if (previous) {
      await this.assertKeyed(table, keyColumns, keys, [
        [snapshotId, `the rows already written for ${snapshotId}`],
        [previous.snapshotId, `snapshot ${previous.snapshotId}`],
      ]);
    }

    if (previous) {
      const columns = [
        SNAPSHOT_COLUMN,
        PRINCIPAL_COLUMN,
        LOADED_AT_COLUMN,
        BATCH_COLUMN,
        ROW_COLUMN,
        ...type.properties.map((p) => physicalColumn(p.name)),
      ];

      // `_principal_id` and `_loaded_at` come across untouched rather than
      // being restamped with this run. A carried row is not a new load of that
      // row — nobody loaded it today, it simply did not change — so restamping
      // would erase the one thing the column is good for, which is telling you
      // when a value last actually moved. Who owns the *snapshot* is on the
      // snapshot row, and that is a different question.
      //
      // `_row` is the exception, and has to be: it is a position, not
      // provenance, and the positions it would inherit come from several
      // different batches of the previous load and would collide. Renumbered
      // across the carried set, which is the only set it has to be unique
      // within, since `(_batch, _row)` is the order and every carried row
      // shares one `_batch`.
      const selected = [
        `{s:String} AS ${ident(SNAPSHOT_COLUMN)}`,
        `prev.${ident(PRINCIPAL_COLUMN)}`,
        `prev.${ident(LOADED_AT_COLUMN)}`,
        `{c:Int32} AS ${ident(BATCH_COLUMN)}`,
        `rowNumberInAllBlocks() AS ${ident(ROW_COLUMN)}`,
        ...type.properties.map((p) => `prev.${ident(physicalColumn(p.name))}`),
      ];

      // `LEFT ANTI JOIN` rather than a `NOT EXISTS` correlated subquery, which
      // ClickHouse would have to decorrelate and which it historically declines
      // to. The right side selects only the key columns, so the join builds a
      // hash of keys rather than of whole rows.
      //
      // The `_batch != carry` predicate on the right side is what stops a
      // re-run from feeding on its own previous output: without it, the rows
      // this call is about to replace would count as "already written here" and
      // every carried row would suppress itself.
      const join = keyColumns
        .map((column) => `prev.${ident(column)} = incoming.${ident(column)}`)
        .join(' AND ');

      await this.dropPartition(stage, snapshotId, CARRY_FORWARD_BATCH);
      await this.client.command({
        query: `INSERT INTO ${ident(stage)} (${columns.map(ident).join(',')})
                SELECT ${selected.join(',')}
                  FROM (SELECT * FROM ${ident(table)} WHERE ${ident(SNAPSHOT_COLUMN)} = {p:String}) AS prev
                  LEFT ANTI JOIN (
                        SELECT ${keyColumns.map(ident).join(',')}
                          FROM ${ident(table)}
                         WHERE ${ident(SNAPSHOT_COLUMN)} = {s:String}
                           AND ${ident(BATCH_COLUMN)} != {c:Int32}
                       ) AS incoming
                    ON ${join}`,
        query_params: {
          s: snapshotId,
          p: previous.snapshotId,
          c: CARRY_FORWARD_BATCH,
        },
      });
      // Replaces whatever an earlier carry-forward left there, including
      // nothing. A source partition with no parts is not an error — it clears
      // the destination — which is what makes the empty merge work without a
      // special case.
      await this.client.command({
        query: `ALTER TABLE ${ident(table)} REPLACE PARTITION tuple({s:String}, {c:Int32}) FROM ${ident(stage)}`,
        query_params: { s: snapshotId, c: CARRY_FORWARD_BATCH },
      });
      await this.dropPartition(stage, snapshotId, CARRY_FORWARD_BATCH);
    } else {
      // Nothing to carry from, so the carried partition must be empty rather
      // than left holding what a previous run put there. This is the branch
      // that runs when the only committed snapshot was dropped between runs.
      await this.dropPartition(table, snapshotId, CARRY_FORWARD_BATCH);
    }

    // Counted from the table for the same reason `write` counts there: it is
    // the only thing that knows what the statement actually did, and a number
    // derived from anything else drifts the first time a retry replaces a
    // batch. Both numbers come from one statement.
    const counts = await this.client.query({
      query: `SELECT count() AS total, countIf(${ident(BATCH_COLUMN)} = {c:Int32}) AS carried
                FROM ${ident(table)} WHERE ${ident(SNAPSHOT_COLUMN)} = {s:String}`,
      query_params: { s: snapshotId, c: CARRY_FORWARD_BATCH },
      format: 'JSONEachRow',
    });
    const [totals] = await counts.json<{
      total: string | number;
      carried: string | number;
    }>();
    const rowCount = Number(totals?.total ?? 0);
    const carriedCount = Number(totals?.carried ?? 0);

    // Created here when it does not exist yet, which is the run that fetched
    // nothing new. That run still has to produce a complete snapshot — "the
    // source had no changes" and "the dataset is empty" are different facts,
    // and only one of them should ever repoint the view at nothing.
    const record: SnapshotRecord = own ?? {
      typeName: type.name,
      snapshotId,
      principalId: options.principalId,
      rowCount: 0,
      committed: false,
      createdAt: new Date(),
      labels: options.labels,
    };

    const labels = { ...record.labels };
    labels[CARRIED_FROM_LABEL] = previous?.snapshotId ?? CARRIED_FROM_NOTHING;
    // The merge is current as of now, whatever it was before this call.
    delete labels[CARRY_FORWARD_STALE_LABEL];
    record.labels = labels;
    record.rowCount = rowCount;
    await putSnapshot(this.client, record);

    // `snapshot.written` rather than an event of its own: rows landed in a
    // snapshot, which is what the event means, and a lineage feed that reports
    // the carried rows as a write is telling the truth about where the data in
    // that snapshot came from.
    emitCatalog('snapshot.written', {
      typeName: type.name,
      snapshotId,
      principalId: options.principalId,
      rows: carriedCount,
    });

    this.logger.log(
      previous
        ? `Carried ${carriedCount} rows from ${previous.snapshotId} into ${snapshotId} of ${type.name}; ${rowCount} rows total`
        : `Nothing committed for ${type.name} yet, so ${snapshotId} stands as the whole state (${rowCount} rows)`,
    );

    return {
      from: previous?.snapshotId,
      carried: carriedCount,
      total: rowCount,
    };
  }

  /**
   * Make a snapshot the one readers get by default.
   *
   * Three statements, and no transaction to wrap them in — ClickHouse has none.
   * The order is chosen so that a failure part-way through is repaired by
   * re-running rather than by a human:
   *
   * 1. the view exchange, which is the fallible one (DDL, identifier rules) and
   *    which touches only the ad-hoc SQL console;
   * 2. the snapshot row, marking it committed so a later `carryForward` can
   *    find it;
   * 3. the pointer, which is what `read()` consults and is therefore the
   *    moment the commit becomes real.
   *
   * A crash after step 1 leaves the console showing a snapshot the API does not
   * yet serve. That is not a half-written load — by the time `commit` is called
   * every batch is in place and the merge is done — it is a blessing that did
   * not finish, and the retry finishes it. The reverse order would have been
   * worse: the API serving a snapshot the console cannot see is the same
   * inconsistency, reached by making the *authoritative* pointer move first.
   */
  async commit(type: CatalogObjectTypeDef, snapshotId: string): Promise<SnapshotRef> {
    const record = await findSnapshot(this.client, type.name, snapshotId);
    if (!record) {
      throw new BadRequestException(`No snapshot ${snapshotId} has been written for ${type.name}.`);
    }

    // Refused, not repaired. The carry-forward could be re-run from here, but
    // then a commit would be quietly doing a merge, and the caller that wrote
    // the late batch would never learn that its ordering was wrong. What is on
    // the other side of committing anyway is a view serving two versions of
    // every row the late batch touched, under one primary key, with nothing to
    // say which is current.
    const labels = record.labels;
    if (labels?.[CARRY_FORWARD_STALE_LABEL] !== undefined) {
      throw new BadRequestException(
        `Snapshot ${snapshotId} of ${type.name} carried rows forward from ${
          labels[CARRIED_FROM_LABEL] ?? 'an earlier snapshot'
        } and then took more batches, so the merge no longer covers the whole load and every re-sent row is in it twice. Carry forward again, then commit — in that order.`,
      );
    }

    await refreshView(this.client, type, snapshotId);

    record.committed = true;
    record.committedAt = new Date();
    await putSnapshot(this.client, record);
    await writeCurrent(this.client, type.name, snapshotId);

    emitCatalog('snapshot.committed', {
      typeName: type.name,
      snapshotId,
      principalId: record.principalId,
      rowCount: record.rowCount,
    });
    return toRef(record);
  }

  /**
   * Drop a snapshot's rows.
   *
   * A partition drop per batch, which is a metadata operation and a file
   * unlink. This is the only place the partition-per-batch layout costs
   * something rather than paying: a load of a thousand batches is a thousand
   * `DROP PARTITION` statements. The batch numbers are read from the data
   * rather than assumed to be contiguous, because a load that failed part-way
   * leaves gaps and a loop from 0 to N would stop at the first one.
   */
  async dropSnapshot(type: CatalogObjectTypeDef, snapshotId: string): Promise<void> {
    const current = await readCurrent(this.client, type.name);
    if (current === snapshotId) {
      throw new BadRequestException(
        `Snapshot ${snapshotId} is the one being served for ${type.name}. Commit another one first.`,
      );
    }

    const table = tableFor(type.name);
    const stage = stageFor(type.name);
    for (const batch of await this.batchesIn(table, snapshotId)) {
      await this.dropPartition(table, snapshotId, batch);
    }
    // Debris from a run that died between staging a batch and swapping it in.
    // Harmless where it sits — nothing reads the staging table — but it holds
    // disk and it holds a partition, and this is the one moment we know for
    // certain nobody wants it.
    for (const batch of await this.batchesIn(stage, snapshotId)) {
      await this.dropPartition(stage, snapshotId, batch);
    }

    await deleteSnapshot(this.client, type.name, snapshotId);
    emitCatalog('snapshot.dropped', { typeName: type.name, snapshotId });
  }

  async listSnapshots(type: CatalogObjectTypeDef): Promise<SnapshotRef[]> {
    const records = await listSnapshots(this.client, type.name);
    return records.map(toRef);
  }

  /**
   * Drop everything but the newest `keep` snapshots of a type.
   *
   * Not part of the store contract, and deliberately a method a host calls
   * rather than something a commit does on its own. Time travel is the
   * catalog's promise; a store that quietly enforced a retention window would
   * be breaking that promise on a schedule nobody chose. What ClickHouse does
   * change is the economics — dropping a snapshot is unlinking a partition, not
   * a mutation — so a deployment that decides it wants a window can have one
   * cheaply.
   *
   * The currently-served snapshot is never dropped, whatever its age.
   */
  async pruneSnapshots(type: CatalogObjectTypeDef, keep: number): Promise<{ dropped: string[] }> {
    if (!Number.isInteger(keep) || keep < 1) {
      throw new BadRequestException(
        `pruneSnapshots keeps at least one snapshot; ${keep} would leave the type with nothing to serve.`,
      );
    }
    const current = await readCurrent(this.client, type.name);
    const records = await listSnapshots(this.client, type.name, 1000);
    const dropped: string[] = [];
    for (const record of records.slice(keep)) {
      if (record.snapshotId === current) continue;
      await this.dropSnapshot(type, record.snapshotId);
      dropped.push(record.snapshotId);
    }
    if (dropped.length > 0) {
      this.logger.log(
        `Pruned ${dropped.length} snapshot(s) of ${type.name}, keeping the newest ${keep}`,
      );
    }
    return { dropped };
  }

  async read(
    type: CatalogObjectTypeDef,
    fields: string[],
    query: CatalogReadQuery,
  ): Promise<CatalogReadResult> {
    const table = tableFor(type.name);

    const snapshotId = query.snapshot ?? (await readCurrent(this.client, type.name));
    // Nothing committed yet is an empty result, not an error: the type is real
    // and known, it simply has no load anyone has blessed.
    if (!snapshotId) return { rows: [], total: 0 };

    const selected = type.properties.filter((p) => fields.includes(p.name));
    if (selected.length === 0) return { rows: [], total: 0 };

    const params: Record<string, unknown> = { s: snapshotId };
    let where = `${ident(SNAPSHOT_COLUMN)} = {s:String}`;

    const term = query.search?.trim();
    if (term) {
      const searchable = selected.filter((p) => p.type === 'string' && !p.classification);
      if (searchable.length > 0) {
        // `ILIKE`, not `LIKE`. ClickHouse's `LIKE` is case-sensitive where
        // MySQL's is case-insensitive under the usual collations, so a search
        // box that behaved differently depending on which adapter was mounted
        // would look like a bug in the data.
        where += ` AND (${searchable
          .map((p, index) => `${ident(physicalColumn(p.name))} ILIKE {q${index}:String}`)
          .join(' OR ')})`;
        searchable.forEach((_, index) => {
          params[`q${index}`] = `%${term}%`;
        });
      }
    }

    // Conjoined, and conjoined into the same `where` the count below uses. Two
    // statements answer one paged read here — a `count()` and the page — and a
    // filter applied to only one of them is a screen showing three rows above
    // the words "of 4,812", which is a worse outcome than not filtering at all
    // because it is not visibly wrong.
    (query.filters ?? []).forEach((filter, index) => {
      const predicate = filterPredicate(selected, filter, index);
      where += ` AND ${predicate.sql}`;
      Object.assign(params, predicate.params);
    });

    const totals = await this.client.query({
      query: `SELECT count() AS total FROM ${ident(table)} WHERE ${where}`,
      query_params: params,
      format: 'JSONEachRow',
    });
    const [{ total } = { total: 0 }] = await totals.json<{
      total: string | number;
    }>();

    const sortProperty = selected.find((p) => p.name === query.sort);
    const orderBy = sortProperty
      ? `${ident(physicalColumn(sortProperty.name))} ${query.dir === 'desc' ? 'DESC' : 'ASC'}, ${ident(BATCH_COLUMN)}, ${ident(ROW_COLUMN)}`
      : `${ident(BATCH_COLUMN)}, ${ident(ROW_COLUMN)}`;

    const size = Math.max(1, query.size ?? 25);
    const offset = (Math.max(1, query.page ?? 1) - 1) * size;

    // Aliased to `outputAlias`, the same name the committed view exposes, and
    // NOT to the property's name. `ident` refuses rather than escapes, so a
    // verbatim alias here was the second of the two statements that made "is
    // this a SQL identifier?" a condition on every property name in the
    // catalog — and a property that cannot be named `Asset Id` is a property
    // whose loads write NULL, because a load reads `row[property.name]` out of a
    // record the source keyed `Asset Id`. `normalise` looks the value back up
    // under the same alias and hands it out under the property's own name, so
    // nothing outside this method sees the difference.
    const page = await this.client.query({
      query: `SELECT ${selected
        .map((p) => `${ident(physicalColumn(p.name))} AS ${ident(outputAlias(p.name))}`)
        .join(',')}
         FROM ${ident(table)} WHERE ${where}
        ORDER BY ${orderBy} LIMIT {n:UInt64} OFFSET {o:UInt64}`,
      query_params: { ...params, n: size, o: offset },
      format: 'JSONEachRow',
    });

    return {
      total: Number(total ?? 0),
      rows: (await page.json<Record<string, unknown>>()).map((row) => normalise(row, selected)),
    };
  }

  async runQuery(request: CatalogQueryRequest): Promise<CatalogQueryResult> {
    return runReadOnlyQuery(this.queryClient, request);
  }

  /**
   * What a query may select from.
   *
   * Answered from the registry when there is one, because it knows display
   * names and the semantic types, and from the database when there is not. The
   * fallback is not a nicety: this adapter can be mounted with the model living
   * in another service entirely, and a SQL console with no schema panel in that
   * deployment would be a worse product for a reason the user cannot see.
   */
  async queryRelations(): Promise<CatalogQueryRelation[]> {
    const snapshot = this.registry?.getSnapshot();
    if (snapshot) return relationsFor(snapshot.types);

    const result = await this.client.query({
      query: `SELECT \`table\`, \`name\`, \`type\`
                FROM system.columns
               WHERE \`database\` = currentDatabase()
                 AND \`table\` LIKE 'obj\\_%'
                 AND \`table\` NOT LIKE '%\\_\\_stage'
               ORDER BY \`table\`, \`position\``,
      format: 'JSONEachRow',
    });
    const columns = await result.json<{
      table: string;
      name: string;
      type: string;
    }>();

    const byTable = new Map<string, Array<{ name: string; type: string }>>();
    for (const column of columns) {
      const list = byTable.get(column.table) ?? [];
      list.push({ name: column.name, type: fromClickHouseType(column.type) });
      byTable.set(column.table, list);
    }

    const relations: CatalogQueryRelation[] = [];
    for (const [table, list] of byTable) {
      const typeName = table.replace(/^obj_/, '');
      relations.push({
        name: viewFor(typeName),
        kind: 'current',
        objectType: typeName,
        description: `${typeName} as of the committed snapshot.`,
        columns: list.filter((c) => !RESERVED_COLUMNS.includes(c.name)),
      });
      relations.push({
        name: table,
        kind: 'history',
        objectType: typeName,
        description: `Every load of ${typeName} ever written, one partition per (${SNAPSHOT_COLUMN}, ${BATCH_COLUMN}).`,
        columns: list,
      });
    }
    return relations;
  }

  /**
   * Refuse to merge rows whose key is NULL.
   *
   * A declared primary key is not the same thing as a populated one. A
   * transform that never produces the key column leaves a type that looks
   * mergeable and data that is not, and on this engine the consequence is
   * sharper than on MySQL. ClickHouse's JOIN treats NULL as equal to NULL,
   * where SQL's `=` does not, so NULL-keyed rows do not duplicate themselves
   * here — they *collapse*: one NULL-keyed incoming row would suppress every
   * NULL-keyed row in the previous snapshot, and the load would appear to have
   * legitimately replaced them. Silent loss rather than silent growth, and
   * loss is the harder one to notice.
   *
   * Both sides are checked. NULLs in the incoming batches mean this run's rows
   * match the wrong things; NULLs in the previous snapshot mean rows that
   * vanish for no reason anyone can reconstruct later.
   */
  private async assertKeyed(
    table: string,
    keyColumns: string[],
    keys: CatalogPropertyDef[],
    sides: Array<[snapshotId: string, described: string]>,
  ): Promise<void> {
    const nullTest = keyColumns.map((column) => `${ident(column)} IS NULL`).join(' OR ');

    for (const [snapshotId, described] of sides) {
      const result = await this.client.query({
        query: `SELECT count() AS unkeyed FROM ${ident(table)}
                 WHERE ${ident(SNAPSHOT_COLUMN)} = {s:String} AND (${nullTest})`,
        query_params: { s: snapshotId },
        format: 'JSONEachRow',
      });
      const [row] = await result.json<{ unkeyed: string | number }>();
      const count = Number(row?.unkeyed ?? 0);
      if (count === 0) continue;

      const named = keys.map((property) => property.name).join(', ');
      throw new BadRequestException(
        `${count} row(s) in ${described} have no value for the primary key (${named}), so an incremental load cannot tell an update from a new object. On ClickHouse a NULL key matches every other NULL key in a join, so these rows would silently replace one another rather than accumulate. Either make the load produce ${named}, or publish the type with a primary key its data actually fills, or run this connector in "full" mode — a full run replaces the dataset outright and needs no key.`,
      );
    }
  }

  /**
   * Check the physical layout is the one every guarantee here depends on.
   *
   * Cheap, once per table per process, and it catches the class of mistake that
   * has no other symptom. Pointed at a `ReplacingMergeTree` the writes would
   * succeed and background merges would erase old snapshots; pointed at a
   * `Distributed` table `REPLACE PARTITION` would address the local shard only;
   * pointed at a table someone repartitioned by month, a batch retry would drop
   * a month. All three look like working loads right up until the data is
   * wrong.
   */
  private async assertLayout(table: string): Promise<void> {
    const result = await this.client.query({
      query: `SELECT \`engine\`, \`partition_key\`, \`sorting_key\`
                FROM system.tables
               WHERE \`database\` = currentDatabase() AND \`name\` = {t:String}`,
      query_params: { t: table },
      format: 'JSONEachRow',
    });
    const [row] = await result.json<{
      engine: string;
      partition_key: string;
      sorting_key: string;
    }>();
    if (!row) return;

    const wrong: string[] = [];
    if (row.engine !== REQUIRED_ENGINE) {
      wrong.push(`engine is ${row.engine}, not ${REQUIRED_ENGINE}`);
    }
    if (row.partition_key.replace(/[()]/g, '') !== REQUIRED_PARTITION_KEY) {
      wrong.push(`partitioned by (${row.partition_key}), not (${REQUIRED_PARTITION_KEY})`);
    }
    if (row.sorting_key.replace(/[()]/g, '') !== REQUIRED_SORTING_KEY) {
      wrong.push(`ordered by (${row.sorting_key}), not (${REQUIRED_SORTING_KEY})`);
    }
    if (wrong.length === 0) return;

    throw new BadRequestException(
      `${table} exists but is not shaped the way this store writes: ${wrong.join('; ')}. Loading into it would appear to work — a retried batch would drop the wrong rows, or background merges would collapse the snapshots this store keeps for time travel. Point the store at a different database, or rename the table and let it be recreated. Set verifyEngine: false only if you built the table yourself and know it matches.`,
    );
  }

  /**
   * Refuse a property whose physical column would land on a reserved one.
   *
   * `physicalColumn` is a lossy mapping, so a property genuinely called
   * `_batch`, or one called `_ batch` that cleans to the same thing, would be
   * written into the column this store uses to tell one chunk of a load from
   * another. Nothing would fail. The load would land, the batch numbers would
   * be whatever the source had, and every retry and every merge from then on
   * would replace the wrong partition.
   */
  private assertNoReservedCollision(type: CatalogObjectTypeDef): void {
    const collisions = type.properties
      .filter((property) => RESERVED_COLUMNS.includes(physicalColumn(property.name)))
      .map((property) => property.name);
    if (collisions.length === 0) return;
    throw new BadRequestException(
      `${type.name} has ${collisions.length === 1 ? 'a property' : 'properties'} that would be stored in a column this store reserves for itself: ${collisions.join(', ')}. Reserved columns are ${RESERVED_COLUMNS.join(', ')}. Rename the ${collisions.length === 1 ? 'property' : 'properties'} — writing into these would corrupt snapshot and batch bookkeeping without failing.`,
    );
  }

  /**
   * `DROP PARTITION`, which is not a mutation.
   *
   * It unlinks the partition's parts and commits the metadata change; it does
   * not queue work, does not rewrite anything, and returns having done it. That
   * distinction is the reason this store is built around partitions at all.
   * Dropping a partition that does not exist is a no-op rather than an error,
   * which is what lets every caller here run unconditionally.
   */
  private async dropPartition(table: string, snapshotId: string, batch: number): Promise<void> {
    await this.client.command({
      query: `ALTER TABLE ${ident(table)} DROP PARTITION tuple({s:String}, {b:Int32})`,
      query_params: { s: snapshotId, b: batch },
    });
  }

  private async batchesIn(table: string, snapshotId: string): Promise<number[]> {
    const result = await this.client.query({
      query: `SELECT DISTINCT ${ident(BATCH_COLUMN)} AS batch FROM ${ident(table)}
               WHERE ${ident(SNAPSHOT_COLUMN)} = {s:String}`,
      query_params: { s: snapshotId },
      format: 'JSONEachRow',
    });
    return (await result.json<{ batch: string | number }>()).map((row) => Number(row.batch));
  }

  private async countSnapshot(table: string, snapshotId: string): Promise<number> {
    const result = await this.client.query({
      query: `SELECT count() AS total FROM ${ident(table)}
               WHERE ${ident(SNAPSHOT_COLUMN)} = {s:String}`,
      query_params: { s: snapshotId },
      format: 'JSONEachRow',
    });
    const [row] = await result.json<{ total: string | number }>();
    return Number(row?.total ?? 0);
  }

  private async existingColumns(tables: string[]): Promise<Map<string, Set<string>>> {
    const result = await this.client.query({
      query: `SELECT \`table\`, \`name\` FROM system.columns
               WHERE \`database\` = currentDatabase() AND \`table\` IN {t:Array(String)}`,
      query_params: { t: tables },
      format: 'JSONEachRow',
    });
    const rows = await result.json<{ table: string; name: string }>();
    const out = new Map<string, Set<string>>();
    for (const row of rows) {
      const set = out.get(row.table) ?? new Set<string>();
      set.add(row.name.toLowerCase());
      out.set(row.table, set);
    }
    return out;
  }
}

/**
 * The properties an incremental load merges on.
 *
 * Two spellings of one declaration are accepted, because publishers use both:
 * `primary: true` on the properties, and `primaryKey: [...]` on the type. They
 * say the same thing, so either is enough. What is refused is neither — and it
 * is refused rather than worked around, because both of the available
 * workarounds are worse than an error. Appending without a key duplicates the
 * whole dataset on every run; quietly promoting the load to a full reload
 * commits whatever partial slice the source handed over as the complete state,
 * which is the same load succeeding and the same data ending up wrong.
 */
function primaryKeyProperties(type: CatalogObjectTypeDef): CatalogPropertyDef[] {
  const flagged = type.properties.filter((property) => property.primary);
  if (flagged.length > 0) return flagged;

  const resolved: CatalogPropertyDef[] = [];
  const missing: string[] = [];
  for (const name of type.primaryKey ?? []) {
    const property = type.properties.find((p) => p.name === name);
    if (property) resolved.push(property);
    else missing.push(name);
  }

  // A key naming a property the type does not have is a broken declaration, and
  // merging on the part of it that does resolve would be merging on the wrong
  // key — which looks like it worked and collapses rows that are not the same
  // object.
  if (missing.length > 0) {
    throw new BadRequestException(
      `${type.name} declares a primary key of ${(type.primaryKey ?? []).join(
        ', ',
      )}, but ${missing.join(', ')} is not one of its properties. Publish the type again with a key that matches its shape; merging on the rest of it would join rows that are not the same object.`,
    );
  }

  if (resolved.length === 0) {
    throw new BadRequestException(
      `${type.name} has no primary key, so an incremental load has no way to tell an updated row from a new one — every run would carry the old copy forward and add the new one beside it. Publish the type with a primary key (either \`primaryKey\` on the type or \`primary: true\` on the identifying properties), or run this connector in "full" mode, which replaces the dataset outright and needs no key.`,
    );
  }

  return resolved;
}

/**
 * One filter, against a column this read is actually returning.
 *
 * The membership check is against `selected` rather than against the type, for
 * the reason the MySQL adapter gives in the same place: the service already
 * resolves a filter against the visible columns, so this can only fail for a
 * caller building the query itself — and what it prevents is a predicate over a
 * column the same request declined to return, which is how a hidden or
 * classified value leaks out through row membership one `gte` at a time.
 *
 * `ident` is the guard on the column, the same one the SELECT list and the
 * ORDER BY go through: a name outside a narrow character set is refused rather
 * than escaped. Nothing a caller sent reaches it — the property came off the
 * type — and no value reaches the statement text at all.
 */
function filterPredicate(
  selected: CatalogPropertyDef[],
  filter: CatalogResolvedFilter,
  index: number,
): { sql: string; params: Record<string, unknown> } {
  const property = selected.find((p) => p.name === filter.property.name);
  if (!property) {
    throw new BadRequestException(
      `${filter.property.name} is not among the columns this read returns, so it cannot be filtered on.`,
    );
  }
  return predicateFor(ident(physicalColumn(property.name)), property.type, filter, `f${index}`);
}

/**
 * One filter as a predicate and the parameters it binds.
 *
 * Every value is a named placeholder the driver binds, including the `%`
 * wrapping for `contains`, which is built as a parameter rather than into the
 * statement. The column is already quoted by `ident`.
 *
 * Four of these are not the naive translation, and the first two are wrong in
 * exactly the ways the MySQL adapter documents:
 *
 * - `ne` matches rows whose column is NULL as well. `<>` is never true of NULL,
 *   so "state is not FL" would drop every row with no state at all — and a
 *   reader of that list would conclude those rows are in Florida.
 * - `empty` counts the empty string as well as NULL on a text column. `coerce`
 *   writes `''` as NULL on the way in, so today they are the same set here; a
 *   column loaded by an older version of this store, or by hand, is where they
 *   come apart, and "no value" has to mean no value on both.
 *
 * The other two are where this engine is genuinely not MySQL:
 *
 * - `empty` and `notEmpty` compare against `''` **only for the text types.**
 *   MySQL will happily compare a `DOUBLE` to a string and coerce it; ClickHouse
 *   refuses `Nullable(Float64) = String` outright, so the same predicate would
 *   turn a filter on a number or a date column into an engine error. `IS NULL`
 *   alone is the whole of the question on those columns anyway — a numeric
 *   column has no empty string to hold.
 * - `contains` is `ILIKE`, not `LIKE`, which is the same choice `read()` already
 *   makes for the search box and for the same reason: ClickHouse's `LIKE` is
 *   case-sensitive where MySQL's is case-insensitive under the usual collations,
 *   and a control that behaved differently depending on which adapter was
 *   mounted would look like a bug in the data rather than a difference between
 *   engines.
 *
 * `eq` and `ne` are deliberately **not** given the same treatment, and the
 * difference is worth stating rather than hiding: they compare exactly, so
 * `label:eq:Alpha` matches on ClickHouse only what was stored as `Alpha`, where
 * MySQL's default collation would also match `alpha`. Matching MySQL there would
 * mean lowering both sides on every row, which forfeits the sparse index that is
 * the reason to be on this engine — and it still would not match, because
 * MySQL's default collation is accent-insensitive too and nothing here can
 * reproduce that. `contains` is a free fix and gets one; `eq` is not, and is left
 * as the engine's own answer.
 */
function predicateFor(
  column: string,
  type: ScalarType,
  filter: CatalogResolvedFilter,
  key: string,
): { sql: string; params: Record<string, unknown> } {
  const bound = { [key]: coerce(filter.value, type) };
  const value = `{${key}:${placeholderType(type)}}`;
  // A date is compared through the same best-effort parse the insert path uses,
  // rather than left to an implicit cast. `coerce` hands over the ISO string it
  // would have written, so the two sides of the comparison are produced by one
  // function — the alternative is a filter that agrees with the stored value
  // everywhere except the boundary where the server's own string-to-DateTime64
  // rules differ from `date_time_input_format`.
  const operand = type === 'date' ? `parseDateTime64BestEffort(${value}, 3, 'UTC')` : value;
  const emptyable = type !== 'number' && type !== 'boolean' && type !== 'date';
  const blank = emptyable ? ` OR ${column} = ''` : '';
  const notBlank = emptyable ? ` AND ${column} != ''` : '';

  switch (filter.op) {
    case 'eq':
      return { sql: `${column} = ${operand}`, params: bound };
    case 'ne':
      return { sql: `(${column} != ${operand} OR ${column} IS NULL)`, params: bound };
    case 'contains':
      return {
        sql: `${column} ILIKE {${key}:String}`,
        params: { [key]: `%${String(filter.value)}%` },
      };
    case 'gt':
      return { sql: `${column} > ${operand}`, params: bound };
    case 'gte':
      return { sql: `${column} >= ${operand}`, params: bound };
    case 'lt':
      return { sql: `${column} < ${operand}`, params: bound };
    case 'lte':
      return { sql: `${column} <= ${operand}`, params: bound };
    case 'empty':
      return { sql: `(${column} IS NULL${blank})`, params: {} };
    case 'notEmpty':
      return { sql: `(${column} IS NOT NULL${notBlank})`, params: {} };
    default:
      // An operator added to the contract and not to this switch fails to
      // compile here, which is what lets `objectFilterOperators` be the core's
      // whole list rather than a subset restated above. The alternative to a
      // `never` is a `default` that returns something true, which is a filter
      // silently matching every row.
      return unknownOperator(filter.op);
  }
}

function unknownOperator(operator: never): never {
  throw new BadRequestException(`This store cannot filter with ${String(operator)}.`);
}

/**
 * The placeholder type a filter value is bound under.
 *
 * ClickHouse's parameters are typed at the call site — `{f0:String}` — so this
 * has to agree with what {@link coerce} produces for the same scalar, which is
 * why the two are read together: `boolean` becomes 0/1 and so binds as `UInt8`,
 * `date` becomes an ISO string and so binds as `String` before being parsed back
 * server-side.
 */
function placeholderType(type: ScalarType): string {
  if (type === 'number') return 'Float64';
  if (type === 'boolean') return 'UInt8';
  return 'String';
}
