---
"@dudousxd/nestjs-catalog-store-drizzle": minor
---

New package: the catalog's saved queries, dashboards, saved-query revisions, audit trail and curation overlay on Drizzle and PostgreSQL, for hosts that do not run MikroORM. `DrizzleWorkspaceStore` implements `CatalogWorkspaceStore` and `DrizzleCatalogOverlayStore` implements `CatalogOverlayStore`. Each takes either a Drizzle database or a `run` function that executes work in the host's own transaction. Table names take a prefix (default `catalog_`, matching the MikroORM store) and an optional schema. The tables ship as Drizzle definitions for drizzle-kit and as SQL (`catalogDrizzleSql()`, `sql/catalog.sql`) that needs no superuser.
