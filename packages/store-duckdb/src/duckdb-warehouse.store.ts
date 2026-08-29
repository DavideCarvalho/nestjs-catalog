import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CatalogFilterOperator,
  CatalogObjectTypeDef,
  CatalogPropertyDef,
  CatalogReadQuery,
  CatalogReadResult,
  CatalogStoreCapabilities,
  SnapshotRef,
} from '@dudousxd/nestjs-catalog';
import {
  CATALOG_FILTER_OPERATORS,
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
  LOADED_AT_COLUMN,
  PRINCIPAL_COLUMN,
  ROW_COLUMN,
  SNAPSHOT_COLUMN,
  batchKey,
  ident,
  snapshotPrefix,
} from './identifiers';
import { type ObjectStore, isS3Root, localObjectStore } from './object-store';
import { CATALOG_DUCKDB_OPTIONS, type CatalogDuckDbStoreOptions } from './options';
import { SNAPSHOT_LIST_LIMIT, type SnapshotCatalog, objectSnapshotCatalog } from './snapshots';

@Injectable()
export class DuckDbWarehouseStore {
  /**
   * What this adapter can do, and what it has not measured.
   *
   * `snapshots: 'emulated'` is the honest label and the one the core package predicts:
   * DuckDB keeps no history of its own. History here is a prefix per load and a pointer at
   * one of them, which is emulation in exactly the sense MySQL's `_snapshot_id` column is.
   *
   * The three atomicity fields are absent, which is a third answer meaning *not stated*. A
   * guess about atomicity is indistinguishable from a measurement once it is a literal in
   * this object, and a caller reading the optimistic answer skips the repair it exists for.
   * They are filled in once measured, not before.
   */
  readonly capabilities: CatalogStoreCapabilities = {
    snapshots: 'emulated',
    writable: true,
    timeTravel: true,
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
        ? unsupportedRemoteStore(options.root)
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
    if (!Number.isInteger(batch) || batch < 0) {
      throw new Error(
        `batch must be a non-negative integer, got ${String(options.batch)}. The batch number is half of this store's object key, and a key it cannot derive is a batch a retry cannot replace.`,
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
    // Rows accepted by THIS call. Never the snapshot's running total: a caller sums these
    // across batches, and a fan-out compares its primary's answer with its follower's.
    return { written: rows.length };
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
   */
  async commit(type: CatalogObjectTypeDef, snapshotId: string): Promise<SnapshotRef> {
    const existing = await this.snapshots.find(type.name, snapshotId);
    if (existing?.droppedAt) {
      throw new Error(
        `snapshot ${snapshotId} of ${type.name} was dropped on ${existing.droppedAt} and cannot be committed. Its rows are gone; the record survives so run history stays resolvable.`,
      );
    }
    const ref: SnapshotRef = {
      id: snapshotId,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      rowCount: await this.countStaged(type, snapshotId),
      principalId: existing?.principalId ?? (await this.principalOf(type, snapshotId)),
      ...(existing?.labels ? { labels: existing.labels } : {}),
      ...(existing?.archive ? { archive: existing.archive } : {}),
    };
    await this.snapshots.put(type.name, ref);
    await this.snapshots.setCurrent(type.name, snapshotId);
    return ref;
  }

  /** The snapshot record behind the served pointer, or `undefined` when nothing has committed. */
  async currentSnapshot(type: CatalogObjectTypeDef): Promise<SnapshotRef | undefined> {
    const id = await this.snapshots.current(type.name);
    return id ? this.snapshots.find(type.name, id) : undefined;
  }

  /** Every record, newest first, tombstones included. */
  async listSnapshots(type: CatalogObjectTypeDef): Promise<SnapshotRef[]> {
    return this.snapshots.list(type.name);
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
   */
  async listSnapshotsWithRows(
    type: CatalogObjectTypeDef,
    limit = SNAPSHOT_LIST_LIMIT,
  ): Promise<SnapshotRef[]> {
    return this.snapshots.listLive(type.name, limit);
  }

  /** Exact lookup by id, tombstone included, whatever the age. */
  async findSnapshot(
    type: CatalogObjectTypeDef,
    snapshotId: string,
  ): Promise<SnapshotRef | undefined> {
    return this.snapshots.find(type.name, snapshotId);
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
    const rowCount = existing?.rowCount ?? (await this.countStaged(type, snapshotId));
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
          `snapshot ${wanted} of ${type.name} was dropped on ${ref.droppedAt}. Its rows are gone; this read cannot be served and is refused rather than answered with none.`,
        );
      }
    }

    // Resolved up front, ahead of the empty-glob guard, so a field the type does not have is
    // refused identically whether or not the snapshot has anything staged yet.
    const properties = fields.map((field) => {
      const property = type.properties.find((each) => each.name === field);
      if (!property) {
        throw new BadRequestException(
          `${type.name} has no property named ${field}; a store must never return a column outside the whitelist it was handed.`,
        );
      }
      return property;
    });

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
 * An `s3://` root with no object-store binding.
 *
 * DuckDB reaches S3 itself, so reads and writes would work — and everything this store does
 * *besides* moving rows (listing a snapshot's parts, swapping the pointer, tombstoning)
 * goes through the port, which has no S3 binding until Task 13. Refusing here is what keeps
 * that gap from presenting as a store that writes and then cannot remember what it wrote.
 */
function unsupportedRemoteStore(root: string): ObjectStore {
  throw new Error(
    `root ${root} is object storage, but no \`objectStore\` was supplied. Bind s3ObjectStore(root) — DuckDB can read and write the Parquet itself, but the snapshot records and the served pointer go through the object store port.`,
  );
}
