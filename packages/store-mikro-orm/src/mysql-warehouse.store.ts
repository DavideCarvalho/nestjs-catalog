import { assertNoColumnCollisions, emitCatalog } from '@dudousxd/nestjs-catalog';
import type {
  CatalogQueryRelation,
  CatalogQueryRequest,
  CatalogQueryResult,
  CatalogQueryStore,
} from '@dudousxd/nestjs-catalog';
import type {
  CarryForwardResult,
  CatalogMergeStore,
  CatalogObjectTypeDef,
  CatalogPropertyDef,
  CatalogReadQuery,
  CatalogReadResult,
  CatalogStoreCapabilities,
  ScalarType,
  SnapshotRef,
} from '@dudousxd/nestjs-catalog';
import type { EntityManager } from '@mikro-orm/mysql';
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { CATALOG_STORE_ENTITY_MANAGER } from './context';
import { SnapshotRow } from './entities/governance';
import { ObjectTypeRow, PropertyRow } from './entities/model';
import {
  BATCH_COLUMN,
  LOADED_AT_COLUMN,
  PRINCIPAL_COLUMN,
  ROW_COLUMN,
  SNAPSHOT_COLUMN,
  ident,
  tableFor,
} from './identifiers';
import { refreshView, relationsFor, runReadOnlyQuery } from './query';

/**
 * MySQL as a warehouse: one physical table per object type, append-only,
 * partitioned by snapshot.
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
export class MySqlWarehouseStore implements CatalogMergeStore, CatalogQueryStore {
  private readonly logger = new Logger(MySqlWarehouseStore.name);

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
  ) {}

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
    // `foldsColumnCase` because MySQL does: `assetId` and `AssetID` are one
    // column here, and the DDL would be refused for a collision the property
    // names do not look like they have.
    assertNoColumnCollisions(type, physicalColumn, {
      foldsColumnCase: true,
      store: 'MySQL',
    });

    const existing = await this.existingColumns(table);

    if (existing.size === 0) {
      const columns = type.properties.map(
        (p) => `${ident(physicalColumn(p.name))} ${sqlType(p.type)} NULL`,
      );
      await connection.execute(
        `CREATE TABLE IF NOT EXISTS ${ident(table)} (
           ${ident(ROW_COLUMN)} BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
           ${ident(SNAPSHOT_COLUMN)} VARCHAR(128) NOT NULL,
           ${ident(PRINCIPAL_COLUMN)} VARCHAR(128) NOT NULL,
           ${ident(LOADED_AT_COLUMN)} DATETIME NOT NULL,
           ${ident(BATCH_COLUMN)} INT NOT NULL DEFAULT 0,
           ${columns.join(',\n           ')},
           KEY \`ix_snapshot\` (${ident(SNAPSHOT_COLUMN)})
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
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
      if (existing.has(column.toLowerCase())) continue;
      await connection.execute(
        `ALTER TABLE ${ident(table)} ADD COLUMN ${ident(column)} ${definition}`,
      );
      this.logger.log(`Added reserved column ${column} to ${table}`);
    }

    const missing = type.properties.filter(
      (p) => !existing.has(physicalColumn(p.name).toLowerCase()),
    );
    for (const property of missing) {
      await connection.execute(
        `ALTER TABLE ${ident(table)} ADD COLUMN ${ident(
          physicalColumn(property.name),
        )} ${sqlType(property.type)} NULL`,
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
        values.push(coerce(row[property.name], property.type));
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
        `DELETE FROM ${ident(table)} WHERE ${ident(SNAPSHOT_COLUMN)} = ? AND ${ident(BATCH_COLUMN)} = ?`,
        [options.snapshotId, batch],
      );
    // Skipped only because MySQL has no syntax for inserting no tuples. Nothing
    // downstream of here treats the two cases differently.
    if (placeholders.length > 0) {
      await em
        .getConnection()
        .execute(
          `INSERT INTO ${ident(table)} (${columns.map(ident).join(',')}) VALUES ${placeholders.join(',')}`,
          values,
        );
    }

    // The snapshot row is upserted rather than inserted so a retried batch does
    // not create a second one. rowCount accumulates across batches of the same
    // load, which is what a caller streaming a large type actually does.
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

    // Counted, not accumulated: a replaced batch must not be added twice, and
    // the table is the only thing that knows what actually survived.
    const [{ total }] = await em
      .getConnection()
      .execute<Array<{ total: number }>>(
        `SELECT COUNT(*) AS total FROM ${ident(table)} WHERE ${ident(SNAPSHOT_COLUMN)} = ?`,
        [options.snapshotId],
      );
    snapshot.rowCount = Number(total ?? 0);
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
    const previous = await em.findOne(
      SnapshotRow,
      {
        typeName: type.name,
        committed: true,
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
      `DELETE FROM ${ident(table)} WHERE ${ident(SNAPSHOT_COLUMN)} = ? AND ${ident(BATCH_COLUMN)} = ?`,
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
      const previousAlias = ident('prev');
      const incomingAlias = ident('incoming');

      // `_principal_id` and `_loaded_at` come across untouched rather than
      // being restamped with this run. A carried row is not a new load of that
      // row — nobody loaded it today, it simply did not change — so restamping
      // would erase the one thing the column is good for, which is telling you
      // when a value last actually moved. Who owns the *snapshot* is on the
      // snapshot row, and that is a different question.
      const selected = [
        '?',
        `${previousAlias}.${ident(PRINCIPAL_COLUMN)}`,
        `${previousAlias}.${ident(LOADED_AT_COLUMN)}`,
        '?',
        ...type.properties.map((p) => `${previousAlias}.${ident(physicalColumn(p.name))}`),
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
        .map((column) => `${incomingAlias}.${ident(column)} = ${previousAlias}.${ident(column)}`)
        .join(' AND ');

      await connection.execute(
        `INSERT INTO ${ident(table)} (${columns.map(ident).join(',')})
         SELECT ${selected.join(',')}
           FROM ${ident(table)} AS ${previousAlias}
           LEFT JOIN ${ident(table)} AS ${incomingAlias}
             ON ${incomingAlias}.${ident(SNAPSHOT_COLUMN)} = ?
            AND ${incomingAlias}.${ident(BATCH_COLUMN)} <> ?
            AND ${join}
          WHERE ${previousAlias}.${ident(SNAPSHOT_COLUMN)} = ?
            AND ${incomingAlias}.${ident(ROW_COLUMN)} IS NULL`,
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
      `SELECT COUNT(*) AS total, SUM(${ident(BATCH_COLUMN)} = ?) AS carried
         FROM ${ident(table)} WHERE ${ident(SNAPSHOT_COLUMN)} = ?`,
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
    await refreshView(em, type, snapshotId);

    emitCatalog('snapshot.committed', {
      typeName: type.name,
      snapshotId,
      principalId: snapshot.principalId,
      rowCount: snapshot.rowCount,
    });
    return toRef(snapshot);
  }

  async dropSnapshot(type: CatalogObjectTypeDef, snapshotId: string): Promise<void> {
    const em = this.em.fork();
    const typeRow = await em.findOne(ObjectTypeRow, { name: type.name });
    if (typeRow?.currentSnapshotId === snapshotId) {
      throw new BadRequestException(
        `Snapshot ${snapshotId} is the one being served for ${type.name}. Commit another one first.`,
      );
    }
    await em
      .getConnection()
      .execute(`DELETE FROM ${ident(tableFor(type.name))} WHERE ${ident(SNAPSHOT_COLUMN)} = ?`, [
        snapshotId,
      ]);
    await em.nativeDelete(SnapshotRow, { id: `${type.name}:${snapshotId}` });
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
    return toRef(snapshot);
  }

  async listSnapshots(type: CatalogObjectTypeDef): Promise<SnapshotRef[]> {
    const em = this.em.fork();
    const rows = await em.find(
      SnapshotRow,
      { typeName: type.name },
      { orderBy: { createdAt: 'desc' }, limit: 50 },
    );
    return rows.map(toRef);
  }

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

    const selected = type.properties.filter((p) => fields.includes(p.name));
    if (selected.length === 0) return { rows: [], total: 0 };

    const params: unknown[] = [snapshotId];
    let where = `${ident(SNAPSHOT_COLUMN)} = ?`;

    const term = query.search?.trim();
    if (term) {
      const searchable = selected.filter((p) => p.type === 'string' && !p.classification);
      if (searchable.length > 0) {
        where += ` AND (${searchable
          .map((p) => `${ident(physicalColumn(p.name))} LIKE ?`)
          .join(' OR ')})`;
        for (const _ of searchable) params.push(`%${term}%`);
      }
    }

    const [{ total }] = await em
      .getConnection()
      .execute<Array<{ total: number }>>(
        `SELECT COUNT(*) AS total FROM ${ident(table)} WHERE ${where}`,
        params,
      );

    const sortProperty = selected.find((p) => p.name === query.sort);
    const orderBy = sortProperty
      ? `${ident(physicalColumn(sortProperty.name))} ${query.dir === 'desc' ? 'DESC' : 'ASC'}`
      : `${ident(ROW_COLUMN)} ASC`;

    const size = Math.max(1, query.size ?? 25);
    const offset = (Math.max(1, query.page ?? 1) - 1) * size;

    const rows = await em.getConnection().execute<Array<Record<string, unknown>>>(
      `SELECT ${selected
        .map((p) => `${ident(physicalColumn(p.name))} AS ${ident(p.name)}`)
        .join(',')}
         FROM ${ident(table)} WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, size, offset],
    );

    return {
      total: Number(total ?? 0),
      rows: rows.map((row) => normalise(row, selected)),
    };
  }

  async runQuery(request: CatalogQueryRequest): Promise<CatalogQueryResult> {
    return runReadOnlyQuery(this.em.fork(), request);
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
  private async assertKeyed(
    table: string,
    keyColumns: string[],
    keys: CatalogPropertyDef[],
    sides: Array<[snapshotId: string, described: string]>,
  ): Promise<void> {
    const nullTest = keyColumns.map((column) => `${ident(column)} IS NULL`).join(' OR ');

    for (const [snapshotId, described] of sides) {
      const [{ unkeyed }] = await this.em.getConnection().execute<Array<{ unkeyed: number }>>(
        `SELECT COUNT(*) AS unkeyed FROM ${ident(table)}
            WHERE ${ident(SNAPSHOT_COLUMN)} = ? AND (${nullTest})`,
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

  private async existingColumns(table: string): Promise<Set<string>> {
    const rows = await this.em.getConnection().execute<Array<{ COLUMN_NAME: string }>>(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table],
    );
    return new Set(rows.map((r) => String(r.COLUMN_NAME).toLowerCase()));
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

/** Property name → physical column. Stable, so it never needs storing twice. */
function physicalColumn(propertyName: string): string {
  return propertyName
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 60);
}

/**
 * Deliberately wide types.
 *
 * A warehouse is fed by publishers that will widen a column one day without
 * telling anyone, and a load that fails on a value one character too long is a
 * worse outcome than a column that is roomier than it needs to be.
 */
function sqlType(type: ScalarType): string {
  switch (type) {
    case 'number':
      return 'DOUBLE';
    case 'boolean':
      return 'TINYINT(1)';
    case 'date':
      return 'DATETIME';
    case 'uuid':
      return 'CHAR(36)';
    case 'json':
      return 'JSON';
    default:
      return 'TEXT';
  }
}

function coerce(value: unknown, type: ScalarType): unknown {
  if (value === undefined || value === null || value === '') return null;
  if (type === 'date') {
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (type === 'boolean') return value ? 1 : 0;
  if (type === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'json') return JSON.stringify(value);
  return String(value);
}

/** MySQL hands back TINYINT for booleans and strings for DOUBLE; undo that. */
function normalise(
  row: Record<string, unknown>,
  properties: CatalogObjectTypeDef['properties'],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const property of properties) {
    const value = row[property.name];
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

function toRef(row: SnapshotRow): SnapshotRef {
  return {
    id: row.snapshotId,
    createdAt: row.createdAt.toISOString(),
    rowCount: row.rowCount,
    principalId: row.principalId,
    labels: row.labels,
  };
}
