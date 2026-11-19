---
"@dudousxd/nestjs-catalog": minor
"@dudousxd/nestjs-catalog-store-mikro-orm": minor
---

`CatalogAuditRecorder` moves to the core package. It writes catalog diagnostics events through `CATALOG_WORKSPACE_STORE` and nothing else, so any store can register it, not only the MikroORM one. `@dudousxd/nestjs-catalog-store-mikro-orm` re-exports it unchanged and now needs `@dudousxd/nestjs-catalog` 0.38.0 or later. The MikroORM trace store's database cases now run as a shared contract (`test/trace-store-contract.ts`) that the Drizzle store runs on Postgres. Only the MySQL query-plan case stays specific to this store.
