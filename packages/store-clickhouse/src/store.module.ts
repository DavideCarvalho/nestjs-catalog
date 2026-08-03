import type { ClickHouseClient } from '@clickhouse/client';
import { CATALOG_STORE } from '@dudousxd/nestjs-catalog';
import { type DynamicModule, Inject, Module, type OnModuleInit } from '@nestjs/common';
import { ClickHouseWarehouseStore } from './clickhouse-warehouse.store';
import {
  CATALOG_CLICKHOUSE_CLIENT,
  CATALOG_CLICKHOUSE_QUERY_CLIENT,
  catalogClickHouseProviders,
} from './context';
import { CATALOG_CLICKHOUSE_OPTIONS, type CatalogClickHouseStoreOptions } from './options';
import { ensureCatalogClickHouseSchema } from './snapshots';

/**
 * Binds the catalog library's storage seam to ClickHouse.
 *
 * **Only the storage seam.** The MikroORM adapter also supplies a stored model,
 * a workspace store and a pipeline store, because it has a transactional
 * database to keep them in. This one deliberately does not: saved queries,
 * dashboards, connector definitions and audit rows are small, mutable,
 * read-modify-write data, and putting them in a column store would mean either
 * a `ReplacingMergeTree` for every one of them or a stream of mutations. The
 * snapshot bookkeeping here is the exception that proves the rule — two tables,
 * a handful of rows, and it is kept in ClickHouse only so the adapter needs no
 * second database to answer "which load is current".
 *
 * So a full deployment mounts this *for the rows* and something else for the
 * model. `CatalogModule.forRoot` takes an explicit `store` provider, which is
 * the seam to use — importing two modules that both export `CATALOG_STORE` and
 * relying on which one Nest resolves last is not a wiring anyone should have to
 * reason about:
 *
 * ```ts
 * CatalogModule.forRoot({
 *   imports: [CatalogClickHouseStoreModule.forRoot({ connection })],
 *   store: { provide: CATALOG_STORE, useExisting: ClickHouseWarehouseStore },
 * })
 * ```
 */
@Module({})
export class CatalogClickHouseStoreModule implements OnModuleInit {
  constructor(
    @Inject(CATALOG_CLICKHOUSE_CLIENT)
    private readonly client: ClickHouseClient,
    @Inject(CATALOG_CLICKHOUSE_OPTIONS)
    private readonly options: CatalogClickHouseStoreOptions,
  ) {}

  static forRoot(options: CatalogClickHouseStoreOptions): DynamicModule {
    return {
      module: CatalogClickHouseStoreModule,
      global: false,
      providers: [
        ...catalogClickHouseProviders(options),
        ClickHouseWarehouseStore,
        { provide: CATALOG_STORE, useExisting: ClickHouseWarehouseStore },
      ],
      exports: [
        // The clients are handed out so a host that adds its own services on
        // top of this store — a reporting endpoint, a backfill script — talks
        // to the *same* server and database instead of building a second client
        // from environment variables that have since diverged.
        CATALOG_CLICKHOUSE_CLIENT,
        CATALOG_CLICKHOUSE_QUERY_CLIENT,
        ClickHouseWarehouseStore,
        CATALOG_STORE,
      ],
    };
  }

  /**
   * Create the bookkeeping tables before anything reads them.
   *
   * In `onModuleInit` rather than lazily on first use: the two statements are
   * `CREATE TABLE IF NOT EXISTS` and the cost of getting it wrong is a boot
   * that looks healthy and a first load that fails on a missing table, at
   * whatever hour the connector happens to run.
   */
  async onModuleInit(): Promise<void> {
    if (this.options.autoSchema === false) return;
    await ensureCatalogClickHouseSchema(this.client);
  }
}
