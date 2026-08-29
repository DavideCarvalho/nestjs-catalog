import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CatalogObjectTypeDef,
  CatalogPropertyDef,
  CatalogStoreCapabilities,
} from '@dudousxd/nestjs-catalog';
import {
  assertNoColumnCollisions,
  assertSafeIdentifier,
  physicalColumn,
} from '@dudousxd/nestjs-catalog';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { coerce, duckDbType } from './column-types';
import { type DuckDbConnection, openDuckDb, quoteLiteral } from './duckdb';
import {
  BATCH_COLUMN,
  LOADED_AT_COLUMN,
  PRINCIPAL_COLUMN,
  ROW_COLUMN,
  SNAPSHOT_COLUMN,
  batchKey,
  snapshotPrefix,
} from './identifiers';
import { type ObjectStore, isS3Root, localObjectStore } from './object-store';
import { CATALOG_DUCKDB_OPTIONS, type CatalogDuckDbStoreOptions } from './options';
import { type SnapshotCatalog, objectSnapshotCatalog } from './snapshots';

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
