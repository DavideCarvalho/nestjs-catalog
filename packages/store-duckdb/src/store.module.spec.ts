import { CATALOG_STORE } from '@dudousxd/nestjs-catalog';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { CatalogDuckDbStoreModule } from './store.module';

describe('CatalogDuckDbStoreModule', () => {
  it('refuses to boot without a root, rather than inventing one', () => {
    // A store that silently writes somewhere plausible is a store that lands a
    // production snapshot in a developer's home directory. The ClickHouse
    // adapter refuses a default URL for the same reason.
    expect(() => CatalogDuckDbStoreModule.forRoot({ root: '' })).toThrow(/root/i);
  });

  it('binds CATALOG_STORE to the DuckDB store', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CatalogDuckDbStoreModule.forRoot({ root: '/tmp/catalog-duckdb-boot' })],
    }).compile();
    expect(moduleRef.get(CATALOG_STORE)).toBeDefined();
  });
});
