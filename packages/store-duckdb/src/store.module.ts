import { CATALOG_STORE } from '@dudousxd/nestjs-catalog';
import { type DynamicModule, Module } from '@nestjs/common';
import { DuckDbWarehouseStore } from './duckdb-warehouse.store';
import { CATALOG_DUCKDB_OPTIONS, type CatalogDuckDbStoreOptions } from './options';

@Module({})
// A class with only static members, because in Nest the CLASS IS THE TOKEN: a module is
// identified by its constructor reference, so an object or a bare factory has no identity
// the injector can register.
export class CatalogDuckDbStoreModule {
  static forRoot(options: CatalogDuckDbStoreOptions): DynamicModule {
    if (!options.root) {
      throw new Error(
        "CatalogDuckDbStoreModule.forRoot needs a `root` — a directory or an s3:// URL. Refusing to default, because a store that silently writes somewhere plausible is a store that lands a production snapshot in a developer's home directory.",
      );
    }
    return {
      module: CatalogDuckDbStoreModule,
      global: false,
      providers: [
        { provide: CATALOG_DUCKDB_OPTIONS, useValue: options },
        DuckDbWarehouseStore,
        { provide: CATALOG_STORE, useExisting: DuckDbWarehouseStore },
      ],
      exports: [DuckDbWarehouseStore, CATALOG_STORE],
    };
  }
}
