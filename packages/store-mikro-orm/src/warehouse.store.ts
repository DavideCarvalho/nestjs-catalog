import {
  CATALOG_FILTER_OPERATORS,
  CATALOG_PROVENANCE_COLUMNS,
  assertNoColumnCollisions,
  emitCatalog,
} from '@dudousxd/nestjs-catalog';
import type {
  CatalogQueryRelation,
  CatalogQueryRequest,
  CatalogQueryResult,
  CatalogQueryStore,
  CatalogQueryStreamRequest,
} from '@dudousxd/nestjs-catalog';
import type {
  CarryForwardResult,
  CatalogFilteringReadStore,
  CatalogMergeStore,
  CatalogObjectTypeDef,
  CatalogPropertyDef,
  CatalogReadQuery,
  CatalogReadResult,
  CatalogResolvedFilter,
  CatalogSnapshotLocation,
  CatalogSnapshotLookupStore,
  CatalogSnapshotStreamStore,
  CatalogStoreCapabilities,
  ScalarType,
  SnapshotRef,
  SnapshotStreamOptions,
} from '@dudousxd/nestjs-catalog';
// From `@mikro-orm/sql`, which is where `@mikro-orm/mysql` and
// `@mikro-orm/postgresql` both re-export it from — the *same* `SqlEntityManager`
// class, not two structurally similar ones. This import used to name the MySQL
// package, and that single line was the whole of what bound this file to one
// engine at the type level.
import type { EntityManager } from '@mikro-orm/sql';
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { CATALOG_STORE_ENTITY_MANAGER } from './context';
import { type CatalogSqlDialect, MYSQL_DIALECT, POSTGRES_DIALECT } from './dialect';
import { SnapshotRow } from './entities/governance';
import { ObjectTypeRow, PropertyRow } from './entities/model';
import {
  BATCH_COLUMN,
  LOADED_AT_COLUMN,
  PRINCIPAL_COLUMN,
  ROW_COLUMN,
  SNAPSHOT_BATCH_INDEX,
  SNAPSHOT_COLUMN,
  outputAlias,
  physicalColumn,
  tableFor,
} from './identifiers';
import { refreshView, relationsFor, runReadOnlyQuery, streamReadOnlyQuery } from './query';

/**
 * A SQL warehouse: one physical table per object type, append-only, partitioned
 * by snapshot.
 *
 * **One class, two engines.** Everything below is written against
 * {@link CatalogSqlDialect} rather than against MySQL, and the two shipped
 * dialects are values rather than subclasses — see `dialect.ts` for what is
 * genuinely different between them and, more usefully, for the much longer list
 * of things that turned out not to be. A second store forked from this one would
 * be two implementations that disagree the moment either is edited, and the
 * shared contract in `test/catalog-store-contract.ts` is what keeps this one
 * honest about both.
 *
 * Snapshots are emulated, not native, and that is the honest label. MySQL keeps
 * no history of its own, so history here is a column — every load writes rows
 * tagged with its snapshot id and reads filter to the committed one. The same
 * is true of ClickHouse and DuckDB, which is worth saying out loud because
 * their reputation suggests otherwise: DuckDB has no time travel at all, and
 * ClickHouse's ReplacingMergeTree collapses old versions rather than keeping
 * them. A column store would be chosen here for read speed over wide tables,
 * not because it would make this class simpler. The engines that do give
 * history for free are table formats — Iceberg, Delta — read *through* those.
 */
/**
 * The batch number carried rows are written under.
 *
 * Negative on purpose. `write()` defaults an unnumbered batch to 0 and callers
 * count up from there, so anything at or above zero can legitimately arrive
 * from outside; a negative number is one no caller produces, which keeps the
 * store's own rows separable from the load's by a predicate rather than by
 * convention. Everything below relies on that: telling carried rows from
 * written ones is what makes the merge, the recount and the retry work.
 */
const CARRY_FORWARD_BATCH = -1;

/**
 * How many snapshots of one type {@link MikroOrmWarehouseStore.listSnapshots}
 * will report.
 *
 * It was 50, chosen as a page and not as a bound, and the difference showed up
 * as a deployment holding 441 retained snapshots of one type across 100 GB with
 * no screen anywhere able to show more than the newest 50. Nothing was hidden on
 * purpose; the list was simply shorter than the problem, and a truncated list
 * that does not say it is truncated reads as the whole answer.
 *
 * 500 is not a page size — no console renders 500 rows usefully — it is the size
 * at which the accumulation this list exists to make visible is visible. A type
 * loaded hourly for three weeks fits under it; one loaded every few minutes for
 * a year does not, and that type has a retention problem the list is now large
 * enough to show the shape of.
 *
 * Exported so a host reading a full list knows whether it read all of them: a
 * result of exactly this length is the one case where there may be more.
 */
export const CATALOG_SNAPSHOT_LIST_LIMIT = 500;

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

@Injectable()
export class MikroOrmWarehouseStore
  implements
    CatalogMergeStore,
    CatalogQueryStore,
    CatalogFilteringReadStore,
    CatalogSnapshotStreamStore,
    CatalogSnapshotLookupStore
{
  private readonly logger = new Logger(this.constructor.name);

  /**
   * All nine, because all nine become one conjunct in the `WHERE` this store
   * already builds. Declared rather than left to be inferred from the class: the
   * service offers a screen exactly what is listed here, so a store that stopped
   * applying one of these would have to say so here to be honest, and saying so
   * is what removes the control rather than leaving it to return unfiltered rows.
   */
  readonly objectFilterOperators = CATALOG_FILTER_OPERATORS;

  /**
   * Measured against what this class actually issues, not against what MySQL is
   * capable of. The three atomicity fields are the interesting ones and two of
   * them are false, which is the point of declaring them: a caller writing
   * recovery logic against this store needs to know that re-running is the
   * repair, because nothing here will roll back for it.
   */
  readonly capabilities: CatalogStoreCapabilities = {
    snapshots: 'emulated',
    writable: true,
    timeTravel: true,
    // Each side of the cutover lands whole. The pointer `read()` consults
    // (`ObjectTypeRow.currentSnapshotId`) and the snapshot's `committed` flag
    // move together in one `em.flush()`, which is one transaction; the SQL
    // console's view moves by `CREATE OR REPLACE VIEW`, which on MySQL 8 is a
    // data-dictionary change made under an exclusive metadata lock: the name is
    // never undefined, and a concurrent `SELECT` waits and then reads one
    // definition or the other. Worth stating because the same statement on
    // ClickHouse drops and recreates the name — measured, 18 `UNKNOWN_TABLE`
    // errors in 400 concurrent reads — which is why that adapter had to reach
    // for `EXCHANGE TABLES` to be able to claim this.
    //
    // What this does NOT claim is that the two sides flip in the same instant.
    // They do not: `commit()` flushes and then refreshes the view, so there is a
    // window in which the API serves the new snapshot and the console still
    // selects from the old one. That gap is what `transactional: false` below
    // is about, and a crash inside it is repaired by re-running the commit.
    atomicCutover: true,
    // `write()` deletes the batch's rows and then inserts the new ones, as two
    // statements outside a transaction, so there is a moment in which neither
    // copy is present. Invisible for an ordinary load — an uncommitted snapshot
    // has no readers — and visible for the case nobody plans for: a durable run
    // whose commit already succeeded, retrying from the top and re-sending its
    // batches into a snapshot that is live and being served. ClickHouse's
    // `REPLACE PARTITION` is one metadata commit and does not have this window.
    atomicBatchReplace: false,
    // No operation here spans its statements in one transaction. `write()` is
    // DELETE, INSERT, then a flush of the snapshot row; `commit()` is a flush
    // and then DDL. Each step is individually atomic and every one of them is
    // written to be re-runnable, which is what makes a retry the repair.
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
    // By token, never positionally. The default connection is whichever one the
    // host registered first, and in a host with a database of its own that is
    // not this catalog's.
    @Inject(CATALOG_STORE_ENTITY_MANAGER)
    private readonly em: EntityManager,
    /**
     * Which engine's SQL this store emits.
     *
     * Defaulted to MySQL rather than required, so every existing wiring — a
     * host's `new MySqlWarehouseStore(em)`, the module's provider list, the
     * environment bundle — keeps working and keeps meaning what it meant. A
     * Postgres deployment names {@link PostgresWarehouseStore}, which is this
     * class with the other value bound.
     */
    protected readonly dialect: CatalogSqlDialect = MYSQL_DIALECT,
  ) {}

  /** Quote an identifier the way this store's engine does. */
  private ident(value: string): string {
    return this.dialect.ident(value);
  }

  /**
   * Bring the physical table in line with the type definition.
   *
   * **Additive only.** A column that appears is created; a column that
   * disappears from the definition is left alone, and a column whose type
   * changes is left alone. Dropping and retyping are the changes that lose data
   * and break readers, and a service that accepts them over HTTP from whatever
   * application happened to deploy first is one bad release away from an
   * outage. Those go through a human.
   */
  async ensureType(type: CatalogObjectTypeDef): Promise<void> {
    const em = this.em.fork();
    const table = tableFor(type.name);
    const connection = em.getConnection();

    // Before any DDL, because the answer does not depend on the table and the
    // point is to refuse in terms of the type rather than in terms of SQL.
    //
    // MySQL does catch all of this on its own — a property mapping onto a
    // reserved column makes CREATE TABLE list that column twice ("Duplicate
    // column name"), and on an existing table makes the INSERT name it twice
    // ("Column ... specified twice"). So nothing here is preventing silent
    // corruption; it is replacing a driver error that names a *derived* column
    // with one that names the properties that produced it. Working backwards
    // from `Asset_NSN` to whichever two of forty properties clean to it, through
    // a mapping the publisher has never seen, is the part that costs an
    // afternoon.
    //
    // `foldsColumnCase` from the dialect, because the two engines genuinely
    // differ: MySQL folds, so `assetId` and `AssetID` are one column and this
    // refuses; Postgres quotes, so they are two columns and this must not. The
    // consequence is an asymmetry an operator has to know about — a model
    // Postgres accepts can be refused by MySQL — and it is stated where the flag
    // is declared rather than smoothed over here.
    assertNoColumnCollisions(type, physicalColumn, {
      foldsColumnCase: this.dialect.foldsColumnCase,
      store: this.dialect.name,
    });

    const existing = await this.existingColumns(table);

    if (existing.size === 0) {
      for (const statement of this.dialect.createObjectTable({
        table,
        columns: type.properties.map((p) => [
          this.ident(physicalColumn(p.name)),
          `${this.dialect.columnType(p.type)} NULL`,
        ]),
        rowColumn: ROW_COLUMN,
        snapshotColumn: SNAPSHOT_COLUMN,
        principalColumn: PRINCIPAL_COLUMN,
        loadedAtColumn: LOADED_AT_COLUMN,
        batchColumn: BATCH_COLUMN,
        index: SNAPSHOT_BATCH_INDEX,
      })) {
        await connection.execute(statement);
      }
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

    // Reserved columns evolve too. They only appear in CREATE TABLE, so a table
    // created by an older version of this package is missing whatever was added
    // since — and the failure lands at write time, on a table that looks fine.
    const RESERVED: Array<[string, string]> = [[BATCH_COLUMN, 'INT NOT NULL DEFAULT 0']];
    for (const [column, definition] of RESERVED) {
      if (existing.has(this.foldName(column))) continue;
      await connection.execute(this.dialect.addColumn(table, column, definition));
      this.logger.log(`Added reserved column ${column} to ${table}`);
    }

    // And so do the indexes — which had no path at all, and that was the
    // expensive half. See {@link ensureSnapshotBatchIndex}. Strictly after the
    // reserved columns above, because the index it adds names one of them.
    await this.ensureSnapshotBatchIndex(type.name, table);

    const missing = type.properties.filter(
      (p) => !existing.has(this.foldName(physicalColumn(p.name))),
    );
    for (const property of missing) {
      await connection.execute(
        this.dialect.addColumn(
          table,
          physicalColumn(property.name),
          `${this.dialect.columnType(property.type)} NULL`,
        ),
      );
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

  /**
   * Write one batch.
   *
   * `written` is the rows this call took, which is what the interface says it
   * must be: not the snapshot's total, not the rows this batch displaced. The
   * distinction is invisible on a single-batch load and decides two things
   * elsewhere — a caller summing across batches to report what a load produced,
   * and a fan-out comparing this number against a follower's to catch a batch
   * that landed short. The snapshot's own count is on the `SnapshotRef` that
   * `commit` returns, and it is deliberately counted from the table rather than
   * accumulated here.
   *
   * ## A batch of zero rows is a batch
   *
   * `rows: []` writes no rows and still does everything else: it replaces
   * whatever that batch held, it creates the snapshot, and it counts. This used
   * to return immediately, and the cost of that was paid two steps later and
   * under the wrong name — no rows meant no snapshot row, so `commit` refused
   * with "no snapshot has been written", which sends somebody looking for a lost
   * batch when what actually happened is that a source returned nothing.
   *
   * A source CAN legitimately become empty: a base decommissioned, a filter
   * narrowed on purpose, a dataset retired. A store that cannot hold an empty
   * snapshot is a catalog that can never show an empty type, and the only way
   * left to express it is to delete the type — which throws away its history and
   * its curation to say something about one day's data.
   *
   * **Whether that emptiness is acceptable is not decided here.** The row-count
   * bound decides it (`refuseRowCountDrift` in the pipeline package): zero rows
   * never replaces a non-empty dataset, at any size, unless the snapshot's labels
   * carry the operator's acknowledgement. Both halves of that need this snapshot
   * to exist — the count to measure and the labels to read — so the store's job
   * is to make the load representable and the bound's job is to refuse it. A
   * refusal here instead would be the same rule enforced with no way to
   * acknowledge it, which is the acknowledgement made inert in a second place:
   * the very case most likely to need it is a source that really was emptied.
   *
   * **Silence is still not a declaration.** A caller that writes no batch at all
   * — a run whose source was unreachable rather than empty — leaves no snapshot,
   * and `commit` refuses. This store cannot tell those two apart from the rows,
   * because there are none either way, so it makes the caller say which one it
   * means: an empty batch says "the load ran and produced nothing", and writing
   * nothing says nothing at all.
   */
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
       * a retry silently doubles the data. Sending batch 2 twice replaces it;
       * sending batches 1..N again replaces the whole load.
       */
      batch?: number;
      labels?: Record<string, string>;
    },
  ): Promise<{ written: number }> {
    const em = this.em.fork();
    const table = tableFor(type.name);

    // Once per table per process, make sure the table matches the type before
    // writing to it. Publishing the type used to be the only thing that ran
    // this, so a table whose type had not been republished since a reserved
    // column was added stayed one column short — and the failure surfaced as
    // `Unknown column '_batch' in 'where clause'` on an ordinary load, hours or
    // releases away from the change that caused it. The check is two catalogue
    // reads on the first write after boot and nothing after that.
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
    //
    // Asked only of a batch that has rows. Zero rows carry no field names to
    // disagree with the type, and reading that silence as "nothing matched"
    // would refuse the empty load in the one voice guaranteed to send the reader
    // to the wrong place: a message about mismatched headers, for a batch that
    // has no headers.
    if (rows.length > 0) {
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
    const columns = [
      SNAPSHOT_COLUMN,
      PRINCIPAL_COLUMN,
      LOADED_AT_COLUMN,
      BATCH_COLUMN,
      ...properties.map((p) => physicalColumn(p.name)),
    ];

    const now = new Date();
    const values: unknown[] = [];
    const placeholders = rows.map((row) => {
      values.push(options.snapshotId, options.principalId, now, batch);
      for (const property of properties) {
        values.push(this.dialect.coerce(row[property.name], property.type));
      }
      return `(${columns.map(() => '?').join(',')})`;
    });

    // Replace, not append. This is what makes a retried batch idempotent.
    //
    // Unconditional, including for a batch of zero rows, and that is the whole
    // of the special-casing an empty batch gets: "this batch is now what I last
    // said it was" is one rule, and a caller re-sending a batch that has since
    // emptied means it. Exempting the empty case would leave the previous
    // attempt's rows in a snapshot the caller has retracted them from — and it
    // would need its own answer to the merge question below, because rows
    // vanishing from a batch changes what the carry-forward should have copied
    // in exactly the way rows arriving does.
    await em
      .getConnection()
      .execute(
        `DELETE FROM ${this.ident(table)} WHERE ${this.ident(SNAPSHOT_COLUMN)} = ? AND ${this.ident(BATCH_COLUMN)} = ?`,
        [options.snapshotId, batch],
      );
    // Skipped only because MySQL has no syntax for inserting no tuples. Nothing
    // downstream of here treats the two cases differently.
    if (placeholders.length > 0) {
      await em
        .getConnection()
        .execute(
          `INSERT INTO ${this.ident(table)} (${columns.map((column) => this.ident(column)).join(',')}) VALUES ${placeholders.join(',')}`,
          values,
        );
    }

    // The snapshot row is upserted rather than inserted so a retried batch does
    // not create a second one. What it carries is identity and labels; its
    // `rowCount` is not maintained here and is not to be read off an
    // uncommitted row — {@link countBySnapshot} says where it comes from
    // instead.
    const id = `${type.name}:${options.snapshotId}`;
    const snapshot =
      (await em.findOne(SnapshotRow, { id })) ??
      em.create(SnapshotRow, {
        id,
        typeName: type.name,
        snapshotId: options.snapshotId,
        principalId: options.principalId,
        rowCount: 0,
        committed: false,
        labels: options.labels,
        createdAt: now,
      });

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
    if (snapshot.labels?.[CARRIED_FROM_LABEL] !== undefined) {
      snapshot.labels = {
        ...snapshot.labels,
        [CARRY_FORWARD_STALE_LABEL]: 'true',
      };
    }

    // No row count here. See {@link countBySnapshot} for where it moved to and
    // why; the short version is that counting the whole snapshot once per batch
    // makes a load quadratic in its own size, and nothing reads the number
    // between the first batch and the commit.
    em.persist(snapshot);
    await em.flush();

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
   * One statement does the whole thing, and the shape of it is the design: an
   * anti-join from the previous snapshot against the rows already written here,
   * so a previous row is copied only when nothing in this load carries its
   * primary key. "The incoming row replaces the old one" is therefore not a
   * second step that could half-happen — the old one is simply never copied.
   *
   * It is SQL rather than a read-modify-write through Node because these tables
   * hold whole datasets. Pulling a snapshot into memory to merge it would put
   * the size of the largest object type into the heap of the process that
   * happened to run the connector.
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

    const em = this.em.fork();
    const table = tableFor(type.name);
    const connection = em.getConnection();

    // Same reason as `write`: the reserved columns this depends on may postdate
    // the table, and `_batch` is one of them.
    if (!this.ensured.has(table)) await this.ensureType(type);

    const id = `${type.name}:${snapshotId}`;
    const own = await em.findOne(SnapshotRow, { id });

    // Which snapshot to carry from, asked of the snapshot table rather than of
    // `ObjectTypeRow.currentSnapshotId`.
    //
    // The two agree right up until the moment they matter. A durable run that
    // retries *after* its commit step succeeded replays every step, and by then
    // `currentSnapshotId` points at this very snapshot — carrying forward from
    // itself would delete the carried rows and then find nothing to replace
    // them with, silently reducing the dataset to whatever the run happened to
    // fetch. Asking for the newest committed snapshot that is not this one, and
    // that existed before this one did, gives the same answer on the first run
    // and on the tenth replay.
    //
    // Tombstones are excluded, and that clause is what keeps a drop from
    // becoming a silent truncation one load later. The row survives a drop now,
    // so the newest committed snapshot can be one whose rows are gone — reachable
    // by rolling back to an older load and then dropping the bad one, which is
    // the ordinary way a bad load is cleaned up. Carrying forward from it would
    // copy nothing, and the load would commit holding only what this run
    // happened to fetch: a full replacement wearing an incremental load's name.
    // Skipping to the next committed snapshot that still has its data lands on
    // the one the type is actually serving, which is what a merge is a merge
    // against.
    const previous = await em.findOne(
      SnapshotRow,
      {
        typeName: type.name,
        committed: true,
        droppedAt: null,
        snapshotId: { $ne: snapshotId },
        createdAt: { $lte: own?.createdAt ?? new Date() },
      },
      { orderBy: { createdAt: 'desc', snapshotId: 'desc' } },
    );

    // Before the delete below, so that a load which cannot legally be merged
    // leaves the snapshot byte for byte as it found it. Doing it the other way
    // round would strip an earlier, valid carry-forward off a snapshot and then
    // throw, and the snapshot left behind would still look committable.
    if (previous) {
      await this.assertKeyed(table, keyColumns, keys, [
        [snapshotId, `the rows already written for ${snapshotId}`],
        [previous.snapshotId, `snapshot ${previous.snapshotId}`],
      ]);
    }

    // Unconditional, and before the copy: this is what makes a second call
    // idempotent rather than additive, and it also clears a stale merge left by
    // a batch that arrived after the last one.
    await connection.execute(
      `DELETE FROM ${this.ident(table)} WHERE ${this.ident(SNAPSHOT_COLUMN)} = ? AND ${this.ident(BATCH_COLUMN)} = ?`,
      [snapshotId, CARRY_FORWARD_BATCH],
    );

    if (previous) {
      const columns = [
        SNAPSHOT_COLUMN,
        PRINCIPAL_COLUMN,
        LOADED_AT_COLUMN,
        BATCH_COLUMN,
        ...type.properties.map((p) => physicalColumn(p.name)),
      ];
      const previousAlias = this.ident('prev');
      const incomingAlias = this.ident('incoming');

      // `_principal_id` and `_loaded_at` come across untouched rather than
      // being restamped with this run. A carried row is not a new load of that
      // row — nobody loaded it today, it simply did not change — so restamping
      // would erase the one thing the column is good for, which is telling you
      // when a value last actually moved. Who owns the *snapshot* is on the
      // snapshot row, and that is a different question.
      const selected = [
        '?',
        `${previousAlias}.${this.ident(PRINCIPAL_COLUMN)}`,
        `${previousAlias}.${this.ident(LOADED_AT_COLUMN)}`,
        '?',
        ...type.properties.map((p) => `${previousAlias}.${this.ident(physicalColumn(p.name))}`),
      ];

      // A LEFT JOIN anti-join rather than `NOT EXISTS`, and not for taste:
      // MySQL allows the target of an `INSERT ... SELECT` to appear in the FROM
      // clause and refuses it in a subquery. Both references live in FROM here,
      // so the statement is legal by the documented rule rather than by luck,
      // and the optimiser gets a plain equi-join it can hash.
      //
      // Reading and writing one table in one statement is safe here for a
      // second, sturdier reason than MySQL buffering the SELECT: the rows this
      // inserts can match neither side of its own join. They carry this load's
      // snapshot id, which the `prev` side excludes, and the carry-forward
      // batch, which the `incoming` side excludes. That is what the `_batch`
      // predicate below is really for — without it the statement could feed on
      // its own output.
      //
      // `=` and not the null-safe `<=>`: NULL is not a value two rows can share
      // and a row whose key is unknown must not silently absorb another. What
      // makes that choice safe is `assertKeyed` above — with `=` alone, a
      // NULL-keyed row would match nothing, be carried forward on every run,
      // and duplicate itself for as long as the connector kept running.
      const join = keyColumns
        .map(
          (column) =>
            `${incomingAlias}.${this.ident(column)} = ${previousAlias}.${this.ident(column)}`,
        )
        .join(' AND ');

      await connection.execute(
        `INSERT INTO ${this.ident(table)} (${columns.map((column) => this.ident(column)).join(',')})
         SELECT ${selected.join(',')}
           FROM ${this.ident(table)} AS ${previousAlias}
           LEFT JOIN ${this.ident(table)} AS ${incomingAlias}
             ON ${incomingAlias}.${this.ident(SNAPSHOT_COLUMN)} = ?
            AND ${incomingAlias}.${this.ident(BATCH_COLUMN)} <> ?
            AND ${join}
          WHERE ${previousAlias}.${this.ident(SNAPSHOT_COLUMN)} = ?
            AND ${incomingAlias}.${this.ident(ROW_COLUMN)} IS NULL`,
        [snapshotId, CARRY_FORWARD_BATCH, snapshotId, CARRY_FORWARD_BATCH, previous.snapshotId],
      );
    }

    // Counted from the table for the same reason `write` counts there: it is
    // the only thing that knows what the statement actually did, and a number
    // derived from anything else drifts the first time a retry replaces a
    // batch. Both numbers come from one statement — `SUM` over a predicate
    // rather than a second query — because the alternative is two scans of the
    // same index range. MySQL returns NULL for a sum over no rows, which the
    // `?? 0` covers.
    const [{ total, carried }] = await connection.execute<
      Array<{ total: number; carried: number | null }>
    >(
      `SELECT COUNT(*) AS total, ${this.dialect.countCarried(this.ident(BATCH_COLUMN))} AS carried
         FROM ${this.ident(table)} WHERE ${this.ident(SNAPSHOT_COLUMN)} = ?`,
      [CARRY_FORWARD_BATCH, snapshotId],
    );
    const rowCount = Number(total ?? 0);
    const carriedCount = Number(carried ?? 0);

    const now = new Date();
    // Created here when it does not exist yet, which is the run that fetched
    // nothing new. That run still has to produce a complete snapshot — "the
    // source had no changes" and "the dataset is empty" are different facts,
    // and only one of them should ever repoint the view at nothing.
    const snapshot =
      own ??
      em.create(SnapshotRow, {
        id,
        typeName: type.name,
        snapshotId,
        principalId: options.principalId,
        rowCount: 0,
        committed: false,
        labels: options.labels,
        createdAt: now,
      });

    const labels = { ...snapshot.labels };
    labels[CARRIED_FROM_LABEL] = previous?.snapshotId ?? CARRIED_FROM_NOTHING;
    // The merge is current as of now, whatever it was before this call.
    delete labels[CARRY_FORWARD_STALE_LABEL];
    snapshot.labels = labels;
    snapshot.rowCount = rowCount;
    em.persist(snapshot);
    await em.flush();

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
   * Publish a snapshot: flip its flag, move the pointer, move the view.
   *
   * **What a missing snapshot means, and why it is still refused.** Nothing
   * creates a snapshot row here. A load that wrote no batch at all — the source
   * was unreachable, the run died before its first batch, the caller sent a
   * snapshot id it never wrote to — reaches this method with nothing to commit,
   * and those are different facts that look identical from inside the store.
   * Inventing an empty snapshot to commit would pick the most destructive of
   * them: it would repoint every reader at no rows on the strength of a typo.
   * So it refuses, and the message names the possibility that is easy to miss,
   * because the other two announce themselves in the caller's own logs and "the
   * source returned nothing" does not.
   *
   * A load that genuinely produced nothing says so by writing an empty batch,
   * which creates the snapshot like any other write. From there it is an
   * ordinary snapshot holding zero rows, and whether it may replace what is
   * being served is the row-count bound's decision rather than this method's —
   * see the note on {@link write}.
   */
  async commit(type: CatalogObjectTypeDef, snapshotId: string): Promise<SnapshotRef> {
    const em = this.em.fork();
    const id = `${type.name}:${snapshotId}`;
    const snapshot = await em.findOne(SnapshotRow, { id });
    if (!snapshot) {
      throw new BadRequestException(
        `No snapshot ${snapshotId} has been written for ${type.name}, so there is nothing to commit. A snapshot is created by the first batch written under its id, and a load that produced no rows writes no batch — so a source that returned nothing, a run that died before its first batch, and a snapshot id that was never written to all arrive here looking the same. If ${type.name} really is empty at the source, write an empty batch under ${snapshotId}: that creates the snapshot, and committing it over a non-empty dataset is then refused by the row-count expectation rather than by this message, which is where the acknowledgement for a deliberate collapse belongs.`,
      );
    }

    // Before the stale-carry-forward check and before the count, because it is
    // the cheapest refusal and the most serious one. Committing a tombstone is
    // exactly the failure that kept `dropSnapshot` off any schedule: the pointer
    // moves to a snapshot with no rows, every reader of the type sees an empty
    // dataset, and the recount below would have found zero and merely logged
    // about it — a warning, for the one case that is never a real empty load.
    if (snapshot.droppedAt) {
      throw new BadRequestException(
        `${droppedMessage(type.name, snapshot, snapshot.droppedAt)} Committing it would point ${type.name} at a snapshot holding nothing. Commit a snapshot that still has its rows, or load ${type.name} again.`,
      );
    }

    // Refused, not repaired. The carry-forward could be re-run from here, but
    // then a commit would be quietly doing a merge, and the caller that wrote
    // the late batch would never learn that its ordering was wrong. What is on
    // the other side of committing anyway is a view serving two versions of
    // every row the late batch touched, under one primary key, with nothing to
    // say which is current.
    const labels = snapshot.labels;
    if (labels?.[CARRY_FORWARD_STALE_LABEL] !== undefined) {
      throw new BadRequestException(
        `Snapshot ${snapshotId} of ${type.name} carried rows forward from ${
          labels[CARRIED_FROM_LABEL] ?? 'an earlier snapshot'
        } and then took more batches, so the merge no longer covers the whole load and every re-sent row is in it twice. Carry forward again, then commit — in that order.`,
      );
    }

    const typeRow = await em.findOne(ObjectTypeRow, { name: type.name });

    // The count, and this is the only place it is taken for a snapshot that is
    // being published. Strictly before the empty-check below, which reads it,
    // and before the flush, which makes it the number every later reader of
    // this committed row gets without asking the table again.
    //
    // After the stale-carry-forward refusal above rather than before it: a
    // snapshot that cannot be committed should not pay for a scan to be told so.
    snapshot.rowCount = await this.countRows(em, tableFor(type.name), snapshotId);

    // An empty snapshot is committed, not refused — and said out loud when it
    // replaces something.
    //
    // Refused is the tempting answer and it is the wrong one here. The rule
    // "zero rows never replaces a non-empty dataset" already exists, one layer
    // up, together with the one thing that makes it liveable: a label on the
    // snapshot by which an operator acknowledges a collapse they meant. This
    // store cannot read that acknowledgement — the label and its meaning belong
    // to the pipeline package, which depends on this one and not the other way
    // round — so a refusal here would be that rule re-enforced by the component
    // that has no way to hear the answer, and a deliberate truncation would
    // become impossible to express at all.
    //
    // What is left is to say it. A host running this adapter without that bound
    // has nothing else standing between an empty load and the live view, and one
    // line naming both snapshots is the difference between noticing today and
    // noticing when somebody asks why a screen is blank.
    if (snapshot.rowCount === 0 && typeRow?.currentSnapshotId) {
      const served = await em.findOne(SnapshotRow, {
        id: `${type.name}:${typeRow.currentSnapshotId}`,
      });
      if (served && served.snapshotId !== snapshotId && served.rowCount > 0) {
        this.logger.warn(
          `Committing snapshot ${snapshotId} of ${type.name}, which holds no rows, over ${served.snapshotId}, which holds ${served.rowCount}. Every reader of ${type.name} now sees an empty dataset. That is what a source that really emptied looks like, and it is also what a filter matching nothing and a transform returning [] look like — this store cannot tell them apart. Nothing here refuses it; a row-count expectation on ${type.name} is what does.`,
        );
      }
    }

    snapshot.committed = true;
    snapshot.committedAt = new Date();
    if (typeRow) typeRow.currentSnapshotId = snapshotId;
    await em.flush();

    // The view is what queries select from, so it moves with the commit.
    await refreshView(em, type, snapshotId, this.dialect);

    emitCatalog('snapshot.committed', {
      typeName: type.name,
      snapshotId,
      principalId: snapshot.principalId,
      rowCount: snapshot.rowCount,
    });
    // Counted a few lines above and flushed since, so the row and the table
    // agree: this is the committed snapshot's final size.
    return toRef(snapshot, snapshot.rowCount);
  }

  /**
   * Delete a snapshot's rows and keep its record, marked as holding none.
   *
   * ## The two deletions this used to do, and why they came apart
   *
   * It deleted the rows from `obj_<type>` *and* the row from `catalog_snapshot`.
   * The first is what reclaims the disk this operation exists for; the second is
   * what made the operation unusable on any schedule, because
   * `catalog_connector_run.snapshotId` names a snapshot and a run log whose ids
   * resolve to nothing cannot answer what it is asked. That is written down as
   * the reason there is no retention policy anywhere in this package, and it is
   * correct — about the record. The disk is held by the rows.
   *
   * So the record stays, with `droppedAt` set. What a caller can still do with a
   * tombstone is everything except read it: name it, attribute it, see how large
   * it was, and find it from the run that produced it. What it cannot do is get
   * the data back, and every path to that data says so out loud rather than
   * answering with an empty result — {@link read}, {@link streamSnapshot},
   * {@link commit} and {@link carryForward} each refuse in their own terms.
   *
   * **This is not a retention policy and does not imply one.** Nothing here runs
   * on a timer, nothing chooses a snapshot, and deciding *when* rows may go is a
   * separate decision that now has something safe to be built on.
   *
   * ## The three orderings that matter
   *
   * The count is taken **before** the delete, because it is the last moment the
   * number exists; a tombstone that could not say how large the load was would
   * lose the one fact that makes a run's history worth keeping. `droppedAt` is
   * set **after** the delete, so a crash in between leaves a snapshot whose rows
   * are partly gone and whose record still says it holds them — visible, and
   * repaired by running this again. The reverse ordering would leave a tombstone
   * over rows nobody will ever delete, which is the failure that cannot be seen.
   *
   * And a second call is a no-op rather than a re-drop: `droppedAt` keeps the
   * time of the first, so a durable step that replays does not rewrite the date
   * to the moment of its retry.
   */
  async dropSnapshot(type: CatalogObjectTypeDef, snapshotId: string): Promise<void> {
    const em = this.em.fork();
    const typeRow = await em.findOne(ObjectTypeRow, { name: type.name });
    if (typeRow?.currentSnapshotId === snapshotId) {
      throw new BadRequestException(
        `Snapshot ${snapshotId} is the one being served for ${type.name}. Commit another one first.`,
      );
    }

    const snapshot = await em.findOne(SnapshotRow, { id: `${type.name}:${snapshotId}` });
    if (snapshot?.droppedAt) return;

    // Before the delete, and only when there is a record to write it to: a
    // snapshot with no row has nowhere to keep the number and the scan would be
    // paid for nothing.
    const held = snapshot ? await this.countRows(em, tableFor(type.name), snapshotId) : 0;

    await em
      .getConnection()
      .execute(
        `DELETE FROM ${this.ident(tableFor(type.name))} WHERE ${this.ident(SNAPSHOT_COLUMN)} = ?`,
        [snapshotId],
      );

    if (snapshot) {
      snapshot.rowCount = held;
      snapshot.droppedAt = new Date();
      await em.flush();
    }
    emitCatalog('snapshot.dropped', { typeName: type.name, snapshotId });
  }

  /**
   * The snapshot readers are being served, or nothing when none is.
   *
   * The same value `read()` resolves and the same one `dropSnapshot()` refuses
   * to remove — `ObjectTypeRow.currentSnapshotId` — rather than a fresh opinion
   * assembled from the snapshot table. That is the whole value of the method: a
   * caller that reconstructed it from `listSnapshots` would order by time and
   * pick the newest committed snapshot, which is a different row from this one
   * the moment somebody rolls a bad load back by committing an older snapshot
   * again. Those are exactly the circumstances in which a replay is running.
   *
   * The pointer can name a snapshot whose row has since been deleted. That is
   * reported as "nothing being served" rather than as a bare id, because a
   * caller cannot do anything useful with an id it can learn nothing else
   * about, and inventing a `SnapshotRef` with a zero row count would be
   * reporting an empty load rather than a missing record.
   *
   * **That warning is not what a dropped snapshot looks like, and it must not
   * be.** {@link dropSnapshot} keeps the record and marks it, so a deliberate
   * drop leaves the row here to be found; this branch is reachable only by a
   * hand-edited database or a bug, which is the state it was written to
   * describe. A drop of a snapshot this pointer names is refused outright, so
   * the branch below is a defect report and not a second name for a routine
   * one — the two states are told apart because they now say different things.
   */
  async currentSnapshot(type: CatalogObjectTypeDef): Promise<SnapshotRef | undefined> {
    const em = this.em.fork();
    const typeRow = await em.findOne(ObjectTypeRow, { name: type.name });
    const snapshotId = typeRow?.currentSnapshotId;
    if (!snapshotId) return undefined;
    const snapshot = await em.findOne(SnapshotRow, {
      id: `${type.name}:${snapshotId}`,
    });
    if (!snapshot) {
      this.logger.warn(
        `${type.name} points at snapshot ${snapshotId}, which has no row in catalog_snapshot. Reporting nothing as current: the pointer alone cannot say who loaded it or how many rows it holds.`,
      );
      return undefined;
    }
    if (snapshot.droppedAt) {
      this.logger.warn(
        `${type.name} is serving snapshot ${snapshotId}, whose rows were dropped on ${snapshot.droppedAt.toISOString()}. Reporting nothing as current: every read of ${type.name} is answering from a snapshot that holds no rows. Dropping a served snapshot is refused, so this state was not reached through this adapter — commit a snapshot that still has its data.`,
      );
      return undefined;
    }
    // The stored count, not a fresh one, and that is safe for exactly one
    // reason: `commit` is the only thing that sets `currentSnapshotId`, and it
    // writes the count and the pointer in the same flush. A snapshot reachable
    // through this method has therefore been counted at the moment it was
    // published. Recounting here would put a scan on the baseline half of every
    // row-count check to re-derive a number that cannot have moved.
    return toRef(snapshot, snapshot.rowCount);
  }

  /**
   * The type's recent snapshots, with the uncommitted ones counted fresh.
   *
   * That second half is load-bearing rather than tidy. This is the method the
   * row-count bound reads the *pending* snapshot's size from —
   * `PublishService.assertRowCountIsPlausible` calls it immediately before
   * `commit`, finds the snapshot about to be published, and compares its
   * `rowCount` against the one being served. An uncommitted row's stored count
   * is not maintained (see {@link countBySnapshot}), so reporting it verbatim
   * would hand the bound a zero for every load and refuse all of them.
   *
   * One extra statement, and only when there is something uncommitted to count.
   * A type in the ordinary state has at most one uncommitted snapshot in the
   * window — the load in flight — so this is one index range scan per call,
   * against the one-per-batch it replaces. A type carrying a backlog of
   * abandoned loads costs one scan per abandoned snapshot, still in a single
   * round trip.
   *
   * ## The window, and why it moved
   *
   * It was 50, and that is how 441 retained snapshots of one type went unnoticed
   * until the database filled: this is the only list of them anything has, so a
   * console reading it was blind to 391. The number that mattered was never on
   * the screen, and the screen did not say it was truncating.
   *
   * A window is still wanted — an unbounded list is one query that can return a
   * five-figure result set on a type loaded every few minutes for years — but it
   * has to be past the size where the accumulation this bounds is still
   * invisible. {@link CATALOG_SNAPSHOT_LIST_LIMIT} is that number, and the
   * tombstones {@link dropSnapshot} now leaves behind make it matter more rather
   * than less: a dropped snapshot used to leave the list, and now it stays in it.
   */
  async listSnapshots(type: CatalogObjectTypeDef): Promise<SnapshotRef[]> {
    const em = this.em.fork();
    const rows = await em.find(
      SnapshotRow,
      { typeName: type.name },
      { orderBy: { createdAt: 'desc' }, limit: CATALOG_SNAPSHOT_LIST_LIMIT },
    );

    // Tombstones are excluded from the fresh count and not merely absent from
    // the table: their rows are gone, so a count would come back zero and the
    // ref would report a load that held 27 million rows as an empty one. Their
    // stored number is the count `dropSnapshot` took before deleting, and it is
    // as final as a committed snapshot's.
    const pending = rows
      .filter((row) => !row.committed && !row.droppedAt)
      .map((row) => row.snapshotId);
    const counts = await this.countBySnapshot(em, tableFor(type.name), pending);

    // `?? 0` and never `?? row.rowCount`: a snapshot with no rows produces no
    // group row, and an empty load is precisely the case the bound above exists
    // to catch. Falling back to the stored number would report a collapse as
    // whatever size the type used to be.
    return rows.map((row) =>
      toRef(row, row.committed || row.droppedAt ? row.rowCount : (counts.get(row.snapshotId) ?? 0)),
    );
  }

  /**
   * What one snapshot id refers to, across every type in this store.
   *
   * ## Why it is not scoped to a type, and why it is not `read`
   *
   * The caller is a workflow whose graph names a snapshot, and it is holding a
   * string. Every wrong answer about that string is silent unless something goes
   * and looks: {@link read} given an id that no row carries answers `{ rows: [],
   * total: 0 }`, which is also what it answers for a snapshot that is genuinely
   * empty. Existence is a different question from emptiness and it needs a
   * different statement.
   *
   * Unscoped because the case worth telling apart is an id belonging to *another
   * type* — pasted from the wrong history, or off a run that loaded something
   * else. A per-type lookup can only say "not here", and "not here" sends a
   * person to look for a snapshot that is sitting in the next type along.
   *
   * One statement answers both, and it carries no index of its own: this table
   * holds one row per load rather than one per row of data, and this runs once
   * per run of a graph that names a snapshot — and then only to decide what to
   * refuse. Adding an index would be an ALTER on every deployment to speed up a
   * scan of a few thousand rows on a path that ends in an error message.
   *
   * A list rather than an option because the id is the caller's: a durable run
   * that loads two types passes its run id to both, so two rows legitimately
   * share an id, and returning one of them would be returning a coin toss.
   *
   * ## The count it reports
   *
   * `row.rowCount` verbatim, which is final for a committed snapshot and for a
   * tombstone — both were written by the operation that made them final — and is
   * **not maintained** for a load still in flight, where it reads 0. That is the
   * honest shape of a one-statement locator: {@link listSnapshots} is what
   * recounts, and it costs a statement per uncommitted snapshot to do it. Nobody
   * resolving an identity needs a live count.
   *
   * A tombstone is reported exactly as a live snapshot is, which is the whole
   * point of the method: a caller that could not see the tombstone would report
   * a dropped snapshot as one that never existed, and those two send a reader to
   * entirely different places.
   */
  async locateSnapshot(snapshotId: string): Promise<CatalogSnapshotLocation[]> {
    const rows = await this.em
      .fork()
      .find(SnapshotRow, { snapshotId }, { orderBy: { createdAt: 'desc' } });
    return rows.map((row) => ({ typeName: row.typeName, snapshot: toRef(row, row.rowCount) }));
  }

  /**
   * Rows of one type, as of one snapshot.
   *
   * **Reading history is the same read with a different id.** The snapshot is a
   * column on this table, so `WHERE _snapshot_id = ?` against the leading column
   * of `ix_snapshot_batch` is the whole of time travel — an old load costs exactly what the current one
   * costs, and nothing here touches the SQL view. That matters: the view is what
   * the query console selects from and it names the *committed* snapshot, so
   * reading last Tuesday by pointing the view at last Tuesday would have every
   * ad-hoc query in the deployment silently answering about last Tuesday too,
   * until somebody committed again. The view moves on commit and only on commit.
   *
   * Two statements per read, unchanged by any of this: one `COUNT`, one page.
   * Filters and the snapshot are conjuncts in both.
   *
   * ## Reading a snapshot whose rows were dropped
   *
   * Refused, with the date. A tombstoned snapshot's predicate matches nothing,
   * so without the check below this returns `{ rows: [], total: 0 }` — the same
   * answer as a filter that excluded everything and as a load that collapsed, on
   * a screen that has no way to tell those apart.
   *
   * The lookup that finds out costs a statement, so it is paid **only on the
   * history path**. A read with no `snapshot` resolves the type's pointer, and
   * {@link dropSnapshot} refuses to drop what that pointer names — so the
   * ordinary read is two statements exactly as it was, and the third arrives
   * only when a caller has explicitly asked for an older load.
   */
  async read(
    type: CatalogObjectTypeDef,
    fields: string[],
    query: CatalogReadQuery,
  ): Promise<CatalogReadResult> {
    const em = this.em.fork();
    const table = tableFor(type.name);

    const typeRow = await em.findOne(ObjectTypeRow, { name: type.name });
    const snapshotId = query.snapshot ?? typeRow?.currentSnapshotId;
    // Nothing committed yet is an empty result, not an error: the type is real
    // and known, it simply has no load anyone has blessed.
    if (!snapshotId) return { rows: [], total: 0 };
    // Only when the caller named one. See the docblock: the pointer's own
    // snapshot cannot be a tombstone, so the ordinary read pays nothing.
    if (query.snapshot) await this.assertNotDropped(em, type.name, query.snapshot);
    // Answered from the row already fetched, so saying which load these rows are
    // costs no query at all. `current` is the comparison a reader cares about and
    // is the one thing they cannot work out for themselves.
    const snapshot = { id: snapshotId, current: snapshotId === typeRow?.currentSnapshotId };

    const selected = type.properties.filter((p) => fields.includes(p.name));
    if (selected.length === 0) return { rows: [], total: 0, snapshot };

    const params: unknown[] = [snapshotId];
    let where = `${this.ident(SNAPSHOT_COLUMN)} = ?`;

    const search = searchPredicate(selected, query.search, this.dialect);
    if (search) {
      where += ` AND ${search.sql}`;
      params.push(...search.values);
    }

    for (const filter of query.filters ?? []) {
      const { sql, values } = filterPredicate(selected, filter, this.dialect);
      where += ` AND ${sql}`;
      params.push(...values);
    }

    const [{ total }] = await em
      .getConnection()
      .execute<Array<{ total: number }>>(
        `SELECT COUNT(*) AS total FROM ${this.ident(table)} WHERE ${where}`,
        params,
      );

    const sortProperty = selected.find((p) => p.name === query.sort);
    const orderBy = sortProperty
      ? `${this.ident(physicalColumn(sortProperty.name))} ${query.dir === 'desc' ? 'DESC' : 'ASC'}`
      : `${this.ident(ROW_COLUMN)} ASC`;

    const size = Math.max(1, query.size ?? 25);
    const offset = (Math.max(1, query.page ?? 1) - 1) * size;

    // Aliased to `outputAlias`, the same name the committed view exposes, and
    // NOT to the property's name. `ident` refuses rather than escapes, so a
    // verbatim alias here was the second of the two statements that made "is
    // this a SQL identifier?" a condition on every property name in the
    // catalog — and a property that cannot be named `Asset Id` is a property
    // whose loads write NULL, because a load reads `row[property.name]` out of a
    // record the source keyed `Asset Id`. `normalise` below looks the value back
    // up under the same alias and hands it out under the property's own name, so
    // nothing outside this method sees the difference.
    const rows = await em.getConnection().execute<Array<Record<string, unknown>>>(
      `SELECT ${selected
        .map((p) => `${this.ident(physicalColumn(p.name))} AS ${this.ident(outputAlias(p.name))}`)
        .join(',')}
         FROM ${this.ident(table)} WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, size, offset],
    );

    return {
      total: Number(total ?? 0),
      rows: rows.map((row) => normalise(row, selected)),
      snapshot,
    };
  }

  /**
   * Every row of one snapshot, as the driver produces them.
   *
   * ## Why this exists beside `read`
   *
   * `read` is a page: two statements, a `COUNT` and a `LIMIT`/`OFFSET`. A whole
   * dataset read through it costs the offset walk once per page, so the cost is
   * quadratic in the size of the thing being read — and the row counts this is
   * for (7,637,391 in one type here) are exactly the ones that makes fatal.
   * This is one statement and one pass, and nothing holds more than the driver's
   * buffer.
   *
   * ## The predicate is the whole point
   *
   * `WHERE _snapshot_id = ?`, against the leading column of `ix_snapshot_batch`.
   * The table retains every committed load, so a read of it *without* this
   * predicate returns every snapshot concatenated — which is what a workflow
   * reaching its own warehouse through a `sql` connector was doing, silently, at
   * exactly twice the row count and with every sum doubled. See
   * {@link CatalogSnapshotStreamStore}.
   *
   * The id is the caller's and is never defaulted here: resolving "current" is
   * the caller's decision and it is made once, at the start of a run, so a
   * commit landing mid-read cannot splice two snapshots into one load.
   *
   * ## What it does NOT go through
   *
   * The committed view. The view names the snapshot that was current when it was
   * last refreshed, so reading through it would silently switch datasets under a
   * long read the moment anything committed — which is the same failure this
   * repairs, arrived at from the other side. It also aliases its columns to
   * `outputAlias`, and rows are handed out keyed by property name here exactly as
   * `read` hands them out, so the caller sees one vocabulary.
   *
   * ## `provenance`, and why it is two columns rather than five
   *
   * With it, every row also carries `_principal_id` and `_loaded_at`. Those two
   * and no others, because those two are the ones {@link carryForward} *reads*
   * off the snapshot it merges against — see {@link CATALOG_PROVENANCE_COLUMNS}
   * for the argument, which was asked of all five reserved columns and answered
   * differently for each.
   *
   * The keys are the reserved names verbatim, which is safe rather than lucky: a
   * property may not be *called* one, so `_loaded_at` cannot collide with a
   * property's own key in the row this hands back.
   *
   * `_loaded_at` gets whatever the driver hands over, unconverted, exactly as a
   * `date` property does — MikroORM's MySQL connection sets `dateStrings` and a
   * `DATETIME` arrives as `2026-01-02 03:04:05`, where Postgres returns a `Date`
   * that {@link normalise}'s rule turns into an ISO string. That divergence is
   * real, is the shared store contract's already-recorded finding about `date`
   * columns, and is deliberately not repaired here: inventing a zone for MySQL's
   * naive string in this one method would make `_loaded_at` disagree with every
   * `date` property beside it in the same row.
   */
  async *streamSnapshot(
    type: CatalogObjectTypeDef,
    fields: string[],
    snapshotId: string,
    options?: SnapshotStreamOptions,
  ): AsyncGenerator<Record<string, unknown>> {
    const selected = type.properties.filter((p) => fields.includes(p.name));
    // Nothing asked for is nothing to read, and it is not an error: `read` says
    // the same thing about the same input. A `SELECT` with no columns is not a
    // statement.
    if (selected.length === 0) return;
    const provenance = options?.provenance === true;

    // Always, unlike `read`, and the asymmetry is not an oversight: this method
    // takes the id from its caller and never resolves the pointer, so there is
    // no path here that a dropped snapshot cannot be on. A workflow reading a
    // tombstone would otherwise iterate zero rows, report success, and commit an
    // empty load over whatever it was pointed at downstream — which is the exact
    // failure `streamSnapshot` was added to stop, arrived at from the other side.
    await this.assertNotDropped(this.em.fork(), type.name, snapshotId);

    const table = tableFor(type.name);
    // Named from the core package's list rather than from this adapter's own
    // `PRINCIPAL_COLUMN` and `LOADED_AT_COLUMN`, for the reason `RESERVED_COLUMNS`
    // is: the archiver checks its rows against that same list, so a copy here
    // that drifted would produce a stream the archiver refuses — or worse, one it
    // accepts under names nothing else uses.
    //
    // Unaliased, unlike the properties. `outputAlias` exists to let a property
    // named `Asset Id` out under its own spelling; a reserved name is already an
    // identifier by the rule that reserves it, so aliasing it would only give the
    // driver a second name for the same column to disagree about.
    const provenanceColumns = provenance ? CATALOG_PROVENANCE_COLUMNS : [];
    const statement = `SELECT ${[
      ...selected.map(
        (p) => `${this.ident(physicalColumn(p.name))} AS ${this.ident(outputAlias(p.name))}`,
      ),
      ...provenanceColumns.map((column) => this.ident(column)),
    ].join(',')}
       FROM ${this.ident(table)} WHERE ${this.ident(SNAPSHOT_COLUMN)} = ?
       ORDER BY ${this.ident(ROW_COLUMN)} ASC`;

    // Read-only, and a transaction rather than a bare statement for the reason
    // `streamReadOnlyQuery` opens one: the handle lives as long as the iteration
    // does, and it must be released by the generator's `finally` whether the
    // consumer drained it or walked away.
    const connection = this.em.fork().getConnection();
    const trx = await connection.begin({ readOnly: true });
    try {
      for await (const row of connection.stream<Record<string, unknown>>(
        statement,
        [snapshotId],
        trx,
      )) {
        const out = normalise(row, selected);
        for (const column of provenanceColumns) {
          const value = row[column];
          out[column] = value instanceof Date ? value.toISOString() : value;
        }
        yield out;
      }
    } finally {
      await connection.rollback(trx).catch(() => undefined);
    }
  }

  async runQuery(request: CatalogQueryRequest): Promise<CatalogQueryResult> {
    return runReadOnlyQuery(this.em.fork(), request, this.dialect);
  }

  /**
   * Rows as the engine produces them, for the export route.
   *
   * Offered rather than left off because this driver can honestly do it — see
   * {@link streamReadOnlyQuery} for how, and for what the caller owes the
   * generator in return.
   */
  streamQuery(request: CatalogQueryStreamRequest): AsyncIterable<Record<string, unknown>> {
    return streamReadOnlyQuery(this.em, request, this.dialect);
  }

  async queryRelations(): Promise<CatalogQueryRelation[]> {
    const em = this.em.fork();
    const rows = await em.find(ObjectTypeRow, {}, { populate: ['properties'] });
    return relationsFor(
      rows.map((row) => ({
        name: row.name,
        displayName: row.displayName,
        pluralDisplayName: row.pluralDisplayName,
        tableName: row.physicalTable,
        group: row.group,
        primaryKey: row.primaryKey ?? [],
        enriched: true,
        relations: [],
        properties: row.properties.getItems().map((p) => ({
          name: p.name,
          displayName: p.displayName,
          type: toScalar(p.type),
          columnName: p.sourceColumn,
          nullable: p.nullable,
          primary: p.primary,
          hidden: p.hidden,
          order: p.position,
          enriched: true,
        })),
      })),
    );
  }

  /**
   * Refuse to merge rows whose key is NULL.
   *
   * A declared primary key is not the same thing as a populated one. A
   * transform that never produces the key column leaves a type that looks
   * mergeable and data that is not, and every NULL-keyed row then matches
   * nothing on either side of the anti-join: it is carried forward on this run,
   * carried forward again on the next, and duplicates itself once per run
   * forever. The counts stay plausible for a while, which is what makes it
   * expensive to find later.
   *
   * Both sides are checked. NULLs in the incoming batches mean this run's rows
   * can never replace anything; NULLs in the previous snapshot mean rows that
   * can never be replaced.
   */
  /**
   * Refuse a read of a snapshot whose rows have been dropped.
   *
   * One PK lookup, and the only shared gate the four refusal sites go through —
   * so "what does a tombstone do to a reader" has one answer that can be changed
   * in one place, rather than four checks that agree until one of them is edited.
   *
   * A snapshot with no row at all passes: this is not an existence check, and
   * making it one would change what `read` does with an unknown id from "no
   * rows" to a refusal, which is a different decision with different callers.
   */
  private async assertNotDropped(
    em: EntityManager,
    typeName: string,
    snapshotId: string,
  ): Promise<void> {
    const row = await em.findOne(SnapshotRow, { id: `${typeName}:${snapshotId}` });
    if (!row?.droppedAt) return;
    throw new BadRequestException(droppedMessage(typeName, row, row.droppedAt));
  }

  private async assertKeyed(
    table: string,
    keyColumns: string[],
    keys: CatalogPropertyDef[],
    sides: Array<[snapshotId: string, described: string]>,
  ): Promise<void> {
    const nullTest = keyColumns.map((column) => `${this.ident(column)} IS NULL`).join(' OR ');

    for (const [snapshotId, described] of sides) {
      const [{ unkeyed }] = await this.em.getConnection().execute<Array<{ unkeyed: number }>>(
        `SELECT COUNT(*) AS unkeyed FROM ${this.ident(table)}
            WHERE ${this.ident(SNAPSHOT_COLUMN)} = ? AND (${nullTest})`,
        [snapshotId],
      );
      const count = Number(unkeyed ?? 0);
      if (count === 0) continue;

      const named = keys.map((property) => property.name).join(', ');
      throw new BadRequestException(
        `${count} row(s) in ${described} have no value for the primary key (${named}), so an incremental load cannot tell an update from a new object and would add a second copy of each of them on every run. Either make the load produce ${named}, or publish the type with a primary key its data actually fills, or run this connector in "full" mode — a full run replaces the dataset outright and needs no key.`,
      );
    }
  }

  /**
   * How many rows each of these snapshots holds, asked of the table.
   *
   * ## Why this is not accumulated in `write`
   *
   * It used to be counted there, once per batch, over the whole snapshot — and
   * the comment defending that was right about the hazard and wrong about the
   * price. The hazard is real: a batch can be **replaced**, because a retried
   * durable step re-sends its batches and `write` answers that with
   * delete-then-reinsert, so a count that added each batch's rows as they
   * arrived would count a re-sent batch twice. Counting from the table is
   * immune to that, and to anything else that moved rows.
   *
   * The price is that the count is a function of the snapshot while the number
   * of counts is a function of the load, so a load costs O(rows² / batch).
   * Measured on a local container against the 42-column PriBuy shape: one
   * `COUNT(*)` takes 1.7ms over 10,000 rows, 3.9ms over 25,000, 7.0ms over
   * 50,000 and 14.4ms over 100,000 — linear in the snapshot, as an index range
   * scan should be. Multiply by `rows / 500` batches and the counting alone is
   * 0.03s, 0.19s, 0.70s and 2.87s: four times the cost for twice the data. On
   * the deployment's 783,000-row Subwo load that curve is the dominant term,
   * and on the 7.6M-row PriBuy table it is not survivable — which is what a
   * quadratic is, and it was hiding behind a number that looked small at the
   * size anyone had tested.
   *
   * ## Why arithmetic did not replace it
   *
   * The obvious repair is `rowCount += inserted - deleted`, and it fails twice.
   *
   * First, the number is not there to add. `write` issues its DELETE through
   * `connection.execute(sql, params)`, whose default method is `all` — measured,
   * not assumed: that call returns `[]` for a DELETE that removed 300 rows and
   * `[]` for one that removed none. The affected-row count is reachable only by
   * passing the method explicitly (`execute(sql, params, 'run')` returns
   * `{ affectedRows, insertId, row, rows }`), so adopting arithmetic means
   * changing how the statement is issued, not just what is done with its result.
   *
   * Second, and fatal: the arithmetic drifts on exactly the event it has to
   * survive. `write` is three statements outside a transaction — DELETE,
   * INSERT, then the snapshot row's flush — and a crash between the INSERT and
   * the flush leaves the table holding N more rows than the snapshot row was
   * told about. The retry re-sends the batch, deletes those N and inserts N,
   * nets zero, and the snapshot is permanently N rows short. Counting has no
   * such window: it reports what is there whenever it is asked, so a replay
   * converges instead of accumulating error. Keeping arithmetic honest would
   * mean putting all three statements in one transaction, which is a different
   * and much larger claim than this class makes today (`transactional: false`).
   *
   * ## So it is counted, once, where the number is read
   *
   * Not per batch — per read. `commit` counts the snapshot it is about to
   * publish, and `listSnapshots` counts the uncommitted ones it is about to
   * report, which between them cover every path that can observe a count that
   * is still moving. Committed snapshots are not recounted: `commit` is the
   * only thing that sets the flag, and it sets the count in the same flush.
   *
   * One statement for however many snapshots are asked about, because the
   * caller that needs more than one needs them together. A snapshot holding no
   * rows produces no group row at all, so **callers must default a miss to 0
   * and never to the stored value** — an empty snapshot is a real state here,
   * and falling back to what the row last said is how a truncation gets
   * reported as the size it used to be.
   */
  private async countBySnapshot(
    em: EntityManager,
    table: string,
    snapshotIds: readonly string[],
  ): Promise<Map<string, number>> {
    // `IN ()` is a syntax error on MySQL, and "no uncommitted snapshots" is the
    // ordinary state of a type nobody is loading.
    if (snapshotIds.length === 0) return new Map();

    const rows = await em.getConnection().execute<Array<{ snapshot: string; total: number }>>(
      `SELECT ${this.ident(SNAPSHOT_COLUMN)} AS snapshot, COUNT(*) AS total
           FROM ${this.ident(table)}
          WHERE ${this.ident(SNAPSHOT_COLUMN)} IN (${snapshotIds.map(() => '?').join(',')})
          GROUP BY ${this.ident(SNAPSHOT_COLUMN)}`,
      [...snapshotIds],
    );

    const counts = new Map<string, number>();
    for (const row of rows) counts.set(String(row.snapshot), Number(row.total ?? 0));
    return counts;
  }

  /** One snapshot's rows. Zero when it holds none — see {@link countBySnapshot}. */
  private async countRows(em: EntityManager, table: string, snapshotId: string): Promise<number> {
    return (await this.countBySnapshot(em, table, [snapshotId])).get(snapshotId) ?? 0;
  }

  /**
   * A column name as this engine compares it.
   *
   * Lower-cased on MySQL, which folds; left exactly as written on Postgres,
   * which does not. Getting this wrong in the Postgres direction is not a
   * cosmetic slip: folding both sides would match a wanted `AssetId` against an
   * existing `assetid`, conclude the column is already there, and skip creating
   * it — and the load then fails on `column "AssetId" does not exist`, against a
   * table that looks complete.
   */
  private foldName(value: string): string {
    return this.dialect.foldsColumnCase ? value.toLowerCase() : value;
  }

  private async existingColumns(table: string): Promise<Set<string>> {
    const { sql, nameKey } = this.dialect.existingColumnsQuery();
    const rows = await this.em
      .getConnection()
      .execute<Array<Record<string, unknown>>>(sql, [table]);
    return new Set(rows.map((row) => this.foldName(String(row[nameKey]))));
  }

  private async existingIndexes(table: string): Promise<Set<string>> {
    const { sql, nameKey } = this.dialect.existingIndexesQuery();
    const rows = await this.em
      .getConnection()
      .execute<Array<Record<string, unknown>>>(sql, [table]);
    // Index names are always compared case-insensitively, unlike columns: this
    // package chooses them itself (`ix_snapshot_batch`), they are never a
    // publisher's, and both engines create them lower-case.
    return new Set(rows.map((row) => String(row[nameKey]).toLowerCase()));
  }

  /**
   * Give an already-existing object table the index its writes need.
   *
   * ## What was wrong
   *
   * Every `obj_*` table was created with one secondary index,
   * `ix_snapshot (_snapshot_id)`, and the statement that replaces a batch is
   * `DELETE ... WHERE _snapshot_id = ? AND _batch = ?`. Every row of a snapshot
   * carries the same `_snapshot_id`, so that index narrows nothing at all — and
   * MySQL, correctly, declines to use it and scans the **whole table** instead,
   * taking row locks the whole way. On a deployment's 313,833-row snapshot that
   * is a full scan per batch, thirty batches per load, with the API on the same
   * database waiting behind the locks. Its query log had that one statement at
   * 821 seconds against 15 for the `SELECT COUNT(*)` beside it.
   *
   * Measured here at 300,000 rows in one snapshot (`write-path.db.spec.ts`):
   * `EXPLAIN` went from **no index and ~296,000 rows examined** to the composite
   * and ~19,000, and the statement from 214ms to 71ms on a warm local container.
   * The remaining 71ms is the cost of actually removing 10,000 rows, which is
   * the work the load asked for; the scan is what has gone.
   *
   * ## Why the composite replaces `ix_snapshot` on a new table
   *
   * A composite whose leading column is `_snapshot_id` answers every
   * `_snapshot_id = ?` lookup as a prefix match, so the single-column index is
   * redundant rather than complementary — confirmed rather than assumed: with
   * `ix_snapshot` dropped, both the snapshot count and a page of snapshot rows
   * still plan onto `ix_snapshot_batch`, at the same cost. And redundancy is not
   * free here: the ingestion pattern is delete-and-reinsert, so every one of the
   * 300,000 inserts a load makes would maintain a second index for nothing.
   *
   * ## Why it does NOT drop `ix_snapshot` on a table that already has one
   *
   * Adding an index is additive and recoverable; dropping one is neither, and
   * the cost of being wrong is asymmetric — a redundant index costs write
   * amplification, and an index dropped while something was planning onto it
   * costs a scan on a production read path. This package also does not otherwise
   * remove anything from a table it did not create in this process; the
   * column path above is explicitly "additive only… dropping and retyping go
   * through a human", and an index is the same kind of decision. So the
   * composite is added, `ix_snapshot` is left, and the log says it can go.
   *
   * ## Why a failure here is a warning and not a throw
   *
   * The asymmetry that decides it: a missing *column* makes the next INSERT
   * fail, so evolving it is a correctness repair and must be fatal if it cannot
   * be done. A missing *index* makes the next INSERT slow. Refusing the load
   * would convert a performance problem into an outage, on a deployment whose
   * database user may simply not hold ALTER. So it is reported, with the
   * statement to run by hand, and the load goes ahead.
   *
   * ## Where it runs, and why not at boot
   *
   * From `ensureType`, which is the first write to each table after boot and
   * every publish — the same place the reserved column above is added, and one
   * `information_schema` read per table per process. Deliberately not at boot:
   * boot does not know which types exist, an `ALTER` per object table would put
   * an unbounded amount of DDL in front of a pod becoming ready, and the pod
   * that needs the index is the one about to write. InnoDB builds a secondary
   * index in place without blocking DML, so the load that triggers it pays the
   * build once — 906ms for 300,000 rows here — and every load after it is fast.
   */
  private async ensureSnapshotBatchIndex(typeName: string, table: string): Promise<void> {
    const indexes = await this.existingIndexes(table);
    if (indexes.has(SNAPSHOT_BATCH_INDEX.toLowerCase())) return;

    const statement = this.dialect.addIndex(table, SNAPSHOT_BATCH_INDEX, [
      SNAPSHOT_COLUMN,
      BATCH_COLUMN,
    ]);
    try {
      await this.em.getConnection().execute(statement);
    } catch (error) {
      this.logger.warn(
        `Could not add ${SNAPSHOT_BATCH_INDEX} to ${table}, so every batch this load replaces will scan the whole table: ${
          error instanceof Error ? error.message : String(error)
        }. Run it by hand when you can — "${statement}" — it is online and does not block writes. The load itself is unaffected and is going ahead.`,
      );
      return;
    }

    this.logger.log(
      `Added ${SNAPSHOT_BATCH_INDEX} to ${table}, so replacing a batch reads that batch instead of scanning the table.${
        indexes.has('ix_snapshot')
          ? ` ${table} still carries ix_snapshot, which this index makes redundant — every _snapshot_id lookup matches its leading column. Dropping it is safe and saves maintaining a second index on every insert, and it is left for you to do because this package does not drop what it did not create here.`
          : ''
      }`,
    );
    emitCatalog('schema.changed', {
      typeName,
      table,
      addedColumns: [],
      addedIndexes: [SNAPSHOT_BATCH_INDEX],
      created: false,
    });
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
 * The search term, over the text columns this read is returning.
 *
 * Classified columns are left out: a search that reached one would leak it
 * through row membership even though the value is never rendered. `undefined`
 * when there is nothing to search or nothing to search in.
 */
function searchPredicate(
  selected: CatalogPropertyDef[],
  term: string | undefined,
  dialect: CatalogSqlDialect,
): { sql: string; values: unknown[] } | undefined {
  const trimmed = term?.trim();
  if (!trimmed) return undefined;
  const searchable = selected.filter((p) => p.type === 'string' && !p.classification);
  if (searchable.length === 0) return undefined;
  return {
    // `dialect.likeOperator`, because "does a search box match case" is not a
    // detail of SQL syntax — it is what the screen returns. MySQL's default
    // collation is case-insensitive and Postgres's `LIKE` is not, so the same
    // catalog on the two engines would answer differently for the same term
    // unless one of them says `ILIKE`. See the flag's own docblock.
    sql: `(${searchable.map((p) => `${dialect.ident(physicalColumn(p.name))} ${dialect.likeOperator} ?`).join(' OR ')})`,
    values: searchable.map(() => `%${trimmed}%`),
  };
}

/**
 * One filter, against a column this read is actually returning.
 *
 * The membership check is against `selected` rather than against the type, and
 * that is deliberate. The service already resolves a filter against the visible
 * columns, so this can only fail for a caller that builds the query itself — and
 * what it prevents is a predicate over a column the same request declined to
 * return, which is how a hidden or classified value leaks out through row
 * membership.
 *
 * `ident` is the guard on the column, and it is the same one the SELECT list and
 * the ORDER BY go through: a name outside a narrow character set is refused
 * rather than escaped. Nothing a caller sent reaches it — the property came off
 * the type — and no value reaches the statement text at all.
 */
function filterPredicate(
  selected: CatalogPropertyDef[],
  filter: CatalogResolvedFilter,
  dialect: CatalogSqlDialect,
): { sql: string; values: unknown[] } {
  const property = selected.find((p) => p.name === filter.property.name);
  if (!property) {
    throw new BadRequestException(
      `${filter.property.name} is not among the columns this read returns, so it cannot be filtered on.`,
    );
  }
  return predicateFor(dialect.ident(physicalColumn(property.name)), filter, dialect);
}

/**
 * One filter as a predicate and its bound values.
 *
 * The column arrives already quoted by `ident`, which refuses anything outside
 * `[A-Za-z_][A-Za-z0-9_]*` rather than escaping it — the rule the whole adapter
 * uses and the only rule it uses. Every value is a `?`; none of them is
 * concatenated, including the `%` wrapping for `contains`, which is built as a
 * parameter rather than into the statement.
 *
 * Two of the nine are not the naive translation and both would be wrong if they
 * were:
 *
 * - `ne` matches rows whose column is NULL as well. SQL's `<>` is never true of
 *   NULL, so "state is not FL" would drop every row with no state at all — and a
 *   reader reading that list would conclude those rows are in Florida.
 * - `empty` counts the empty string as well as NULL. `coerce` writes `''` as
 *   NULL on the way in, so today they are the same set on this store; a column
 *   loaded by an older version of it, or by hand, is where they come apart, and
 *   "no value" has to mean no value on both.
 */
function predicateFor(
  column: string,
  filter: CatalogResolvedFilter,
  dialect: CatalogSqlDialect,
): { sql: string; values: unknown[] } {
  switch (filter.op) {
    case 'eq':
      return { sql: `${column} = ?`, values: [filter.value] };
    case 'ne':
      return { sql: `(${column} <> ? OR ${column} IS NULL)`, values: [filter.value] };
    case 'contains':
      // The same reasoning as the search box above: `contains` means the same
      // thing to a user on both engines, so the operator differs to keep the
      // meaning identical rather than the syntax identical.
      return {
        sql: `${column} ${dialect.likeOperator} ?`,
        values: [`%${String(filter.value)}%`],
      };
    case 'gt':
      return { sql: `${column} > ?`, values: [filter.value] };
    case 'gte':
      return { sql: `${column} >= ?`, values: [filter.value] };
    case 'lt':
      return { sql: `${column} < ?`, values: [filter.value] };
    case 'lte':
      return { sql: `${column} <= ?`, values: [filter.value] };
    case 'empty':
      return { sql: `(${column} IS NULL OR ${column} = '')`, values: [] };
    case 'notEmpty':
      return { sql: `(${column} IS NOT NULL AND ${column} <> '')`, values: [] };
    default:
      // An operator added to the contract and not to this switch fails to
      // compile here. The alternative to a `never` is a `default` that returns
      // something true, which is a filter silently matching every row.
      return unknownOperator(filter.op);
  }
}

function unknownOperator(operator: never): never {
  throw new BadRequestException(`This store cannot filter with ${String(operator)}.`);
}

// `sqlType` and `coerce` used to live here. Both are now per-dialect and sit in
// `dialect.ts` beside the reason each mapping is what it is — the two engines
// disagree on the boolean in both directions (`TINYINT(1)` takes 1/0, `BOOLEAN`
// refuses them) and on very little else.

/**
 * An engine hands back TINYINT or a real boolean, and strings for wide numbers;
 * undo that.
 *
 * In under the alias `read` selected, out under the property's own name. Those
 * are the same string for almost every property and are not for one whose name
 * SQL cannot take, so they are written as the two different things they are —
 * looking the value up by `property.name` would hand back `undefined` for
 * exactly the properties this change exists to make work, and `undefined` here
 * is indistinguishable from a genuine NULL.
 */
function normalise(
  row: Record<string, unknown>,
  properties: CatalogObjectTypeDef['properties'],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const property of properties) {
    const value = row[outputAlias(property.name)];
    if (value === null || value === undefined) {
      out[property.name] = null;
    } else if (property.type === 'boolean') {
      out[property.name] = Boolean(Number(value));
    } else if (property.type === 'number') {
      out[property.name] = Number(value);
    } else if (value instanceof Date) {
      out[property.name] = value.toISOString();
    } else if (typeof value === 'bigint') {
      out[property.name] = value.toString();
    } else {
      out[property.name] = value;
    }
  }
  return out;
}

const SCALARS: ScalarType[] = ['string', 'number', 'boolean', 'date', 'json', 'uuid', 'unknown'];

function toScalar(value: string): ScalarType {
  return SCALARS.find((s) => s === value) ?? 'unknown';
}

/**
 * A stored snapshot as the interface's `SnapshotRef`.
 *
 * `rowCount` is a parameter rather than `row.rowCount`, and the redundancy is
 * the point: an uncommitted row's stored count is not maintained, so every
 * caller has to say where its number came from and a new one that forgets fails
 * to compile instead of quietly publishing a stale figure. The two honest
 * answers are `row.rowCount` for a committed snapshot — `commit` wrote it — and
 * a fresh {@link MySqlWarehouseStore.countBySnapshot} for anything else.
 *
 * A tombstone has a third: the count `dropSnapshot` took immediately before it
 * deleted the rows, which is `row.rowCount` for the same reason a committed
 * snapshot's is — it was written by the operation that made it final, and no
 * later scan can rediscover it.
 */
function toRef(row: SnapshotRow, rowCount: number): SnapshotRef {
  return {
    id: row.snapshotId,
    createdAt: row.createdAt.toISOString(),
    rowCount,
    principalId: row.principalId,
    labels: row.labels,
    ...(row.droppedAt ? { droppedAt: row.droppedAt.toISOString() } : {}),
  };
}

/**
 * The sentence a reader of a tombstoned snapshot gets, in place of zero rows.
 *
 * One function so the four refusal sites cannot drift into four different
 * accounts of the same state, and so the date is always in it: "that snapshot
 * was dropped" sends a reader to look for a bug, and "dropped on the 8th"
 * sends them to whoever ran the drop.
 */
function droppedMessage(typeName: string, row: SnapshotRow, droppedAt: Date): string {
  return `Snapshot ${row.snapshotId} of ${typeName} held ${row.rowCount} row(s) and they were dropped on ${droppedAt.toISOString()}. The record of the load is kept so the runs that produced it stay resolvable, but the data is gone and no read of it can be answered. This is refused rather than returned as an empty result, because an empty result here is indistinguishable from a load that collapsed.`;
}

/**
 * The store on MySQL.
 *
 * A named subclass rather than a factory call, because this is the class every
 * existing host, module and test constructs by name, and Nest resolves a
 * provider by its class identity. It has no body: the whole of "this is the
 * MySQL store" is the dialect value it binds, which is the point of the seam.
 */
@Injectable()
export class MySqlWarehouseStore extends MikroOrmWarehouseStore {
  constructor(@Inject(CATALOG_STORE_ENTITY_MANAGER) em: EntityManager) {
    super(em, MYSQL_DIALECT);
  }
}

/**
 * The store on PostgreSQL.
 *
 * Same class, other dialect, and nothing else — which is the claim the shared
 * contract in `test/catalog-store-contract.ts` checks rather than takes on
 * trust: both of these run the same suite, and a case that passes for one and
 * not the other is a real disagreement rather than a gap in somebody's
 * imagination.
 *
 * Its capabilities are inherited unchanged, and each of the four is still true
 * of what this class issues on Postgres. `atomicCutover` is the one worth
 * pausing on, because it is obtained differently: MySQL gets it from
 * `CREATE OR REPLACE VIEW` taking an exclusive metadata lock, and Postgres
 * cannot use that statement at all (it refuses to insert a column into an
 * existing view's column list), so it drops and recreates inside a transaction
 * — which Postgres honours for DDL, so a concurrent `SELECT` still sees one
 * definition or the other and never a missing name.
 */
@Injectable()
export class PostgresWarehouseStore extends MikroOrmWarehouseStore {
  constructor(@Inject(CATALOG_STORE_ENTITY_MANAGER) em: EntityManager) {
    super(em, POSTGRES_DIALECT);
  }
}
