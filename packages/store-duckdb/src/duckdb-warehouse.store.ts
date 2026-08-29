import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CarryForwardResult,
  CatalogFilterOperator,
  CatalogObjectTypeDef,
  CatalogPropertyDef,
  CatalogReadQuery,
  CatalogReadResult,
  CatalogStoreCapabilities,
  SnapshotRef,
  SnapshotStreamOptions,
} from '@dudousxd/nestjs-catalog';
import {
  CATALOG_FILTER_OPERATORS,
  CATALOG_PROVENANCE_COLUMNS,
  assertNoColumnCollisions,
  assertSafeIdentifier,
  outputAlias,
  physicalColumn,
} from '@dudousxd/nestjs-catalog';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { coerce, duckDbType, normalise } from './column-types';
import { type DuckDbConnection, openDuckDb, quoteLiteral } from './duckdb';
import { predicateFor } from './filters';
import {
  BATCH_COLUMN,
  CARRY_FORWARD_BATCH,
  LOADED_AT_COLUMN,
  PRINCIPAL_COLUMN,
  ROW_COLUMN,
  SNAPSHOT_COLUMN,
  batchKey,
  carryForwardKey,
  ident,
  snapshotPrefix,
} from './identifiers';
import { type ObjectStore, isS3Root, localObjectStore } from './object-store';
import { CATALOG_DUCKDB_OPTIONS, type CatalogDuckDbStoreOptions } from './options';
import { s3ObjectStore } from './s3-object-store';
import { SNAPSHOT_LIST_LIMIT, type SnapshotCatalog, objectSnapshotCatalog } from './snapshots';

/**
 * Provenance and flag at once, kept in the snapshot record's labels rather than as a column,
 * matching the ClickHouse and MikroORM siblings' own choice (see `CARRIED_FROM_LABEL` in each
 * of their `warehouse.store.ts`): "these rows came from there" is genuinely provenance, and a
 * label needs no schema change, so an older reader of the record is unaffected by its presence.
 */
const CARRIED_FROM_LABEL = '_carriedFrom';
/** Value of {@link CARRIED_FROM_LABEL} when the type had nothing committed to carry from. */
const CARRIED_FROM_NOTHING = 'none';
/**
 * Set on the snapshot record by {@link DuckDbWarehouseStore.write} when a batch lands after
 * {@link DuckDbWarehouseStore.carryForward} already ran for that snapshot, and cleared by
 * `carryForward` itself when it runs again. `commit` refuses on it — see that method's own
 * docblock for why refusal, and not a silent repair, is the only safe response.
 */
const CARRY_FORWARD_STALE_LABEL = '_carryForwardStale';
/**
 * Set on the snapshot record by {@link DuckDbWarehouseStore.commit} alone, never by `write` or
 * `carryForward` — the ClickHouse sibling's `findPreviousCommitted` guards its own fallback the
 * same way with a `committed = 1` predicate over its own schema's dedicated column (see
 * `packages/store-clickhouse/src/snapshots.ts`); this store has no such column, so the label
 * carries the fact the ecosystem already agrees a merge source needs.
 *
 * Why this exists: before it did, a load that ran `write` and `carryForward` but never
 * `commit` — an aborted or still-in-flight run — left behind a live `SnapshotRef` (created by
 * `carryForward`'s own bookkeeping) that `listSnapshotsWithRows` cannot tell apart from a
 * genuinely served one, because "live" there means only "not tombstoned". `carryForward`'s own
 * fallback resolution reads that same list when nothing is currently served, so an aborted
 * run's half-finished snapshot was eligible to be chosen as the next load's merge source — a
 * merge source nobody ever served, which is exactly the mistake Ruling 2's whole "served, not
 * newest" argument exists to prevent, reached through the one path that argument did not name.
 *
 * Stored on every `commit`, unconditionally — which means it also has to be kept OUT of what a
 * caller outside this class sees, or every ordinary full load that never touches
 * `carryForward` and never asked for a label at all would suddenly report one. See {@link
 * omitCommittedLabel}.
 */
const COMMITTED_LABEL = '_committed';

@Injectable()
export class DuckDbWarehouseStore {
  /**
   * What this adapter can do, and what it has measured about atomicity.
   *
   * `snapshots: 'emulated'` is the honest label and the one the core package predicts:
   * DuckDB keeps no history of its own. History here is a prefix per load and a pointer at
   * one of them, which is emulation in exactly the sense MySQL's `_snapshot_id` column is.
   *
   * ## `atomicCutover: true` — measured, by an experiment that can fail
   *
   * `commit` repoints the served pointer with one `SnapshotCatalog.setCurrent` call, which is
   * one `ObjectStore.put` of a small JSON body (`{"snapshotId":"..."}`, a few dozen bytes) —
   * see `snapshots.ts`. What makes that whole for a concurrent reader is not the body's size
   * but the write: the local binding puts the body in a sibling of the key and `rename`s it
   * into place, so a `read` resolving the pointer gets the old object or the new one. See
   * `writeThenRename` in `object-store.ts`, which also states the constraint that keeps it
   * true — the sibling has to be in the destination's own directory, because `rename` is
   * atomic within one filesystem and not across two.
   *
   * The claim is a measurement. The db-spec's `measures whether a cutover is atomic under
   * concurrent reads` test runs sixteen readers in a loop for the lifetime of 200 cutovers,
   * so pointer reads are still in flight while `setCurrent` fires, and seven runs came back
   * **0 torn, out of 5,048-6,993 reads each and 38,558 in total**. Pointed instead at a `writeFile` straight at
   * the key — an `O_CREAT|O_TRUNC` open with the body written separately after it — the same
   * experiment tears 229-8,296 times per run. That control is the half that licenses this
   * field: it is what makes a clean result a result rather than a switched-off gauge.
   *
   * Stated for this class, not only for the binding that was raced: the S3 binding moves the
   * same pointer with a single `PutObjectCommand`, which by S3's own contract never exposes a
   * partial object. Both bindings answer the same way, which is what makes one field able to
   * speak for the class here where `atomicBatchReplace` cannot.
   *
   * ## `atomicBatchReplace` — left absent, deliberately
   *
   * `atomicBatchReplace` asks what a concurrent reader sees while a batch already served is
   * being replaced — and the two bindings this store ships disagree. The local filesystem
   * binding's `write` does `COPY … TO` straight over the batch's existing path: DuckDB opens
   * the destination with truncate-then-write, so a reader gunning for that exact file mid-copy
   * can see a partial or empty Parquet object — not atomic. The S3 binding's `write` issues one
   * `PutObject` per batch key, and S3 never exposes a partially-uploaded object under a key —
   * a `GET` during an in-flight `PutObject` returns the previous object whole, never a mixture
   * — which is atomic. One field cannot honestly describe both bindings this class is
   * configured with at construction time, and splitting `capabilities` per binding is a bigger
   * change than this measurement earns, so it stays absent for both rather than picking one
   * binding's answer and letting it stand for the class.
   *
   * ## `transactional: false` — stated, not left absent
   *
   * The earned answer, not the unmeasured one, and stated rather than left absent: there is
   * no cross-statement transaction anywhere in this file — `commit` is three separate calls
   * (`countStaged`, `snapshots.put`, `snapshots.setCurrent`) and
   * `carryForward` is a `COPY` followed by a label write, each of which can succeed while the
   * next one fails. Every one of those sequences is ordered so that re-running it from the top
   * is the repair (see `commit`'s and `carryForward`'s own docblocks), which is what a store
   * without transactions has to do instead of rolling back.
   */
  readonly capabilities: CatalogStoreCapabilities = {
    snapshots: 'emulated',
    writable: true,
    timeTravel: true,
    atomicCutover: true,
    transactional: false,
  };

  /**
   * Every operator the core package declares.
   *
   * All of them, because `predicateFor` answers all of them behind an exhaustive switch. A
   * store that declares an operator it does not apply returns more rows than were asked for,
   * and nothing in that answer distinguishes it from a filter that genuinely matched
   * everything.
   */
  readonly objectFilterOperators: readonly CatalogFilterOperator[] = CATALOG_FILTER_OPERATORS;

  private readonly objects: ObjectStore;
  private readonly snapshots: SnapshotCatalog;
  private connection?: DuckDbConnection;
  private opening?: Promise<DuckDbConnection>;

  constructor(
    @Inject(CATALOG_DUCKDB_OPTIONS)
    private readonly options: CatalogDuckDbStoreOptions,
  ) {
    this.objects =
      options.objectStore ??
      (isS3Root(options.root)
        ? s3ObjectStore(options.root, options.s3)
        : localObjectStore(options.root));
    this.snapshots = options.snapshotCatalog ?? objectSnapshotCatalog(this.objects);
  }

  /**
   * Opened once, lazily, because a constructor cannot await and a boot should not block on
   * I/O — and it is the in-flight PROMISE that is memoized, not only the resolved connection.
   *
   * Two concurrent first callers — a `write` and a `countStaged` racing at boot, say — used to
   * each see `this.connection` unset, each call `openDuckDb`, and have the loser's instance
   * silently overwritten: never closed, unreachable from `close()`, and running under none of
   * this store's memory or thread settings, which `openDuckDb` applies once per instance (see
   * its own docblock). N such leaked instances under one configured `memory_limit` is N times
   * the process's real ceiling — precisely the OOMKill those settings exist to prevent.
   *
   * Caching the promise closes the window: every concurrent caller awaits the same open, and
   * only the first actually calls `openDuckDb`. A failed open evicts the cached promise before
   * rethrowing, so a transient failure does not wedge every future call behind the first error
   * forever — the next caller gets a fresh attempt.
   */
  private async ready(): Promise<DuckDbConnection> {
    if (this.connection) return this.connection;
    if (!this.opening) {
      this.opening = openDuckDb(this.options).catch((error: unknown) => {
        this.opening = undefined;
        throw error;
      });
    }
    this.connection = await this.opening;
    return this.connection;
  }

  async close(): Promise<void> {
    await this.connection?.close();
    this.connection = undefined;
    // Dropped too: reopening after a close must call `openDuckDb` again rather than resolve to
    // the promise for the connection that was just closed.
    this.opening = undefined;
  }

  /**
   * Nothing to create, and the check is the point.
   *
   * There is no DDL here — a Parquet object carries its own schema, so the shape of storage
   * is decided per write rather than declared once. What survives from a row store's
   * `ensureType` is two refusals. `assertNoColumnCollisions` is the core package's: a property
   * whose physical name collides with a reserved column, or with another property's physical
   * name, is a load that would write one column over another. `foldsColumnCase: false`
   * because DuckDB is case-sensitive and does not fold two names that differ only in case
   * into one column — so only a same-spelling or reserved-name collision applies here, not a
   * same-case-folded one.
   *
   * The second is this file's own: `assertSafeIdentifier` on the cleaned name.
   * `assertNoColumnCollisions` only checks that two properties do not clean to the *same*
   * column — it says nothing about whether the result is one this store can ever name again.
   * `stageColumns` writes a physical column through `quoteLiteral`, which accepts any string,
   * so a property that cleans to something like `1_2_3` would write successfully and then be
   * unreadable: every later `SELECT` list in this store goes through `ident()`, which refuses
   * it. Refusing at `ensureType` turns that into a refusal at publish time instead of a read
   * that can never name the column it wrote.
   */
  async ensureType(type: CatalogObjectTypeDef): Promise<void> {
    assertNoColumnCollisions(type, physicalColumn, {
      foldsColumnCase: false,
      store: 'duckdb',
    });
    for (const property of type.properties) {
      assertSafeIdentifier(physicalColumn(property.name));
    }
  }

  /**
   * Stage `rows` as newline-delimited JSON, then `COPY` them straight into one Parquet
   * object at the batch's deterministic key.
   *
   * The empty case is not special-cased. An empty NDJSON file read through `read_json` with
   * an explicit `columns` map yields zero rows of the declared schema rather than an error —
   * verified against the real engine while building this — so `COPY` of that result produces
   * a valid, zero-row Parquet object with the batch's schema. That object is what the
   * pipeline needs for a full load of zero rows: a snapshot that has something to point at
   * and a schema a later `read` can open, carrying no rows and no lie about it. Returning
   * early instead would mean a batch whose key `countStaged` and `read` can never resolve,
   * for the one case a caller is guaranteed to hit on every empty source.
   *
   * Every call touches the load's snapshot record, and the first one creates it: see {@link
   * recordWrittenBatch} for what that record carries, why this call is what anchors its
   * `createdAt`, why its `rowCount` is a placeholder rather than a count, and what a batch after
   * the first can still change about it.
   */
  async write(
    type: CatalogObjectTypeDef,
    rows: Array<Record<string, unknown>>,
    options: {
      snapshotId: string;
      principalId: string;
      batch?: number;
      labels?: Record<string, string>;
    },
  ): Promise<{ written: number }> {
    // Matches the sibling adapters (store-mikro-orm, store-clickhouse) exactly: a batch-less
    // write is batch 0, not batch 1. A divergent default would mean the same logical batch
    // lands under a different key here than on a MikroORM primary behind the same fan-out —
    // a false mismatch — and, worse locally, a batch-less write followed by an explicit
    // `batch: 1` write would land at two different keys instead of the same one, silently
    // keeping both instead of the second replacing the first. `Number.isFinite` rather than
    // `??`, because `??` only catches `null`/`undefined` and would let a `NaN` batch straight
    // through into a key nothing could ever `list()` back out consistently.
    const batch = Number.isFinite(options.batch) ? Number(options.batch) : 0;
    // Bounded at MAX_SAFE_INTEGER, not merely non-negative: `batchKey` renders a batch through
    // `String(batch)`, and a batch past that bound (`1e21`, say) renders as `'1e+21'` rather
    // than digits `batchNumberOf` — `streamSnapshot`'s per-file ordering, see that function's
    // own docblock — can parse back out of the key. An unparseable batch key falls through to
    // `CARRY_FORWARD_BATCH`, landing an ordinary loader batch in the slot reserved for the one
    // object no caller of `write` can forge into — silently, since nothing here would raise on
    // it. Refusing the batch outright keeps `batchNumberOf`'s fallback exhaustive rather than
    // merely true of every batch this file's own specs happened to try.
    if (!Number.isInteger(batch) || batch < 0 || batch > Number.MAX_SAFE_INTEGER) {
      throw new Error(
        `batch must be a non-negative integer no greater than Number.MAX_SAFE_INTEGER, got ${String(options.batch)}. The batch number is half of this store's object key, and a key it cannot derive — or cannot parse back out of a listing — is a batch a retry cannot replace and an ordered read cannot place.`,
      );
    }
    // Records that match nothing are a misconfiguration, not a load.
    //
    // Every field is looked up by property name — `stageRow` reads `row[property.name]` — so
    // records whose keys share no name with the type produce rows of pure NULL. Nothing about
    // that fails: `write` returns `{ written: rows.length }`, the object lands, and a later
    // `commit` repoints the served pointer at data that says nothing — a row count that looks
    // plausible, over rows with nothing in them. Losing sight of a real dataset because a CSV
    // arrived under different headers is exactly the failure the core interface's `write`
    // docblock warns about; one matching property is enough to proceed, since a partial load
    // is a judgement call and no matching property is not.
    //
    // Asked only of a batch that has rows. Zero rows carry no field names to disagree with the
    // type, and reading that silence as "nothing matched" would refuse the empty load Ruling 4
    // requires this store to accept, in the one voice guaranteed to send the reader to the
    // wrong place: a message about mismatched headers, for a batch that has no headers.
    if (rows.length > 0) {
      const matched = type.properties.filter((property) =>
        rows.some((row) => row[property.name] !== undefined),
      );
      if (matched.length === 0) {
        const incoming = Object.keys(rows[0] ?? {});
        throw new BadRequestException(
          `None of the incoming fields match ${type.name}. Got ${
            incoming.length > 0 ? incoming.slice(0, 8).join(', ') : 'no fields'
          }; expected any of ${type.properties
            .slice(0, 8)
            .map((property) => property.name)
            .join(', ')}. A transform is where a source's names become the type's.`,
        );
      }
    }
    const connection = await this.ready();
    const key = batchKey(type.name, options.snapshotId, batch);
    const staging = join(tmpdir(), `catalog-duckdb-${randomUUID()}.ndjson`);
    const loadedAt = new Date().toISOString();
    try {
      await writeFile(
        staging,
        rows
          .map((row, index) =>
            JSON.stringify(
              stageRow(type, row, {
                snapshotId: options.snapshotId,
                principalId: options.principalId,
                batch,
                row: index,
                loadedAt,
              }),
            ),
          )
          .join('\n'),
        'utf8',
      );
      // The `COPY` target's directory does not exist on first write, and DuckDB will not
      // create it — it fails naming the path, not the missing directory. `prepare` is a
      // no-op on object storage and an mkdir here.
      await this.objects.prepare(key);
      // SNAPPY, never anything else: any other codec needs `hyparquet-compressors` on the
      // reading side, which has had no release since March 2025 and fails on DuckDB-written
      // LZ4_RAW. The archive path in this repo already tells producers to write SNAPPY.
      await connection.run(
        `COPY (SELECT * FROM read_json(${quoteLiteral(staging)}, columns = ${stageColumns(type)}, format = 'newline_delimited')) TO ${quoteLiteral(this.objects.locate(key))} (FORMAT PARQUET, COMPRESSION SNAPPY)`,
      );
    } finally {
      await rm(staging, { force: true });
    }

    await this.recordWrittenBatch(type, options, loadedAt);

    // Rows accepted by THIS call. Never the snapshot's running total: a caller sums these
    // across batches, and a fan-out compares its primary's answer with its follower's.
    return { written: rows.length };
  }

  /**
   * The snapshot record `write` leaves behind: created on a load's first batch, kept current
   * with any labels a later batch brings, and marked when a batch lands after a merge.
   *
   * Split out of {@link write} rather than left inline for this file's complexity budget, which
   * the record's two jobs pushed that method past. They are separate jobs and both belong to a
   * batch write rather than to the commit that follows it:
   *
   * ## Marking a merge a later batch invalidated
   *
   * `carryForward` decides which of the previous snapshot's rows survive by looking at the
   * batches present under `snapshotId` when it runs; a batch arriving afterwards has nothing to
   * displace, so the previous version of every row it touches is still sitting there, carried,
   * and the snapshot now holds both under one primary key. Marked here rather than repaired —
   * repairing would mean re-running the merge from inside a batch write, which turns an ordinary
   * write into a scan of the previous snapshot on every call — and certainly rather than
   * ignored: `commit` refuses on this mark, so the only way past it is to run `carryForward`
   * again, which is exactly what a full retry of the load does anyway.
   *
   * ## Creating the load's record, and keeping its labels current
   *
   * Created by the FIRST batch, then upserted by any later batch that has something to add —
   * matching both siblings, whose `write` upserts the same row on every batch and leaves
   * whatever it finds (`packages/store-mikro-orm/src/warehouse.store.ts`, "upserted rather than
   * inserted so a retried batch does not create a second one"). What a later batch can change is
   * bounded: the stale mark above, and label keys the record does not already carry. `id`,
   * `createdAt`, `principalId` and any label value already recorded are written once and left
   * alone; a batch with nothing new to say writes nothing at all (see {@link labelsUnchanged}).
   *
   * `options.labels` is a caller's provenance — which base, which file, which workflow run —
   * and it used to be declared on `write` and never read, so a plain full load's labels were
   * silently discarded, `commit` taking no `labels` parameter of its own and only ever seeing
   * labels that arrived on a record something else had already written. Reading it only on the
   * batch that creates the record was the same defect one batch over: the core package's own
   * `EXPECT_SHRINK_LABEL` docblock (`packages/pipeline/src/load-expectations.ts`) tells a
   * publisher to "set it in the `labels` of ANY batch of the load", `PublishService.appendRows`
   * takes labels per call, and the publish controller passes them per request — so a publisher
   * acknowledging a deliberate collapse on its second batch had the acknowledgement dropped and
   * was then refused at commit for the collapse it had acknowledged. Merged under what is
   * already recorded, so a key keeps the value the first batch to supply it gave it; see
   * `carryForward`'s own merge of the same parameter for the third writer of the same rule.
   *
   * The second is `createdAt`, and it is why this runs whether or not any labels came with it.
   * `createdAt` is what `SnapshotCatalog`'s `list`/`listLive` sort on, so it is what "newest"
   * means to `carryForward`'s fallback merge source and to a retention sweep. Creating the
   * record only for a caller that supplied labels anchored `createdAt` on the load's first write
   * for that caller and on commit time for every other one — two otherwise identical loads
   * ordered by different clocks, differing by however long the load ran, decided by a parameter
   * that has nothing to do with when anything happened. One anchor, stated: **`createdAt` is
   * when this store first saw the load**, which is the first batch for every load that writes
   * anything, and `commit` for the one shape that does not (an empty load, committed with
   * nothing ever staged — see `principalOf`'s own docblock).
   *
   * `rowCount: 0` is a placeholder, not a count. Nothing here can maintain it: the batches that
   * follow this one are what determine the load's size. It is not to be read off an uncommitted
   * record — see {@link present}, which is where that is enforced for every caller outside this
   * class.
   */
  private async recordWrittenBatch(
    type: CatalogObjectTypeDef,
    options: { snapshotId: string; principalId: string; labels?: Record<string, string> },
    loadedAt: string,
  ): Promise<void> {
    const existingRef = await this.snapshots.find(type.name, options.snapshotId);
    if (!existingRef) {
      const created: SnapshotRef = {
        id: options.snapshotId,
        createdAt: loadedAt,
        rowCount: 0,
        principalId: options.principalId,
      };
      await this.snapshots.put(
        type.name,
        options.labels ? { ...created, labels: options.labels } : created,
      );
      return;
    }
    // Under what is already recorded, never over it — the same spread, in the same order, as
    // `carryForward`'s. A key a previous batch supplied keeps its value; a key only THIS batch
    // supplies is added.
    const labels: Record<string, string> = { ...options.labels, ...existingRef.labels };
    if (existingRef.labels?.[CARRIED_FROM_LABEL] !== undefined) {
      labels[CARRY_FORWARD_STALE_LABEL] = 'true';
    }
    // Nothing new to say: no label this batch brought is missing from the record, and no merge
    // needs marking. Skipped rather than written, so an ordinary multi-batch load still pays one
    // GET per batch and no PUT — the cost `write` has always had.
    if (labelsUnchanged(existingRef.labels, labels)) return;
    await this.snapshots.put(type.name, { ...existingRef, labels });
  }

  /** How many rows are staged under a snapshot. Present for this package's own specs. */
  async countStaged(type: CatalogObjectTypeDef, snapshotId: string): Promise<number> {
    // A glob that matches nothing is an error in DuckDB, not an empty result — and "this
    // snapshot has no objects yet" is an ordinary state during a load. Asking the object store
    // first keeps the difference between "nothing written yet" and "the engine could not
    // read what was written".
    if ((await this.objects.list(snapshotPrefix(type.name, snapshotId))).length === 0) {
      return 0;
    }
    const connection = await this.ready();
    const glob = this.objects.locate(`${snapshotPrefix(type.name, snapshotId)}/*.parquet`);
    // `union_by_name = true`, kept even though testing this against the real engine found
    // `count(*)` returns the identical total with or without it — the flag changes nothing
    // this particular query can observe. It stays for two reasons. First, every
    // `read_parquet` this store issues carries the same flag, so nobody reading this file has
    // to work out call-by-call whether a given query happens to be safe without it. Second,
    // and the reason that matters: the row-level reads a later task adds over this same glob
    // are NOT safe without it. A later task writes carry-forward rows as their own object in
    // the same snapshot prefix with a different column set, and `SELECT *` over a glob whose
    // files disagree on which columns exist silently drops the columns some of them lack,
    // rather than erroring — verified against the real engine. `count(*)` alone cannot see
    // that failure; the reads built on top of this glob can.
    const rows = await connection.rows(
      `SELECT count(*) AS total FROM read_parquet(${quoteLiteral(glob)}, union_by_name = true)`,
    );
    return Number(rows[0]?.total ?? 0);
  }

  /**
   * Make a staged snapshot the one readers get.
   *
   * Three steps, ordered so that re-running is the repair: count the rows, record the
   * snapshot, then move the pointer. A crash after the record leaves a snapshot nobody
   * serves, which the next attempt overwrites; the reverse order would leave the pointer at
   * a snapshot with no record, and nothing later could tell whether that load finished.
   *
   * The pointer move goes through `SnapshotCatalog.setCurrent`, which is a blind write, not a
   * compare-and-swap — see that method's own docblock. This is deliberate rather than a gap:
   * committing an older snapshot is how a rollback is expressed, so `commit` must be able to
   * move the pointer backwards, and a guard here that only accepted a newer snapshot would
   * make a rollback impossible to express through this method at all.
   *
   * ## The fourth refusal: a merge a later batch invalidated
   *
   * `CatalogMergeStore.carryForward`'s own docblock (`packages/catalog/src/catalog.store.ts`)
   * states the one legal order for an incremental load: write every batch, `carryForward` once,
   * *after* the last batch, then `commit`. A batch written after the merge has nothing in the
   * merge's anti-join to displace it — the previous version of every row it touches is still
   * sitting there, carried — so the snapshot would hold two versions of the same primary key.
   * Refused rather than repaired by re-running the merge here, for the reason `write`'s own
   * marking comment gives: `commit` doing a merge on the caller's behalf would hide from that
   * caller that its ordering was wrong, and the caller would never learn to fix the batch that
   * produced the problem in the first place. The repair is stated in the message: carry forward
   * again, then commit.
   *
   * ## Marks the record committed, unconditionally
   *
   * {@link COMMITTED_LABEL} is set on every successful call, merged into whatever labels the
   * record already carried (from an earlier `carryForward`, or from a caller's own
   * `options.labels` on `write`) rather than replacing them. This is the fact `carryForward`'s
   * own fallback resolution reads back to exclude a written-but-never-committed snapshot from
   * standing in as a merge source — see that label's own docblock.
   */
  async commit(type: CatalogObjectTypeDef, snapshotId: string): Promise<SnapshotRef> {
    const existing = await this.snapshots.find(type.name, snapshotId);
    if (existing?.droppedAt) {
      throw new Error(
        `snapshot ${snapshotId} of ${type.name} was dropped on ${existing.droppedAt} and cannot be committed. Its rows are gone; the record survives so run history stays resolvable.`,
      );
    }
    if (existing?.labels?.[CARRY_FORWARD_STALE_LABEL] !== undefined) {
      throw new BadRequestException(
        `Snapshot ${snapshotId} of ${type.name} carried rows forward from ${
          existing.labels[CARRIED_FROM_LABEL] ?? 'an earlier snapshot'
        } and then took more batches, so the merge no longer covers the whole load and every row those batches touched is in the snapshot twice. Carry forward again, then commit — in that order.`,
      );
    }
    const ref: SnapshotRef = {
      id: snapshotId,
      // Never restamped. `write` anchors `createdAt` on the load's first batch and this keeps
      // it, so a load's place in `list`/`listLive`'s recency order is when it started rather
      // than when it finished — one anchor for every load, instead of one for the loads that
      // wrote something and another for the loads that did not. `?? now` is reached only by a
      // snapshot `write` never touched: an empty load committed with nothing staged, whose
      // first record this call is (see `principalOf`'s own docblock).
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      rowCount: await this.countStaged(type, snapshotId),
      principalId: existing?.principalId ?? (await this.principalOf(type, snapshotId)),
      // Unconditional: this IS the fact that a commit records, and `carryForward`'s fallback
      // resolution reads it back to tell a served snapshot apart from a merely-written one —
      // see COMMITTED_LABEL's own docblock.
      labels: { ...existing?.labels, [COMMITTED_LABEL]: 'true' },
      ...(existing?.archive ? { archive: existing.archive } : {}),
    };
    await this.snapshots.put(type.name, ref);
    await this.snapshots.setCurrent(type.name, snapshotId);
    // `omitCommittedLabel` rather than `present`: the ref built just above already carries a
    // freshly counted, now-final `rowCount`, and it is the record this call just wrote, so
    // there is nothing for a recount to correct and a second `countStaged` would only be a
    // second chance for the two numbers to disagree.
    return omitCommittedLabel(ref);
  }

  /**
   * The snapshot record behind the served pointer, or `undefined` when nothing has committed.
   *
   * Goes through {@link present} like every other method here that hands a `SnapshotRef` to
   * code outside this class, which is a no-op for its own answer in particular: the served
   * pointer is moved by `commit` alone, so what this resolves is always a committed record and
   * always carries a final, stored `rowCount`. Routed through it anyway rather than special-
   * cased, so there is one answer in this file to "what does a caller see", not four.
   */
  async currentSnapshot(type: CatalogObjectTypeDef): Promise<SnapshotRef | undefined> {
    const id = await this.snapshots.current(type.name);
    if (!id) return undefined;
    const ref = await this.snapshots.find(type.name, id);
    return ref ? this.present(type, ref) : undefined;
  }

  /**
   * Every record, newest first, tombstones included. {@link COMMITTED_LABEL} stripped and
   * `rowCount` recomputed where the stored one is a placeholder — see {@link present}.
   */
  async listSnapshots(type: CatalogObjectTypeDef): Promise<SnapshotRef[]> {
    return this.presentAll(type, await this.snapshots.list(type.name));
  }

  /**
   * The newest N snapshots that still hold rows.
   *
   * The predicate is applied before the bound, not after it. A caller that takes the newest
   * N records and then drops the tombstones among them is holding the live snapshots *of
   * that window* — and past N tombstones the filtered list is empty, which is
   * indistinguishable from "nothing to do" to every caller that asks this question.
   *
   * That guarantee has to live in `SnapshotCatalog.listLive`, not here: this method used to
   * build it out of `this.snapshots.list(type.name, SNAPSHOT_LIST_LIMIT)` and its own
   * `.filter().slice()`, which filters correctly relative to *that call*, but `list`'s own
   * `limit` is a raw cap applied before `list` ever hands back a result — so for a type whose
   * lifetime history exceeds `SNAPSHOT_LIST_LIMIT`, the filtering here ran on an already-cut
   * window and a live snapshot older than that raw cutoff was invisible no matter what `limit`
   * this method was given. Delegating to `listLive` moves the predicate inside the read
   * `SnapshotCatalog` does, where it can run before any cap is taken — see that method's own
   * docblock.
   *
   * {@link COMMITTED_LABEL} is stripped here too, same as `listSnapshots`, `findSnapshot` and
   * `currentSnapshot` — this method is not an internal helper `carryForward` happens to share.
   * It is declared on the core `CatalogWriteStore` interface, re-exported through the fan-out,
   * and consumed by the pipeline's eviction sweep, so a caller reaching it from any of those
   * places sees the identical contract every other snapshot-returning method on this class
   * already gives: `labels` present only when a caller supplied some.
   *
   * `carryForward`'s own fallback resolution does NOT call this method — it calls
   * `this.snapshots.listLive` directly, the same catalog read this method wraps, exactly the
   * way it already calls `this.snapshots.find` directly rather than the public `findSnapshot`.
   * Stripping happens once, here, for the one caller that is not this class itself.
   */
  async listSnapshotsWithRows(
    type: CatalogObjectTypeDef,
    limit = SNAPSHOT_LIST_LIMIT,
  ): Promise<SnapshotRef[]> {
    return this.presentAll(type, await this.snapshots.listLive(type.name, limit));
  }

  /**
   * Exact lookup by id, tombstone included, whatever the age. {@link COMMITTED_LABEL} stripped
   * and `rowCount` recomputed where the stored one is a placeholder — see {@link present}.
   */
  async findSnapshot(
    type: CatalogObjectTypeDef,
    snapshotId: string,
  ): Promise<SnapshotRef | undefined> {
    const ref = await this.snapshots.find(type.name, snapshotId);
    return ref ? this.present(type, ref) : undefined;
  }

  /**
   * One `SnapshotRef` as code outside this class is allowed to see it: {@link COMMITTED_LABEL}
   * removed, and `rowCount` counted fresh when the stored one is not a fact about the data.
   *
   * ## Which refs carry a computed count, and which carry a stored one
   *
   * Two states carry a number the operation that produced them was in a position to know, and
   * both are handed back verbatim. A **tombstone** carries what `dropSnapshot` recorded before
   * deleting the rows; recounting one would answer zero for a load that held millions. A
   * **committed** record carries what `commit` counted while blessing it, which is also the
   * number the pipeline's bound compared against. Nothing in this store refuses a `write` into
   * an already-committed snapshot, so that number can be overtaken on disk — but those rows are
   * a load nobody has blessed, and recounting here would change what a committed snapshot claims
   * with no commit having said so.
   *
   * One other writer reaches a committed record's `rowCount`: `carryForward` assigns
   * `ref.rowCount = total` to whatever record it found, and on the served-replay path that
   * record is committed and no commit follows. The two numbers agree in practice — `total` is
   * the same `countStaged` over the same snapshot that `commit` ran — but that is an agreement
   * rather than a rule this method enforces, and it is stated here rather than left as a claim
   * that only a committed number is written by a commit.
   *
   * Every OTHER writer of a record writes a `rowCount` it has no way to maintain: `write`
   * creates one on a load's first batch, before the rest of the load exists, and `carryForward`
   * records the total as of the moment it merged, which a later batch invalidates. For a record
   * that is neither committed nor dropped the stored number is a placeholder, and the count
   * comes fresh from {@link countStaged} — the same statement `commit` itself uses, so the
   * number a caller sees before a commit and the number that commit records cannot disagree.
   *
   * The MikroORM sibling reaches the same contract by the same route, in `snapshotWindow` (see
   * `packages/store-mikro-orm/src/warehouse.store.ts`): stored for committed and dropped rows,
   * recounted for the rest, and its `write` says outright that `rowCount` "is not maintained
   * here and is not to be read off an uncommitted row".
   *
   * ## Why this is not cosmetic
   *
   * The pipeline's row-count bound (`assertRowCountIsPlausible` in
   * `packages/pipeline/src/publish.service.ts`) runs BEFORE `store.commit` and reads `rowCount`
   * off the pending snapshot it finds in `listSnapshots`. `refuseRowCountDrift`'s `pending === 0`
   * branch (`packages/pipeline/src/load-expectations.ts`) refuses unconditionally — under no
   * bound and below any `minRows` floor — because a load that collapsed to nothing is never
   * plausible. A placeholder reaching that branch means every full-mode load onto a type already
   * serving rows is refused at commit, with a sentence saying the snapshot holds no rows while
   * its rows are staged on disk and about to be committed.
   *
   * ## Cost
   *
   * One `countStaged` per record that is neither committed nor dropped, sequentially. That set
   * is the loads in flight plus any that were abandoned before commit and not yet retired, not
   * the type's history — a committed record, which is what a type accumulates, costs nothing
   * here. It is also small against what the two list methods reaching this already pay:
   * `SnapshotCatalog.list` and `listLive` read every record ever written for the type, one GET
   * each (see that module's own docblock). `findSnapshot` and `currentSnapshot` reach it one ref
   * at a time, so they pay at most one count each.
   */
  private async present(type: CatalogObjectTypeDef, ref: SnapshotRef): Promise<SnapshotRef> {
    if (hasFinalRowCount(ref)) return omitCommittedLabel(ref);
    return omitCommittedLabel({ ...ref, rowCount: await this.countStaged(type, ref.id) });
  }

  /**
   * {@link present}, over a list, one at a time.
   *
   * Sequential rather than `Promise.all`, and deliberately so: every count below runs on the
   * one connection `ready()` memoizes for the whole store, and overlapping two uses of that
   * single connection is the failure `streamSnapshot` was rewritten to avoid — an open result
   * on it came back truncated, with no error, when another statement ran against it (measured;
   * see `openStreamConnection`'s docblock in `duckdb.ts`). Whether `count(*)` in particular
   * would survive that has not been measured here, and issuing N of them at once to find out is
   * not what this method is for.
   */
  private async presentAll(
    type: CatalogObjectTypeDef,
    refs: SnapshotRef[],
  ): Promise<SnapshotRef[]> {
    const presented: SnapshotRef[] = [];
    for (const ref of refs) presented.push(await this.present(type, ref));
    return presented;
  }

  /**
   * Take the rows and keep the record.
   *
   * The record survives because `catalog_connector_run` names the snapshot each run
   * produced, so deleting it turns run history into pointers to nothing. The disk is held by
   * the rows, and the two are separable.
   *
   * The count is read *before* the objects go, and `droppedAt` is written *after* — so a
   * crash between them leaves rows deleted and a record that still claims them, which the
   * next call repairs. Writing the tombstone first would leave a snapshot reported as
   * dropped whose rows are still there and still costing.
   *
   * Refuses to drop the snapshot the type is currently serving — the one refusal that keeps
   * `read`'s hot path free of the tombstone check. `commit` above refuses to move the pointer
   * onto an already-dropped snapshot; this is the other half. Without it, dropping the served
   * snapshot would make an ordinary read (no `query.snapshot`, which never looks the record
   * up) answer with zero rows instead of the refusal a dropped snapshot is owed elsewhere in
   * this file — the exact silent-wrong-answer the core interface forbids.
   *
   * Idempotent: a second call on an already-dropped snapshot is a no-op, so a durable step
   * that replays this call does not rewrite `droppedAt` to the moment of its retry. The date
   * is evidence of when the drop happened, not of when it was last asked for.
   */
  async dropSnapshot(type: CatalogObjectTypeDef, snapshotId: string): Promise<void> {
    const existing = await this.snapshots.find(type.name, snapshotId);
    if (existing?.droppedAt) return;
    if ((await this.snapshots.current(type.name)) === snapshotId) {
      throw new Error(
        `snapshot ${snapshotId} is the one ${type.name} is currently serving and cannot be dropped. Commit another snapshot first — a served tombstone would make every ordinary read pay for the question.`,
      );
    }
    // The stored number when it is final, a fresh count otherwise — the same split {@link
    // present} makes, and for the same reason. `existing?.rowCount` verbatim wrote a permanent
    // tombstone claiming zero rows whenever the record was one `write` or `carryForward` had
    // created and `commit` had not yet reached, since those two store a placeholder; the rows
    // are deleted a line below, so nothing can ever correct that number afterwards. A fresh
    // count unconditionally would break this method's own crash repair instead: a retry that
    // finds `deletePrefix` already done but `droppedAt` never written has nothing left to count
    // and must fall back to what the committed record recorded.
    const rowCount =
      existing && hasFinalRowCount(existing)
        ? existing.rowCount
        : await this.countStaged(type, snapshotId);
    await this.objects.deletePrefix(snapshotPrefix(type.name, snapshotId));
    await this.snapshots.put(type.name, {
      id: snapshotId,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      rowCount,
      principalId: existing?.principalId ?? 'unknown',
      ...(existing?.labels ? { labels: existing.labels } : {}),
      ...(existing?.archive ? { archive: existing.archive } : {}),
      droppedAt: new Date().toISOString(),
    });
  }

  /**
   * Resolve which snapshot is being asked for, refuse to serve a tombstone, apply the
   * `fields` whitelist, and answer both the page and the total over the glob covering that
   * snapshot's parts.
   *
   * ## Resolution
   * `query.snapshot` if the caller named one, otherwise the type's served pointer. Neither
   * being set means nothing has ever committed for this type, which is an empty result, not
   * an error — the type is real, it simply has no load anyone has blessed yet.
   *
   * ## The tombstone check runs only when the caller named a snapshot
   * `SnapshotCatalog`'s own docblock states the invariant this read leans on: **the snapshot
   * a type is serving is never a tombstone**. It holds here by construction, from two
   * separate refusals rather than by luck — `commit` above refuses to move the pointer to an
   * already-dropped snapshot, and `dropSnapshot` above refuses to drop the snapshot the
   * pointer currently names. Because the invariant holds, an ordinary read (no `snapshot` in
   * the query) never needs to ask whether what it is about to serve is a tombstone; the
   * lookup is skipped for it, not merely cheap. It runs for the one case the pointer's good
   * behaviour says nothing about: a caller naming a specific, possibly historical snapshot.
   *
   * ## The `fields` whitelist, and `size`/`page`, are resolved before storage is touched
   * Resolving `fields` to properties happens before the empty-glob guard below, so a caller
   * naming a field the type does not have is refused the same way regardless of whether
   * anything happens to be staged yet. Resolving it later, inside the SELECT-list builder,
   * meant an identical bad request either threw or came back with zero rows depending on
   * data state that has nothing to do with the request being malformed. `size` and `page`'s
   * own finiteness checks sit right beside it for the same reason: a `{ size: NaN }` read
   * against a snapshot with nothing staged used to return a quiet `{ rows: [], total: 0 }`
   * from the guard below rather than the named refusal it gets once anything is on disk —
   * two different answers to one bad request, depending on data state a caller cannot see.
   *
   * ## `filters`, `search`, `sort` and `dir`
   * All four narrow or order the same two statements — the count and the page — never just
   * one, because they share the `clause`/`orderBy` built once below. A filter or a search
   * term applied to only one of them is a screen showing three rows above the words "of
   * 4,812", which reads as more wrong than not filtering at all: the count and the page then
   * disagree about the same question.
   *
   * `filters` is `(query.filters ?? []).map(predicateFor)`, ANDed with {@link searchPredicate}'s
   * result (if any) into one `WHERE`. Each filter's column comes off `filter.property`,
   * resolved by the core service against the type before this method ever sees it — see
   * `predicateFor`'s own docblock. Before that, though, every filter's property is checked
   * against `properties` (the resolved `fields`) and refused by name if it names a column
   * this read did not select — not a tidiness rule, an information leak: a predicate over a
   * column outside the whitelist narrows which ROWS come back without ever putting the
   * column's value in the SELECT list, so `gte`/`lte` let a caller who cannot see a column
   * binary-search its value one request at a time, and `eq`/`contains` narrow it one guess at
   * a time. The core service only ever resolves filters against the same visible columns it
   * derives `fields` from, so this refusal is reached only by a caller building the request
   * itself — the same caller `predicateFor`'s `filter.property`-not-the-request's-string
   * design is guarding against one layer up.
   *
   * `search` and `sort`/`dir` are built by {@link searchPredicate} and {@link orderByClause}
   * respectively; see their own docblocks for how each matches the ClickHouse sibling's
   * `read` and where it deviates.
   *
   * ## Ordering
   * `(_batch, _row)` is a total order over one snapshot's rows because {@link batchKey} is
   * derived from `(type, snapshot, batch)`: two objects staged under one snapshot cannot
   * share a `_batch`, since writing the same batch number again replaces that object rather
   * than adding a second one at the same key. That fact lives in `identifiers.ts`, not here —
   * and it is exactly what a later task's carry-forward write, landing in the same snapshot
   * prefix under its own batch numbers, has to keep true for this ordering to still mean
   * anything.
   */
  async read(
    type: CatalogObjectTypeDef,
    fields: string[],
    query: CatalogReadQuery,
  ): Promise<CatalogReadResult> {
    const currentId = await this.snapshots.current(type.name);
    const wanted = query.snapshot ?? currentId;
    if (!wanted) return { rows: [], total: 0 };

    // Only when the caller named a snapshot explicitly — see the docblock above for why the
    // ordinary, pointer-resolved read is exempt from this lookup.
    if (query.snapshot) {
      const ref = await this.snapshots.find(type.name, wanted);
      if (ref?.droppedAt) {
        throw new Error(
          `snapshot ${wanted} of ${type.name} held ${ref.rowCount} row(s) and was dropped on ${ref.droppedAt}. Its rows are gone; this read cannot be served and is refused rather than answered with none — an empty result here is indistinguishable from a load that collapsed.`,
        );
      }
    }

    // Resolved up front, ahead of the empty-glob guard, so a field the type does not have is
    // refused identically whether or not the snapshot has anything staged yet.
    const properties = this.resolveProperties(type, fields);

    // A predicate over a column this read did not select is how a hidden or classified
    // value leaks out through row membership even though it never reaches the SELECT list:
    // `gte`/`lte` let a reader who cannot see a column binary-search its value one request at
    // a time, and `eq`/`contains` narrow it one guess at a time. `read`'s whitelist promise —
    // never return a column outside `fields` — is not kept by controlling the SELECT list
    // alone, so every filter's property is checked against the same `properties` the SELECT
    // list is built from before any statement is built. Checked here, beside `fields`, and
    // ahead of the empty-glob guard below, for the same reason as `size`/`page` just below:
    // an identical bad request must fail the same way regardless of what is on disk yet.
    for (const filter of query.filters ?? []) {
      if (!properties.some((property) => property.name === filter.property.name)) {
        throw new BadRequestException(
          `${filter.property.name} is not among the columns this read returns, so it cannot be filtered on.`,
        );
      }
    }

    // Checked here, beside `fields` and the filter-vs-`fields` check above, and ahead of the
    // empty-glob guard below — see the docblock above for why an identical bad request must
    // fail the same way regardless of what is on disk yet.
    const { size, page } = resolvedPaging(query);

    const connection = await this.ready();
    // A glob that matches nothing is an error in DuckDB, not an empty result — and "this
    // snapshot has no objects yet" is an ordinary state during a load. Asking the object store
    // first keeps the difference between "nothing written yet" and "the engine could not
    // read what was written".
    if ((await this.objects.list(snapshotPrefix(type.name, wanted))).length === 0) {
      return { rows: [], total: 0, snapshot: { id: wanted, current: wanted === currentId } };
    }

    const source = `read_parquet(${quoteLiteral(this.globFor(type, wanted))}, union_by_name = true)`;
    const selected = properties
      .map(
        (property) =>
          `${ident(physicalColumn(property.name))} AS ${ident(outputAlias(property.name))}`,
      )
      .join(', ');

    // One `WHERE`, built once and used by both statements below — see the docblock's
    // "filters, search, sort and dir" section for why a predicate applied to only one of
    // them is worse than applying it to neither.
    const predicates: string[] = [];
    const search = searchPredicate(properties, query.search);
    if (search) predicates.push(search);
    predicates.push(...(query.filters ?? []).map(predicateFor));
    const clause = predicates.length > 0 ? ` WHERE ${predicates.join(' AND ')}` : '';
    const orderBy = orderByClause(properties, query);

    const totalRows = await connection.rows(`SELECT count(*) AS total FROM ${source}${clause}`);
    // `count(*)` comes back as a `bigint` on this engine — DuckDB's INT64 — and
    // `JSON.stringify` throws on a bare bigint rather than rendering it, so a response body
    // built from the raw value would fail the serialiser rather than the read.
    const total = Number(totalRows[0]?.total ?? 0);
    const rows = await connection.rows(
      `SELECT ${selected} FROM ${source}${clause} ORDER BY ${orderBy} LIMIT ${size} OFFSET ${(page - 1) * size}`,
    );

    return {
      rows: rows.map((row) => normaliseRow(properties, row)),
      total,
      snapshot: { id: wanted, current: wanted === currentId },
    };
  }

  /** The glob covering one snapshot's parts, and only that snapshot's. */
  private globFor(type: CatalogObjectTypeDef, snapshotId: string): string {
    return this.objects.locate(`${snapshotPrefix(type.name, snapshotId)}/*.parquet`);
  }

  /**
   * Who loaded a snapshot, read off the rows when no record names them yet.
   *
   * `union_by_name = true` for the same reason every other `read_parquet` over a snapshot
   * glob in this file carries it: without it, DuckDB matches a glob's files column-by-position
   * rather than column-by-name, so a glob whose files disagree on column order can hand back
   * whatever sits at `_principal_id`'s position in the first file — which may not be
   * `_principal_id` at all in the others.
   *
   * Guarded against the empty glob the same way `read` and `countStaged` are: `commit` calls
   * this for a snapshot `write` never touched — an operator committing early, or a retry racing
   * ahead of its own load — and a glob matching nothing raises in DuckDB rather than answering
   * with no rows. `'unknown'` is the answer chosen deliberately rather than a thrown refusal,
   * because it is the identical answer a snapshot that DID get written already gets a few
   * lines down, for a batch that happened to write zero rows: to a caller, "nothing was ever
   * staged" and "a real batch staged nothing" are the same boring outcome, not two different
   * failures that need two different error shapes.
   */
  private async principalOf(type: CatalogObjectTypeDef, snapshotId: string): Promise<string> {
    if ((await this.objects.list(snapshotPrefix(type.name, snapshotId))).length === 0) {
      return 'unknown';
    }
    const connection = await this.ready();
    const rows = await connection.rows(
      `SELECT ${ident(PRINCIPAL_COLUMN)} AS principal FROM read_parquet(${quoteLiteral(this.globFor(type, snapshotId))}, union_by_name = true) LIMIT 1`,
    );
    const principal = rows[0]?.principal;
    return typeof principal === 'string' ? principal : 'unknown';
  }

  /**
   * Every row of one snapshot, in `(_batch, _row)` order, pulled from the engine one chunk at a
   * time rather than paged or read in full.
   *
   * ## Why not `read`, paged
   *
   * `read` resolves "current" correctly and can be paged, but a page is `LIMIT`/`OFFSET`, and
   * the core package's own `CatalogSnapshotStreamStore` docblock explains why that is the wrong
   * tool for a whole dataset: reading it in pages makes the engine walk the offset each time, a
   * cost that is quadratic in exactly the row counts this feature exists for, and paging is only
   * correct under a total order, which `read` does not promise. `(_batch, _row)` is that total
   * order for the same reason `read`'s own docblock gives it one: {@link batchKey} derives a
   * batch's key from `(type, snapshot, batch)`, so two objects staged under one snapshot can
   * never share a `_batch` — and a carried object's `_batch` is {@link CARRY_FORWARD_BATCH}
   * (`-1`), which sorts before every ordinary batch rather than colliding with one.
   *
   * ## No `ORDER BY` over the whole snapshot — reconstructed from file order instead
   *
   * A first version of this method did one `read_parquet` over the snapshot's whole glob with
   * `ORDER BY _batch, _row`. That is wrong, and measurably so: `ORDER BY` is a blocking
   * operator, so DuckDB has to see every input row before it can produce the first output row —
   * `stream` still pulls chunk-by-chunk faithfully once the result exists, but the result does
   * not exist until the whole snapshot has been sorted. Measured directly (see `duckdb.ts`'s
   * `stream` docblock for the numbers): a 4,000,000-row unsorted scan returns its first chunk in
   * single-digit milliseconds; the same table sorted took roughly ten times as long and pulled
   * tens of megabytes into the process before that first chunk came back. A `streamSnapshot`
   * that materialises the whole snapshot before yielding row 1 is a slower `read` wearing a
   * different signature — exactly the cost this method exists to avoid.
   *
   * The fix is to never ask DuckDB to sort more than one file at a time. `(_batch, _row)` is
   * reconstructed by iterating the snapshot's Parquet objects in **parsed-batch-number order**
   * — see {@link batchNumberOf} — and running `ORDER BY _row` **per file**, which reproduces
   * write order within one batch and costs a sort over one batch's rows rather than the whole
   * snapshot.
   *
   * Not a lexicographic sort of the key strings: an earlier version of this method sorted the
   * keys directly, on the claim that {@link batchKey}'s zero-padding to six digits "makes
   * ascending batch numbers sort the same way lexicographically as numerically" — which is
   * true only below 1,000,000. `write` accepts any non-negative integer batch (see that
   * method's own guard), and `'part-1000000.parquet' < 'part-999999.parquet'` as strings —
   * confirmed directly — which is backwards. {@link batchNumberOf} parses the number back out
   * instead of trusting the string, so this method's order agrees with `read`'s numeric
   * `ORDER BY _batch` at every magnitude, not merely below seven digits.
   *
   * ## Genuinely streamed, on a connection of its own
   *
   * `openStreamConnection` — see that method's own docblock in `duckdb.ts` — rather than
   * `this.ready()`'s single memoized connection: DuckDB serialises within one connection, so a
   * stream left open across `await`s on the store's shared connection is silently truncated by
   * any other query this store issues while it is open (a `read`, a `write`, a concurrent
   * `streamSnapshot`) — measured against the real driver, and documented at length in
   * `duckdb.ts` because the failure is silent rather than thrown. The dedicated connection is
   * closed in `finally`, whether the loop below runs to completion or the generator is
   * abandoned early via `break`, `return()`, or an error thrown by the consumer's own body —
   * all three run this generator's `finally` by the language's own generator semantics.
   *
   * **Known, accepted gap**: a consumer that drives the iterator with raw `.next()` calls and
   * simply stops calling it — never `for await`, never an explicit `.return()` — leaks this
   * dedicated connection, because nothing ever resumes the generator to reach `finally`. That is
   * inherent to the generator shape `AsyncIterable` asks for, not something this method can
   * detect or guard against from the inside; `for await`, the ordinary way to consume this
   * interface, does not have the problem.
   *
   * ## Refusals
   *
   * A dropped snapshot is refused outright: iterating zero rows here would let a workflow
   * report success and commit an empty load downstream, which is the exact failure `read`'s own
   * tombstone check exists to prevent — see that method's docblock. `fields` is resolved to
   * properties and refused by name exactly as `read` refuses it, ahead of the empty-object
   * check below — matching `read`'s own reasoning for doing the same in that order: an
   * identical bad request (an unknown field) must fail the same way whether or not anything is
   * staged yet, rather than depend on data state a caller cannot see.
   *
   * `provenance: true` adds both of {@link CATALOG_PROVENANCE_COLUMNS} or throws — this store
   * never has to choose the latter: `write`'s own `stageRow` puts `_principal_id` and
   * `_loaded_at` on every row it ever stages, and this method's own `carryForward` copies both
   * across untouched rather than dropping either, so there is no code path in this file that
   * could produce a row with one and not the other.
   */
  async *streamSnapshot(
    type: CatalogObjectTypeDef,
    fields: string[],
    snapshotId: string,
    options?: SnapshotStreamOptions,
  ): AsyncIterable<Record<string, unknown>> {
    const ref = await this.snapshots.find(type.name, snapshotId);
    if (ref?.droppedAt) {
      throw new Error(
        `snapshot ${snapshotId} of ${type.name} was dropped on ${ref.droppedAt} and cannot be streamed. Iterating zero rows here would let a workflow report success and commit an empty load downstream.`,
      );
    }

    const properties = this.resolveProperties(type, fields);
    const selected = properties.map(
      (property) =>
        `${ident(physicalColumn(property.name))} AS ${ident(outputAlias(property.name))}`,
    );
    if (options?.provenance) {
      for (const column of CATALOG_PROVENANCE_COLUMNS) {
        selected.push(ident(column));
      }
    }

    // Sorted by PARSED batch number, not the key string — see the docblock above and
    // `batchNumberOf`'s own for why a lexicographic sort is wrong past six digits.
    const keys = (await this.objects.list(snapshotPrefix(type.name, snapshotId)))
      .filter((key) => key.endsWith('.parquet'))
      .sort((left, right) => batchNumberOf(left) - batchNumberOf(right));
    if (keys.length === 0) return;

    const primary = await this.ready();
    const stream = await primary.openStreamConnection();
    try {
      for (const key of keys) {
        const sql = `SELECT ${selected.join(', ')} FROM read_parquet(${quoteLiteral(this.objects.locate(key))}, union_by_name = true) ORDER BY ${ident(ROW_COLUMN)}`;
        for await (const row of stream.stream(sql)) {
          yield options?.provenance
            ? withProvenance(normaliseRow(properties, row), row)
            : normaliseRow(properties, row);
        }
      }
    } finally {
      await stream.close();
    }
  }

  /**
   * `fields` resolved to the type's own declared properties, refused by name for a field the
   * type does not have — shared by `read` and `streamSnapshot` so the whitelist refusal reads
   * identically from either entry point rather than being maintained as two copies that could
   * drift apart on the exact wording or the exact check.
   */
  private resolveProperties(type: CatalogObjectTypeDef, fields: string[]): CatalogPropertyDef[] {
    return fields.map((field) => {
      const property = type.properties.find((each) => each.name === field);
      if (!property) {
        throw new BadRequestException(
          `${type.name} has no property named ${field}; a store must never return a column outside the whitelist it was handed.`,
        );
      }
      return property;
    });
  }

  /**
   * Refuse to merge when either side's primary key holds a NULL.
   *
   * Matches the MikroORM and ClickHouse siblings' own `assertKeyed` (see each package's
   * `warehouse.store.ts`/`clickhouse-warehouse.store.ts`), which check the same thing for the
   * same reason: a declared primary key is not the same thing as a populated one. A transform
   * that never produces the key column leaves a type that looks mergeable and data that is not
   * — a NULL-keyed row matches nothing in the anti-join below, since SQL's `=` is never true of
   * two NULLs, so it would be carried forward this run, carried forward again next run, and
   * duplicate itself once per run forever while the row counts stay merely plausible. Checked on
   * both sides: a NULL in the incoming batches means this run's rows can never replace anything,
   * a NULL in the previous snapshot means rows that can never be replaced.
   */
  private async assertKeyed(glob: string, keyColumns: string[], described: string): Promise<void> {
    const connection = await this.ready();
    const nullTest = keyColumns.map((column) => `${ident(column)} IS NULL`).join(' OR ');
    const rows = await connection.rows(
      `SELECT count(*) AS unkeyed FROM read_parquet(${quoteLiteral(glob)}, union_by_name = true) WHERE ${nullTest}`,
    );
    const count = Number(rows[0]?.unkeyed ?? 0);
    if (count === 0) return;
    throw new BadRequestException(
      `${count} row(s) in ${described} have no value for the primary key (${keyColumns.join(', ')}), so an incremental load cannot tell an update from a new object and would add a second copy of each of them on every run. Either make the load produce the key, publish the type with a primary key its data actually fills, or run this connector in "full" mode — a full run replaces the dataset outright and needs no key.`,
    );
  }

  /**
   * Rows in `snapshotId`'s carry-forward object, and zero when there is no such object.
   *
   * Safe to call at any point in a snapshot's life, including before `carryForward` has ever
   * run for it. That is not free: `read_parquet` on an exact path that does not exist is a raw
   * IO error in this engine, not an empty result — the same fact `countStaged`, `read` and
   * `principalOf` each guard their globs against — so the object store is asked first, exactly
   * as they ask it. The precondition this used to state instead ("safe after `carryForward` has
   * run at least once for `snapshotId`") was true of the two call sites that read the result and
   * false of the one that decides a branch: {@link DuckDbWarehouseStore.carryForward}'s
   * served-clear guard runs this BEFORE anything has written `carryKey`, and a plain full load
   * that was committed and is now served has no `carry.parquet` at all.
   *
   * Zero rather than a refusal, because "no carry object" and "a carry object holding nothing"
   * are the same answer to the only question anyone asks this: whether overwriting `carryKey`
   * would destroy anything.
   *
   * `union_by_name = true`, matching every other `read_parquet` in this file — a single file has
   * nothing to union against, but the flag costs nothing here either, and its absence would be
   * the one `read_parquet` call in this method that did not match its own docblock's claim that
   * all of them carry it.
   */
  private async countCarried(type: CatalogObjectTypeDef, snapshotId: string): Promise<number> {
    const key = carryForwardKey(type.name, snapshotId);
    const staged = await this.objects.list(snapshotPrefix(type.name, snapshotId));
    if (!staged.includes(key)) return 0;
    const connection = await this.ready();
    const rows = await connection.rows(
      `SELECT count(*) AS total FROM read_parquet(${quoteLiteral(this.objects.locate(key))}, union_by_name = true)`,
    );
    return Number(rows[0]?.total ?? 0);
  }

  /**
   * Write zero rows, with the full declared schema, to `carryKey`.
   *
   * Used whenever a `carryForward` call finds nothing to carry — no previous snapshot at all,
   * or one that is itself a fully empty, committed snapshot (a first run that fetched nothing;
   * see `carryForward`'s own docblock) — so that `carryKey` always exists after the call
   * returns and always reflects what THIS call decided, rather than whatever an earlier call on
   * the same `snapshotId` left there. Without this, a call that finds nothing to carry would
   * leave an earlier call's carried rows in place untouched: not merely a stale lineage label,
   * but `total` still counting rows that call's own answer says should not be there.
   *
   * The same technique `write` uses for a zero-row batch, and for the same reason: an empty
   * NDJSON file read through `read_json` with an explicit `columns` map yields zero rows of the
   * declared schema, and `COPY` of that produces a valid, zero-row Parquet object rather than an
   * error or a missing file — see `write`'s own docblock for where this was verified against the
   * real engine.
   */
  private async clearCarryObject(type: CatalogObjectTypeDef, carryKey: string): Promise<void> {
    const connection = await this.ready();
    const staging = join(tmpdir(), `catalog-duckdb-${randomUUID()}.ndjson`);
    try {
      await writeFile(staging, '', 'utf8');
      await this.objects.prepare(carryKey);
      await connection.run(
        `COPY (SELECT * FROM read_json(${quoteLiteral(staging)}, columns = ${stageColumns(type)}, format = 'newline_delimited')) TO ${quoteLiteral(this.objects.locate(carryKey))} (FORMAT PARQUET, COMPRESSION SNAPPY)`,
      );
    } finally {
      await rm(staging, { force: true });
    }
  }

  /**
   * Refuse to overwrite `carryKey` when `snapshotId` is the snapshot this type is CURRENTLY
   * SERVING, this call found nothing to carry forward, AND `carryKey` currently holds rows.
   *
   * `read` globs every object under a snapshot's prefix with no commit gate to pass first, so
   * a served snapshot's own `carryKey` being overwritten is instantly live — there is no
   * staging step protecting it the way an uncommitted snapshot's objects are protected simply
   * by not being the one `read` resolves yet. Reachable without anything exotic: `run-2` carries
   * `run-1`'s survivors forward and is committed (served); `run-1` is later dropped during
   * ordinary retention (legal — `dropSnapshot` only refuses the served snapshot); a durable
   * retry then replays `carryForward` for `run-2` — the self-merge-retry state, where
   * `served.id === snapshotId` sends resolution to the fallback — and the fallback can no
   * longer find `run-1`, live or otherwise. Clearing here would delete `run-1`'s carried rows
   * from `run-2`'s already-served dataset, with no error and nothing to make the change visible
   * or reversible — worse than the stale-count gap {@link clearCarryObject} exists to close,
   * which at least left the rows alone. Refused instead: the caller that triggered this (a
   * durable retry replaying `carryForward` after its own commit already succeeded) needs to
   * know its merge source is gone, not have this call guess that "found nothing to carry" means
   * "there was never anything to carry".
   *
   * **The `countCarried > 0` gate at the call site is not an optimisation — it is what keeps
   * this from refusing a call that would destroy nothing.** Three reachable, legitimate calls
   * have `served.id === snapshotId` and reach this branch with `carryKey` holding zero rows or
   * missing entirely, and they get there by two different routes rather than one:
   *
   * - **No `previous` resolves.** The first-ever incremental load of a type — `write('run-1')`
   *   → `carryForward('run-1')` finds no previous and writes a zero-row `carryKey` →
   *   `commit('run-1')` — replayed, reaches the identical state, with the fallback excluding
   *   `run-1` itself and nothing else ever committed. So does a plain full load, committed and
   *   served, for which `carryForward` is called with no other committed snapshot to find; that
   *   one has never had a `carryKey` written at all, which is why {@link
   *   DuckDbWarehouseStore.countCarried} answers about a missing object rather than assuming
   *   one.
   * - **A `previous` DOES resolve, and holds nothing.** A merge from a legitimately empty
   *   committed predecessor (see the "carries nothing forward, without crashing" case): the
   *   fallback finds that predecessor, live and committed, and what skips the merge branch is
   *   `previousObjects.length === 0`, not an absent `previous`. An earlier version of this
   *   passage said both legitimate replays "resolve no `previous`", which was true of the first
   *   route and false of this one.
   *
   * Refusing on `served.id === snapshotId` alone would strand all three, including `commit`'s
   * own documented recovery from the stale-merge refusal ("Carry forward again, then commit")
   * for any type with no second live committed snapshot to fall back to. The message above is
   * only true when something is actually at stake, which is exactly what the gate at the call
   * site restricts this method to.
   */
  private refuseServedClear(
    type: CatalogObjectTypeDef,
    snapshotId: string,
    carryKey: string,
  ): never {
    throw new Error(
      `${type.name}'s snapshot ${snapshotId} is currently served and already carries rows forward from an earlier snapshot, but this call found no committed snapshot to carry from (its predecessor may have been dropped). Refusing to overwrite ${carryKey} rather than silently deleting rows ${type.name} is currently serving.`,
    );
  }

  /**
   * Refuse to put one dataset's rows into a snapshot that is already SERVED, when that
   * snapshot's own record does not name the source this call resolved.
   *
   * Two shapes of "does not name it", covered in the two sections below: the record names a
   * DIFFERENT origin, and the record names no origin at all.
   *
   * The self-merge-retry state (`served.id === snapshotId`) assumes a replay's fallback
   * resolves to the SAME predecessor the original successful `carryForward` used, which is
   * what makes overwriting `carryKey` safe: the recomputed content matches what is already
   * being served. That assumption does not always hold. The fallback returns the newest LIVE,
   * COMMITTED record other than `snapshotId` — not the original predecessor by identity — so a
   * history of `run-0` → `run-1` → `run-2`, with `run-2` served and carrying from `run-1`,
   * takes the merge branch onto `run-0` instead the moment `run-1` is dropped while `run-0`
   * survives (reachable through an ordinary bundled retention sweep that catches one
   * candidate's failure and continues past it, not only through a single manual drop). Nothing
   * about that state resembles the missing-predecessor case {@link
   * DuckDbWarehouseStore.refuseServedClear} guards — `previous` resolves to something real —
   * so the anti-join would run and quietly substitute `run-0`'s survivors into `run-2`'s
   * already-served dataset, with no error and no commit to make the change visible or
   * reversible. Comparing the resolved `previous.id` against what `snapshotId`'s own record
   * says it was carried from ({@link CARRIED_FROM_LABEL}) is what tells the safe replay apart
   * from this one.
   *
   * ## A served snapshot whose record names no origin at all
   *
   * `recordedOrigin` is `undefined` for a snapshot that never carried anything: a plain full
   * load. That used to short-circuit this comparison, on the reading that with nothing recorded
   * there is nothing to disagree with — which left the same mutation uncovered one state over.
   * A full load, committed and served, with any older committed snapshot still live resolves a
   * real `previous` through the fallback the moment someone calls `carryForward` for it (a
   * connector switching a type from full to incremental, a durable step replaying past its own
   * commit), and the merge branch then injects that predecessor's rows into the served dataset
   * — the identical silent, uncommitted mutation, reached without a drop and without a
   * substitution. So the comparison is `recordedOrigin !== previous.id` with no exemption for
   * `undefined`: on an already-served snapshot, a merge is allowed only when it recomputes the
   * one origin that snapshot's own record already names. Everything reached before a snapshot
   * is served — every ordinary in-flight incremental load, whose first `carryForward` records
   * an origin where there was none — is outside this method entirely, gated by `isServedReplay`
   * at the call site.
   */
  private refuseSubstitutedOrigin(
    type: CatalogObjectTypeDef,
    snapshotId: string,
    recordedOrigin: string | undefined,
    resolvedOrigin: string,
  ): never {
    if (recordedOrigin === undefined) {
      throw new Error(
        `${type.name}'s snapshot ${snapshotId} is the one currently being served and its record says it has never carried rows forward from anything, but this call resolved ${resolvedOrigin} as a source to merge in. Merging would put ${resolvedOrigin}'s rows straight into the dataset ${type.name} is serving, with no commit to make that visible or reversible. Carry forward into a new snapshot and commit that instead.`,
      );
    }
    throw new Error(
      `${type.name}'s snapshot ${snapshotId} is currently served and was carried forward from ${recordedOrigin}, but this call resolved a different source: ${resolvedOrigin}. That happens when ${recordedOrigin} is no longer a live, committed snapshot (most likely dropped) and a different one took its place as the newest live committed record. Refusing to substitute ${resolvedOrigin}'s survivors into a snapshot ${type.name} is already serving under ${recordedOrigin}'s name.`,
    );
  }

  /**
   * The anti-join `COPY`: `previous`'s rows, minus whichever of them a primary key already
   * present among `snapshotId`'s own loader batches would replace, written to `carryKey`.
   *
   * Split out of `carryForward` itself so that method's own branching stays under this file's
   * complexity budget — this is the one branch with anything to compute, and the NULL-key
   * refusals, the anti-join's `WHERE`, and the `SELECT` list's column order (matching {@link
   * stageColumns}'s and `stageRow`'s exactly — see `carryForward`'s own docblock, "the anti-join,
   * and why the incoming glob excludes `carry.parquet`") all belong to this one statement.
   *
   * `isServedReplay`/`recordedOrigin` exist for exactly one check, ahead of everything else:
   * on a snapshot that is already SERVED, the merge may only recompute the one origin that
   * snapshot's own record already names. Anything else — a different live predecessor standing
   * in for a dropped one, or no recorded origin at all — would put rows a caller never asked
   * for into a dataset that is already live, with no commit to make it visible or reversible.
   * See {@link refuseSubstitutedOrigin}'s own docblock for both states and how each is reached.
   */
  private async writeMergedCarryObject(
    type: CatalogObjectTypeDef,
    snapshotId: string,
    carryKey: string,
    previous: SnapshotRef,
    keyColumns: string[],
    loaderObjects: string[],
    incomingGlob: string,
    isServedReplay: boolean,
    recordedOrigin: string | undefined,
  ): Promise<void> {
    // No exemption for `recordedOrigin === undefined`: a served snapshot that never carried
    // anything is the state where a merge has the LEAST claim to run, not the most — see
    // `refuseSubstitutedOrigin`'s own docblock.
    if (isServedReplay && recordedOrigin !== previous.id) {
      this.refuseSubstitutedOrigin(type, snapshotId, recordedOrigin, previous.id);
    }
    const previousGlob = this.globFor(type, previous.id);
    await this.assertKeyed(previousGlob, keyColumns, `snapshot ${previous.id}`);
    if (loaderObjects.length > 0) {
      await this.assertKeyed(
        incomingGlob,
        keyColumns,
        `the rows already written for ${snapshotId}`,
      );
    }

    const selected = [
      ...type.properties.map(
        (property) =>
          `previous.${ident(physicalColumn(property.name))} AS ${ident(physicalColumn(property.name))}`,
      ),
      `${quoteLiteral(snapshotId)} AS ${ident(SNAPSHOT_COLUMN)}`,
      `previous.${ident(PRINCIPAL_COLUMN)} AS ${ident(PRINCIPAL_COLUMN)}`,
      `previous.${ident(LOADED_AT_COLUMN)} AS ${ident(LOADED_AT_COLUMN)}`,
      `${CARRY_FORWARD_BATCH} AS ${ident(BATCH_COLUMN)}`,
      `row_number() OVER () AS ${ident(ROW_COLUMN)}`,
    ];
    const join = keyColumns
      .map((column) => `previous.${ident(column)} = incoming.${ident(column)}`)
      .join(' AND ');
    const antiJoin =
      loaderObjects.length > 0
        ? ` WHERE NOT EXISTS (SELECT 1 FROM read_parquet(${quoteLiteral(incomingGlob)}, union_by_name = true) AS incoming WHERE ${join})`
        : '';

    const connection = await this.ready();
    await this.objects.prepare(carryKey);
    await connection.run(
      `COPY (SELECT ${selected.join(', ')} FROM read_parquet(${quoteLiteral(previousGlob)}, union_by_name = true) AS previous${antiJoin}) TO ${quoteLiteral(this.objects.locate(carryKey))} (FORMAT PARQUET, COMPRESSION SNAPPY)`,
    );
  }

  /**
   * Copy the previously SERVED snapshot's surviving rows into `snapshotId`, letting whatever
   * this load already wrote win on a shared primary key.
   *
   * ## The merge source is the served snapshot, not the newest record
   *
   * `currentSnapshot` is the exact pointer `read`'s own docblock says an ordinary caller (no
   * `query.snapshot`) resolves against — not a second opinion about "current". The core
   * package's `CatalogWriteStore.currentSnapshot` docblock states why that matters here:
   * committing an OLDER snapshot is how a rollback is expressed, so the newest record and the
   * served one are different rows exactly when a rollback has happened, and a caller that
   * reconstructed "current" from a list ordered by `createdAt` would confidently name the load
   * that was just rolled back. Merging onto the newest live record instead of the served one
   * would carry forward from a load nobody is serving.
   *
   * ## The fallback runs from TWO conditions, and it is not idle in either
   *
   * `previous` falls back to the newest LIVE AND COMMITTED record (excluding `snapshotId`
   * itself) when `served` is `undefined` (nothing has ever been committed for this type) OR
   * when `served.id === snapshotId` (this exact snapshot is the one being served, and is being
   * carried forward into again). The two reach the same expression for different reasons, and
   * only the first one has no candidate to find: if nothing has ever committed, nothing can
   * carry {@link COMMITTED_LABEL} either, so the fallback in that branch always resolves to
   * `undefined`.
   *
   * The SECOND branch is not idle — a served snapshot certainly exists, and other committed
   * records commonly do too, and the fallback finding one of them is the load-bearing case, not
   * a formality. `served.id === snapshotId` is the durable-retry state: this exact merge already
   * ran and was committed once, and the whole step — `write`, `carryForward`, `commit` — is being
   * replayed. Excluding `snapshotId` from its own candidacy here is what stops the anti-join
   * from being run against its own rows, which would match every previous row against itself,
   * carry nothing forward, and silently erase whatever the earlier, legitimate call had copied
   * in.
   *
   * **What the fallback does NOT promise, and used to be documented here as though it did**:
   * that it resolves to the SAME predecessor the original successful call used. It does not —
   * it returns the newest LIVE, COMMITTED record other than `snapshotId`, by recency, with no
   * memory of what a previous call actually used. See {@link
   * DuckDbWarehouseStore.refuseSubstitutedOrigin}'s own docblock for the cases that gap opens
   * and the check that closes them: a served snapshot resolving a live predecessor other than
   * the one recorded in its own {@link CARRIED_FROM_LABEL}, an absent label included.
   *
   * The committed filter matters independently of which branch reached it: `write` creates a
   * `SnapshotRef` on a load's first batch and `carryForward` updates it (see below), both
   * before `commit` ever runs, so a load that was abandoned — a crash, a step that never
   * reached `commit` — leaves a live, un-tombstoned record behind. Without the filter that
   * record is indistinguishable from a served one to `listSnapshotsWithRows`, and the FIRST
   * branch's fallback would pick an abandoned run's half-finished snapshot as its merge source: a merge
   * source nobody ever served, reached through the one path Ruling 2's "served, not newest"
   * argument did not originally name. See {@link COMMITTED_LABEL}'s own docblock.
   *
   * ## What the SECOND branch's fallback can find, and the two hazards that follow from it
   *
   * The second branch's fallback CAN and typically DOES resolve to a real snapshot. Whatever it
   * resolves, `snapshotId` is by then the snapshot the type is SERVING, so anything written
   * under it is instantly live — and the fallback has no memory of what, if anything, an
   * earlier call for this same snapshot actually merged. Two things can therefore be wrong
   * about what it hands back, and they are answered two different ways:
   *
   * - **It can find nothing at all.** `dropSnapshot` only refuses the currently served
   *   snapshot, and dropping a superseded one during retention is ordinary, so the recorded
   *   predecessor can be gone with nothing left to stand in for it. The fallback resolves to
   *   `undefined` while `snapshotId` is STILL served: see {@link
   *   DuckDbWarehouseStore.refuseServedClear} for why that combination must refuse rather than
   *   clear — gated on whether anything is actually at stake, not on `served.id === snapshotId`
   *   alone.
   * - **It can find a snapshot this one was never merged with.** The recorded predecessor being
   *   dropped does not mean nothing else is left to find: an older snapshot can still be live
   *   and committed, and the fallback returns THAT one. Neither does `snapshotId` need to have
   *   carried from anything in the first place — a plain full load, committed and served, has
   *   no recorded origin at all, and the fallback answers it just the same. Either way the
   *   merge branch runs against a real, non-empty `previous` that disagrees with what
   *   `snapshotId`'s own record says. See {@link DuckDbWarehouseStore.refuseSubstitutedOrigin}
   *   for why both must refuse.
   *
   * ## A previous snapshot with no objects at all
   *
   * Reachable without anything exotic: `commit` does not require `write` to have run first —
   * see `principalOf`'s own docblock, "`commit` calls this for a snapshot `write` never
   * touched" — so a run that fetched nothing from its source at all can `commit` straight away,
   * publishing a legitimate, empty snapshot whose prefix holds zero Parquet objects. That
   * snapshot can then become `previous` for the next incremental load. Every other glob in this
   * file checks `objects.list(...)` before handing a glob to DuckDB, because a glob matching
   * nothing is an IO error in this engine, not an empty result (see `countStaged`'s own
   * docblock) — this one used not to, and would die on that error instead of doing the correct
   * thing, which is to carry nothing forward. Checked below via `previousObjects`.
   *
   * ## The anti-join, and why the incoming glob excludes `carry.parquet`
   *
   * `NOT EXISTS` against a glob of this snapshot's loader batches (`part-*.parquet`) only —
   * never against {@link carryForwardKey}'s object, which this call is about to overwrite.
   * Reading the target of a `COPY` back into the statement that produces it is the self-feeding
   * hazard the MikroORM and ClickHouse siblings guard against with an explicit `_batch <>
   * CARRY_FORWARD_BATCH` predicate; naming the loader glob by the batches' own key shape (see
   * {@link batchKey}) achieves the same exclusion without needing that predicate at all, since
   * `carry.parquet` never matches `part-*.parquet`.
   *
   * `_principal_id` and `_loaded_at` cross untouched from the previous snapshot — see {@link
   * CATALOG_PROVENANCE_COLUMNS}'s own docblock in the core package: a carried row is not a new
   * load of that row, so restamping it would erase the one thing those columns are good for.
   * `_batch` is stamped {@link CARRY_FORWARD_BATCH} (`-1`); `_row` is renumbered with `row_number()
   * OVER ()` because the positions carried rows would otherwise inherit come from several
   * different previous batches and would collide.
   *
   * `union_by_name = true` on every `read_parquet` here, matching every other one in this file —
   * see `countStaged`'s own docblock for the failure that flag prevents — and the `SELECT`
   * list's column order matches {@link stageColumns}'s and `stageRow`'s exactly: declared
   * properties in `type.properties` order, then the five reserved columns in the same order
   * `stageRow` writes them in. That is what Ruling 3 asks for and what makes it safe: a later
   * `union_by_name` read over the mix of loader batches and this carried object matches columns
   * by name regardless of order, but a name it cannot find in every file is a column silently
   * dropped from the merged result, not an error — matching the order removes any reliance on
   * that fallback ever being exercised.
   *
   * ## Idempotence, both ways — except when clearing would delete SERVED rows
   *
   * Safe to call twice with the same inputs. `carry.parquet`'s key is fixed per `(type,
   * snapshotId)` — see {@link carryForwardKey} — so a second call's `COPY … TO` overwrites the
   * first call's output rather than adding to it, and the anti-join is recomputed from whatever
   * loader batches exist when it runs, so a re-run after more batches landed sees them.
   *
   * Also safe when a SECOND call finds nothing to carry after a FIRST call found something —
   * {@link clearCarryObject} runs in that branch rather than leaving `carryKey` untouched, so
   * `carried` and `total` both describe what THIS call decided rather than a stale mix of this
   * call's `total` (recomputed fresh below, from whatever is actually on disk) and a first
   * call's carried rows sitting in a file nobody asked this call to rewrite.
   *
   * **Except** when `snapshotId` is the snapshot this type is CURRENTLY SERVING, and even then
   * only when something would actually change. `read` globs every object under a snapshot's
   * prefix with no commit gate to pass first, so `carryKey` being part of an already-served
   * snapshot means any write to it is instantly live — there is no staging step protecting it
   * the way an uncommitted snapshot's own objects are protected simply by not being the one
   * `read` resolves yet. The self-merge-retry path above (`served` resolves to `snapshotId`
   * itself) is ordinarily safe because the merge branch recomputes content from the same
   * predecessor the original call used, reproducing the same result — but the fallback that
   * resolves `previous` on a replay has no memory of what an earlier call actually used (see
   * "the fallback runs from TWO conditions" above), so that assumption can fail in two distinct
   * ways, each with its own guard:
   *
   * - **The predecessor is gone and nothing replaces it.** `dropSnapshot` only refuses the
   *   served snapshot, and dropping a superseded one during retention is ordinary. The replay
   *   then finds no previous and would otherwise call {@link clearCarryObject}, deleting rows
   *   the type is currently serving with no error and no commit to make it visible or
   *   reversible. Refused by {@link refuseServedClear} — but only when `carryKey` currently
   *   holds something to lose; see that method's own docblock for the three legitimate calls
   *   (a first-ever incremental load, a plain full load that never carried anything, a merge
   *   from a genuinely empty predecessor) that must NOT be refused because there is nothing to
   *   protect.
   * - **A live, committed record resolves that is not the one this snapshot carried from.**
   *   The merge branch then runs — `previous` is real and non-empty, so this is not the case
   *   above — against a source that disagrees with what `snapshotId`'s own record says. Two
   *   ways in: the recorded predecessor was dropped and an older one took its place as the
   *   newest live committed record, or `snapshotId` never carried from anything at all (a plain
   *   full load, committed and served, for which `carryForward` is then called) and the
   *   fallback finds a predecessor it was never merged with. Both are refused by {@link
   *   refuseSubstitutedOrigin}, which compares the resolved `previous.id` against {@link
   *   CARRIED_FROM_LABEL} — an absent label included, not exempted — before the merge branch
   *   below is allowed to run on an already-served snapshot.
   *
   * ## The ordering refusal
   *
   * Recording {@link CARRIED_FROM_LABEL} on the snapshot record, and clearing {@link
   * CARRY_FORWARD_STALE_LABEL}, is what lets `commit` notice a batch that arrived after THIS
   * call and refuse it — see `commit`'s own docblock and `write`'s marking comment for the two
   * halves of that mechanism, which mirrors the MikroORM and ClickHouse siblings' own labels of
   * the same names rather than inventing a third vocabulary for the same fact.
   */
  async carryForward(
    type: CatalogObjectTypeDef,
    snapshotId: string,
    options: { principalId: string; labels?: Record<string, string> },
  ): Promise<CarryForwardResult> {
    if (type.primaryKey.length === 0) {
      throw new BadRequestException(
        `${type.name} declares no primary key, so an incremental load has no way to say which incoming row replaces which existing one. Publish the type with a primary key, or run this connector in "full" mode, which replaces the dataset outright and needs no key.`,
      );
    }
    const keyColumns = type.primaryKey.map((name) => physicalColumn(name));

    const served = await this.currentSnapshot(type);
    // `this.snapshots.listLive` directly, not the public `listSnapshotsWithRows` — that method
    // strips {@link COMMITTED_LABEL} before returning (see its own docblock), and this
    // resolution is the one place inside this class that has to see the raw label. Matches how
    // this method already reads `this.snapshots.find` directly a few lines below rather than
    // the public `findSnapshot`.
    const previous =
      served && served.id !== snapshotId
        ? served
        : (await this.snapshots.listLive(type.name, SNAPSHOT_LIST_LIMIT)).find(
            (each) => each.id !== snapshotId && each.labels?.[COMMITTED_LABEL] !== undefined,
          );

    const prefix = snapshotPrefix(type.name, snapshotId);
    const carryKey = carryForwardKey(type.name, snapshotId);
    const loaderObjects = (await this.objects.list(prefix)).filter((each) => each !== carryKey);
    const incomingGlob = this.objects.locate(`${prefix}/part-*.parquet`);
    const previousObjects = previous
      ? await this.objects.list(snapshotPrefix(type.name, previous.id))
      : [];
    // Read once, ahead of every branch below: the merge branch needs it to detect a
    // substituted origin, the clear-refusal branch needs nothing from it directly but reads
    // the SAME record again afterward to build `ref`, and reading it twice would risk the two
    // reads disagreeing if anything else touched the record in between (nothing does, but the
    // single read makes that true by construction rather than by accident).
    const existingRef = await this.snapshots.find(type.name, snapshotId);
    const isServedReplay = served?.id === snapshotId;

    if (previous && previousObjects.length > 0) {
      await this.writeMergedCarryObject(
        type,
        snapshotId,
        carryKey,
        previous,
        keyColumns,
        loaderObjects,
        incomingGlob,
        isServedReplay,
        existingRef?.labels?.[CARRIED_FROM_LABEL],
      );
    } else if (isServedReplay && (await this.countCarried(type, snapshotId)) > 0) {
      // `snapshotId` is the snapshot this type is CURRENTLY SERVING, this call found nothing to
      // carry forward, AND `carryKey` currently holds rows -- reachable exactly when the
      // predecessor a previous, successful `carryForward` call for this same snapshotId
      // carried rows FROM has since been dropped (legal: `dropSnapshot` only refuses the
      // served snapshot, and dropping a superseded predecessor during retention is ordinary)
      // and no other committed record stands in for it. The `countCarried` guard is what keeps
      // this from over-firing on a snapshot that never carried anything in the first place --
      // including a plain full load, whose `carry.parquet` does not exist at all, which is why
      // `countCarried` answers about a missing object rather than assuming one. See
      // `refuseServedClear`'s own docblock for both halves of this reasoning.
      this.refuseServedClear(type, snapshotId, carryKey);
    } else {
      // Nothing worth protecting: either nothing to carry from and nothing currently carried
      // (a first-ever incremental load, a plain full load nothing was ever merged into, or one
      // merging from a legitimately empty predecessor), or `snapshotId` is not yet served, so
      // nothing is reading it as current either way.
      // Clears whatever an earlier call on THIS snapshotId left in `carryKey`, closing the
      // same idempotence gap a re-sent batch's replace semantics close for `write`.
      await this.clearCarryObject(type, carryKey);
    }

    const total = await this.countStaged(type, snapshotId);
    const carried = await this.countCarried(type, snapshotId);

    const ref: SnapshotRef = existingRef ?? {
      id: snapshotId,
      createdAt: new Date().toISOString(),
      rowCount: 0,
      principalId: options.principalId,
    };
    // One rule for a caller's labels across every writer of this record: **a key is recorded by
    // the first call that supplies it and never overwritten by a later one.** `write` merges
    // each batch's labels the same way, in the same spread order (see `recordWrittenBatch`), so
    // labels supplied only here — a caller that labels its merge and not its batches — are kept,
    // and labels supplied to both do not flip value halfway through a load. Written as a spread
    // rather than as a branch on `existingRef`, because branching is how this parameter came to
    // be read on one path and silently discarded on the other, twice.
    const labels = { ...options.labels, ...ref.labels };
    labels[CARRIED_FROM_LABEL] = previous?.id ?? CARRIED_FROM_NOTHING;
    // The merge is current as of now, whatever it was before this call.
    delete labels[CARRY_FORWARD_STALE_LABEL];
    ref.labels = labels;
    ref.rowCount = total;
    await this.snapshots.put(type.name, ref);

    return {
      ...(previous ? { from: previous.id } : {}),
      carried,
      total,
    };
  }
}

/**
 * The search box's predicate, or nothing when there is nothing to search.
 *
 * Matches the ClickHouse sibling's `read`: the term is trimmed, and a blank one (missing,
 * empty, or only whitespace) means no predicate at all rather than one that matches
 * everything vacuously. `properties` is the same fields-whitelisted list the SELECT list is
 * built from, not `type.properties` — a search never reaches over a column this read was not
 * asked to return.
 *
 * Only `string` columns with no `classification` are searched, for the reason
 * `filterOperatorsFor` in the core package excludes a classified column from filtering: a
 * predicate over it — even one as coarse as a substring match — leaks the value's presence
 * through row membership, though the value itself is never rendered.
 *
 * `ILIKE` for the same case-insensitivity `contains` in `filters.ts` uses: DuckDB's `LIKE` is
 * case-sensitive, and a search box that behaved differently depending on which adapter is
 * mounted would look like a bug in the data. Unlike `contains`, the term is **not** escaped
 * against `%`/`_` — the ClickHouse sibling does not escape it either, so a caller sees the
 * same search behaviour whichever adapter is mounted, at the cost of a literal `%` or `_` in
 * a search term acting as a wildcard instead of matching itself.
 */
function searchPredicate(
  properties: CatalogPropertyDef[],
  search: string | undefined,
): string | undefined {
  const term = search?.trim();
  if (!term) return undefined;
  const searchable = properties.filter(
    (property) => property.type === 'string' && !property.classification,
  );
  if (searchable.length === 0) return undefined;
  return `(${searchable
    .map((property) => `${ident(physicalColumn(property.name))} ILIKE ${quoteLiteral(`%${term}%`)}`)
    .join(' OR ')})`;
}

/**
 * `ORDER BY`, composing an explicit sort with the fallback rather than replacing it.
 *
 * `query.sort` is matched against `properties` — the same fields-whitelisted list `read`
 * selects from — so a `sort` naming a column this read does not return behaves exactly like
 * one naming nothing at all: neither is a refusal. The core service already narrows
 * `query.sort` to a real, visible column before a store ever sees one (`CatalogService`'s own
 * `readObjects` falls it back to `undefined` there), so a store-level refusal here would be a
 * second, redundant guard on the ordinary path and a needless failure for a caller that
 * reaches `read` directly, such as this package's own specs.
 *
 * `(_batch, _row)` is appended whether or not a sort resolved, because it is what
 * {@link batchKey} guarantees is a total order over one snapshot's rows — see `read`'s own
 * docblock. Two rows tying on the sorted column would otherwise come back in whatever order
 * the engine feels like, which is a page whose boundary moves under a caller paging through it.
 */
function orderByClause(properties: CatalogPropertyDef[], query: CatalogReadQuery): string {
  const sortProperty = properties.find((property) => property.name === query.sort);
  const tiebreak = `${ident(BATCH_COLUMN)}, ${ident(ROW_COLUMN)}`;
  if (!sortProperty) return tiebreak;
  const direction = query.dir === 'desc' ? 'DESC' : 'ASC';
  return `${ident(physicalColumn(sortProperty.name))} ${direction}, ${tiebreak}`;
}

/**
 * `size` and `page`, refused if either is non-finite and clamped otherwise.
 *
 * `write`'s own `batch` guards a non-finite input with a named error rather than letting it
 * flow into a key nothing could resolve; `size` and `page` get the same rather than silently
 * becoming `LIMIT NaN OFFSET NaN`, which is not a value DuckDB is owed to reject usefully.
 * `read` calls this ahead of its empty-glob guard — see that method's own docblock for why an
 * identical bad request must be refused the same way regardless of what is on disk yet.
 *
 * `size` also gets an upper bound: a page size sourced from a request is not a number a
 * caller should be able to inflate into "the whole snapshot in one read".
 */
function resolvedPaging(query: CatalogReadQuery): { size: number; page: number } {
  if (query.size !== undefined && !Number.isFinite(query.size)) {
    throw new BadRequestException(`size must be a finite number, got ${String(query.size)}.`);
  }
  if (query.page !== undefined && !Number.isFinite(query.page)) {
    throw new BadRequestException(`page must be a finite number, got ${String(query.page)}.`);
  }
  return {
    size: Math.min(1000, Math.max(1, query.size ?? 50)),
    page: Math.max(1, query.page ?? 1),
  };
}

/**
 * The `columns` argument for `read_json`, so nothing is inferred from the data.
 *
 * Keys are string literals, not identifiers: `read_json`'s `columns` parameter is a struct
 * literal mapping a column name to a type name, both spelled as text, and `quoteLiteral` is
 * what produces a string literal. `ident()` belongs to statements that reference a column by
 * name — a `SELECT` list, a `CREATE TABLE` — which this is not.
 *
 * Tested against the real engine both ways: on this DuckDB build, a double-quoted `ident()`
 * key parses here too, including for a mixed-case name and one that is a reserved word — only
 * a bare unquoted key fails. So this is not working around an observed failure; it is using
 * the form that matches what the argument actually is, on the basis that a parser being
 * lenient about a string-literal position today is not a guarantee it stays lenient.
 */
function stageColumns(type: CatalogObjectTypeDef): string {
  const declared = type.properties.map(
    (property: CatalogPropertyDef) =>
      `${quoteLiteral(physicalColumn(property.name))}: ${quoteLiteral(duckDbType(property.type))}`,
  );
  const reserved = [
    `${quoteLiteral(SNAPSHOT_COLUMN)}: 'VARCHAR'`,
    `${quoteLiteral(PRINCIPAL_COLUMN)}: 'VARCHAR'`,
    `${quoteLiteral(LOADED_AT_COLUMN)}: 'TIMESTAMP WITH TIME ZONE'`,
    `${quoteLiteral(BATCH_COLUMN)}: 'INTEGER'`,
    `${quoteLiteral(ROW_COLUMN)}: 'BIGINT'`,
  ];
  return `{${[...declared, ...reserved].join(', ')}}`;
}

/**
 * One row, keyed by physical column name and carrying its provenance.
 *
 * `_row` is a position within the batch, not a running count, so `(_batch, _row)` is a
 * total order over the snapshot. Parquet has no auto-increment, and paging a set with no
 * total order silently repeats and skips rows between pages.
 */
function stageRow(
  type: CatalogObjectTypeDef,
  row: Record<string, unknown>,
  provenance: {
    snapshotId: string;
    principalId: string;
    batch: number;
    row: number;
    loadedAt: string;
  },
): Record<string, unknown> {
  const staged: Record<string, unknown> = {};
  for (const property of type.properties) {
    staged[physicalColumn(property.name)] = coerce(row[property.name], property.type);
  }
  staged[SNAPSHOT_COLUMN] = provenance.snapshotId;
  staged[PRINCIPAL_COLUMN] = provenance.principalId;
  staged[LOADED_AT_COLUMN] = provenance.loadedAt;
  staged[BATCH_COLUMN] = provenance.batch;
  staged[ROW_COLUMN] = provenance.row;
  return staged;
}

/**
 * A row off the wire, keyed by the property's own name rather than by its physical column or
 * its SQL alias.
 *
 * `read`'s SELECT list aliases each column to `outputAlias(property.name)` — the spelling
 * `stageRow` keys by via `physicalColumn`, and the spelling this function reads back by — and
 * this is where that alias is translated to the name the caller asked for. `properties` is
 * already the resolved, whitelist-checked list `read` built before calling this, so there is
 * no "field with no matching property" case here to guard against; a caller can only reach
 * this function with properties `read` has already vouched for.
 *
 * The incident `outputAlias`'s own docblock records is on the WRITE side, not this one: a
 * verbatim alias forced a source column like `Asset Id` to be renamed to `Asset_Id` to
 * survive `ident()`'s refusal, and since a load matches a record to a property by property
 * NAME — `stageRow` reads `row[property.name]` — the renamed property's every load read
 * `undefined` out of a record the source keyed `Asset Id`, landing NULL on disk in every row.
 * Thirteen types were loaded that way; six came back with most of their columns empty,
 * 313,833 rows on the largest.
 *
 * This function's own failure mode, if it lost the translation, is different and narrower: a
 * value staged correctly under `Asset_Id` would be handed back keyed `Asset_Id` instead of
 * `Asset Id` — data under the wrong key, not a NULL on disk. It cannot reproduce the
 * write-side incident; it is its own way of breaking the same round-trip.
 */
function normaliseRow(
  properties: CatalogPropertyDef[],
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const property of properties) {
    out[property.name] = normalise(row[outputAlias(property.name)], property.type);
  }
  return out;
}

/**
 * The `_batch` a snapshot object was written under, parsed back out of its key — never read off
 * the key's own lexicographic order.
 *
 * `streamSnapshot` needs this to reconstruct `(_batch, _row)` without asking DuckDB to sort the
 * whole snapshot (see that method's own docblock). {@link batchKey} zero-pads to six digits,
 * which keeps a listing's STRING order agreeing with batch NUMBER order only below 1,000,000,
 * and `'part-1000000.parquet' < 'part-999999.parquet'` as strings, which is backwards. Parsing
 * the number back out and comparing numerically is correct regardless.
 *
 * `carryForwardKey`'s object never matches `part-<digits>.parquet` — it is named `carry.parquet`
 * precisely so it cannot (see that function's own docblock) — so it falls through to {@link
 * CARRY_FORWARD_BATCH} here, which is also the exact value it is stamped with on disk: this
 * function's answer for a carried object and the `_batch` a reader finds inside it agree by
 * construction, not by coincidence.
 *
 * **That fallthrough is exhaustive, not merely true of every batch this file's own specs
 * happen to try, because `write` bounds a batch at `Number.MAX_SAFE_INTEGER`** (see that
 * method's own guard). Without the bound, a batch like `1e21` renders through `batchKey` as
 * `'part-1e+21.parquet'` — the regex below does not match exponential notation — and would
 * silently fall through to `CARRY_FORWARD_BATCH` here too, landing an ordinary loader batch in
 * the slot this function otherwise reserves for the one object no caller of `write` can forge
 * into.
 */
function batchNumberOf(key: string): number {
  const match = /\/part-(\d+)\.parquet$/.exec(key);
  return match ? Number(match[1]) : CARRY_FORWARD_BATCH;
}

/**
 * Whether a merged label map says anything the record does not already say.
 *
 * {@link DuckDbWarehouseStore.recordWrittenBatch} runs on every batch of a load, and the
 * ordinary case is a load whose batches all carry the same labels: the merge then produces
 * exactly what is already stored, and writing it back would be one object PUT per batch to
 * record nothing.
 *
 * Size first, then values. The size test alone would in fact be enough today, because the merged
 * map is built by spreading the stored one LAST: a key can only be added, never dropped, and no
 * stored value is ever replaced. The value test costs one pass over a handful of keys and does
 * not depend on that argument continuing to hold for whatever writes this map next.
 */
function labelsUnchanged(
  before: Record<string, string> | undefined,
  after: Record<string, string>,
): boolean {
  const keys = Object.keys(after);
  if (keys.length !== Object.keys(before ?? {}).length) return false;
  return keys.every((key) => before?.[key] === after[key]);
}

/**
 * Whether a record's stored `rowCount` is a fact about the data or a placeholder.
 *
 * True for exactly the two states whose count was written by the operation that made it final:
 * a tombstone, whose rows are gone and whose number `dropSnapshot` took before deleting them,
 * and a committed record, whose number `commit` counted while blessing it. False for everything
 * else, including the record `write` creates on a load's first batch and the one `carryForward`
 * updates mid-load — see {@link DuckDbWarehouseStore.present} for what is done with the
 * difference and why it is load-bearing rather than tidy.
 *
 * A plain `boolean` rather than a type predicate: the question is about a record's contents,
 * not about whether one is there, and a predicate over `SnapshotRef | undefined` would narrow
 * its own negative branch to `never` for the caller that already holds a record.
 */
function hasFinalRowCount(ref: SnapshotRef): boolean {
  return ref.droppedAt !== undefined || ref.labels?.[COMMITTED_LABEL] !== undefined;
}

/**
 * Removes {@link COMMITTED_LABEL} before a `SnapshotRef` reaches code outside this class.
 *
 * `_committed` is set on every `commit` call, unconditionally — see that label's own docblock —
 * which means every ordinary full load, one that never touches `carryForward` and never asked
 * for a label of its own, would otherwise report one anyway. Before this label existed, a
 * `SnapshotRef`'s `labels` was present only when a caller supplied some; this restores that
 * contract for every method that hands a ref to code outside this class.
 *
 * `_carriedFrom` and `_carryForwardStale` are left alone, deliberately. Both are opt-in facts
 * about a snapshot that actually went through an incremental merge, and the ClickHouse and
 * MikroORM siblings surface those same two labels to their own callers without stripping them
 * either. `_committed` is the one label that is not opt-in — every commit gets it whether or
 * not the caller asked for a label at all — which is what makes it the one that has to come off
 * before a caller sees it.
 *
 * Returns `ref` itself, unmodified, when `_committed` is absent — never true for anything this
 * store's own `commit` has touched, but a defensive no-op costs nothing against a record this
 * store did not write.
 */
function omitCommittedLabel(ref: SnapshotRef): SnapshotRef {
  if (ref.labels?.[COMMITTED_LABEL] === undefined) return ref;
  const { [COMMITTED_LABEL]: _committed, ...rest } = ref.labels;
  if (Object.keys(rest).length === 0) {
    const { labels: _labels, ...withoutLabels } = ref;
    return withoutLabels;
  }
  return { ...ref, labels: rest };
}

/**
 * Adds {@link CATALOG_PROVENANCE_COLUMNS} to an already-`normaliseRow`d row, read off the RAW
 * row rather than the normalised one: `_principal_id`/`_loaded_at` are selected verbatim (no
 * `outputAlias`) in `streamSnapshot`'s SELECT list, since they are reserved columns rather than
 * declared properties, so they live on `row` under their own literal names, not under whatever
 * `normaliseRow` keyed its output by.
 */
function withProvenance(
  out: Record<string, unknown>,
  row: Record<string, unknown>,
): Record<string, unknown> {
  for (const column of CATALOG_PROVENANCE_COLUMNS) {
    out[column] = normalise(row[column], column === '_loaded_at' ? 'date' : 'string');
  }
  return out;
}
