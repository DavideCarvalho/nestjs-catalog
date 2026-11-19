---
"@dudousxd/nestjs-catalog-store-drizzle": minor
---

`DrizzleCatalogTraceStore` implements `CatalogTraceStore` on Postgres: the audit trail grouped into traces per load, graded and paged in one statement. `CatalogDrizzleStoreModule` registers it under `CATALOG_TRACE_STORE`, along with the core `CatalogAuditRecorder` (`audit: false` leaves the recorder out). It passes the trace contract the MikroORM store passes on MySQL.
