import { Inject, Injectable } from '@nestjs/common';
import { CATALOG_DUCKDB_OPTIONS, type CatalogDuckDbStoreOptions } from './options';

@Injectable()
export class DuckDbWarehouseStore {
  constructor(
    @Inject(CATALOG_DUCKDB_OPTIONS)
    private readonly options: CatalogDuckDbStoreOptions,
  ) {}

  /** The configured root, exposed so a host's own tooling reaches the same place the store does. */
  get root(): string {
    return this.options.root;
  }
}
