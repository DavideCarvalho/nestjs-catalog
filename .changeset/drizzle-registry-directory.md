---
"@dudousxd/nestjs-catalog-store-drizzle": minor
---

`DrizzleCatalogRegistry` (`CatalogRegistry`) serves the catalog model from the `object_type`, `property` and `snapshot` tables, curates on the rows and notices other replicas' changes through a watermark. `DrizzleCatalogDirectory` (`CATALOG_DIRECTORY`) lists applications from the `principal` table. The schema adds those four tables with MikroORM's column types, index and foreign-key names, and `catalogDrizzleSql()` now emits foreign keys. `CatalogDrizzleStoreModule` binds both, and takes `staleAfterMs`. Both pass a registry and directory contract that the MikroORM store also runs.
